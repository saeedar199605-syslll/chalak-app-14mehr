import { AuthSession, CloudflareEnv, jsonResponse, readSession } from '../../cloudflare/auth';

interface Context {
  request: Request;
  env: CloudflareEnv;
  data: Record<string, unknown>;
  next(): Promise<Response>;
}

export async function onRequest(context: Context): Promise<Response> {
  const path = new URL(context.request.url).pathname;
  if (path === '/api/health' || path === '/api/auth/login' || path === '/api/auth/logout') return context.next();
  if (context.request.method === 'OPTIONS') return context.next();

  if (!context.env.CHALAK_DB) return jsonResponse({ error: 'پایگاه داده ابری پیکربندی نشده است.', code: 'storage_not_configured', reason: 'storage_configuration_missing', retryable: false }, 503);
  // Inbound provider requests authenticate with their dedicated webhook secret,
  // never with a browser session cookie.
  if (path === '/api/email/inbound') return context.next();
  let session: AuthSession | null;
  try { session = await readSession(context.request, context.env); }
  catch { return jsonResponse({ error: 'بررسی نشست موقتاً در دسترس نیست.', code: 'session_store_temporarily_unavailable', reason: 'kv_read_failed', retryable: true }, 503); }
  if (!session) return jsonResponse({ error: 'Authentication required.', code: 'authentication_required', reason: 'authentication_required', retryable: false }, 401);
  if (path.startsWith('/api/gemini/')) {
    if (context.request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
    const contentLength = Number(context.request.headers.get('Content-Length') || '0');
    if (contentLength > 64_000) return jsonResponse({ error: 'AI request is too large.' }, 413);
    const windowKey = `rate:ai:${session.id}:${Math.floor(Date.now() / 60_000)}`;
    const currentCount = Number(await context.env.CHALAK_DB.get(windowKey) || '0');
    if (currentCount >= 20) return jsonResponse({ error: 'AI rate limit exceeded. Try again shortly.' }, 429, { 'Retry-After': '60' });
    await context.env.CHALAK_DB.put(windowKey, String(currentCount + 1), { expirationTtl: 120 });
  }
  context.data.session = session;
  return context.next();
}
