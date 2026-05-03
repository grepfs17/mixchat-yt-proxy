import { getInnertube, invalidateInnertube } from '../../lib/innertube';
import { validateAuthToken } from '../../lib/auth';

const DEBUG = process.env.YT_DEBUG === '1';

export const config = {
  maxDuration: 300,
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  };

  const authError = validateAuthToken(req);
  if (authError) return authError;

  const url = new URL(req.url);
  // The catch-all [...path] captures everything after /api/youtube/
  // e.g. /api/youtube/youtubei/v1/live_chat/get_live_chat → youtubei/v1/live_chat/get_live_chat
  const pathSegments = url.pathname.replace(/^\/api\/youtube\/?/, '');
  const innerTubePath = '/' + pathSegments;

  if (!innerTubePath || innerTubePath === '/') {
    return new Response(JSON.stringify({ error: 'Missing InnerTube path' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  try {
    let yt;
    try {
      yt = await getInnertube();
    } catch (initErr) {
      const msg = initErr instanceof Error ? initErr.message : String(initErr);
      console.error('[Proxy] Failed to initialize Innertube:', msg);

      // If it was a 403 cooldown, return 503 so the client knows to retry
      if (msg.includes('Cooldown after 403')) {
        return new Response(JSON.stringify({ error: 'YouTube temporarily blocked — retry later', retryAfter: 30 }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '30', ...corsHeaders },
        });
      }

      return new Response(JSON.stringify({ error: 'YouTube service unavailable', details: DEBUG ? msg : undefined }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Read the request body (POST) or query params (GET)
    let body: any = undefined;
    if (req.method === 'POST') {
      const contentType = req.headers.get('content-type') || '';
      if (contentType.includes('application/json') || contentType.includes('text/plain') || contentType.includes('application/x-protobuf') || contentType.includes('application/x-www-form-urlencoded')) {
        const rawBody = await req.text();
        if (rawBody) {
          try {
            body = JSON.parse(rawBody);
          } catch {
            // Not JSON — pass through as-is for protobuf etc.
            // For protobuf, we need to forward raw bytes via actions.execute
            // which only supports JSON payloads. Fall back to raw fetch.
            return forwardRaw(yt, innerTubePath, req, rawBody, corsHeaders);
          }
        }
      }
    }

    // Build the InnerTube API endpoint from the path.
    // Strip leading slash and the "youtubei/v1/" prefix if present, since
    // actions.execute expects just the API name (e.g. "live_chat/get_live_chat").
    let apiName = innerTubePath.replace(/^\//, '');
    if (apiName.startsWith('youtubei/v1/')) {
      apiName = apiName.slice('youtubei/v1/'.length);
    }

    if (DEBUG) {
      console.debug(`[Proxy] ${req.method} → InnerTube API: ${apiName}`, { hasBody: !!body });
    }

    // Merge query params from the original request
    const params: Record<string, any> = {};
    for (const [key, value] of url.searchParams.entries()) {
      params[key] = value;
    }

    // Use actions.execute for JSON payloads
    let response;
    try {
      response = await yt.actions.execute(apiName, {
        ...(body ? { ...body } : {}),
        ...params,
        parse: false,
      });
    } catch (execErr) {
      const msg = execErr instanceof Error ? execErr.message : String(execErr);

      if (/status code 403/i.test(msg)) {
        invalidateInnertube();
        console.error('[Proxy] InnerTube 403 — invalidated session for retry');

        // Retry once with a fresh session
        try {
          yt = await getInnertube();
          response = await yt.actions.execute(apiName, {
            ...(body ? { ...body } : {}),
            ...params,
            parse: false,
          });
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          return new Response(JSON.stringify({ error: 'YouTube blocked request after retry', details: DEBUG ? retryMsg : undefined }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      } else {
        throw execErr;
      }
    }

    // response from actions.execute({ parse: false }) is the raw JSON
    const responseData = typeof response === 'string' ? response : JSON.stringify(response);

    return new Response(responseData, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        ...corsHeaders,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error('[Proxy] Unhandled error:', { message: msg, stack });

    return new Response(JSON.stringify({ error: 'Internal proxy error', details: DEBUG ? msg : undefined }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}

/**
 * For non-JSON request bodies (protobuf, etc.), forward the raw request
 * directly to YouTube using the Innertube session's context.
 */
async function forwardRaw(
  yt: any,
  innerTubePath: string,
  req: Request,
  rawBody: string,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const baseURL = 'https://www.youtube.com';
  const targetURL = `${baseURL}${innerTubePath}`;

  const headers: Record<string, string> = {
    'Content-Type': req.headers.get('content-type') || 'application/x-protobuf',
    'User-Agent': process.env.YT_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://www.youtube.com/',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  // Copy the InnerTube context headers from the session
  const session = yt.session;
  if (session?.context?.client) {
    const client = session.context.client;
    headers['x-youtube-client-name'] = String(client.clientName ?? '1');
    headers['x-youtube-client-version'] = client.clientVersion ?? '2.20240510.00.00';
    if (client.visitorData) {
      headers['x-goog-visitor-id'] = client.visitorData;
    }
  }

  const sessionHeaders = yt.session?.api_key ? { 'x-youtube-api-key': yt.session.api_key } : {};

  const ytRes = await fetch(targetURL, {
    method: 'POST',
    headers: { ...headers, ...sessionHeaders },
    body: rawBody,
  });

  const respBody = await ytRes.text();

  return new Response(respBody, {
    status: ytRes.status,
    headers: {
      'Content-Type': ytRes.headers.get('content-type') || 'application/json',
      'Cache-Control': 'no-cache',
      ...corsHeaders,
    },
  });
}