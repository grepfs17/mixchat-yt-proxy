# MixChat YouTube Proxy

A Vercel serverless function that proxies YouTube InnerTube API requests. MixChat uses this to route all YouTube API traffic through a separate domain, avoiding IP blocks from YouTube on the main app server.

## How it works

MixChat sends InnerTube API requests here. The proxy adds its own session context (API key, visitor data, client headers) and forwards the request to YouTube. The raw response is sent back unchanged.

This way MixChat's server IP never talks to YouTube directly -- only Vercel's IPs do.

## Endpoints

**`GET /api/youtube`** -- Health check, returns `{ status: "ok" }`

**`POST /api/youtube/youtubei/v1/<endpoint>`** -- Proxies the request to YouTube

All requests (including health check) require an `Authorization: Bearer <token>` header matching the `AUTH_TOKEN` env var.

Example:
```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"videoId":"dQw4w9WgXcQ","context":{...}}' \
  "https://your-proxy.vercel.app/api/youtube/youtubei/v1/player?prettyPrint=false"
```

The `context` in the body is merged with the proxy's session context (preserving client-specific fields), so the client's `context.client.clientName` and similar fields are kept.

## Setup

1. Deploy to Vercel: `vercel deploy --prod`
2. Set environment variables in Vercel dashboard (or `.env` for local dev)
3. In MixChat, set `YT_PROXY` to your deployed URL and `YT_PROXY_TOKEN` to the auth token

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AUTH_TOKEN` | Yes | -- | Shared secret for Bearer auth. Constant-time comparison prevents timing attacks. |
| `CORS_ORIGIN` | No | -- | Allowed origin for CORS. Set to your MixChat URL. If empty, browser requests are blocked. |
| `YT_CLIENT` | No | `WEB` | InnerTube client type. Must match MixChat's `YT_CLIENT` for compatible response formats. |
| `YT_DEBUG` | No | `0` | Set to `1` for verbose logging |
| `YT_USER_AGENT` | No | Chrome 124 | Custom User-Agent string |
| `YT_COOKIE` | No | -- | Browser cookie string for authenticated access |
| `YT_POTOKEN` | No | -- | Manual PoToken override |
| `YT_VISITOR_DATA` | No | -- | Manual visitor data override |
| `YT_AUTO_POTOKEN` | No | `0` | Set to `1` to auto-generate PoToken. Requires JSDOM, which does not work on Vercel. Only use on a VPS or Docker. |
| `YT_GENERATE_SESSION_LOCALLY` | No | `true` | Set to `false` to fetch session from YouTube instead of generating locally |
| `ORIGIN` | No | `https://www.youtube.com/` | Origin URL for Referer header |

## Local development

```bash
npm install
cp .env.example .env
# Edit .env with your AUTH_TOKEN
vercel dev
```

## Architecture

- `api/index.ts` -- Single serverless function handling all requests. Vercel rewrites `/api/youtube/*` to this file.
- `vercel.json` -- Routes and function config (300s timeout for long-polling chat requests)
- No separate lib files -- everything is in one file to avoid Vercel's ESM module resolution issues

## 403 handling

When YouTube returns a 403, the proxy invalidates its Innertube session so the next request creates a fresh one. There is a 30 second cooldown after each 403 to avoid hammering YouTube.

## Security

- **Auth**: All requests require a Bearer token. Token comparison uses `crypto.timingSafeEqual` to prevent timing attacks.
- **CORS**: `Access-Control-Allow-Origin` is set to `CORS_ORIGIN`. If not configured, CORS headers are empty and browser requests are blocked. Server-to-server requests (from MixChat) work regardless since they don't enforce CORS.
- **Rate limiting**: 120 requests per minute per IP. Exceeded requests get a 429 with a `Retry-After` header.
- **Health check**: Requires auth. Does not leak service info to unauthenticated requests.