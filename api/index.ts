import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Innertube, Parser } from 'youtubei.js';

const DEBUG = process.env.YT_DEBUG === '1';

// ── PoToken ──────────────────────────────────────────────────────────
interface PoTokenData {
  visitorData: string;
  poToken: string;
  generatedAt: number;
  ttlMs: number;
}

const BG_REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
let cachedPoToken: PoTokenData | null = null;
let poTokenPromise: Promise<PoTokenData> | null = null;
const PO_TOKEN_DEFAULT_TTL = 30 * 60 * 1000;

async function generatePoToken(): Promise<PoTokenData> {
  const { BG } = await import('bgutils-js');

  const userAgent = process.env.YT_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  const tempYT = await Innertube.create({
    retrieve_player: false,
    user_agent: userAgent,
    generate_session_locally: true,
  });

  const visitorData = tempYT.session.context.client.visitorData;
  if (!visitorData) throw new Error('[PoToken] No visitorData from session');

  let dom: any;
  try {
    const { JSDOM } = await import('jsdom');
    dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
      url: 'https://www.youtube.com/',
      referrer: 'https://www.youtube.com/',
    });
    const win = dom.window as any;
    Object.assign(globalThis, { window: win, document: win.document, location: win.location, origin: win.origin });
    if (!Reflect.has(globalThis, 'navigator')) {
      Object.defineProperty(globalThis, 'navigator', { value: win.navigator });
    }
  } catch (domErr: any) {
    throw new Error(`[PoToken] JSDOM failed: ${domErr?.message || String(domErr)}`);
  }

  const bgConfig = {
    fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
    globalObj: globalThis,
    identifier: visitorData,
    requestKey: BG_REQUEST_KEY,
  };

  const bgChallenge = await BG.Challenge.create(bgConfig as any);
  if (!bgChallenge) throw new Error('[PoToken] No BotGuard challenge');

  const interpreterJavascript = bgChallenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (interpreterJavascript) {
    new Function(interpreterJavascript)();
  } else {
    throw new Error('[PoToken] No BotGuard interpreter script');
  }

  const result = await BG.PoToken.generate({
    program: bgChallenge.program,
    globalName: bgChallenge.globalName,
    bgConfig: bgConfig as any,
  });

  const poToken = result.poToken;
  if (!poToken) throw new Error('[PoToken] Empty poToken result');

  const ttlMs = result.integrityTokenData?.estimatedTtlSecs != null
    ? Math.max(result.integrityTokenData.estimatedTtlSecs * 1000 * 0.8, 60_000)
    : PO_TOKEN_DEFAULT_TTL;

  if (DEBUG) console.debug('[PoToken] Generated OK');
  return { visitorData, poToken, generatedAt: Date.now(), ttlMs };
}

function getPoToken(): Promise<PoTokenData> {
  if (cachedPoToken && Date.now() < cachedPoToken.generatedAt + cachedPoToken.ttlMs) {
    return Promise.resolve(cachedPoToken);
  }
  if (poTokenPromise) return poTokenPromise;
  poTokenPromise = generatePoToken().then(data => { cachedPoToken = data; poTokenPromise = null; return data; }).catch(err => { poTokenPromise = null; throw err; });
  return poTokenPromise;
}

function invalidatePoToken() { cachedPoToken = null; poTokenPromise = null; }

// ── Innertube singleton ───────────────────────────────────────────────
let ytSingleton: Innertube | null = null;
let isInitializing = false;
let last403Time = 0;
const COOLDOWN_AFTER_403_MS = 30_000;

Parser.setParserErrorHandler(({ error_type }) => {
  if (error_type === 'class_not_found') return;
});

function invalidateInnertube() {
  ytSingleton = null;
  invalidatePoToken();
}

async function getInnertube(): Promise<Innertube> {
  if (ytSingleton) return ytSingleton;

  const timeSince403 = Date.now() - last403Time;
  if (timeSince403 < COOLDOWN_AFTER_403_MS) {
    throw new Error(`[YouTube] Cooldown after 403 — retry in ${Math.ceil((COOLDOWN_AFTER_403_MS - timeSince403) / 1000)}s`);
  }
  if (isInitializing) throw new Error('[YouTube] Init already in progress');
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

    if (process.env.YT_COOKIE) opts.cookie = process.env.YT_COOKIE;

    const envPoToken = process.env.YT_POTOKEN;
    const envVisitorData = process.env.YT_VISITOR_DATA;

    if (envPoToken) opts.po_token = envPoToken;
    if (envVisitorData) opts.visitor_data = envVisitorData;

    const autoPotoken = !envPoToken && !envVisitorData && clientType === 'WEB' && process.env.YT_POTOKEN !== 'off' && process.env.YT_AUTO_POTOKEN !== '0';

    if (autoPotoken) {
      try {
        const tokenData = await getPoToken();
        opts.po_token = tokenData.poToken;
        opts.visitor_data = tokenData.visitorData;
      } catch (poErr: any) {
        const msg = poErr instanceof Error ? poErr.message : String(poErr);
        console.warn('[YouTube] Auto PoToken failed, continuing without:', msg);
      }
    }

    if (DEBUG) {
      console.debug(`[YouTube] Initializing Innertube (${clientType})`, {
        hasPoToken: !!opts.po_token,
        hasCookie: !!opts.cookie,
        hasVisitorData: !!opts.visitor_data,
        autoPotoken,
      });
    }

    const baseUserAgent = opts.user_agent;
    const baseReferer = (process.env.ORIGIN || 'https://www.youtube.com/').replace(/\/?$/, '/');

    opts.fetch = async (input: any, init?: any) => {
      let urlStr = '';
      try {
        if (typeof input === 'string') urlStr = input;
        else if (input && typeof input === 'object' && 'url' in input) urlStr = String(input.url);
        else urlStr = String(input);
      } catch { urlStr = String(input); }

      const headers: Record<string, string> = {};
      const orig = init?.headers;
      if (orig) {
        if (typeof (orig as any).entries === 'function') {
          for (const [k, v] of (orig as any).entries()) { try { headers[k.toLowerCase()] = String(v); } catch {} }
        } else if (typeof (orig as any).forEach === 'function') {
          try { (orig as any).forEach((v: any, k: string) => { try { headers[k.toLowerCase()] = String(v); } catch {} }); } catch {}
        } else if (typeof orig === 'object') {
          for (const k of Object.keys(orig)) { try { headers[k.toLowerCase()] = String((orig as any)[k]); } catch {} }
        }
      }

      if ('x-goog-visitor-id' in headers) {
        if (!headers['x-goog-visitor-id']?.trim()) delete headers['x-goog-visitor-id'];
      }

      if (!headers['user-agent'] && baseUserAgent) headers['user-agent'] = baseUserAgent;
      if (!headers['referer']) headers['referer'] = baseReferer;
      if (!headers['accept-language']) headers['accept-language'] = 'en-US,en;q=0.9';

      if (DEBUG) console.debug('[YouTube] innertube fetch:', urlStr.slice(0, 120));

      const merged = { ...(init || {}), headers };
      try {
        const res = await fetch(input, merged);
        if (res.status >= 400) {
          try {
            const clone = res.clone();
            const txt = await clone.text().catch(() => '');
            if (res.status === 403) {
              last403Time = Date.now();
              console.error('[YouTube] 403 — invalidating session.', { url: urlStr, body: txt.slice(0, 500) });
              invalidateInnertube();
            } else {
              console.error('[YouTube] non-OK', { url: urlStr, status: res.status, body: txt.slice(0, 500) });
            }
          } catch {}
        }
        return res;
      } catch (err) {
        if (DEBUG) console.error('[YouTube] fetch failed', err);
        throw err;
      }
    };

    ytSingleton = await Innertube.create(opts);
    return ytSingleton;
  } catch (error) {
    ytSingleton = null;
    if (error instanceof Error && /status code 403/i.test(error.message)) last403Time = Date.now();
    throw error;
  } finally {
    isInitializing = false;
  }
}

// ── API Handler ───────────────────────────────────────────────────────
export const config = { maxDuration: 300 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Health check
  if (!req.url || req.url === '/api/youtube' || req.url === '/api/youtube/' || req.url?.split('?')[0] === '/api/youtube' || req.url?.split('?')[0] === '/api/youtube/') {
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({ status: 'ok', service: 'mixchat-yt-proxy', timestamp: Date.now() });
    return;
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
    return;
  }

  const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };

  // Auth
  const authToken = process.env.AUTH_TOKEN;
  if (!authToken) {
    console.error('[Auth] AUTH_TOKEN env var is not set — proxy is open!');
  } else {
    const auth = req.headers['authorization'];
    if (!auth) { res.status(401).json({ error: 'Missing Authorization header' }); return; }
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    if (token.length !== authToken.length || token !== authToken) { res.status(401).json({ error: 'Invalid token' }); return; }
  }

  // Parse path
  const originalUrl: string = req.url || '';
  const pathMatch = originalUrl.match(/^\/api\/youtube\/?(.*)/);
  if (!pathMatch || !pathMatch[1]) {
    res.status(400).json({ error: 'Invalid path. Expected /api/youtube/youtubei/v1/...' });
    return;
  }

  const pathAndQuery = pathMatch[1];
  const qIdx = pathAndQuery.indexOf('?');
  const pathSegments = qIdx >= 0 ? pathAndQuery.slice(0, qIdx) : pathAndQuery;
  const queryString = qIdx >= 0 ? pathAndQuery.slice(qIdx + 1) : '';

  // Reject full URLs or garbage paths — only InnerTube API paths are valid
  if (pathSegments.startsWith('http') || pathSegments.includes('://') || pathSegments.includes('@')) {
    res.status(400).json({ error: 'Invalid InnerTube path. Expected youtubei/v1/<endpoint>', received: pathSegments });
    return;
  }

  try {
    let yt;
    try {
      yt = await getInnertube();
    } catch (initErr: any) {
      const msg = initErr?.message || String(initErr);
      console.error('[Proxy] Failed to initialize Innertube:', msg);
      if (msg.includes('Cooldown after 403')) {
        res.setHeader('Retry-After', '30');
        res.status(503).json({ error: 'YouTube temporarily blocked — retry later', retryAfter: 30 });
        return;
      }
      res.status(503).json({ error: 'YouTube service unavailable', details: DEBUG ? msg : undefined });
      return;
    }

    let body: any = undefined;
    if (req.method === 'POST' && req.body) {
      if (typeof req.body === 'object') {
        body = req.body;
      } else if (typeof req.body === 'string') {
        try { body = JSON.parse(req.body); } catch { return await forwardRaw(yt, '/' + pathSegments, req, res, req.body, corsHeaders); }
      }
    }

    // Strip client context from body — actions.execute adds the proxy's
    // own session context (with PoToken, visitor data, etc.). Without
    // this, the forwarded client context overwrites the proxy's context
    // and YouTube returns 400 "invalid argument".
    if (body && typeof body === 'object') {
      delete body.context;
    }

    let apiName = pathSegments.replace(/^youtubei\/v1\//, '');
    if (DEBUG) console.debug(`[Proxy] ${req.method} → ${apiName}`, { hasBody: !!body });

    const params: Record<string, any> = {};
    if (queryString) {
      for (const pair of queryString.split('&')) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx >= 0) params[decodeURIComponent(pair.slice(0, eqIdx))] = decodeURIComponent(pair.slice(eqIdx + 1));
        else if (pair) params[decodeURIComponent(pair)] = '';
      }
    }

    let response;
    try {
      response = await yt.actions.execute(apiName, { ...(body ? { ...body } : {}), ...params, parse: false });
    } catch (execErr: any) {
      const msg = execErr?.message || String(execErr);
      if (/status code 403/i.test(msg)) {
        invalidateInnertube();
        console.error('[Proxy] 403 — retrying with fresh session');
        try {
          yt = await getInnertube();
          response = await yt.actions.execute(apiName, { ...(body ? { ...body } : {}), ...params, parse: false });
        } catch (retryErr: any) {
          const retryMsg = retryErr?.message || String(retryErr);
          res.status(503).json({ error: 'YouTube blocked request after retry', details: DEBUG ? retryMsg : undefined });
          return;
        }
      } else {
        throw execErr;
      }
    }

    const responseData = typeof response === 'string' ? response : JSON.stringify(response);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.status(200).send(responseData);
  } catch (error: any) {
    const msg = error?.message || String(error);
    const stack = error?.stack;
    console.error('[Proxy] Unhandled error:', { message: msg, stack });
    res.status(500).json({ error: 'Internal proxy error', details: DEBUG ? msg : undefined });
  }
}

async function forwardRaw(yt: any, innerTubePath: string, req: VercelRequest, res: VercelResponse, rawBody: string, corsHeaders: Record<string, string>): Promise<void> {
  const targetURL = `https://www.youtube.com${innerTubePath}`;
  const headers: Record<string, string> = {
    'Content-Type': req.headers['content-type'] as string || 'application/x-protobuf',
    'User-Agent': process.env.YT_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://www.youtube.com/',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const session = yt.session;
  if (session?.context?.client) {
    const client = session.context.client;
    headers['x-youtube-client-name'] = String(client.clientName ?? '1');
    headers['x-youtube-client-version'] = client.clientVersion ?? '2.20240510.00.00';
    if (client.visitorData) headers['x-goog-visitor-id'] = client.visitorData;
  }
  if (yt.session?.api_key) headers['x-youtube-api-key'] = yt.session.api_key;

  const ytRes = await fetch(targetURL, { method: 'POST', headers, body: rawBody });
  const respBody = await ytRes.text();
  res.setHeader('Content-Type', ytRes.headers.get('content-type') || 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v);
  res.status(ytRes.status).send(respBody);
}