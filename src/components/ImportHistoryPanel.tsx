import React, { useState } from 'react';
import { History, RefreshCw } from 'lucide-react';

interface HistoryItem {
  id: string; time: string; actor?: string; source: string; period: string;
  rowsRead: number; acceptedRows: number; rejectedRows: number; affectedEvaluations: number; status: string;
}

const sourceLabel: Record<string, string> = { MIS: 'سامانه MIS', KASRA: 'سامانه کسری', FILE_IMPORT: 'فایل شاخص‌ها', EMPLOYEE: 'پرسنل', CRITERIA: 'شاخص‌ها' };

export default function ImportHistoryPanel() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/imports/history', { credentials: 'same-origin' });
      const result = await response.json() as { items?: HistoryItem[]; error?: string };
      if (!response.ok) throw new Error(result.error || 'تاریخچه در دسترس نیست.');
      setItems(Array.isArray(result.items) ? result.items : []);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'تاریخچه در دسترس نیست.'); }
    finally { setLoading(false); }
  };

  return <section className="rounded-2xl border border-slate-800 bg-slate-950/50 p-4" aria-label="تاریخچه ورود اطلاعات">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <button type="button" aria-expanded={open} onClick={() => { const next = !open; setOpen(next); if (next) void load(); }} className="inline-flex min-h-10 items-center gap-2 text-xs font-black text-slate-200"><History className="h-4 w-4 text-teal-300" /> تاریخچه ورود اطلاعات</button>
      {open && <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-slate-700 px-3 text-[10px] font-bold text-slate-300 disabled:opacity-50"><RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> تازه‌سازی</button>}
    </div>
    {open && <div className="mt-3 space-y-2">
      <p className="text-[10px] leading-5 text-slate-400">زمان، منبع، دوره و تعداد ردیف‌های پذیرفته یا ردشده از گزارش ثبت‌شده سرور نمایش داده می‌شود.</p>
      {error && <p role="alert" className="rounded-lg bg-rose-500/10 p-2 text-xs text-rose-200">{error}</p>}
      {!items.length && !loading && !error && <p className="rounded-lg border border-slate-800 p-3 text-xs text-slate-500">هنوز ورود ثبت‌شده‌ای وجود ندارد.</p>}
      {items.length > 0 && <div className="max-h-72 overflow-auto rounded-xl border border-slate-800">
        <table className="w-full min-w-[650px] text-right text-[10px]">
          <thead className="sticky top-0 bg-slate-900 text-slate-400"><tr><th className="p-2">زمان</th><th className="p-2">منبع</th><th className="p-2">دوره</th><th className="p-2">ردیف‌ها</th><th className="p-2">پذیرفته</th><th className="p-2">ردشده</th><th className="p-2">پرونده‌های به‌روزشده</th><th className="p-2">کاربر</th></tr></thead>
          <tbody className="divide-y divide-slate-800 text-slate-200">{items.map(item => <tr key={item.id}><td className="p-2 whitespace-nowrap">{item.time ? new Date(item.time).toLocaleString() : '—'}</td><td className="p-2">{sourceLabel[item.source] || 'ورود داده'}</td><td className="p-2">{item.period || '—'}</td><td className="p-2">{item.rowsRead}</td><td className="p-2 text-emerald-300">{item.acceptedRows}</td><td className="p-2 text-amber-300">{item.rejectedRows}</td><td className="p-2">{item.affectedEvaluations}</td><td className="p-2">{item.actor || 'شما'}</td></tr>)}</tbody>
        </table>
      </div>}
    </div>}
  </section>;
}
