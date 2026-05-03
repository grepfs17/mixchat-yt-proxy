# MixChat YouTube Proxy

## What this project does

Proxies YouTube InnerTube API requests through a Vercel serverless function so that MixChat's main server IP never talks to YouTube directly. This avoids IP blocks from YouTube.

## Tech stack

- Vercel serverless functions (Node.js)
- youtubei.js for InnerTube session management
- TypeScript

## Key files

- `api/index.ts` -- All logic in one file (single function handler). Includes Innertube session init, auth, request forwarding, and 403 retry with cooldown.
- `vercel.json` -- Route rewrites and 300s maxDuration for long-polling chat requests.
- `.env.example` -- All env vars documented.

## How requests flow

1. MixChat's InnerTube session has a custom `fetch` that intercepts `/youtubei/v1/*` requests
2. Those get forwarded to `https://proxy.vercel.app/api/youtube/youtubei/v1/<endpoint>`
3. The proxy validates the Bearer auth token
4. The proxy merges the `context` in the request body — the client's `context` is preserved and the proxy's session context is merged on top, keeping client-specific fields that affect response format.
5. The proxy forwards the request to `https://www.youtube.com/youtubei/v1/<endpoint>`
6. The raw response is returned to MixChat unchanged

## Important constraints

- Vercel serverless functions have a 300s timeout (set in vercel.json). Live chat long-polling relies on this.
- Vercel free tier has 100k requests/month.
- JSDOM (needed for PoToken generation) does not work on Vercel. Use `YT_CLIENT=TV` which does not need PoToken, or deploy on a VPS with `YT_AUTO_POTOKEN=1`.
- All code is in `api/index.ts` to avoid Vercel ESM module resolution issues with separate files.

## Commands

- `npm run dev` -- Start local dev server (vercel dev)
- `npm run type-check` -- TypeScript check
- `vercel deploy --prod` -- Deploy to production

## Environment variables

See `.env.example` for full documentation. Key ones:

- `AUTH_TOKEN` -- Required. Bearer token for auth.
- `YT_CLIENT` -- Default `WEB`. Client type for InnerTube. Both proxy and MixChat should use the same client type for compatible response formats.
- `YT_DEBUG` -- Set to `1` for verbose logs.

## 403 handling

YouTube 403 responses invalidate the Innertube session. A 30 second cooldown prevents retry storms. MixChat's side also has its own cooldown in `src/lib/youtube.ts`.