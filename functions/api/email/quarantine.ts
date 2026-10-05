import { AuthSession, CloudflareEnv, jsonResponse } from '../../../cloudflare/auth';

interface Context { request: Request; env: CloudflareEnv; data: { session?: AuthSession } }
interface EmailQueueItem { id: string; status: 'quarantined' | 'previewed' | 'approved' | 'rejected'; auditReference: string; [key: string]: unknown }

export async function onRequestGet({ request, env, data }: Context): Promise<Response> {
  if (!data.session) return jsonResponse({ error: 'Authentication required.' }, 401);
  if (data.session.role !== 'admin') return jsonResponse({ error: 'Admin access required.' }, 403);
  const id = new URL(request.url).searchParams.get('id');
  if (id) {
    if (!/^[a-f0-9]{64}$/i.test(id)) return jsonResponse({ error: 'Invalid quarantine id.' }, 400);
    const raw = await env.CHALAK_DB.get(`email_ingest:message:${id}`);
    if (!raw) return jsonResponse({ error: 'Email item not found.' }, 404);
    return jsonResponse({ item: JSON.parse(raw) });
  }
  const raw = await env.CHALAK_DB.get('email_ingest:index');
  const items = raw ? JSON.parse(raw) as EmailQueueItem[] : [];
  return jsonResponse({ items: items.map(({ id: itemId, senderAddress, subject, receivedAt, status, attachmentCount, auditReference }) => ({ id: itemId, senderAddress, subject, receivedAt, status, attachmentCount, auditReference })) });
}

export async function onRequestPost({ request, env, data }: Context): Promise<Response> {
  if (!data.session) return jsonResponse({ error: 'Authentication required.' }, 401);
  if (data.session.role !== 'admin') return jsonResponse({ error: 'Admin access required.' }, 403);
  let body: { id?: unknown; action?: unknown; operationId?: unknown };
  try { body = await request.json() as typeof body; } catch { return jsonResponse({ error: 'Invalid request.' }, 400); }
  if (typeof body.id !== 'string' || !/^[a-f0-9]{64}$/i.test(body.id) || !['previewed', 'approved', 'rejected'].includes(String(body.action))) return jsonResponse({ error: 'Invalid quarantine action.' }, 400);
  if (body.action === 'approved' && (typeof body.operationId !== 'string' || !/^[a-zA-Z0-9:_-]{8,100}$/.test(body.operationId))) return jsonResponse({ error: 'An import operation reference is required for approval.' }, 400);
  const key = `email_ingest:message:${body.id}`;
  const raw = await env.CHALAK_DB.get(key);
  if (!raw) return jsonResponse({ error: 'Email item not found.' }, 404);
  const item = JSON.parse(raw) as EmailQueueItem;
  if (item.status !== 'quarantined' && !(item.status === 'previewed' && (body.action === 'approved' || body.action === 'rejected'))) return jsonResponse({ error: 'Email item is no longer awaiting review.' }, 409);
  if (body.action === 'previewed' && item.status !== 'quarantined') return jsonResponse({ error: 'Email item has already been reviewed.' }, 409);
  if (body.action === 'approved' && item.status !== 'previewed') return jsonResponse({ error: 'Preview the quarantined attachment before approval.' }, 409);
  let importType: string | undefined;
  if (body.action === 'approved') {
    const stateRaw = await env.CHALAK_DB.get('app_state');
    if (!stateRaw) return jsonResponse({ error: 'A persisted MIS/Kasra import receipt is required.' }, 409);
    let state: Record<string, unknown>;
    try { state = JSON.parse(stateRaw) as Record<string, unknown>; } catch { return jsonResponse({ error: 'The import receipt could not be verified.' }, 503); }
    const receipt = (Array.isArray(state.__operation_receipts) ? state.__operation_receipts : []) as Array<Record<string, unknown>>;
    const acceptedReceipt = receipt.find(entry => entry.operationId === body.operationId && entry.actorId === data.session!.id);
    const auditLogs = Array.isArray(state.pe_audit_logs) ? state.pe_audit_logs as Array<Record<string, unknown>> : [];
    const importAudit = auditLogs.find(entry => entry.id === `audit:source_import:${body.operationId}` && entry.actorId === data.session!.id && entry.result === 'accepted' && (entry.importType === 'MIS' || entry.importType === 'KASRA'));
    if (!acceptedReceipt || !importAudit) return jsonResponse({ error: 'The operation is not a persisted MIS/Kasra import accepted by this administrator.' }, 409);
    importType = String(importAudit.importType);
  }
  const now = new Date().toISOString();
  const next = { ...item, status: body.action, ...(body.action === 'approved' ? { approvedBy: data.session.username, approvedAt: now, operationId: body.operationId, importType } : {}), ...(body.action === 'rejected' ? { rejectedBy: data.session.username, rejectedAt: now } : {}), ...(body.action === 'previewed' ? { previewedBy: data.session.username, previewedAt: now } : {}) };
  await env.CHALAK_DB.put(key, JSON.stringify(next), { expirationTtl: 60 * 60 * 24 * 90 });
  const indexRaw = await env.CHALAK_DB.get('email_ingest:index');
  if (indexRaw) {
    const index = JSON.parse(indexRaw) as EmailQueueItem[];
    await env.CHALAK_DB.put('email_ingest:index', JSON.stringify(index.map(entry => entry.id === body.id ? { ...entry, status: body.action } : entry)));
  }
  const auditKey = `audit_event:${crypto.randomUUID()}`;
  await env.CHALAK_DB.put(auditKey, JSON.stringify({ id: auditKey, timestamp: now, actorId: data.session.id, action: `email_import_${body.action}`, auditReference: item.auditReference, operationId: body.operationId || null }));
  return jsonResponse({ accepted: true, status: body.action, auditReference: item.auditReference, ...(importType ? { importType } : {}) });
}
