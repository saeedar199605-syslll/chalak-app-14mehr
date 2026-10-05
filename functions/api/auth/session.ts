import { AuthSession, CloudflareEnv, jsonResponse, normalizeUsername } from '../../../cloudflare/auth';

interface Context { data: { session?: AuthSession }; env: CloudflareEnv }

export async function onRequestGet({ data, env }: Context): Promise<Response> {
  const session = data.session;
  if (!session) return jsonResponse({ session: null }, 401);
  if (session.username === 'admin') {
    return jsonResponse({
      session,
      user: { id: session.id, name: session.name, username: 'admin', code: 'ADMIN-001', role: 'admin', profileId: 'prof-3', unit: 'دفتر مرکزی' },
    });
  }
  let rawState: string | null;
  try { rawState = await env.CHALAK_DB.get('app_state'); }
  catch { return jsonResponse({ error: 'بازیابی هویت کاربر موقتاً در دسترس نیست.', code: 'session_identity_temporarily_unavailable', reason: 'kv_read_failed', retryable: true }, 503); }
  try {
    const state = rawState ? JSON.parse(rawState) as Record<string, unknown> : {};
    const employees = Array.isArray(state.pe_employees) ? state.pe_employees as Array<Record<string, unknown>> : [];
    const user = employees.find(item => String(item.id) === session.id && normalizeUsername(item.username) === session.username);
    if (!user) return jsonResponse({ error: 'حساب کاربری دیگر در سامانه فعال نیست.' }, 401);
    return jsonResponse({ session, user });
  } catch {
    return jsonResponse({ error: 'اطلاعات هویت ذخیره‌شده معتبر نیست.', code: 'session_identity_invalid', reason: 'invalid_stored_identity', retryable: false }, 500);
  }
}
