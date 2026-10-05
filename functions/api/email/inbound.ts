import { CloudflareEnv, jsonResponse } from '../../../cloudflare/auth';

interface InboundAttachment { filename: string; contentType: string; contentBase64: string }
interface InboundBody { messageId: string; senderAddress: string; subject: string; receivedAt?: string; attachments: InboundAttachment[] }
interface Context { request: Request; env: CloudflareEnv }

const ALLOWED_TYPES = new Set(['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = 15 * 1024 * 1024;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function equalSecret(expected: string, supplied: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(expected), sha256(supplied)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function allowedSender(sender: string, allowlist: string[]): boolean {
  const normalized = sender.trim().toLocaleLowerCase();
  const domain = normalized.split('@').at(-1) || '';
  return allowlist.some(entry => {
    const rule = entry.toLocaleLowerCase();
    return rule.startsWith('@') ? domain === rule.slice(1) : rule.includes('@') ? normalized === rule : domain === rule;
  });
}

export async function onRequestPost({ request, env }: Context): Promise<Response> {
  const secret = env.EMAIL_INGEST_WEBHOOK_SECRET;
  const allowlist = (env.EMAIL_INGEST_ALLOWED_SENDERS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!secret || !allowlist.length) return jsonResponse({ error: 'اتصال ایمیل تنظیم نشده است.', code: 'email_ingestion_unconfigured', configured: false }, 503);
  const suppliedSecret = request.headers.get('X-Email-Webhook-Secret') || '';
  if (!suppliedSecret || !(await equalSecret(secret, suppliedSecret))) return jsonResponse({ error: 'Webhook authentication failed.', code: 'email_webhook_unauthorized' }, 401);
  if (!request.headers.get('Content-Type')?.toLowerCase().includes('application/json')) return jsonResponse({ error: 'JSON payload required.', code: 'email_payload_invalid' }, 415);
  const raw = await request.text();
  const requestBytes = new TextEncoder().encode(raw).byteLength;
  if (requestBytes > MAX_REQUEST_BYTES) return jsonResponse({ error: 'Email message is too large.', code: 'email_payload_too_large' }, 413);
  let body: InboundBody;
  try { body = JSON.parse(raw) as InboundBody; } catch { return jsonResponse({ error: 'Invalid email payload.', code: 'email_payload_invalid' }, 400); }
  if (!body || typeof body.messageId !== 'string' || body.messageId.length < 1 || body.messageId.length > 300 ||
      typeof body.senderAddress !== 'string' || body.senderAddress.length > 320 || !body.senderAddress.includes('@') ||
      typeof body.subject !== 'string' || body.subject.length > 500 || !Array.isArray(body.attachments) || !body.attachments.length || body.attachments.length > 10) {
    return jsonResponse({ error: 'Email message metadata is invalid.', code: 'email_payload_invalid' }, 400);
  }
  if (!allowedSender(body.senderAddress, allowlist)) return jsonResponse({ error: 'Email sender is not permitted.', code: 'email_sender_not_allowed' }, 403);
  const attachments: Array<{ filename: string; contentType: string; contentBase64: string; byteLength: number }> = [];
  for (const item of body.attachments) {
    if (!item || typeof item.filename !== 'string' || item.filename.length > 255 || typeof item.contentType !== 'string' || !ALLOWED_TYPES.has(item.contentType) || typeof item.contentBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.contentBase64)) {
      return jsonResponse({ error: 'Attachment type or encoding is not permitted.', code: 'email_attachment_not_allowed' }, 400);
    }
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(item.contentBase64), char => char.charCodeAt(0)); } catch { return jsonResponse({ error: 'Attachment encoding is invalid.', code: 'email_attachment_invalid' }, 400); }
    if (!bytes.byteLength || bytes.byteLength > MAX_ATTACHMENT_BYTES) return jsonResponse({ error: 'Attachment size is not permitted.', code: 'email_attachment_too_large' }, 413);
    attachments.push({ filename: item.filename, contentType: item.contentType, contentBase64: item.contentBase64, byteLength: bytes.byteLength });
  }
  const messageKey = await sha256(body.messageId);
  const bodyHash = await sha256(JSON.stringify({ ...body, attachments }));
  const key = `email_ingest:message:${messageKey}`;
  const existing = await env.CHALAK_DB.get(key);
  if (existing) {
    const previous = JSON.parse(existing) as { bodyHash?: string; id?: string; status?: string };
    if (previous.bodyHash !== bodyHash) return jsonResponse({ error: 'This provider message identifier was already used.', code: 'email_message_id_reused' }, 409);
    return jsonResponse({ accepted: true, duplicate: true, status: previous.status || 'quarantined', quarantineId: previous.id }, 200);
  }
  const id = messageKey;
  const record = {
    id,
    bodyHash,
    providerMessageId: body.messageId,
    senderAddress: body.senderAddress.trim().toLocaleLowerCase(),
    subject: body.subject,
    receivedAt: typeof body.receivedAt === 'string' && Number.isFinite(Date.parse(body.receivedAt)) ? body.receivedAt : new Date().toISOString(),
    status: 'quarantined' as const,
    attachments,
    auditReference: `email:${messageKey.slice(0, 16)}`,
  };
  await env.CHALAK_DB.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 90 });
  const indexKey = 'email_ingest:index';
  const currentIndex = await env.CHALAK_DB.get(indexKey);
  const index = currentIndex ? JSON.parse(currentIndex) as Array<Record<string, unknown>> : [];
  await env.CHALAK_DB.put(indexKey, JSON.stringify([{ id, senderAddress: record.senderAddress, subject: record.subject, receivedAt: record.receivedAt, status: record.status, attachmentCount: attachments.length, auditReference: record.auditReference }, ...index.filter(item => item.id !== id)].slice(0, 200)));
  return jsonResponse({ accepted: true, duplicate: false, status: 'quarantined', quarantineId: id }, 202);
}
