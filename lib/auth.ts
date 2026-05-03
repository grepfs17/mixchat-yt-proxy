import { createHash } from 'node:crypto';

const AUTH_TOKEN = process.env.AUTH_TOKEN;

export function validateAuthToken(req: Request): Response | null {
  if (!AUTH_TOKEN) {
    console.error('[Auth] AUTH_TOKEN env var is not set — proxy is open!');
    return null;
  }

  const auth = req.headers.get('authorization');
  if (!auth) {
    return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;

  const expected = AUTH_TOKEN;
  const provided = token;

  if (provided.length !== expected.length) {
    return new Response(JSON.stringify({ error: 'Invalid token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const expectedHash = createHash('sha256').update(expected).digest();
  const providedHash = createHash('sha256').update(provided).digest();

  let mismatch = 0;
  for (let i = 0; i < expectedHash.length; i++) {
    mismatch |= expectedHash[i] ^ providedHash[i];
  }

  if (mismatch !== 0) {
    return new Response(JSON.stringify({ error: 'Invalid token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
}