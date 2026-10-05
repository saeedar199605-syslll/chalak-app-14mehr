import { useEffect, useRef, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';

export interface GuidedTourStep {
  tab: string;
  title: string;
  desc: string;
}

interface GuidedTourProps {
  steps: GuidedTourStep[];
  activeStep: number | null;
  onPrevious: () => void;
  onNext: () => void;
  onSkip: () => void;
  onNeverShowAgain: () => void;
  theme: 'dark' | 'light';
  themeMode?: 'dark' | 'light' | 'system';
}

export default function GuidedTour({ steps, activeStep, onPrevious, onNext, onSkip, onNeverShowAgain, theme, themeMode = theme }: GuidedTourProps) {
  const panelRef = useRef<HTMLElement>(null);
  const onNextRef = useRef(onNext);
  const onSkipRef = useRef(onSkip);
  onNextRef.current = onNext;
  onSkipRef.current = onSkip;
  const [position, setPosition] = useState({ left: 16, top: 16 });
  const step = activeStep === null ? undefined : steps[activeStep];
  const compact = typeof window !== 'undefined' && window.innerWidth < 768;

  useEffect(() => {
    if (!step) return;
    const target = document.getElementById(`tour-target-page-${step.tab}`);
    if (!target) {
      onNextRef.current();
      return;
    }

    const oldOutline = target.style.outline;
    const oldOutlineOffset = target.style.outlineOffset;
    const oldBorderRadius = target.style.borderRadius;
    target.style.outline = `3px solid ${theme === 'dark' ? '#2dd4bf' : '#0f766e'}`;
    target.style.outlineOffset = '3px';
    target.style.borderRadius = '1rem';
    target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });

    const updatePosition = () => {
      if (window.innerWidth < 768) return;
      const rect = target.getBoundingClientRect();
      const panelWidth = Math.min(360, window.innerWidth - 32);
      const panelHeight = panelRef.current?.offsetHeight || 220;
      const left = Math.max(16, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - 16));
      const below = rect.bottom + 12;
      const top = below + panelHeight < window.innerHeight - 16 ? below : Math.max(16, rect.top - panelHeight - 12);
      setPosition({ left, top });
    };
    const frame = requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onSkipRef.current();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('keydown', onKeyDown);
      target.style.outline = oldOutline;
      target.style.outlineOffset = oldOutlineOffset;
      target.style.borderRadius = oldBorderRadius;
    };
  }, [step?.tab, step?.title, step?.desc, activeStep, theme]);

  if (!step || activeStep === null) return null;
  const isLast = activeStep === steps.length - 1;

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-labelledby="guided-tour-title"
      aria-describedby="guided-tour-description"
      data-testid="guided-tour-panel"
      data-theme={theme}
      data-theme-mode={themeMode}
      dir="rtl"
      className={`fixed z-[1000] w-[min(22.5rem,calc(100vw-2rem))] max-h-[45dvh] overflow-y-auto rounded-2xl border p-4 text-right shadow-2xl backdrop-blur-md outline-none ${theme === 'dark' ? 'border-slate-700 bg-slate-950/95 text-slate-100 shadow-black/40' : 'border-slate-200 bg-white/95 text-slate-900 shadow-slate-900/15'} ${compact ? 'bottom-3 left-3 right-3 w-auto' : ''}`}
      style={compact ? { paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' } : position}
    >
      <header className={`flex items-start justify-between gap-3 border-b pb-3 ${theme === 'dark' ? 'border-slate-800' : 'border-slate-200'}`}>
        <div>
          <p className={`text-[11px] font-bold ${theme === 'dark' ? 'text-teal-300' : 'text-teal-800'}`}>راهنمای داخل برنامه · {activeStep + 1} از {steps.length}</p>
          <h2 id="guided-tour-title" className="mt-1 text-sm font-black">{step.title}</h2>
        </div>
        <button type="button" aria-label="بستن راهنما" onClick={onSkip} className={`grid min-h-10 min-w-10 place-items-center rounded-lg ${theme === 'dark' ? 'text-slate-400 hover:bg-slate-800 hover:text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'}`}>
          <X className="h-4 w-4" />
        </button>
      </header>
      <p id="guided-tour-description" className={`mt-3 text-xs leading-6 ${theme === 'dark' ? 'text-slate-300' : 'text-slate-600'}`}>{step.desc}</p>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={onNeverShowAgain} className={`min-h-10 text-[11px] font-bold underline underline-offset-4 ${theme === 'dark' ? 'text-slate-400 hover:text-slate-200' : 'text-slate-600 hover:text-slate-900'}`}>دیگر نمایش داده نشود</button>
        <div className="flex items-center gap-2">
          {activeStep > 0 && <button type="button" onClick={onPrevious} className={`min-h-10 rounded-lg border px-3 text-xs font-bold ${theme === 'dark' ? 'border-slate-700 text-slate-200 hover:bg-slate-800' : 'border-slate-300 text-slate-700 hover:bg-slate-100'}`}>قبلی</button>}
          <button type="button" onClick={onNext} className={`flex min-h-10 items-center gap-1.5 rounded-lg px-4 text-xs font-black ${theme === 'dark' ? 'bg-teal-400 text-slate-950 hover:bg-teal-300' : 'bg-teal-700 text-white hover:bg-teal-800'}`}>
            {isLast ? 'پایان' : 'بعدی'}{!isLast && <ArrowRight className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      <button type="button" onClick={onSkip} className={`mt-2 min-h-9 text-[11px] font-bold ${theme === 'dark' ? 'text-slate-500 hover:text-slate-300' : 'text-slate-500 hover:text-slate-800'}`}>رد کردن این راهنما</button>
    </section>
  );
}
