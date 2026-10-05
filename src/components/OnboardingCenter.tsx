import React, { useEffect, useState } from 'react';
import { BookOpenCheck, CheckCircle2, Circle, ClipboardList, FileSpreadsheet, Search } from 'lucide-react';
import type { Employee } from '../types';
import { canAccessTab, defaultTabFor } from '../utils/accessControl';
import { markOnboardingStep, readOnboardingPreferences, saveOnboardingPreferences, type OnboardingPreferences } from '../utils/onboardingProgress';

interface Props { currentUser: Employee; onNavigate: (tab: string) => void; onStartInteractiveTour?: () => void }

const checklist = [
  { id: 'cartable-seen', label: 'کارتابل را دیدم', icon: ClipboardList },
  { id: 'search-tested', label: 'جستجو را امتحان کردم', icon: Search },
  { id: 'import-preview-seen', label: 'راهنمای ورود اطلاعات را دیدم', icon: FileSpreadsheet },
];

export default function OnboardingCenter({ currentUser, onNavigate, onStartInteractiveTour }: Props) {
  const [preferences, setPreferences] = useState<OnboardingPreferences>(() => readOnboardingPreferences(currentUser));
  useEffect(() => {
    const next = saveOnboardingPreferences(currentUser, { seen: true });
    setPreferences(next);
  }, [currentUser.id, currentUser.role]);

  const toggle = (stepId: string) => {
    const completed = preferences.completed.includes(stepId)
      ? preferences.completed.filter(item => item !== stepId)
      : [...preferences.completed, stepId];
    setPreferences(saveOnboardingPreferences(currentUser, { seen: true, completed }));
  };
  const goTo = (tab: string, checklistId?: string) => {
    if (!canAccessTab(currentUser, tab)) return;
    if (checklistId) setPreferences(markOnboardingStep(currentUser, checklistId));
    onNavigate(tab);
  };
  const roleLabel = currentUser.role === 'admin' ? 'مدیر' : currentUser.role === 'supervisor' ? 'سرپرست' : 'کارمند';

  return (
    <section className="mx-auto max-w-4xl space-y-5" dir="rtl" aria-labelledby="onboarding-title">
      <div className="rounded-3xl border border-teal-500/20 bg-white p-6 shadow-sm dark:bg-slate-900">
        <div className="flex items-start gap-3">
          <BookOpenCheck className="mt-1 h-6 w-6 shrink-0 text-teal-600 dark:text-teal-300" />
          <div>
            <h1 id="onboarding-title" className="text-xl font-black text-slate-900 dark:text-slate-100">شروع کار با چالاک</h1>
            <p className="mt-2 text-sm leading-7 text-slate-600 dark:text-slate-300">سلام {currentUser.name}. این راهنمای کوتاه برای نقش {roleLabel} آماده شده است. هر بخش را هنگام نیاز باز کنید؛ تکمیل همه موارد الزامی نیست.</p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {canAccessTab(currentUser, 'my-evaluation') && <article className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-2 text-sm font-black"><CheckCircle2 className="h-4 w-4 text-emerald-500" /> کارنامه و خودارزیابی من</div>
          <ol className="mt-3 space-y-2 text-xs leading-6 text-slate-600 dark:text-slate-300">
            <li>۱. شاخص‌های دوره جاری و توضیحات هر شاخص را بخوانید.</li>
            <li>۲. امتیاز و توضیح خود را ثبت و پیش از ارسال مرور کنید.</li>
            <li>۳. پس از ارسال، مرحله بعد و پیام‌های کارتابل را پیگیری کنید.</li>
          </ol>
          <button type="button" onClick={() => goTo('my-evaluation', 'self-evaluation-seen')} className="mt-4 min-h-10 rounded-xl bg-emerald-600 px-4 text-xs font-black text-white">رفتن به کارنامه من</button>
        </article>}
        {canAccessTab(currentUser, 'workflow') && <article className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-2 text-sm font-black"><ClipboardList className="h-4 w-4 text-teal-500" /> کارتابل و پیگیری پرونده</div>
          <ol className="mt-3 space-y-2 text-xs leading-6 text-slate-600 dark:text-slate-300">
            <li>۱. پرونده‌های منتظر اقدام خود را در «کارتابل» ببینید.</li>
            <li>۲. پرونده را باز کنید تا مرحله، مسئول بعدی و تاریخچه را بررسی کنید.</li>
            <li>۳. پیش از انتقال گروهی، فهرست واجد شرایط و موارد کنارگذاشته‌شده را مرور کنید.</li>
          </ol>
          <button type="button" onClick={() => goTo('workflow', 'cartable-seen')} className="mt-4 min-h-10 rounded-xl bg-teal-600 px-4 text-xs font-black text-white">رفتن به کارتابل</button>
        </article>}

        {canAccessTab(currentUser, 'evaluations') && <article className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-2 text-sm font-black"><FileSpreadsheet className="h-4 w-4 text-indigo-500" /> ورود اطلاعات ارزیابی
          </div>
          <ol className="mt-3 space-y-2 text-xs leading-6 text-slate-600 dark:text-slate-300">
            <li>۱. منبع، دوره و گروه کارکنان را انتخاب کنید.</li>
            <li>۲. ستون‌ها و شاخص‌ها را بازبینی کنید؛ پیشنهاد مبهم را خودتان تعیین کنید.</li>
            <li>۳. پیش‌نمایش را کنترل کنید. فقط دکمه تأیید، تغییرات را ذخیره می‌کند.</li>
          </ol>
          <button type="button" onClick={() => goTo('evaluations', 'import-preview-seen')} className="mt-4 min-h-10 rounded-xl bg-indigo-600 px-4 text-xs font-black text-white">رفتن به ارزیابی‌ها و ورود اطلاعات</button>
        </article>}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-black">چک‌لیست اختیاری</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {checklist.filter(item => item.id !== 'import-preview-seen' || canAccessTab(currentUser, 'evaluations')).map(item => {
            const Icon = item.icon;
            const done = preferences.completed.includes(item.id);
            return <button key={item.id} type="button" onClick={() => toggle(item.id)} className="flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 px-3 text-right text-xs dark:border-slate-700" aria-pressed={done}>
              {done ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <Circle className="h-4 w-4 text-slate-400" />}
              <Icon className="h-4 w-4 text-slate-500" />{item.label}
            </button>;
          })}
        </div>
        <label className="mt-4 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={preferences.dontShowAutomatically} onChange={event => setPreferences(saveOnboardingPreferences(currentUser, { seen: true, dontShowAutomatically: event.target.checked }))} />
          این راهنما را خودکار باز نکن
        </label>
        <button type="button" onClick={() => { setPreferences(saveOnboardingPreferences(currentUser, { seen: true, dismissed: true })); onNavigate(defaultTabFor(currentUser)); }} className="mt-4 min-h-10 rounded-xl border border-slate-300 px-4 text-xs font-bold text-slate-600 dark:border-slate-700 dark:text-slate-300">فعلاً بعداً</button>
        {onStartInteractiveTour && <button type="button" onClick={onStartInteractiveTour} className="mr-2 mt-4 min-h-10 rounded-xl bg-teal-600 px-4 text-xs font-bold text-white">نمایش راهنمای مرحله‌ای</button>}
      </div>
    </section>
  );
}
