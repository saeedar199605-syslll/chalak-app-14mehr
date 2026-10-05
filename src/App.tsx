/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { lazy, Suspense, useState, useEffect, useCallback, useRef } from 'react';
import Sidebar from './components/Sidebar';
import { navigationLocation } from './utils/navigation';
import Login from './components/Login';
import SupervisorNotificationBell from './components/SupervisorNotificationBell';
import { IconButton } from './components/ui/Primitives';
const Dashboard = lazy(() => import('./components/Dashboard'));
const CriteriaBank = lazy(() => import('./components/CriteriaBank'));
const JobProfiles = lazy(() => import('./components/JobProfiles'));
const Employees = lazy(() => import('./components/Employees'));
const Evaluations = lazy(() => import('./components/Evaluations'));
const Calibration = lazy(() => import('./components/Calibration'));
const Reports = lazy(() => import('./components/Reports'));
const SupportTickets = lazy(() => import('./components/SupportTickets'));
import GuidedTour from './components/GuidedTour';
import type { GuidedTourStep } from './components/GuidedTour';
const MyEvaluation = lazy(() => import('./components/MyEvaluation'));
const ManagementCenter = lazy(() => import('./components/ManagementCenter'));
const RewardCalculationCenter = lazy(() => import('./components/RewardCalculationCenter'));
const WorkflowManager = lazy(() => import('./components/WorkflowManager'));
const LatticePerformanceHub = lazy(() => import('./components/LatticePerformanceHub'));
const KickidlerProductivityHub = lazy(() => import('./components/KickidlerProductivityHub'));
const OnboardingCenter = lazy(() => import('./components/OnboardingCenter'));
const ComprehensiveManualModal = lazy(() => import('./components/ComprehensiveManualModal'));
const GUIDED_TOUR_VERSION = 'v5.0';
import { UploadCloud,  
   BookOpen,
   Sun,
   Moon,
   Activity,
   Sparkles,
   Users,
   Monitor,
  Eye,
  LogOut,
  Menu,
  Download,
  Printer,
  RotateCcw,
  LockKeyhole,
  Scale,
   FileSpreadsheet,
  CheckCircle2,
  Save,
  HelpCircle,
  Bell,
  BellOff,
  RefreshCw
} from 'lucide-react';
import { Criterion, JobProfile, Employee, Evaluation, UserNotification, DEFAULT_ROUTE_RULES } from './types';
import { DelegationRecord, getActionableWorkflowTasks, isDelegationActive, workflowTaskIdentity } from './utils/workflowAuthorization';
import {  SEED_CRITERIA, SEED_PROFILES, SEED_EMPLOYEES, SEED_EVALUATIONS } from './seedData';
import {  browserNotifications } from './utils/browserNotifications';
import {  db } from './utils/db';
import { canAccessTab, defaultTabFor } from './utils/accessControl';
import { buildEvaluationStarts, isEvaluationPeriodActive } from './utils/evaluationStart';
import { employeeDeletionBlockMessage, getEmployeeDeletionBlockReason, planEmployeeBulkDeletion } from './utils/employeeDeletion';
import { markOnboardingStep, readOnboardingPreferences } from './utils/onboardingProgress';
import {  
  validateEmployeeInput, 
  validateCriterionInput, 
  validateJobProfileInput, 
  clearLegacyAdminSessions 
} from './utils/validation';

export default function App() {
  const [currentTab, setCurrentTab] = useState<string>('dashboard');
  const [activeEvalId, setActiveEvalId] = useState<string | null>(null);
  const [workflowNotificationFocus, setWorkflowNotificationFocus] = useState<{ evaluationId: string; sequence: number } | null>(null);
  const [notificationNotice, setNotificationNotice] = useState('');
  const workflowNotificationSequence = useRef(0);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const closeMobileMenu = useCallback(() => setIsMobileMenuOpen(false), []);
  const [saveIndicator, setSaveIndicator] = useState(false);
  const [cloudStatus, setCloudStatus] = useState<{
    status: 'idle' | 'pending' | 'syncing' | 'synced' | 'retrying' | 'offline' | 'error' | 'conflict' | 'authentication_required' | 'write_rejected';
    message: string;
    connectionState?: 'CONNECTED' | 'SYNCING' | 'LOCAL_CHANGES_PENDING' | 'DEGRADED' | 'OFFLINE' | 'AUTH_REQUIRED' | 'CONFLICT';
    revision?: number;
    lastSyncedAt?: string;
    conflict?: boolean;
    code?: string;
    reason?: string;
    retryable?: boolean;
  }>({ status: 'idle', message: 'در انتظار ورود به سامانه' });
  const [cloudDataVersion, setCloudDataVersion] = useState(0);
  const connectionState = cloudStatus.connectionState || (cloudStatus.status === 'synced' ? 'CONNECTED' : cloudStatus.status === 'syncing' ? 'SYNCING' : cloudStatus.status === 'pending' ? 'LOCAL_CHANGES_PENDING' : cloudStatus.status === 'offline' ? 'OFFLINE' : cloudStatus.status === 'authentication_required' ? 'AUTH_REQUIRED' : cloudStatus.status === 'conflict' ? 'CONFLICT' : 'DEGRADED');
  const connectionLabel = connectionState === 'CONNECTED' ? 'متصل' : connectionState === 'SYNCING' ? 'در حال ذخیره' : connectionState === 'LOCAL_CHANGES_PENDING' ? 'تغییرات ذخیره‌نشده' : connectionState === 'OFFLINE' ? 'آفلاین؛ تغییرات حفظ می‌شوند' : connectionState === 'AUTH_REQUIRED' ? 'نیاز به ورود مجدد' : connectionState === 'CONFLICT' ? 'نسخه جدیدتری از اطلاعات روی سرور وجود دارد' : 'ارتباط با سرور برقرار نیست';
  const connectionTone = connectionState === 'CONNECTED' ? 'text-sky-400 bg-sky-500/10 border-sky-500/20' : connectionState === 'SYNCING' || connectionState === 'LOCAL_CHANGES_PENDING' ? 'text-amber-400 bg-amber-500/10 border-amber-500/20' : connectionState === 'OFFLINE' ? 'text-orange-400 bg-orange-500/10 border-orange-500/20' : 'text-rose-400 bg-rose-500/10 border-rose-500/20';
  const [activeTourStep, setActiveTourStep] = useState<number | null>(null);
  const [pageHelpOpenFor, setPageHelpOpenFor] = useState<string | null>(null);
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);
  const sessionRestorePromiseRef = useRef<Promise<{
    isApiResponse: boolean;
    responseOk: boolean;
    result?: { user?: Employee; error?: string };
  }> | null>(null);

  const sanitizeUser = (user: Employee | null): Employee | null => {
    if (!user) return null;
    return user;
  };

  // Session-isolated user state (per browser/device)
  const [currentUser, setCurrentUser] = useState<Employee | null>(() => {
    const sessionSaved = sessionStorage.getItem('pe_session_user');
    if (sessionSaved) {
      try {
        const parsed = JSON.parse(sessionSaved);
        const user = sanitizeUser(parsed);
        if (user && user.role === 'admin') {
          const sessionLoggedAt = sessionStorage.getItem('pe_admin_session_logged_at');
          const passUpdatedAt = localStorage.getItem('pe_admin_password_updated_at');
          if (sessionLoggedAt && passUpdatedAt) {
            if (new Date(passUpdatedAt).getTime() > new Date(sessionLoggedAt).getTime()) {
              // Admin password changed after session was created -> invalidate session
              clearLegacyAdminSessions();
              return null;
            }
          }
        }
        return user;
      } catch {
        return null;
      }
    }
    return null;
  });

  // Restore identity from the HttpOnly server session. Browser storage is never
  // authoritative for role or permissions in production.
  useEffect(() => {
    let active = true;
    const hasSessionHint = Boolean(sessionStorage.getItem('pe_session_user') || localStorage.getItem('pe_server_session_hint'));
    if (!hasSessionHint) {
      setCurrentUser(null);
      setSessionChecked(true);
      return () => { active = false; };
    }
    const restoreServerSession = async () => {
      try {
        const restorePromise = sessionRestorePromiseRef.current || (sessionRestorePromiseRef.current = fetch('/api/auth/session', { credentials: 'same-origin' }).then(async response => {
          const isApiResponse = (response.headers.get('Content-Type') || '').includes('application/json');
          const result = isApiResponse ? await response.json() as { user?: Employee; error?: string } : undefined;
          return { isApiResponse, responseOk: response.ok, result };
        }));
        const { isApiResponse, responseOk, result } = await restorePromise;
        if (isApiResponse) {
          if (!active) return;
          if (responseOk && result?.user) {
            sessionStorage.setItem('pe_session_user', JSON.stringify(result.user));
            localStorage.setItem('pe_server_session_hint', '1');
            setCurrentUser(result.user);
            setCurrentTab(restoreNavigationFor(result.user));
          } else {
            localStorage.removeItem('pe_server_session_hint');
            clearLegacyAdminSessions();
            setCurrentUser(null);
          }
        }
      } catch {
        // Offline/Vite demo mode intentionally keeps the local session available.
      } finally {
        if (active) setSessionChecked(true);
      }
    };
    restoreServerSession().catch(() => { if (active) setSessionChecked(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!sessionChecked || !currentUser) {
      db.stopCloudSync();
      return;
    }
    db.initializeCloudSync(currentUser.id).catch(() => {});
    return () => db.stopCloudSync();
  }, [sessionChecked, currentUser?.id]);

  useEffect(() => {
    const handleCloudStatus = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.status) setCloudStatus(detail);
    };
    const handleAuthExpired = () => {
      if (import.meta.env.DEV) db.stopCloudSync();
      else {
        db.clearAuthorizedCache();
        setEmployees([]);
        setEvaluations([]);
        setArchivedEvaluations([]);
        setProfiles([]);
        setCriteria([]);
        setDelegations([]);
      }
      clearLegacyAdminSessions();
      setCurrentUser(null);
      setCurrentTab('dashboard');
    };
    const handleCloudDataReceived = () => setCloudDataVersion(version => version + 1);
    window.addEventListener('pe_cloud_sync_status', handleCloudStatus);
    window.addEventListener('pe_auth_expired', handleAuthExpired);
    window.addEventListener('pe_cloud_data_received', handleCloudDataReceived);
    return () => {
      window.removeEventListener('pe_cloud_sync_status', handleCloudStatus);
      window.removeEventListener('pe_auth_expired', handleAuthExpired);
      window.removeEventListener('pe_cloud_data_received', handleCloudDataReceived);
    };
  }, []);

  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() => {
    return browserNotifications.getPermissionStatus();
  });

  // Invalidate admin session if password updated in another tab
  useEffect(() => {
    const handleStorageUpdate = (e: StorageEvent) => {
      if (currentUser?.role === 'admin' && e.key === 'pe_admin_password_updated_at') {
        const sessionLoggedAt = sessionStorage.getItem('pe_admin_session_logged_at');
        const passUpdatedAt = localStorage.getItem('pe_admin_password_updated_at');
        if (sessionLoggedAt && passUpdatedAt) {
          if (new Date(passUpdatedAt).getTime() > new Date(sessionLoggedAt).getTime()) {
            clearLegacyAdminSessions();
            setCurrentUser(null);
            setCurrentTab('dashboard');
          }
        }
      }
    };

    window.addEventListener('storage', handleStorageUpdate);
    return () => window.removeEventListener('storage', handleStorageUpdate);
  }, [currentUser]);

  // Invalidate persistent admin session on admin password change event
  useEffect(() => {
    const handleAdminPasswordChangedEvent = () => {
      if (currentUser?.role === 'admin') {
        clearLegacyAdminSessions();
        setCurrentUser(null);
        setCurrentTab('dashboard');
      }
    };

    window.addEventListener('pe_admin_password_changed', handleAdminPasswordChangedEvent);
    return () => window.removeEventListener('pe_admin_password_changed', handleAdminPasswordChangedEvent);
  }, [currentUser]);

  const handleRequestNotification = async () => {
    const granted = await browserNotifications.requestPermission();
    setNotificationPermission(granted ? 'granted' : 'denied');
    if (granted) {
      browserNotifications.send({
        title: 'اعلان‌های سامانه ارزیابی عملکرد فعال شد',
        body: 'از این پس یادآوری‌های تاییدات و سررسید کارتابل‌ها را به صورت خودکار دریافت خواهید کرد.'
      });
    }
  };

  const getTourStepsForRole = (user: Employee): GuidedTourStep[] => {
    const steps: GuidedTourStep[] = user.role === 'employee' ? [
        { tab: 'my-evaluation', title: 'کارنامه و خودارزیابی من', desc: 'مشاهده شاخص‌های تخصصی شغل خود، امتیازدهی ۱ تا ۵ و ارسال نهایی به سرپرست' },
        { tab: 'workflow', title: 'گردش کار و تاییدات', desc: 'رهگیری پرونده‌های شما، مشاهده مرحله جاری و پیگیری درخواست بازنگری' }
      ] : user.role === 'supervisor' ? [
        { tab: 'dashboard', title: 'داشبورد ارزیابی و هدف‌گذاری', desc: 'مرور وضعیت ارزیابی‌ها و ثبت هدف‌های بهبود برای همکاران' },
        { tab: 'workflow', title: 'کارتابل و گردش کار', desc: 'دیدن پرونده‌های منتظر اقدام، بررسی آن‌ها و فرستادن به مرحله بعد' },
        { tab: 'evaluations', title: 'فرم‌های ارزیابی و بازخورد', desc: 'ثبت امتیازها و توضیحات لازم برای ارزیابی هر همکار' },
        { tab: 'employees', title: 'لیست پرسنل و کنترل وضعیت', desc: 'بررسی وضعیت تکمیل ارزیابی زیرمجموعه و شروع سریع ارزیابی دوره‌ای' },
        { tab: 'reports', title: 'گزارش‌ها و ماتریس استعداد', desc: 'مرور نمره‌ها و جایگاه همکاران بر پایه شایستگی‌ها' }
      ] : [
        { tab: 'dashboard', title: 'داشبورد مدیریت', desc: 'مرور وضعیت ارزیابی‌ها و شاخص‌های کلیدی سازمان' },
        { tab: 'workflow', title: 'مدیریت گردش کار و انتساب سازمانی', desc: 'پیکربندی مراحل سازمانی، قوانین تایید و انتساب گروهی سرپرستان' },
        { tab: 'evaluations', title: 'دوره‌ها و ارزیابی‌ها', desc: 'مدیریت دوره‌ها و ورود داده‌های MIS و کسری از همین بخش' },
        { tab: 'criteria', title: 'بانک مرکزی شاخص‌ها', desc: 'تعریف و فرمول‌بندی معیارهای کمی و کیفی بر اساس ابعاد پنج‌گانه شایستگی' },
        { tab: 'profiles', title: 'پروفایل‌های شغلی و اوزان', desc: 'تنظیم اوزان شاخص‌ها (مجموع ۱۰۰٪) و درج اجباری شاخص ایمنی HSE' },
        { tab: 'employees', title: 'مدیریت پرسنل و ساختار', desc: 'ویرایش پرسنل، انتساب مشاغل و تعیین سلسله‌مراتب ارزیابی' },
        { tab: 'evaluations', title: 'فرم‌های ارزیابی سازمانی', desc: 'پایش جامع نمرات، آپلود اکسل و بررسی مستندات پرونده‌ها' },
        { tab: 'calibration', title: 'پنل کالیبراسیون کمیته', desc: 'کنترل توزیع زنگوله‌ای نمرات و جلوگیری از تورم نمره‌ای' },
        { tab: 'reports', title: 'گزارش‌ها و ماتریس استعداد', desc: 'مرور روندها و دریافت خروجی کارنامه‌ها' },
        { tab: 'settings', title: 'مرکز امنیت و پشتیبان‌گیری', desc: 'مدیریت کاربران، کلمات عبور، لاگ‌ها و بکاپ‌گیری ابری' }
      ];
    return steps.filter(step => canAccessTab(user, step.tab));
  };

  const currentTourSteps = currentUser ? getTourStepsForRole(currentUser) : [];

  const guidedTourPreferenceKey = (user: Employee) => `pe_guided_tour_${GUIDED_TOUR_VERSION}_${user.id}_${user.role}`;

  useEffect(() => {
    if (activeTourStep === null || !currentUser) return;
    const expectedTab = getTourStepsForRole(currentUser)[activeTourStep]?.tab;
    if (!expectedTab || currentTab !== expectedTab) setActiveTourStep(null);
  }, [activeTourStep, currentTab, currentUser?.id, currentUser?.role, cloudDataVersion]);

  const handleOpenOnboarding = () => {
    setActiveTourStep(null);
    setCurrentTab('onboarding');
  };

  const handleStartInteractiveTour = () => {
    if (!currentUser) return;
    const steps = getTourStepsForRole(currentUser);
    if (steps.length > 0) {
      setActiveTourStep(0);
      setCurrentTab(steps[0].tab);
    }
  };

  const handleNextTourStep = () => {
    if (activeTourStep === null || !currentUser) return;
    const steps = getTourStepsForRole(currentUser);
    if (activeTourStep < steps.length - 1) {
      const nextStep = activeTourStep + 1;
      setActiveTourStep(nextStep);
      setCurrentTab(steps[nextStep].tab);
    } else {
      setActiveTourStep(null);
      localStorage.setItem(guidedTourPreferenceKey(currentUser), 'completed');
    }
  };

  const handlePrevTourStep = () => {
    if (activeTourStep === null || !currentUser) return;
    const steps = getTourStepsForRole(currentUser);
    if (activeTourStep > 0) {
      const prevStep = activeTourStep - 1;
      setActiveTourStep(prevStep);
      setCurrentTab(steps[prevStep].tab);
    }
  };

  const handleNeverShowTour = () => {
    if (!currentUser) return;
    localStorage.setItem(guidedTourPreferenceKey(currentUser), 'never');
    setActiveTourStep(null);
  };

  const [themePreference, setThemePreference] = useState<'dark' | 'light' | 'system'>(() => {
    const savedMode = localStorage.getItem('pe_theme_mode');
    if (savedMode === 'dark' || savedMode === 'light' || savedMode === 'system') return savedMode;
    return localStorage.getItem('pe_theme') === 'dark' ? 'dark' : 'light';
  });
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const theme: 'dark' | 'light' = themePreference === 'system' ? (systemPrefersDark ? 'dark' : 'light') : themePreference;
  const themePreferenceLabel = themePreference === 'system' ? 'خودکار' : themePreference === 'dark' ? 'تیره' : 'روشن';

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    setSystemPrefersDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    localStorage.setItem('pe_theme_mode', themePreference);
    localStorage.setItem('pe_theme', theme);
  }, [theme, themePreference]);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; visible: boolean } | null>(null);

  const navigationKeyFor = (user: Employee) => `pe_last_tab_${user.id}_${user.username.toLowerCase()}`;
  const restoreNavigationFor = (user: Employee): string => {
    const onboarding = readOnboardingPreferences(user);
    if (!onboarding.seen && !onboarding.dismissed && !onboarding.dontShowAutomatically) return 'onboarding';
    const saved = localStorage.getItem(navigationKeyFor(user));
    const canonicalTab = saved === 'imports' ? 'evaluations' : saved;
    return canonicalTab && canAccessTab(user, canonicalTab) ? canonicalTab : defaultTabFor(user);
  };

  const [criteria, setCriteria] = useState<Criterion[]>(() => db.getCriteria());
  const [profiles, setProfiles] = useState<JobProfile[]>(() => db.getProfiles());
  const [employees, setEmployees] = useState<Employee[]>(() => db.getEmployees());
  const [evaluations, setEvaluations] = useState<Evaluation[]>(() => db.getEvaluations());
  const [archivedEvaluations, setArchivedEvaluations] = useState<Evaluation[]>(() => db.getArchivedEvaluations());
  const [delegations, setDelegations] = useState<DelegationRecord[]>(() => db.getDelegations());
  const [notifications, setNotifications] = useState<UserNotification[]>(() => db.getMiscData<UserNotification[]>('pe_notifications', []));

  const notifyDataSaved = useCallback(() => {
    setSaveIndicator(true);
    const t = setTimeout(() => setSaveIndicator(false), 2000);
    return () => clearTimeout(t);
  }, []);

  // Multi-tab and intra-app real-time synchronization
  useEffect(() => {
    // 1. Intra-app reactive listener for instant updates across all forms
    const unsubscribe = db.subscribe((key, data) => {
      if (key === 'pe_criteria') setCriteria(data || db.getCriteria());
      else if (key === 'pe_profiles') setProfiles(data || db.getProfiles());
      else if (key === 'pe_employees') setEmployees(data || db.getEmployees());
      else if (key === 'pe_evaluations') setEvaluations(data || db.getEvaluations());
      else if (key === 'pe_archived_evaluations') setArchivedEvaluations(data || db.getArchivedEvaluations());
      else if (key === 'pe_delegations') setDelegations(data || db.getDelegations());
      else if (key === 'pe_notifications') setNotifications(data || db.getMiscData<UserNotification[]>('pe_notifications', []));
      notifyDataSaved();
    });
    // Business collections are announced across tabs only after server acceptance.
    // Raw storage events can also expose a temporarily staged, unaccepted write.
    const unsubscribeDomain = db.subscribeDomainEvents(() => setCloudDataVersion(version => version + 1));

    return () => {
      unsubscribe();
      unsubscribeDomain();
    };
  }, [notifyDataSaved]);

  // Check and alert pending tasks if user is logged in
  useEffect(() => {
    if (!currentUser) return;

    if (currentUser.role === 'supervisor') {
      const pendingEvals = evaluations.filter(ev => {
        const emp = employees.find(e => e.id === ev.empId);
        return emp && ev.stage === 'supervisor_review' && ev.currentAssigneeId === currentUser.id && (ev.status === 'draft' || ev.status === 'pending');
      });
      if (pendingEvals.length > 0 && notificationPermission === 'granted') {
        const lastAlert = sessionStorage.getItem('pe_last_notif_alert');
        if (!lastAlert) {
          browserNotifications.sendWorkflowDeadlineAlert('supervisor', pendingEvals.length, 'پایان ماه جاری');
          sessionStorage.setItem('pe_last_notif_alert', 'true');
        }
      }
    } else if (currentUser.role === 'employee') {
      const myEval = evaluations.find(ev => ev.empId === currentUser.id);
      const selfReviewPending = Boolean(myEval && (myEval.stage === 'self_review' || myEval.stage === 'rejected') &&
        myEval.requiresSelfReview !== false && myEval.scores.every(s => s.self === 0));
      if (selfReviewPending && notificationPermission === 'granted') {
        const lastAlert = sessionStorage.getItem('pe_last_notif_emp_alert');
        if (!lastAlert) {
          browserNotifications.sendWorkflowDeadlineAlert('employee', 1);
          sessionStorage.setItem('pe_last_notif_emp_alert', 'true');
        }
      }
    }
  }, [currentUser, evaluations, employees, notificationPermission]);

  // Session user storage is handled strictly inside sessionStorage on handleLogin / handleLogout

  useEffect(() => {
    document.documentElement.classList.toggle('light-theme', theme === 'light');
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    const handleGlobalClick = () => setContextMenu(null);
    window.addEventListener('click', handleGlobalClick);
    return () => window.removeEventListener('click', handleGlobalClick);
  }, []);

  const handleLogin = (emp: Employee) => {
    const sanitized = sanitizeUser(emp);
    if (!sanitized) return;
    sessionStorage.setItem('pe_session_user', JSON.stringify(sanitized));
    if (!import.meta.env.DEV) localStorage.setItem('pe_server_session_hint', '1');
    if (sanitized.role === 'admin') {
      sessionStorage.setItem('pe_admin_session_logged_at', new Date().toISOString());
    }
    setCurrentUser(sanitized);
    setSessionChecked(true);
    setActiveTourStep(null);
    setCurrentTab(restoreNavigationFor(sanitized));
  };

  const handleLogout = () => {
    setActiveTourStep(null);
    if (import.meta.env.DEV) db.stopCloudSync();
    else {
      db.clearAuthorizedCache();
      setEmployees([]);
      setEvaluations([]);
      setArchivedEvaluations([]);
      setProfiles([]);
      setCriteria([]);
    }
    setDelegations([]);
    fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
    clearLegacyAdminSessions();
    localStorage.removeItem('pe_server_session_hint');
    sessionStorage.removeItem('pe_last_notif_alert');
    sessionStorage.removeItem('pe_last_notif_emp_alert');
    setCurrentUser(null);
    setActiveEvalId(null);
    setWorkflowNotificationFocus(null);
    setCurrentTab('dashboard');
  };

  const handleForceAdminReauth = useCallback(() => {
    db.stopCloudSync();
    clearLegacyAdminSessions();
    setCurrentUser(null);
    setActiveEvalId(null);
    setWorkflowNotificationFocus(null);
    setCurrentTab('dashboard');
  }, []);

  const handleForceCloudSync = async () => {
    if (cloudStatus.status === 'syncing') return;
    if (cloudStatus.conflict) return;
    setContextMenu(null);
    await db.refreshFromCloudNow();
  };

  const handleResolveCloudConflict = async (choice: 'local' | 'remote') => {
    await db.resolveCloudRevisionConflict(choice);
  };

  const handleRetryRejectedCloudWrite = async () => {
    await db.retryRejectedCloudWrite();
  };

  const handleToggleTheme = () => {
    setThemePreference(prev => prev === 'light' ? 'dark' : prev === 'dark' ? 'system' : 'light');
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    // DO NOT intercept right-clicks on inputs or textareas so native copy/paste works!
    const target = e.target as HTMLElement;
    if (target.tagName.toLowerCase() === 'input' || target.tagName.toLowerCase() === 'textarea' || target.isContentEditable) {
      return; // allow native menu
    }
    e.preventDefault();
    const menuWidth = 280;
    const menuHeight = 440;
    let x = e.clientX;
    let y = e.clientY;
    if (x + menuWidth > window.innerWidth) x = Math.max(10, window.innerWidth - menuWidth - 15);
    if (y + menuHeight > window.innerHeight) y = Math.max(10, window.innerHeight - menuHeight - 15);
    setContextMenu({ x, y, visible: true });
  };

  const handleQuickJSONBackup = () => {
    const dataToExport = {
      meta: { app: 'سیستم ارزیابی عملکرد', version: '5.0.0-Cloudflare', exportDate: new Date().toISOString(), exportedBy: currentUser?.name || 'ناشناس' },
      employees, profiles, criteria, evaluations
    };
    const jsonString = `data:text/json;charset=utf-8,${encodeURIComponent(JSON.stringify(dataToExport, null, 2))}`;
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', jsonString);
    downloadAnchor.setAttribute('download', `chalak_quick_backup_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    setContextMenu(null);
  };

  const handleAddCriterion = (crit: Omit<Criterion, 'id'>): boolean => {
    const valResult = validateCriterionInput(crit);
    if (!valResult.success) {
      alert(valResult.errors.join('\n'));
      return false;
    }
    const validated = valResult.data;
    const exists = criteria.some(c => c.code.trim().toUpperCase() === validated.code.trim().toUpperCase());
    if (exists) return false;
    db.addCriterion(validated);
    setCriteria(db.getCriteria());
    notifyDataSaved();
    return true;
  };

  const handleUpdateCriterion = (id: string, crit: Omit<Criterion, 'id'>): boolean => {
    const valResult = validateCriterionInput(crit);
    if (!valResult.success) {
      alert(valResult.errors.join('\n'));
      return false;
    }
    const validated = valResult.data;
    const isDuplicate = criteria.some(c => c.code.trim().toUpperCase() === validated.code.trim().toUpperCase() && c.id !== id);
    if (isDuplicate) return false;
    db.updateCriterion(id, validated);
    setCriteria(db.getCriteria());
    notifyDataSaved();
    return true;
  };

  const handleDeleteCriterion = (id: string) => {
    const res = db.deleteCriterion(id);
    if (res.success) {
      setCriteria(db.getCriteria());
      setProfiles(db.getProfiles());
      setEvaluations(db.getEvaluations());
      notifyDataSaved();
    } else {
      alert('خطا در حذف شاخص');
    }
  };

  const handleAddProfile = (prof: Omit<JobProfile, 'id'>) => {
    const valResult = validateJobProfileInput(prof);
    if (!valResult.success) {
      alert(valResult.errors.join('\n'));
      return;
    }
    db.addProfile(valResult.data);
    setProfiles(db.getProfiles());
    notifyDataSaved();
  };

  const handleUpdateProfile = (id: string, prof: Omit<JobProfile, 'id'>) => {
    const valResult = validateJobProfileInput(prof);
    if (!valResult.success) {
      alert(valResult.errors.join('\n'));
      return;
    }
    db.updateProfile(id, valResult.data);
    setProfiles(db.getProfiles());
    notifyDataSaved();
  };

  const handleDeleteProfile = (id: string) => {
    const res = db.deleteProfile(id, true);
    if (!res.success) {
      alert(res.error || 'خطا در حذف پروفایل شغلی.');
      return;
    }
    setProfiles(db.getProfiles());
    setEmployees(db.getEmployees());
    notifyDataSaved();
  };

  const handleBulkDeleteProfiles = (ids: string[]) => {
    const res = db.deleteProfilesBatch(ids);
    setProfiles(db.getProfiles());
    setEmployees(db.getEmployees());
    notifyDataSaved();
  };

  const handleToggleLockProfile = (id: string) => {
    const prof = profiles.find(p => p.id === id);
    if (prof) {
      db.updateProfile(id, { ...prof, locked: !prof.locked });
      setProfiles(db.getProfiles());
      notifyDataSaved();
    }
  };

  const handleAddEmployee = (emp: Omit<Employee, 'id'>) => {
    const valResult = validateEmployeeInput(emp);
    if (!valResult.success) {
      alert(valResult.errors.join('\n'));
      return;
    }
    const { employee: newEmp, evaluation } = db.addEmployee(valResult.data);
    setEmployees(db.getEmployees());
    if (evaluation) {
      setEvaluations(db.getEvaluations());
    }
    notifyDataSaved();
  };

  const renameCloudCredential = async (oldUsername: string, newUsername: string): Promise<boolean> => {
    if (oldUsername.trim().toLowerCase() === newUsername.trim().toLowerCase()) return true;
    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename', oldUsername, username: newUsername }),
      });
      const isJson = (response.headers.get('Content-Type') || '').includes('application/json');
      if (!isJson) return import.meta.env.DEV;
      const result = await response.json() as { error?: string };
      if (!response.ok) alert(result.error || 'انتقال اطلاعات ورود به نام کاربری جدید ناموفق بود.');
      return response.ok;
    } catch {
      if (!import.meta.env.DEV) alert('ارتباط با سرویس مدیریت حساب برقرار نشد.');
      return import.meta.env.DEV;
    }
  };

  const handleUpdateEmployee = async (id: string, emp: Omit<Employee, 'id'>) => {
    const valResult = validateEmployeeInput(emp);
    if (!valResult.success) {
      alert(valResult.errors.join('\n'));
      return;
    }
    const existing = employees.find(employee => employee.id === id);
    if (existing && !(await renameCloudCredential(existing.username, valResult.data.username))) return;
    db.updateEmployee(id, valResult.data);
    setEmployees(db.getEmployees());
    notifyDataSaved();
  };

  const removeCloudCredential = async (username: string) => {
    try {
      const response = await fetch('/api/auth/password', {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const isApiResponse = (response.headers.get('Content-Type') || '').includes('application/json');
      return !isApiResponse && import.meta.env.DEV ? true : response.ok;
    } catch {
      return import.meta.env.DEV;
    }
  };

  const removeCloudCredentialsBulk = async (usernames: string[]): Promise<boolean> => {
    if (usernames.length === 0) return true;
    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bulk_delete', usernames }),
      });
      const isApiResponse = (response.headers.get('Content-Type') || '').includes('application/json');
      return !isApiResponse && import.meta.env.DEV ? true : response.ok;
    } catch {
      return import.meta.env.DEV;
    }
  };

  const handleDeleteEmployee = async (id: string): Promise<boolean> => {
    const target = employees.find(e => e.id === id);
    if (!target) return false;
    const blockReason = getEmployeeDeletionBlockReason(target, employees.filter(employee => employee.id !== id), evaluations, db.getArchivedEvaluations());
    if (blockReason) {
      alert(employeeDeletionBlockMessage(blockReason));
      return false;
    }
    if (!(await removeCloudCredential(target.username))) {
      alert('حذف اطلاعات ورود کاربر از سرور ناموفق بود؛ عملیات حذف متوقف شد.');
      return false;
    }
    const success = db.deleteEmployee(id);
    if (success) {
      if (activeEvalId && evaluations.some(item => item.id === activeEvalId && item.empId === id)) {
        setActiveEvalId(null);
      }
      setEmployees(db.getEmployees());
      setEvaluations(db.getEvaluations());
      notifyDataSaved();
      return true;
    }
    return false;
  };

  const handleBulkDeleteEmployees = async (ids: string[]): Promise<boolean> => {
    if (!ids || ids.length === 0) return false;
    const deletionPlan = planEmployeeBulkDeletion(ids, employees, evaluations, db.getArchivedEvaluations());
    const targets = employees.filter(employee => deletionPlan.deletableIds.has(employee.id));
    const blockedCount = new Set(ids).size - targets.length;
    if (!targets.length) {
      alert('کارکنان انتخاب‌شده سابقه، پرونده باز، رابطه سازمانی یا حساب محافظت‌شده دارند و حذف نشدند.');
      return false;
    }
    // Single bulk credential deletion — ONE request, not N per employee.
    if (!(await removeCloudCredentialsBulk(targets.map(t => t.username).filter(Boolean)))) {
      alert('حذف اطلاعات ورود گروهی از سرور ناموفق بود؛ عملیات گروهی متوقف شد.');
      return false;
    }
    const remaining = employees.filter(employee => !deletionPlan.deletableIds.has(employee.id));
    const accepted = await db.commitBulkState({ pe_employees: remaining }, crypto.randomUUID(), { pe_employees: JSON.stringify(employees) });
    if (!accepted) return false;
    setEmployees(db.getEmployees());
    notifyDataSaved();
    if (blockedCount) alert(`${targets.length} کارمند حذف شد؛ ${blockedCount} مورد به‌دلیل سابقه، پرونده باز، رابطه سازمانی یا حساب محافظت‌شده باقی ماند.`);
    return true;
  };

  const handleBulkUpdateEmployees = async (updatedList: Employee[], operationId?: string): Promise<boolean> => {
    if (!(await db.commitBulkState({ pe_employees: updatedList }, operationId || crypto.randomUUID(), { pe_employees: JSON.stringify(employees) }))) return false;
    setEmployees(db.getEmployees());
    notifyDataSaved();
    return true;
  };

  const handleImportEmployees = async (
    updatedList: Employee[],
    sourceImport: import('./utils/sourceImports').MasterDataSourceImportContext,
  ): Promise<boolean> => {
    const accepted = await db.saveEmployeesWithSourceImport(updatedList, sourceImport);
    if (!accepted) return false;
    setEmployees(db.getEmployees());
    notifyDataSaved();
    return true;
  };

  const handleBulkUpdateEvaluations = async (updatedEvals: Evaluation[], sourceImport?: import('./utils/sourceImports').EvaluationSourceImportContext, operationId?: string): Promise<boolean> => {
    const before = new Map(evaluations.map(record => [record.id, record]));
    const changes = updatedEvals.filter(record => JSON.stringify(record) !== JSON.stringify(before.get(record.id)));
    if (!changes.length) return false;
    const ids = new Set(changes.map(record => record.id));
    const accepted = await db.commitEvaluationChanges(changes, operationId || sourceImport?.operationId || crypto.randomUUID(), sourceImport, evaluations.filter(record => ids.has(record.id)));
    if (!accepted) return false;
    setEvaluations(db.getEvaluations());
    notifyDataSaved();
    return true;
  };

  const handleWorkflowTransitionCommit = async (updatedEvaluation: Evaluation, operationId: string) => {
    const accepted = await handleBulkUpdateEvaluations([updatedEvaluation], undefined, operationId);
    const failure = accepted ? null : db.getLastCloudWriteFailure();
    return {
      accepted,
      retryable: Boolean(!accepted && failure?.retryable && db.hasPendingBulkOperation()),
      message: failure?.message,
    };
  };

  const handleRetryPendingWorkflowOperation = async () => {
    const accepted = await db.retryPendingBulkOperation();
    if (accepted) {
      setEmployees(db.getEmployees());
      setEvaluations(db.getEvaluations());
      notifyDataSaved();
    }
    const failure = accepted ? null : db.getLastCloudWriteFailure();
    return {
      accepted,
      retryable: Boolean(!accepted && failure?.retryable && db.hasPendingBulkOperation()),
      message: failure?.message,
    };
  };

  const handleSetProfiles = (updatedProfiles: JobProfile[]) => {
    db.saveProfiles(updatedProfiles);
    setProfiles(updatedProfiles);
    notifyDataSaved();
  };

  const handleSetCriteria = (updatedCriteria: Criterion[]) => {
    db.saveCriteria(updatedCriteria);
    setCriteria(updatedCriteria);
    notifyDataSaved();
  };

  const handleUpdateDelegations = (updatedDelegations: DelegationRecord[]) => {
    db.saveDelegations(updatedDelegations);
    setDelegations(db.getDelegations());
    notifyDataSaved();
  };

  const handleSetArchivedEvaluations = (updatedArchived: Evaluation[]) => {
    db.saveArchivedEvaluations(updatedArchived);
    setArchivedEvaluations(updatedArchived);
    notifyDataSaved();
  };

  const handleAddEvaluation = (empId: string, period: string) => {
    handleBulkStartEvaluations([empId], period);
  };

  const handleActivateEvaluationPeriod = (period: string): boolean => {
    if (currentUser?.role !== 'admin' || !period.trim()) return false;
    db.saveMiscData('pe_active_period', period.trim());
    notifyDataSaved();
    return true;
  };

  const handleBulkStartEvaluations = async (employeeIds: string[], period: string): Promise<boolean> => {
    if (currentUser?.role !== 'admin' || !isEvaluationPeriodActive(db.getMiscData<string>('pe_active_period', ''), period)) return false;
    const routeRules = db.getMiscData('pe_route_rules', DEFAULT_ROUTE_RULES);
    const newEvaluations = buildEvaluationStarts(employeeIds, period, employees, profiles, evaluations, Date.now(), routeRules);
    if (!newEvaluations.length) return false;
    const next = [...evaluations, ...newEvaluations];
    if (!(await db.commitEvaluationChanges(newEvaluations, crypto.randomUUID()))) return false;
    setEvaluations(db.getEvaluations());
    setActiveEvalId(newEvaluations[0].id);
    setCurrentTab('evaluations');
    notifyDataSaved();
    return true;
  };

  const handleUpdateEvaluation = (id: string, updatedEv: Evaluation) => {
    setEvaluations(prev => {
      const exists = prev.some(e => e.id === id);
      const next = exists ? prev.map(e => e.id === id ? updatedEv : e) : [...prev, updatedEv];
      db.saveEvaluations(next);
      return next;
    });
    notifyDataSaved();
  };

  const handleBatchAddCriteria = (
    newOrUpdatedList: Array<Omit<Criterion, 'id'> & { id?: string }>,
    mode: 'merge' | 'prefix_dept' | 'skip_existing' | 'replace' = 'merge',
    sourceImport?: import('./utils/sourceImports').MasterDataSourceImportContext,
  ): Promise<boolean> | boolean => {
    const batchMode = mode === 'replace' ? 'replace' : mode === 'skip_existing' ? 'skip_existing' : 'merge';
    const prepared = db.prepareCriteriaBatch(newOrUpdatedList, batchMode);
    if (sourceImport) {
      return db.saveCriteriaWithSourceImport(prepared.criteria, sourceImport).then(accepted => {
        if (!accepted) return false;
        setCriteria(db.getCriteria());
        notifyDataSaved();
        return true;
      });
    }
    db.saveCriteria(prepared.criteria);
    setCriteria(db.getCriteria());
    notifyDataSaved();
    return true;
  };

  const handleDeleteEvaluation = (id: string) => {
    if (!db.deleteEvaluation(id)) {
      alert('ارزیابی نهایی یا بایگانی‌شده برای حفظ سوابق حذف نمی‌شود.');
      return;
    }
    setEvaluations(db.getEvaluations());
    if (activeEvalId === id) setActiveEvalId(null);
    notifyDataSaved();
  };

  const handleBulkDeleteCriteria = (ids: string[]) => {
    const res = db.deleteCriteriaBatch(ids);
    if (res.deletedCount > 0) {
      setCriteria(db.getCriteria());
      setProfiles(db.getProfiles());
      setEvaluations(db.getEvaluations());
      notifyDataSaved();
    }
  };

  const handleBulkDeleteEvaluations = async (ids: string[]): Promise<boolean> => {
    const selected = new Set(ids);
    const remaining = evaluations.filter(e => !selected.has(e.id) || e.status === 'locked' || e.stage === 'completed');
    if (remaining.length === evaluations.length) return false;
    if (await db.commitBulkState({ pe_evaluations: remaining }, crypto.randomUUID(), { pe_evaluations: JSON.stringify(evaluations) })) {
      setEvaluations(db.getEvaluations());
      if (activeEvalId && !remaining.some(e => e.id === activeEvalId)) {
        setActiveEvalId(null);
      }
      notifyDataSaved();
      return true;
    }
    return false;
  };

  const handleStartEvaluationDirect = (empId: string) => {
    const period = db.getMiscData<string>('pe_active_period', '').trim();
    if (!period) {
      alert('برای آغاز ارزیابی، ابتدا یک دوره را در بخش ارزیابی‌ها فعال کنید.');
      return;
    }
    const existing = evaluations.find(ev => ev.empId === empId && ev.period === period);
    if (existing) {
      setActiveEvalId(existing.id);
      setCurrentTab('evaluations');
    } else {
      handleAddEvaluation(empId, period);
    }
  };

  const handleSelectEvaluation = (id: string) => {
    setActiveEvalId(id);
    setCurrentTab('evaluations');
  };

  const markNotificationRead = (id: string) => {
    const updated = notifications.map(item => item.id === id && !item.readAt ? { ...item, readAt: new Date().toISOString() } : item);
    db.saveMiscData('pe_notifications', updated);
  };

  const markAllNotificationsRead = () => {
    const readAt = new Date().toISOString();
    db.saveMiscData('pe_notifications', notifications.map(item => item.readAt ? item : { ...item, readAt }));
  };

  const openNotification = (notification: UserNotification) => {
    const evaluation = notification.evaluationId ? evaluations.find(item => item.id === notification.evaluationId) : undefined;
    const currentTaskKey = evaluation ? workflowTaskIdentity(evaluation) : undefined;
    const stale = Boolean(notification.resolvedAt || (notification.evaluationId && (!evaluation || evaluation.currentAssigneeId !== currentUser.id || (notification.taskKey && notification.taskKey !== currentTaskKey))) ||
      (evaluation && notification.targetTab === 'workflow' && !getActionableWorkflowTasks(currentUser, [evaluation], { employees, delegations, allowUnlistedHseReviewer: true }).length));
    if (stale) {
      markNotificationRead(notification.id);
      setNotificationNotice('این اعلان مربوط به اقدام قبلی است و دیگر باز نیست. کارتابل وضعیت فعلی را نشان می‌دهد.');
      return;
    }
    if (notification.evaluationId) {
      setActiveEvalId(notification.evaluationId);
      workflowNotificationSequence.current += 1;
      setWorkflowNotificationFocus({ evaluationId: notification.evaluationId, sequence: workflowNotificationSequence.current });
    }
    setCurrentTab(notification.targetTab);
  };

  const getTabTitle = (tab: string) => {
    switch (tab) {
      case 'dashboard': return 'داشبورد مدیریت';
      case 'workflow': return 'گردش کار و تاییدات';
      case 'criteria': return 'بانک شاخص‌ها';
      case 'profiles': return 'پروفایل‌های شغلی';
      case 'employees': return 'مدیریت کارکنان';
      case 'evaluations': return 'فرم‌های ارزیابی';
      case 'calibration': return 'کالیبراسیون عملکرد';
      case 'reports': return 'گزارشات سازمانی';
      case 'rewards': return 'محاسبات ریالی و پاداش';
      case 'lattice-hub': return 'مدیریت اهداف و استعدادها (Lattice)';
      case 'kickidler-hub': return 'پایش بهره‌وری و زمان کار (Kickidler)';
      case 'onboarding': return 'راهنمای تعاملی';
      case 'my-evaluation': return 'ارزیابی من';
      case 'settings': return 'تنظیمات امنیتی';
      default: return 'سیستم مدیریت عملکرد';
    }
  };

  useEffect(() => {
    if (currentUser && !canAccessTab(currentUser, currentTab)) {
      setCurrentTab(defaultTabFor(currentUser));
    }
  }, [currentUser, currentTab, cloudDataVersion]);

  useEffect(() => {
    if (sessionChecked && currentUser && canAccessTab(currentUser, currentTab)) {
      localStorage.setItem(navigationKeyFor(currentUser), currentTab);
    }
  }, [sessionChecked, currentUser?.id, currentUser?.username, currentTab]);

  if (!sessionChecked) {
    return <div className="min-h-screen grid place-items-center bg-slate-950 text-slate-300" dir="rtl">در حال بررسی نشست امن…</div>;
  }

  if (!currentUser) {
    return <Login employees={employees} onLogin={handleLogin} theme={theme} />;
  }

  if (!canAccessTab(currentUser, currentTab)) {
    return <div className="min-h-screen grid place-items-center bg-slate-950 text-slate-400" dir="rtl">در حال انتقال به بخش مجاز…</div>;
  }

  return (
    <div onContextMenu={handleContextMenu} data-theme={theme} data-theme-mode={themePreference} className={`app-shell flex flex-col md:flex-row h-screen overflow-hidden font-sans text-right transition-colors duration-300 relative ${theme === 'dark' ? 'bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-800'}`} dir="rtl">
      
      <header className={`md:hidden flex items-center justify-between px-4 py-3 border-b z-30 shrink-0 ${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
        <div className="flex items-center gap-2.5">
          <IconButton onClick={() => setIsMobileMenuOpen(true)} className="border-transparent bg-transparent text-teal-500 hover:bg-slate-800/50" label="منو" aria-controls="app-mobile-navigation" aria-expanded={isMobileMenuOpen}>
            <Menu className="w-5 h-5" />
          </IconButton>
          <span className="text-xs font-black tracking-tight">{navigationLocation(currentTab).title || getTabTitle(currentTab)}</span>
        </div>
        <div className="flex items-center gap-2">
          <IconButton
            data-testid="connection-sync-control"
            onClick={handleForceCloudSync}
            disabled={connectionState === 'SYNCING'}
            title={`${connectionLabel} · ${cloudStatus.message}`}
            label={connectionLabel}
            className={`p-1.5 rounded-xl border transition-colors ${connectionTone}`}
          >
            <RefreshCw className={`w-4 h-4 ${connectionState === 'SYNCING' ? 'animate-spin' : ''}`} />
          </IconButton>
          {['write_rejected', 'authentication_required', 'conflict'].includes(cloudStatus.status) && (
            <span role="status" aria-live="polite" className="max-w-[50vw] truncate text-[10px] text-rose-400" title={cloudStatus.message}>{cloudStatus.status === 'write_rejected' ? 'ذخیره ابری رد شد' : cloudStatus.status === 'authentication_required' ? 'ورود دوباره لازم است' : 'تعارض نسخه'}</span>
          )}
          {cloudStatus.status === 'error' && cloudStatus.retryable && (
            <button type="button" role="status" aria-live="polite" onClick={handleForceCloudSync} className="max-w-[34vw] truncate rounded-lg px-2 py-2 text-[10px] font-bold text-amber-600 dark:text-amber-300" title={cloudStatus.message}>ذخیره موقتاً در دسترس نیست · تلاش مجدد</button>
          )}
          <button 
            type="button" 
            onClick={() => setIsManualModalOpen(true)} 
            className="p-1.5 rounded-xl bg-teal-500/10 text-teal-400 hover:bg-teal-500/20 transition-colors cursor-pointer"
            title="کتابچه راهنما و دانلود PDF"
          >
            <BookOpen className="w-4 h-4" />
          </button>
          <SupervisorNotificationBell
            evaluations={evaluations}
            employees={employees}
            delegations={delegations}
            currentUser={currentUser}
            onNavigate={setCurrentTab}
            theme={theme}
            notifications={notifications}
            onMarkNotificationRead={markNotificationRead}
            onMarkAllNotificationsRead={markAllNotificationsRead}
            onOpenNotification={openNotification}
          />
          <IconButton onClick={handleToggleTheme} className="border-transparent bg-transparent" label={`پوسته ${themePreferenceLabel}؛ برای تغییر کلیک کنید`}>
            {themePreference === 'system' ? <Monitor className="w-4 h-4 text-teal-500" /> : theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-indigo-600" />}
          </IconButton>
        </div>
      </header>

      <Sidebar 
        currentTab={currentTab} 
        onChangeTab={(tab) => { const canonicalTab = tab === 'imports' ? 'evaluations' : tab; setCurrentTab(canonicalTab); if (canonicalTab !== 'evaluations') setActiveEvalId(null); }} 
        currentUser={currentUser} onLogout={handleLogout} theme={theme} themePreference={themePreference} onToggleTheme={handleToggleTheme} 
        onStartTour={handleOpenOnboarding}
        onOpenManual={() => setIsManualModalOpen(true)}
        isMobileOpen={isMobileMenuOpen} onCloseMobile={closeMobileMenu} 
      />

      <main className={`app-main min-w-0 flex-1 overflow-y-auto transition-colors duration-300 ${theme === 'dark' ? 'bg-slate-950' : 'bg-slate-50'}`}>
        {/* Desktop Sticky Header with Supervisor Overdue Notification Bell */}
        <div className={`hidden md:flex flex-wrap items-center justify-between gap-3 px-5 lg:px-8 py-3 border-b sticky top-0 z-20 backdrop-blur-xl ${
          theme === 'dark' ? 'bg-slate-950/90 border-slate-800/80' : 'bg-white/90 border-slate-200/80 shadow-sm'
        }`}>
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <span className="text-sm font-extrabold tracking-tight">{navigationLocation(currentTab).title || getTabTitle(currentTab)}</span>
            <span className="hidden xl:inline h-4 w-px bg-slate-200 dark:bg-slate-800" aria-hidden="true" />
            <span aria-label="موقعیت صفحه" className="text-xs text-slate-500 font-medium">{navigationLocation(currentTab).group} / {navigationLocation(currentTab).title}</span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              data-testid="connection-sync-control"
              onClick={handleForceCloudSync}
              disabled={connectionState === 'SYNCING'}
              title={`${connectionLabel} · ${cloudStatus.message}${cloudStatus.revision !== undefined ? ` — نسخه ${cloudStatus.revision}` : ''}`}
              className={`text-[10px] font-bold flex items-center gap-1 px-2.5 py-1 rounded-full border transition-colors ${connectionTone}`}
            >
              <RefreshCw className={`w-3 h-3 ${connectionState === 'SYNCING' ? 'animate-spin' : ''}`} />
              {connectionLabel}
            </button>
            {cloudStatus.status === 'write_rejected' && (
              <div role="status" aria-live="polite" className="flex max-w-[560px] items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-[10px] text-rose-200">
                <span>{cloudStatus.message}</span>
                <button type="button" onClick={handleRetryRejectedCloudWrite} className="shrink-0 rounded-lg bg-rose-500/20 px-2 py-1 font-bold text-rose-100">تلاش دوباره</button>
              </div>
            )}
            {cloudStatus.status === 'error' && cloudStatus.retryable && (
              <div role="status" aria-live="polite" className="flex max-w-[560px] items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[10px] text-amber-800 dark:text-amber-200">
                <span>{cloudStatus.message}</span>
                <button type="button" onClick={handleForceCloudSync} className="shrink-0 rounded-lg bg-amber-500/15 px-2 py-2 font-bold">تلاش مجدد</button>
              </div>
            )}
            {cloudStatus.status === 'authentication_required' && (
              <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[10px] text-amber-200">
                <span>{cloudStatus.message}</span>
                <button type="button" onClick={handleLogout} className="shrink-0 rounded-lg bg-amber-500/15 px-2 py-1 font-bold text-amber-100">ورود دوباره</button>
              </div>
            )}
            {cloudStatus.conflict && <div className="flex items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/5 p-1">
              <span className="px-1 text-[9px] text-rose-300">تعارض نسخه</span>
              <button type="button" onClick={() => handleResolveCloudConflict('remote')} className="rounded-lg bg-slate-800 px-2 py-1 text-[9px] font-bold text-slate-100">نسخه ابری</button>
              <button type="button" onClick={() => handleResolveCloudConflict('local')} className="rounded-lg bg-rose-500/20 px-2 py-1 text-[9px] font-bold text-rose-200">نسخه محلی</button>
            </div>}
            {saveIndicator && <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />ذخیره محلی</span>}
            <button
              type="button"
              onClick={() => setIsManualModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-teal-500/10 hover:bg-teal-500/20 text-teal-400 border border-teal-500/20 text-xs font-bold transition-all cursor-pointer"
              title="مشاهده و دانلود کتابچه راهنمای جامع به صورت PDF"
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>کتابچه راهنما (PDF)</span>
            </button>
            <SupervisorNotificationBell
              evaluations={evaluations}
              employees={employees}
              delegations={delegations}
              currentUser={currentUser}
              onNavigate={setCurrentTab}
              theme={theme}
              notifications={notifications}
              onMarkNotificationRead={markNotificationRead}
              onMarkAllNotificationsRead={markAllNotificationsRead}
              onOpenNotification={openNotification}
            />
            <button
              type="button"
              onClick={handleToggleTheme}
              className="p-1.5 rounded-xl bg-slate-800/20 text-slate-400 hover:text-slate-200 cursor-pointer transition-colors"
              title="تغییر تم"
            >
              {themePreference === 'system' ? <Monitor className="w-4 h-4 text-teal-400" /> : theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-indigo-600" />}
            </button>
          </div>
        </div>

        <div className="app-content px-4 py-5 sm:px-6 sm:py-6 xl:px-8 xl:py-8">
        {notificationNotice && <div role="status" className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-800 dark:text-amber-100"><span>{notificationNotice}</span><button type="button" onClick={() => setNotificationNotice('')} aria-label="بستن پیام" className="rounded px-2 py-1 font-bold">×</button></div>}
        <div id={`tour-target-page-${currentTab}`} className="app-page mx-auto max-w-[88rem] space-y-7">
         {(currentTab === 'workflow' || currentTab === 'evaluations') && <section className="rounded-2xl border border-teal-500/20 bg-teal-500/5 p-3 dark:bg-teal-500/10" aria-label="راهنمای صفحه">
           <button type="button" aria-expanded={pageHelpOpenFor === currentTab} onClick={() => { const opening = pageHelpOpenFor !== currentTab; setPageHelpOpenFor(opening ? currentTab : null); if (opening) markOnboardingStep(currentUser, `page-help-${currentTab}`); }} className="flex min-h-10 items-center gap-2 text-xs font-bold text-teal-700 dark:text-teal-200">
             <HelpCircle className="h-4 w-4" /> راهنمای همین صفحه
           </button>
           {pageHelpOpenFor === 'workflow' && currentTab === 'workflow' && <ul className="mt-2 list-inside list-disc space-y-1 text-xs leading-6 text-slate-600 dark:text-slate-300">
             <li>کارتابل را برای دیدن پرونده‌های منتظر اقدام خود بررسی کنید.</li>
             <li>پیش از انتقال گروهی، موارد انتخاب‌شده و نتیجه هر مورد را مرور کنید.</li>
             <li>پیام موفقیت فقط پس از تأیید ذخیره نمایش داده می‌شود؛ عملیات ناموفق را از نوار وضعیت دوباره پیگیری کنید.</li>
           </ul>}
           {pageHelpOpenFor === 'evaluations' && currentTab === 'evaluations' && <ul className="mt-2 list-inside list-disc space-y-1 text-xs leading-6 text-slate-600 dark:text-slate-300">
             <li>برای یافتن پرونده، جستجو را با نام، شناسه یا دوره محدود کنید.</li>
             <li>در ورود فایل، منبع و دوره را انتخاب و پیش‌نمایش ردیف‌ها و شاخص‌ها را کنترل کنید.</li>
             <li>تأیید نهایی را پس از رفع خطاهای فایل بزنید؛ وضعیت اتصال، نتیجه ذخیره را نشان می‌دهد.</li>
           </ul>}
         </section>}
         {db.hasPendingBulkOperation() && <div role="status" className="rounded-xl border border-amber-500 p-3 text-sm">عملیات گروهی تأییدنشده برای این حساب حفظ شده است. <button disabled={cloudStatus.status === 'syncing'} onClick={async () => { if (await db.retryPendingBulkOperation()) { setEmployees(db.getEmployees()); setEvaluations(db.getEvaluations()); notifyDataSaved(); } }} className="mr-3 underline">بررسی و تلاش دوباره عملیات گروهی</button></div>}
          <Suspense key={currentUser.id} fallback={<div className="p-8 text-center text-sm text-slate-400">در حال بارگذاری بخش…</div>}>
          {currentTab === 'dashboard' && <Dashboard criteria={criteria} profiles={profiles} employees={employees} evaluations={evaluations} delegations={delegations} onNavigate={setCurrentTab} onSelectEvaluation={handleSelectEvaluation} currentUser={currentUser} theme={theme} />}
          {currentTab === 'workflow' && (
            <WorkflowManager 
              currentUser={currentUser} 
              evaluations={evaluations} 
              employees={employees} 
              profiles={profiles} 
              criteria={criteria} 
              delegations={delegations} 
              onUpdateEvaluation={handleUpdateEvaluation} 
              onBulkUpdateEvaluations={handleBulkUpdateEvaluations} 
              onCommitWorkflowTransition={handleWorkflowTransitionCommit}
              onRetryPendingWorkflowOperation={handleRetryPendingWorkflowOperation}
              onDeleteEvaluation={handleDeleteEvaluation}
              onBulkDeleteEvaluations={handleBulkDeleteEvaluations}
              onUpdateEmployees={handleBulkUpdateEmployees} 
              onSelectEvaluation={handleSelectEvaluation} 
              notificationFocus={workflowNotificationFocus}
              onUpdateDelegations={handleUpdateDelegations} 
              theme={theme} 
            />
          )}
          {currentTab === 'criteria' && (
            <CriteriaBank 
              criteria={criteria} 
              onAddCriterion={handleAddCriterion} 
              onUpdateCriterion={handleUpdateCriterion} 
              onDeleteCriterion={handleDeleteCriterion} 
              onBulkDeleteCriteria={handleBulkDeleteCriteria}
              onBatchAddCriteria={handleBatchAddCriteria}
              employees={employees}
              profiles={profiles}
              evaluations={evaluations}
              onUpdateEvaluations={handleBulkUpdateEvaluations}
              currentUser={currentUser}
              theme={theme} 
            />
          )}
          {currentTab === 'profiles' && (
            <JobProfiles 
              profiles={profiles} 
              criteria={criteria} 
              onAddProfile={handleAddProfile} 
              onUpdateProfile={handleUpdateProfile} 
              onDeleteProfile={handleDeleteProfile} 
              onBulkDeleteProfiles={handleBulkDeleteProfiles}
              onToggleLockProfile={handleToggleLockProfile} 
              onAddCriterion={handleAddCriterion} 
              theme={theme} 
              currentUser={currentUser}
            />
          )}
          {currentTab === 'employees' && <Employees employees={employees} profiles={profiles} evaluations={evaluations} currentUser={currentUser} onAddEmployee={handleAddEmployee} onUpdateEmployee={handleUpdateEmployee} onBulkUpdateEmployees={handleBulkUpdateEmployees} onImportEmployees={handleImportEmployees} onDeleteEmployee={handleDeleteEmployee} onBulkDeleteEmployees={handleBulkDeleteEmployees} onStartEvaluation={handleStartEvaluationDirect} theme={theme} />}
          {currentTab === 'evaluations' && <Evaluations evaluations={evaluations} employees={employees} profiles={profiles} criteria={criteria} onAddEvaluation={handleAddEvaluation} onActivateEvaluationPeriod={handleActivateEvaluationPeriod} onBulkStartEvaluations={handleBulkStartEvaluations} onUpdateEvaluation={handleUpdateEvaluation} onBulkUpdateEvaluations={handleBulkUpdateEvaluations} onDeleteEvaluation={handleDeleteEvaluation} onBulkDeleteEvaluations={handleBulkDeleteEvaluations} activeEvalId={activeEvalId} onSetActiveEval={setActiveEvalId} onNavigateToWorkflow={() => setCurrentTab('workflow')} currentUser={currentUser} />}
          {currentTab === 'calibration' && <Calibration currentUser={currentUser} onBulkUpdateEvaluations={handleBulkUpdateEvaluations} evaluations={evaluations} employees={employees} profiles={profiles} onUpdateEvaluation={handleUpdateEvaluation} onSelectEvaluation={handleSelectEvaluation} />}
          {currentTab === 'support' && <SupportTickets currentUser={currentUser} theme={theme} />}
          {currentTab === 'reports' && (
            <Reports 
              evaluations={evaluations} 
              employees={employees} 
              profiles={profiles} 
              criteria={criteria} 
              onDeleteEvaluation={handleDeleteEvaluation}
              onBulkDeleteEvaluations={handleBulkDeleteEvaluations}
              onSelectEvaluation={handleSelectEvaluation}
              onNavigate={setCurrentTab}
              currentUser={currentUser}
              theme={theme}
            />
          )}
          {currentTab === 'lattice-hub' && (
            <LatticePerformanceHub 
              currentUser={currentUser} 
              employees={employees} 
              theme={theme} 
              onNavigate={setCurrentTab} 
            />
          )}
          {currentTab === 'kickidler-hub' && (
            <KickidlerProductivityHub 
              currentUser={currentUser} 
              employees={employees} 
              theme={theme} 
              onNavigate={setCurrentTab} 
            />
          )}
          {currentTab === 'onboarding' && <OnboardingCenter currentUser={currentUser} onNavigate={setCurrentTab} onStartInteractiveTour={handleStartInteractiveTour} />}
          {currentTab === 'my-evaluation' && <MyEvaluation currentUser={currentUser} activePeriod={db.getMiscData<string>('pe_active_period', '')} evaluations={evaluations} profiles={profiles} criteria={criteria} onUpdateEvaluation={handleUpdateEvaluation} theme={theme} />}
          {currentTab === 'rewards' && currentUser.role === 'admin' && <RewardCalculationCenter evaluations={evaluations} employees={employees} profiles={profiles} theme={theme} onBulkUpdateEvaluations={handleBulkUpdateEvaluations} />}
          {currentTab === 'settings' && (
            currentUser.role === 'admin' ? (
              <ManagementCenter 
                employees={employees} 
                profiles={profiles} 
                criteria={criteria} 
                evaluations={evaluations} 
                archivedEvaluations={archivedEvaluations}
                onSetEmployees={handleBulkUpdateEmployees} 
                onSetProfiles={handleSetProfiles} 
                onSetCriteria={handleSetCriteria} 
                onSetEvaluations={handleBulkUpdateEvaluations} 
                onSetArchivedEvaluations={handleSetArchivedEvaluations}
                currentUser={currentUser} 
                theme={theme} 
                onForceReauth={handleForceAdminReauth}
              />
            ) : (
              <div className="bg-rose-500/10 border border-rose-500/30 rounded-3xl p-8 text-center space-y-4 max-w-lg mx-auto mt-12 shadow-xl">
                <div className="w-12 h-12 rounded-2xl bg-rose-500/20 text-rose-400 flex items-center justify-center mx-auto">
                  <LockKeyhole className="w-6 h-6" />
                </div>
                <h3 className="text-base font-black text-rose-700 dark:text-rose-300">عدم دسترسی مجاز به پرتال مدیریت</h3>
                <p className="text-xs leading-relaxed text-slate-700 dark:text-slate-300">
                  تنظیمات پیشرفته و مرکز مدیریت سامانه منحصراً در اختیار مدیریت ارشد منابع انسانی با کلمه عبور اختصاصی می‌باشد.
                </p>
                <button
                  type="button"
                  onClick={() => setCurrentTab(currentUser.role === 'employee' ? 'my-evaluation' : 'dashboard')}
                  className="px-5 py-2.5 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold transition-all shadow-md cursor-pointer"
                >
                  بازگشت به داشبورد
                </button>
              </div>
            )
          )}
          </Suspense>
          </div>
        </div>
      </main>

      {contextMenu?.visible && (
        <div className={`fixed rounded-2xl border p-2 w-72 shadow-2xl z-50 text-right animate-in fade-in zoom-in-95 duration-150 backdrop-blur-xl ${theme === 'dark' ? 'bg-slate-900/95 border-slate-800 text-slate-200 shadow-teal-950/30' : 'bg-white/95 border-slate-200 text-slate-800 shadow-slate-300'}`} style={{ top: contextMenu.y, left: contextMenu.x }} onClick={(e) => e.stopPropagation()}>
          <div className="px-3 py-2 border-b border-slate-800/15 text-[10px] font-black text-slate-400 flex justify-between items-center">
            <span className="flex items-center gap-1.5 text-teal-400"><Sparkles className="w-3.5 h-3.5" /> ابزارهای سریع</span>
            <span className="text-[9px] bg-teal-500/10 text-teal-400 px-1.5 py-0.5 rounded font-mono">v5.0</span>
          </div>
          <div className="p-1 space-y-0.5 mt-1 text-xs">
            <button type="button" onClick={handleForceCloudSync} className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-sky-500/10 hover:text-sky-400 transition-all cursor-pointer text-sky-400">
              <div className="flex items-center gap-2"><UploadCloud className="w-3.5 h-3.5" /><span>همگام‌سازی ابری اکنون</span></div>
              <span className="text-[10px] text-sky-400 font-mono">Sync</span>
            </button>
            <button type="button" onClick={handleQuickJSONBackup} className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-indigo-500/10 hover:text-indigo-400 transition-all cursor-pointer text-indigo-400">
              <div className="flex items-center gap-2"><Download className="w-3.5 h-3.5" /><span>بکاپ سریع (JSON)</span></div>
              <span className="text-[10px] text-indigo-400 font-mono">Backup</span>
            </button>
            <button type="button" onClick={() => { setContextMenu(null); setIsManualModalOpen(true); }} className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-teal-500/10 hover:text-teal-400 transition-all cursor-pointer text-teal-400">
              <div className="flex items-center gap-2"><BookOpen className="w-3.5 h-3.5" /><span>کتابچه راهنمای جامع (PDF)</span></div>
              <span className="text-[10px] text-teal-400 font-mono">Manual</span>
            </button>
            <button type="button" onClick={() => { setContextMenu(null); window.print(); }} className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-teal-500/10 hover:text-teal-400 transition-all cursor-pointer">
              <div className="flex items-center gap-2"><Printer className="w-3.5 h-3.5" /><span>پرینت / PDF گزارش</span></div>
              <span className="text-[10px] text-slate-500 font-mono">Ctrl+P</span>
            </button>
            <button type="button" onClick={() => { handleToggleTheme(); setContextMenu(null); }} className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-teal-500/10 hover:text-teal-400 transition-all cursor-pointer">
              <div className="flex items-center gap-2">{themePreference === 'system' ? <Monitor className="w-3.5 h-3.5 text-teal-400" /> : theme === 'dark' ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5 text-indigo-500" />}<span>تغییر پوسته</span></div>
              <span className="text-[10px] text-slate-500">{themePreferenceLabel} · بعدی: {themePreference === 'light' ? 'تیره' : themePreference === 'dark' ? 'خودکار' : 'روشن'}</span>
            </button>
            <button type="button" onClick={() => { setThemePreference('system'); setContextMenu(null); }} className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-teal-500/10 hover:text-teal-400 transition-all cursor-pointer">
              <div className="flex items-center gap-2"><Monitor className="w-3.5 h-3.5 text-teal-400" /><span>پیروی از پوسته دستگاه</span></div>
              <span className="text-[10px] text-slate-500">{themePreference === 'system' ? 'فعال' : 'انتخاب'}</span>
            </button>
            <button type="button" onClick={() => { handleOpenOnboarding(); setContextMenu(null); }} className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-teal-500/10 hover:text-teal-400 transition-all cursor-pointer">
              <div className="flex items-center gap-2"><HelpCircle className="w-3.5 h-3.5 text-teal-400" /><span>راهنمای شروع کار</span></div>
              <span className="text-[10px] text-slate-500 font-mono">Guide</span>
            </button>
            <hr className={`my-1 ${theme === 'dark' ? 'border-slate-800' : 'border-slate-200'}`} />
            <div className="px-3 py-1 text-[10px] text-slate-500 flex justify-between items-center">
              <span className="truncate">{currentUser.name}</span><span className="font-mono">{currentUser.code}</span>
            </div>
            <button type="button" onClick={() => { handleLogout(); setContextMenu(null); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs text-rose-400 hover:bg-rose-500/10 transition-all cursor-pointer font-bold">
              <LogOut className="w-3.5 h-3.5" /><span>خروج از حساب</span>
            </button>
          </div>
        </div>
      )}
      
       <GuidedTour steps={currentTourSteps} activeStep={activeTourStep} onPrevious={handlePrevTourStep} onNext={handleNextTourStep} onSkip={() => setActiveTourStep(null)} onNeverShowAgain={handleNeverShowTour} theme={theme} themeMode={themePreference} />

      {/* Comprehensive System Manual & Printable PDF Guide Modal */}
      <Suspense fallback={null}>
        <ComprehensiveManualModal
          isOpen={isManualModalOpen}
          onClose={() => setIsManualModalOpen(false)}
          theme={theme}
          currentUser={currentUser}
          employees={employees}
        />
      </Suspense>
    </div>
  );
}
