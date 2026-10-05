import { AuthSession, CloudflareEnv, jsonResponse } from '../../../cloudflare/auth';

interface Context { env: CloudflareEnv; data: { session?: AuthSession } }

export async function onRequestGet({ env, data }: Context): Promise<Response> {
  const session = data.session;
  if (!session) return jsonResponse({ error: 'Authentication required.' }, 401);
  let state: Record<string, unknown>;
  try {
    const raw = await env.CHALAK_DB.get('app_state');
    state = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch {
    return jsonResponse({ error: 'تاریخچه ورود اطلاعات موقتاً در دسترس نیست.', code: 'import_history_unavailable' }, 503);
  }
  const logs = Array.isArray(state.pe_audit_logs) ? state.pe_audit_logs as Array<Record<string, unknown>> : [];
  const items = logs.filter(item => item.action === 'source_import_completed' &&
    (session.role === 'admin' || item.actorId === session.id))
    .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')))
    .slice(0, 100)
    .map(item => ({
      id: typeof item.id === 'string' ? item.id : '',
      operationId: typeof item.operationId === 'string' ? item.operationId : '',
      time: typeof item.timestamp === 'string' ? item.timestamp : '',
      actor: session.role === 'admin' && typeof item.actorName === 'string' ? item.actorName : undefined,
      source: typeof item.importType === 'string' ? item.importType : '—',
      period: typeof item.evaluationPeriodId === 'string' ? item.evaluationPeriodId : '—',
      rowsRead: Number.isInteger(item.rowsRead) ? item.rowsRead : Number(item.affectedEvaluationCount || 0),
      acceptedRows: Number.isInteger(item.acceptedRows) ? item.acceptedRows : Number(item.affectedEvaluationCount || 0),
      rejectedRows: Number.isInteger(item.rejectedRows) ? item.rejectedRows : 0,
      affectedEvaluations: Number(item.affectedEvaluationCount || 0),
      status: item.result === 'accepted' ? 'accepted' : 'unknown',
    }));
  return jsonResponse({ items });
}
