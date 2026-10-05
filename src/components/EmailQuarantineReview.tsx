import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Eye, Mail, RefreshCw, X } from 'lucide-react';

interface QueueSummary {
  id: string;
  senderAddress: string;
  subject: string;
  receivedAt: string;
  status: 'quarantined' | 'previewed' | 'approved' | 'rejected';
  attachmentCount: number;
  auditReference: string;
}
interface QuarantinedAttachment { filename: string; contentType: string; contentBase64: string; byteLength: number }
interface QueueDetail extends QueueSummary { attachments: QuarantinedAttachment[]; providerMessageId: string }
interface AcceptedImport { operationId: string; importType: 'MIS' | 'KASRA' }

const statusLabel: Record<QueueSummary['status'], string> = {
  quarantined: 'در انتظار بازبینی', previewed: 'بازبینی شد؛ منتظر ورود اطلاعات', approved: 'ورود اطلاعات تأیید شد', rejected: 'رد شد',
};

function decodeAttachment(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export default function EmailQuarantineReview({ isAdmin, enabled, acceptedImport }: { isAdmin: boolean; enabled: boolean; acceptedImport: AcceptedImport | null }) {
  const [items, setItems] = useState<QueueSummary[]>([]);
  const [selected, setSelected] = useState<QueueDetail | null>(null);
  const [operationId, setOperationId] = useState(() => {
    try { const saved = JSON.parse(sessionStorage.getItem('pe_last_accepted_import_v5') || 'null') as AcceptedImport | null; return saved?.operationId || ''; }
    catch { return ''; }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!acceptedImport) return;
    setOperationId(acceptedImport.operationId);
    try { sessionStorage.setItem('pe_last_accepted_import_v5', JSON.stringify(acceptedImport)); } catch { /* Current-session approval remains optional if browser storage is blocked. */ }
  }, [acceptedImport?.operationId, acceptedImport?.importType]);

  const refresh = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/email/quarantine', { credentials: 'same-origin' });
      const result = await response.json() as { items?: QueueSummary[]; error?: string };
      if (!response.ok) throw new Error(result.error || 'دریافت صف ایمیل ناموفق بود.');
      setItems(Array.isArray(result.items) ? result.items : []);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'دریافت صف ایمیل ناموفق بود.'); }
    finally { setBusy(false); }
  };

  useEffect(() => { if (enabled && isAdmin) void refresh(); }, [enabled, isAdmin]);

  const review = async (id: string, action: 'previewed' | 'approved' | 'rejected') => {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/email/quarantine', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, ...(action === 'approved' ? { operationId } : {}) }),
      });
      const result = await response.json() as { accepted?: boolean; error?: string; auditReference?: string; importType?: string };
      if (!response.ok || result.accepted !== true) throw new Error(result.error || 'ذخیره نتیجه بازبینی ناموفق بود.');
      setMessage(action === 'approved' ? `ورود ${result.importType || ''} ثبت شد · مرجع ${result.auditReference || ''}` : action === 'rejected' ? 'پیام در صف قرنطینه رد شد.' : 'پیش‌نمایش ثبت شد؛ داده‌ای تغییر نکرد.');
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'ذخیره نتیجه بازبینی ناموفق بود.'); }
    finally { setBusy(false); }
  };

  const openItem = async (item: QueueSummary) => {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch(`/api/email/quarantine?id=${encodeURIComponent(item.id)}`, { credentials: 'same-origin' });
      const result = await response.json() as { item?: QueueDetail; error?: string };
      if (!response.ok || !result.item) throw new Error(result.error || 'پیام قرنطینه‌شده در دسترس نیست.');
      setSelected(result.item);
      if (result.item.status === 'quarantined') await review(item.id, 'previewed');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'بارگذاری پیام ناموفق بود.'); }
    finally { setBusy(false); }
  };

  const download = (attachment: QuarantinedAttachment) => {
    const bytes = decodeAttachment(attachment.contentBase64);
    const blob = new Blob([bytes], { type: attachment.contentType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = attachment.filename.replace(/[\\/:*?"<>|]/g, '_') || 'email-attachment';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const csvPreview = (attachment: QuarantinedAttachment): string[] => {
    if (attachment.contentType !== 'text/csv') return [];
    try { return new TextDecoder().decode(decodeAttachment(attachment.contentBase64)).split(/\r?\n/).slice(0, 12).map(line => line.slice(0, 500)); }
    catch { return ['پیش‌نمایش متنی این فایل در دسترس نیست.']; }
  };

  if (!enabled || !isAdmin) return null;

  return <section className="space-y-4 rounded-2xl border border-violet-500/20 bg-slate-900/70 p-4" aria-label="صف بازبینی ایمیل">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-sm font-black text-slate-100"><Mail className="h-4 w-4 text-violet-300" /> صف قرنطینه ایمیل <span className="text-xs font-normal text-slate-400">({items.length})</span></div>
      <button type="button" onClick={() => void refresh()} disabled={busy} className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-slate-700 px-3 text-xs font-bold text-slate-200 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} /> تازه‌سازی</button>
    </div>
    <p className="text-xs leading-6 text-slate-400">بازبینی فایل فقط آن را پیش‌نمایش می‌کند. برای تأیید، فایل را از تب MIS یا کسری با اعتبارسنجی معمول وارد کنید؛ سپس شناسه عملیات پذیرفته‌شده را ثبت کنید.</p>
    {error && <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">{error}</div>}
    {message && <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">{message}</div>}
    {!items.length && !busy && <p className="rounded-xl border border-slate-800 p-4 text-xs text-slate-400">پیامی در صف ایمیل نیست.</p>}
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <ul className="max-h-80 space-y-2 overflow-auto" aria-label="پیام‌های قرنطینه‌شده">
        {items.map(item => <li key={item.id}><button type="button" onClick={() => void openItem(item)} disabled={busy} className={`w-full rounded-xl border p-3 text-right ${selected?.id === item.id ? 'border-violet-400/50 bg-violet-500/10' : 'border-slate-800 bg-slate-950/40'} disabled:opacity-50`}>
          <span className="flex items-center justify-between gap-2 text-xs font-bold text-slate-100"><span className="truncate">{item.subject || 'بدون عنوان'}</span><span className="shrink-0 text-[10px] text-slate-400">{statusLabel[item.status]}</span></span>
          <span className="mt-1 block truncate text-[10px] text-slate-400">{item.senderAddress} · {item.attachmentCount} پیوست · {item.auditReference}</span>
        </button></li>)}
      </ul>
      {selected ? <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
        <div><h4 className="text-xs font-black text-slate-100">{selected.subject || 'بدون عنوان'}</h4><p className="mt-1 text-[10px] text-slate-400">فرستنده: {selected.senderAddress} · دریافت: {selected.receivedAt} · مرجع ممیزی: {selected.auditReference}</p></div>
        <div className="space-y-2">{selected.attachments.map((attachment, index) => <div key={`${attachment.filename}:${index}`} className="rounded-lg border border-slate-800 p-2">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold text-slate-200">{attachment.filename} <span className="font-normal text-slate-400">· {Math.ceil(attachment.byteLength / 1024)} کیلوبایت</span></span><button type="button" onClick={() => download(attachment)} className="inline-flex min-h-8 items-center gap-1 rounded-md bg-slate-800 px-2 text-[10px] font-bold text-slate-100"><Download className="h-3 w-3" /> دریافت فایل</button></div>
          {csvPreview(attachment).length > 0 ? <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-2 text-[9px] leading-5 text-slate-400">{csvPreview(attachment).join('\n')}</pre> : <p className="mt-2 text-[10px] text-slate-500">برای پیش‌نمایش XLSX، فایل را دریافت و از مسیر ورود استاندارد بررسی کنید.</p>}
        </div>)}</div>
        {selected.status === 'previewed' && <div className="space-y-2 border-t border-slate-800 pt-3">
          <p className="text-[10px] leading-5 text-slate-300">{operationId ? 'ورود موفق MIS یا کسری در همین نشست آماده تأیید است.' : 'برای تأیید، ابتدا همین فایل را از مسیر استاندارد MIS یا کسری بررسی و با موفقیت ذخیره کنید.'}</p>
          <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void review(selected.id, 'approved')} disabled={busy || !/^[a-zA-Z0-9:_-]{8,100}$/.test(operationId)} className="inline-flex min-h-9 items-center gap-1 rounded-lg bg-emerald-600 px-3 text-xs font-bold text-white disabled:opacity-50"><CheckCircle2 className="h-3.5 w-3.5" /> تأیید پس از ورود موفق</button><button type="button" onClick={() => void review(selected.id, 'rejected')} disabled={busy} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-rose-500/30 px-3 text-xs font-bold text-rose-200 disabled:opacity-50"><X className="h-3.5 w-3.5" /> رد پیام</button></div>
          <p className="flex items-start gap-1 text-[10px] leading-5 text-amber-200"><AlertTriangle className="mt-1 h-3 w-3 shrink-0" />تأیید فقط با ثبت موفق و قابل‌بازیابی همان مدیر پذیرفته می‌شود.</p>
        </div>}
        {selected.status === 'quarantined' && <p className="flex items-center gap-1 text-xs text-amber-200"><Eye className="h-3.5 w-3.5" />این پیام هنوز بازبینی نشده است.</p>}
      </div> : <div className="grid min-h-28 place-items-center rounded-xl border border-dashed border-slate-800 text-xs text-slate-500">برای دیدن جزئیات، یک پیام را انتخاب کنید.</div>}
    </div>
  </section>;
}
