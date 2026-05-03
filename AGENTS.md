# MixChat YouTube Proxy

## What this project does

Proxies YouTube InnerTube API requests through a Vercel serverless function so that MixChat's main server IP never talks to YouTube directly. This avoids IP blocks from YouTube.

## Tech stack

- Vercel serverless functions (Node.js)
- youtubei.js for InnerTube session management
- TypeScript

## Key files

- `api/index.ts` -- All logic in one file (single function handler). Includes Innertube session init, auth, rate limiting, request forwarding, and 403 retry with cooldown.
- `vercel.json` -- Route rewrites and 300s maxDuration for long-polling chat requests.
- `.env.example` -- All env vars documented.

## How requests flow

1. MixChat's InnerTube session has a custom `fetch` that intercepts `/youtubei/v1/*` requests
2. Those get forwarded to the proxy at `/api/youtube/youtubei/v1/<endpoint>`
3. The proxy validates the Bearer auth token (constant-time comparison)
4. The proxy checks rate limits (120 req/min per IP)
5. The proxy merges the `context` in the request body -- the client's `context` is preserved and the proxy's session context is merged on top, keeping client-specific fields that affect response format
6. The proxy forwards the request to `https://www.youtube.com/youtubei/v1/<endpoint>`
7. The raw response is returned to MixChat unchanged

## Security

- **Auth**: All requests (including health check) require a Bearer token. Token comparison uses `crypto.timingSafeEqual` to prevent timing attacks.
- **CORS**: `Access-Control-Allow-Origin` is set to `CORS_ORIGIN`. If not configured, CORS headers are empty and browser requests are blocked. Server-to-server requests from MixChat work regardless.
- **Rate limiting**: 120 requests per minute per IP. Exceeded requests get a 429 with `Retry-After: 60`. In-memory with 5-minute cleanup.
- **Health check**: Requires auth. Does not leak service info to unauthenticated requests.

## Important constraints

- Vercel serverless functions have a 300s timeout (set in vercel.json). Live chat long-polling relies on this.
- Vercel free tier has 100k requests/month.
- JSDOM (needed for PoToken generation) does not work on Vercel. Use `YT_AUTO_POTOKEN=1` only on a VPS or Docker with JSDOM support.
- All code is in `api/index.ts` to avoid Vercel's ESM module resolution issues with separate files.
- Both proxy and MixChat should use the same `YT_CLIENT` (default `WEB`) for compatible response formats.

## Commands

- `npm run dev` -- Start local dev server (vercel dev)
- `npm run type-check` -- TypeScript check
- `vercel deploy --prod` -- Deploy to production

## Environment variables

See `.env.example` for full documentation. Key ones:

- `AUTH_TOKEN` -- Required. Bearer token for auth. Constant-time comparison prevents timing attacks.
- `CORS_ORIGIN` -- Required. Your MixChat URL for CORS. If empty, browser requests are blocked.
- `YT_CLIENT` -- Default `WEB`. Client type for InnerTube. Must match MixChat's setting.
- `YT_DEBUG` -- Set to `1` for verbose logs.

## 403 handling

YouTube 403 responses invalidate the Innertube session. A 30 second cooldown prevents retry storms. MixChat's side also has its own cooldown in `src/lib/youtube.ts`.