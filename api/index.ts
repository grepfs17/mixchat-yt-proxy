import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Innertube, Parser } from 'youtubei.js';

const DEBUG = process.env.YT_DEBUG === '1';

// ── Innertube session for session context (api key, visitor data, etc.) ──
let ytSingleton: Innertube | null = null;
let isInitializing = false;
let last403Time = 0;
const COOLDOWN_AFTER_403_MS = 30_000;

Parser.setParserErrorHandler(({ error_type }) => {
  if (error_type === 'class_not_found') return;
});

function invalidateInnertube() { ytSingleton = null; }

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

    // Auto PoToken disabled by default on Vercel (JSDOM not available)
    // Set YT_AUTO_POTOKEN=1 only on VPS/Docker with JSDOM support
    const autoPotoken = !envPoToken && !envVisitorData && clientType === 'WEB' && process.env.YT_POTOKEN !== 'off' && process.env.YT_AUTO_POTOKEN === '1';
    if (autoPotoken) {
      try {
        const { BG } = await import('bgutils-js');
        const { JSDOM } = await import('jsdom');
        const tempYT = await Innertube.create({ retrieve_player: false, user_agent: opts.user_agent, generate_session_locally: true });
        const visitorData = tempYT.session.context.client.visitorData;
        if (!visitorData) throw new Error('No visitorData');
        const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { url: 'https://www.youtube.com/', referrer: 'https://www.youtube.com/' });
        const win = dom.window as any;
        Object.assign(globalThis, { window: win, document: win.document, location: win.location, origin: win.origin });
        if (!Reflect.has(globalThis, 'navigator')) Object.defineProperty(globalThis, 'navigator', { value: win.navigator });
        const bgConfig = { fetch: (input: any, init?: any) => fetch(input, init), globalObj: globalThis, identifier: visitorData, requestKey: 'O43z0dpjhgX20SCx4KAo' };
        const bgChallenge = await BG.Challenge.create(bgConfig as any);
        if (!bgChallenge) throw new Error('No BotGuard challenge');
        const interpJs = bgChallenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
        if (interpJs) new Function(interpJs)(); else throw new Error('No interpreter script');
        const poResult = await BG.PoToken.generate({ program: bgChallenge.program, globalName: bgChallenge.globalName, bgConfig: bgConfig as any });
        if (!poResult.poToken) throw new Error('Empty poToken');
        opts.po_token = poResult.poToken;
        opts.visitor_data = visitorData;
        if (DEBUG) console.debug('[YouTube] PoToken generated');
      } catch (poErr: any) {
        console.warn('[YouTube] PoToken failed:', poErr?.message || String(poErr));
      }
    }

    if (DEBUG) console.debug(`[YouTube] Initializing Innertube (${clientType})`, { hasPoToken: !!opts.po_token, hasCookie: !!opts.cookie, hasVisitorData: !!opts.visitor_data });

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

// ── API Handler (transparent proxy) ──────────────────────────────────
export const config = { maxDuration: 300 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Health check
  if (!req.url || req.url === '/api/youtube' || req.url === '/api/youtube/' || req.url?.split('?')[0] === '/api/youtube' || req.url?.split('?')[0] === '/api/youtube/') {
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({ status: 'ok', service: 'mixchat-yt-proxy' });
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

  // Auth
  const authToken = process.env.AUTH_TOKEN;
  if (authToken) {
    const auth = req.headers['authorization'];
    if (!auth) { res.status(401).json({ error: 'Missing Authorization header' }); return; }
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    if (token !== authToken) { res.status(401).json({ error: 'Invalid token' }); return; }
  } else {
    console.warn('[Auth] AUTH_TOKEN not set — proxy is open!');
  }

  // Parse YouTube InnerTube path
  const originalUrl: string = req.url || '';
  const pathMatch = originalUrl.match(/^\/api\/youtube\/?(.*)/);
  if (!pathMatch || !pathMatch[1]) {
    res.status(400).json({ error: 'Invalid path. Expected /api/youtube/youtubei/v1/...' });
    return;
  }

  const innerTubePath = '/' + pathMatch[1].replace(/\?.*$/, '');
  const queryString = pathMatch[1].includes('?') ? pathMatch[1].split('?').slice(1).join('?') : '';

  // Reject garbage paths
  if (innerTubePath.includes('://') || innerTubePath.includes('@')) {
    res.status(400).json({ error: 'Invalid InnerTube path', path: innerTubePath });
    return;
  }

  // Get Innertube session for context headers
  let yt;
  try {
    yt = await getInnertube();
  } catch (initErr: any) {
    const msg = initErr?.message || String(initErr);
    console.error('[Proxy] Innertube init failed:', msg);
    if (msg.includes('Cooldown after 403')) {
      res.setHeader('Retry-After', '30');
      res.status(503).json({ error: 'YouTube temporarily blocked', retryAfter: 30 });
      return;
    }
    res.status(503).json({ error: 'YouTube service unavailable', details: DEBUG ? msg : undefined });
    return;
  }

  // Build forwarding headers from the Innertube session
  const session = yt.session;
  const client = session?.context?.client;
  const apiKey = session?.api_key || (session as any)?.apiKey;
  const visitorData = client?.visitorData;

  const targetURL = `https://www.youtube.com${innerTubePath}`;

  const forwardHeaders: Record<string, string> = {
    'Content-Type': req.headers['content-type'] as string || 'application/json',
    'User-Agent': process.env.YT_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://www.youtube.com/',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://www.youtube.com',
  };

  if (apiKey) forwardHeaders['x-youtube-api-key'] = apiKey;
  if (client?.clientName) forwardHeaders['x-youtube-client-name'] = String(client.clientName);
  if (client?.clientVersion) forwardHeaders['x-youtube-client-version'] = client.clientVersion;
  if (visitorData) forwardHeaders['x-goog-visitor-id'] = visitorData;
  if (process.env.YT_COOKIE) forwardHeaders['Cookie'] = process.env.YT_COOKIE;

  // Inject session context into request body for POST requests
  let requestBody: string | undefined;
  if (req.method === 'POST' && req.body) {
    let bodyObj: any;
    if (typeof req.body === 'object') {
      bodyObj = { ...req.body };
    } else if (typeof req.body === 'string') {
      try { bodyObj = JSON.parse(req.body); } catch {
        // Non-JSON body — forward as-is
        requestBody = req.body;
      }
    }

    if (bodyObj) {
      // Merge proxy session context into the client's context, preserving
      // client-specific fields (like clientName) that affect response format.
      // This ensures youtubei.js on the MixChat side can parse the response
      // with its own client type while the proxy's session provides auth.
      if (session?.context) {
        bodyObj.context = {
          ...(bodyObj.context || {}),
          ...session.context,
          client: {
            ...(bodyObj.context?.client || {}),
            ...session.context.client,
          },
        };
      }
      requestBody = JSON.stringify(bodyObj);
    }
  }

  // Append query string
  const finalURL = queryString ? `${targetURL}?${queryString}` : targetURL;

  if (DEBUG) {
    console.debug(`[Proxy] ${req.method} → ${targetURL}`, { hasBody: !!requestBody, apiKey: !!apiKey, visitorData: !!visitorData, clientName: client?.clientName });
  }

  try {
    const ytRes = await fetch(finalURL, {
      method: req.method || (requestBody ? 'POST' : 'GET'),
      headers: forwardHeaders,
      body: requestBody,
    });

    if (DEBUG) console.debug(`[Proxy] ← ${ytRes.status} ${ytRes.statusText}`);

    // On 403, invalidate the Innertube session for retry
    if (ytRes.status === 403) {
      invalidateInnertube();
      console.error('[Proxy] YouTube returned 403 — invalidated session');
    }

    const respBody = await ytRes.text();

    res.setHeader('Content-Type', ytRes.headers.get('content-type') || 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.status(ytRes.status).send(respBody);
  } catch (error: any) {
    const msg = error?.message || String(error);
    console.error('[Proxy] Request failed:', msg);
    res.status(502).json({ error: 'Proxy request failed', details: DEBUG ? msg : undefined });
  }
}