import { Innertube, Parser } from 'youtubei.js';
import { getPoToken, invalidatePoToken } from './potoken';

let yt: Innertube | null = null;
let isInitializing = false;

Parser.setParserErrorHandler(({ error_type }) => {
  if (error_type === 'class_not_found') return;
});

let last403Time = 0;
const COOLDOWN_AFTER_403_MS = 30_000;

export function invalidateInnertube(): void {
  yt = null;
  invalidatePoToken();
}

export async function getInnertube(): Promise<Innertube> {
  if (yt) return yt;

  const timeSince403 = Date.now() - last403Time;
  if (timeSince403 < COOLDOWN_AFTER_403_MS) {
    const wait = COOLDOWN_AFTER_403_MS - timeSince403;
    throw new Error(`[YouTube] Cooldown after 403 — retry in ${Math.ceil(wait / 1000)}s`);
  }

  if (isInitializing) {
    throw new Error('[YouTube] Innertube initialization already in progress');
  }
  isInitializing = true;

  try {
    const opts: Record<string, any> = {};
    let clientType = (process.env.YT_CLIENT || 'WEB').toUpperCase();

    if (clientType === 'TV') clientType = 'TVHTML5';
    if (clientType === 'TVHTML5_TV') clientType = 'TVHTML5_SIMPLY_EMBEDDED_PLAYER';

    opts.client_type = clientType;

    if (process.env.YT_USER_AGENT) {
      opts.user_agent = process.env.YT_USER_AGENT;
    } else if (clientType === 'WEB') {
      opts.user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    }

    opts.generate_session_locally = process.env.YT_GENERATE_SESSION_LOCALLY !== 'false';

    if (process.env.YT_COOKIE) {
      opts.cookie = process.env.YT_COOKIE;
    }

    // PoToken: prefer explicit env vars, then auto-generated.
    // Skip auto-gen when YT_POTOKEN=off or non-WEB client.
    const envPoToken = process.env.YT_POTOKEN;
    const envVisitorData = process.env.YT_VISITOR_DATA;

    if (envPoToken) {
      opts.po_token = envPoToken;
    }
    if (envVisitorData) {
      opts.visitor_data = envVisitorData;
    }

    const autoPotoken = !envPoToken && !envVisitorData && clientType === 'WEB' && process.env.YT_POTOKEN !== 'off';

    if (autoPotoken) {
      try {
        const tokenData = await getPoToken();
        opts.po_token = tokenData.poToken;
        opts.visitor_data = tokenData.visitorData;
      } catch (poErr) {
        const msg = poErr instanceof Error ? poErr.message : String(poErr);
        console.warn('[YouTube] Auto PoToken generation failed, continuing without it:', msg);
      }
    }

    if (process.env.YT_DEBUG === '1') {
      console.debug(`[YouTube] Initializing Innertube (${clientType} client)`, {
        hasPoToken: !!opts.po_token,
        hasCookie: !!opts.cookie,
        hasVisitorData: !!opts.visitor_data,
        autoPotoken,
      });
    }

    const baseUserAgent = opts.user_agent;
    const referrer = process.env.ORIGIN || 'https://www.youtube.com/';
    const baseReferer = referrer.endsWith('/') ? referrer : referrer + '/';

    opts.fetch = async (input: any, init?: any) => {
      let urlStr = '';
      try {
        if (typeof input === 'string') urlStr = input;
        else if (input && typeof input === 'object' && 'url' in input) urlStr = String(input.url);
        else urlStr = String(input);
      } catch {
        urlStr = String(input);
      }

      const headers: Record<string, string> = {};
      const orig = init?.headers;
      if (orig) {
        if (typeof (orig as any).entries === 'function') {
          for (const [k, v] of (orig as any).entries()) {
            try { headers[k.toLowerCase()] = String(v); } catch { }
          }
        } else if (typeof (orig as any).forEach === 'function') {
          try {
            (orig as any).forEach((v: any, k: string) => {
              try { headers[k.toLowerCase()] = String(v); } catch { }
            });
          } catch { }
        } else if (typeof orig === 'object') {
          for (const k of Object.keys(orig)) {
            try { headers[k.toLowerCase()] = String((orig as any)[k]); } catch { }
          }
        }
      }

      if ('x-goog-visitor-id' in headers) {
        const val = headers['x-goog-visitor-id'];
        if (!val || !val.trim()) delete headers['x-goog-visitor-id'];
      }

      // For live_chat polling requests, set a longer timeout to avoid
      // Vercel function timeouts.
      const isLiveChat = urlStr.includes('/live_chat/') || urlStr.includes('get_live_chat');
      const controller = isLiveChat ? undefined : undefined;

      if (!headers['user-agent'] && baseUserAgent) headers['user-agent'] = baseUserAgent;
      if (!headers['referer']) headers['referer'] = baseReferer;
      if (!headers['accept-language']) headers['accept-language'] = 'en-US,en;q=0.9';

      if (process.env.YT_DEBUG === '1') {
        try {
          const keys = Object.keys(headers);
          console.debug('[YouTube Proxy] outgoing innertube headers:', keys.join(', '));
        } catch { }
      }

      const merged = { ...(init || {}), headers };
      try {
        const res = await fetch(input, merged);
        if (res.status >= 400) {
          try {
            const clone = res.clone();
            const txt = await clone.text().catch(() => '<failed to read body>');
            const short = typeof txt === 'string' ? txt.slice(0, 2000) : String(txt);

            if (res.status === 403) {
              last403Time = Date.now();
              console.error('[YouTube Proxy] innertube fetch 403 — invalidating session.', { url: urlStr, body: short.slice(0, 500) });
              invalidateInnertube();
            } else {
              console.error('[YouTube Proxy] innertube fetch non-OK', { url: urlStr, status: res.status, body: short.slice(0, 500) });
            }
          } catch (logErr) {
            console.error('[YouTube Proxy] innertube fetch non-OK (failed to log body)', { url: urlStr, status: res.status, err: String(logErr) });
          }
        }
        return res;
      } catch (err) {
        if (process.env.YT_DEBUG === '1') console.error('[YouTube Proxy] innertube fetch failed', err);
        throw err;
      }
    };

    yt = await Innertube.create(opts);
    return yt;
  } catch (error) {
    yt = null;
    if (error instanceof Error && /status code 403/i.test(error.message)) {
      last403Time = Date.now();
    }
    throw error;
  } finally {
    isInitializing = false;
  }
}