import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getInnertube, invalidateInnertube } from '../lib/innertube';

const DEBUG = process.env.YT_DEBUG === '1';

export const config = {
  maxDuration: 300,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

  // Validate auth token from Authorization header
  const authToken = process.env.AUTH_TOKEN;
  if (!authToken) {
    console.error('[Auth] AUTH_TOKEN env var is not set — proxy is open!');
  } else {
    const auth = req.headers['authorization'];
    if (!auth) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    if (token.length !== authToken.length || token !== authToken) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
  }

  // The catch-all route captures everything after /api/
  // e.g. /api/youtube/youtubei/v1/player → /youtube/youtubei/v1/player
  // We only handle paths starting with /youtube/
  const fullPath = (req.url || '').replace(/\?.*$/, '');
  if (!fullPath.startsWith('/api/youtube/')) {
    res.status(404).json({ error: 'Not found. Use /api/youtube/youtubei/v1/...' });
    return;
  }

  const pathSegments = fullPath.replace(/^\/api\/youtube\/?/, '');
  const innerTubePath = '/' + pathSegments;

  if (!pathSegments) {
    res.status(400).json({ error: 'Missing InnerTube path' });
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

    // Parse request body
    let body: any = undefined;
    if (req.method === 'POST' && req.body) {
      if (typeof req.body === 'object') {
        body = req.body;
      } else if (typeof req.body === 'string') {
        try {
          body = JSON.parse(req.body);
        } catch {
          return await forwardRaw(yt, innerTubePath, req, res, req.body, corsHeaders);
        }
      }
    }

    let apiName = innerTubePath.replace(/^\//, '');
    if (apiName.startsWith('youtubei/v1/')) {
      apiName = apiName.slice('youtubei/v1/'.length);
    }

    if (DEBUG) {
      console.debug(`[Proxy] ${req.method} → InnerTube API: ${apiName}`, { hasBody: !!body });
    }

    // Merge query params from the original request URL
    const params: Record<string, any> = {};
    const queryString = (req.url || '').split('?')[1];
    if (queryString) {
      for (const pair of queryString.split('&')) {
        const [key, value] = pair.split('=');
        if (key) params[decodeURIComponent(key)] = decodeURIComponent(value || '');
      }
    }

    let response;
    try {
      response = await yt.actions.execute(apiName, {
        ...(body ? { ...body } : {}),
        ...params,
        parse: false,
      });
    } catch (execErr: any) {
      const msg = execErr?.message || String(execErr);

      if (/status code 403/i.test(msg)) {
        invalidateInnertube();
        console.error('[Proxy] InnerTube 403 — invalidated session for retry');

        try {
          yt = await getInnertube();
          response = await yt.actions.execute(apiName, {
            ...(body ? { ...body } : {}),
            ...params,
            parse: false,
          });
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

async function forwardRaw(
  yt: any,
  innerTubePath: string,
  req: VercelRequest,
  res: VercelResponse,
  rawBody: string,
  corsHeaders: Record<string, string>,
): Promise<void> {
  const baseURL = 'https://www.youtube.com';
  const targetURL = `${baseURL}${innerTubePath}`;

  const headers: Record<string, string> = {
    'Content-Type': req.headers['content-type'] || 'application/x-protobuf',
    'User-Agent': process.env.YT_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://www.youtube.com/',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  const session = yt.session;
  if (session?.context?.client) {
    const client = session.context.client;
    headers['x-youtube-client-name'] = String(client.clientName ?? '1');
    headers['x-youtube-client-version'] = client.clientVersion ?? '2.20240510.00.00';
    if (client.visitorData) {
      headers['x-goog-visitor-id'] = client.visitorData;
    }
  }

  if (yt.session?.api_key) {
    headers['x-youtube-api-key'] = yt.session.api_key;
  }

  const ytRes = await fetch(targetURL, {
    method: 'POST',
    headers,
    body: rawBody,
  });

  const respBody = await ytRes.text();

  res.setHeader('Content-Type', ytRes.headers.get('content-type') || 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  for (const [k, v] of Object.entries(corsHeaders)) {
    res.setHeader(k, v);
  }
  res.status(ytRes.status).send(respBody);
}