import { CloudflareEnv, jsonResponse } from '../../../cloudflare/auth';

interface Context { env: CloudflareEnv; data: { session?: { role: string } } }

export function onRequestGet({ env, data }: Context): Response {
  if (!data.session) return jsonResponse({ error: 'Authentication required.', code: 'authentication_required' }, 401);
  const allowedSenders = (env.EMAIL_INGEST_ALLOWED_SENDERS || '').split(',').map(value => value.trim()).filter(Boolean);
  const configured = Boolean(env.EMAIL_INGEST_WEBHOOK_SECRET && allowedSenders.length);
  return jsonResponse({
    configured,
    providerNeutral: true,
    sourceDescription: configured ? 'ورودی ایمیل سازمانی به صف بررسی امن وصل است.' : null,
    allowedSenderCount: configured ? allowedSenders.length : 0,
    requiresManualApproval: true,
  });
}
