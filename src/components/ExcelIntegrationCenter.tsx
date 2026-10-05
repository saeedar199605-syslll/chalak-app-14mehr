import SearchInput from './ui/SearchInput';
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  FileSpreadsheet,
  Download,
  Upload,
  CheckCircle2,
  AlertTriangle,
  FileCheck,
  RefreshCw,
  Layers,
  Database,
  Users,
  ShieldCheck,
  ArrowLeft,
  Sparkles,
  Info,
  Check,
  X,
  Plus,
  Trash2,
  Edit3,
  SlidersHorizontal,
  Search,
  Filter,
  Lock,
  Unlock,
  Eye,
  Settings2,
  Save,
  RotateCcw,
  Gauge,
  Mail
} from 'lucide-react';
import {
  Employee,
  Evaluation,
  Criterion,
  JobProfile,
  KasraAttendanceRecord,
  MISProductionRecord,
  DynamicColumnMapping,
  DynamicExcelRowRecord
  ,DEFAULT_ROUTE_RULES
} from '../types';
import { resolveInitialEvaluationWorkflow } from '../utils/evaluationStart';
import ProductionCycleTimeCalculator from './ProductionCycleTimeCalculator';
import {
  downloadKasraExcelTemplate,
  downloadMISExcelTemplate,
  downloadDynamicCriteriaExcelTemplate,
  parseKasraExcelFile,
  parseMISExcelFile,
  parseUniversalExcelFile,
  recalculateDynamicRows,
  calculateKasraScore,
  calculateMISScore,
  type MISImportIssue
} from '../utils/excelImportExport';
import { db, CURRENT_ACTIVE_PERIOD } from '../utils/db';
import type { EvaluationSourceImportContext, ProtectedSourceImportContext } from '../utils/sourceImports';
import { canonicalEvaluationPeriodId, getEvaluationPeriodId } from '../utils/evaluationPeriod';
import { authorize, canImport, readGranularPermissionPolicy } from '../utils/authorization';
import { buildKasraPreviewRows, countKasraPreview, type KasraPreviewRow } from '../utils/kasraImport';
import { matchesPersonnelCode, normalizePersonnelCode, normalizeSearchText } from '../utils/personnelSearch';
import { buildCriterionImportRegistry, scoreConfiguredMetric } from '../utils/criterionSourceRegistry';
import EmailQuarantineReview from './EmailQuarantineReview';
import ImportHistoryPanel from './ImportHistoryPanel';

interface ExcelIntegrationCenterProps {
  isOpen: boolean;
  embedded?: boolean;
  onClose: () => void;
  employees: Employee[];
  profiles: JobProfile[];
  criteria: Criterion[];
  evaluations: Evaluation[];
  onUpdateEvaluations: (evals: Evaluation[], sourceImport?: EvaluationSourceImportContext, operationId?: string) => boolean | Promise<boolean> | void;
  onAddEvaluation: (empId: string, period: string) => void;
  currentUser?: Employee | null;
}

export default function ExcelIntegrationCenter({
  isOpen,
  embedded = false,
  onClose,
  employees,
  profiles,
  criteria,
  evaluations,
  onUpdateEvaluations,
  onAddEvaluation,
  currentUser
}: ExcelIntegrationCenterProps) {
  const [activeTab, setActiveTab] = useState<'dynamic' | 'kasra' | 'mis' | 'email' | 'production_calc' | 'builder'>('dynamic');
  const [emailConfigured, setEmailConfigured] = useState<boolean | null>(null);
  const [lastAcceptedImport, setLastAcceptedImport] = useState<{ operationId: string; importType: 'MIS' | 'KASRA' } | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [permissionRevision, setPermissionRevision] = useState(0);
  useEffect(() => {
    const update = (event: Event) => { if ((event as CustomEvent).detail?.key === 'pe_granular_permissions') setPermissionRevision(value => value + 1); };
    window.addEventListener('pe_db_updated', update);
    return () => window.removeEventListener('pe_db_updated', update);
  }, []);
  const [previewPage, setPreviewPage] = useState(0);
  const importSubmitting = useRef(false);
  const dynamicOperationId = useRef(crypto.randomUUID());
  const includeUnmappedWarnings = (warnings: string[], mappings: DynamicColumnMapping[]) => [
    ...warnings,
    ...mappings.filter(mapping => mapping.targetType === 'ignore').map(mapping => `ستون «${mapping.excelColumn}» نگاشت نشده است؛ پیش از تأیید آن را بررسی کنید.`),
  ];
  const misOperationId = useRef(crypto.randomUUID());
  const kasraOperationId = useRef(crypto.randomUUID());
  useEffect(() => setPreviewPage(0), [searchTerm, activeTab]);
  const PreviewPages = ({ count }: { count: number }) => count > 50 ? <div className="flex items-center gap-4 text-xs text-slate-300" aria-label="صفحات پیش‌نمایش"><button type="button" disabled={previewPage === 0} onClick={() => setPreviewPage(page => page - 1)}>صفحه قبل</button><span>{previewPage + 1} / {Math.ceil(count / 50)} · {count} ردیف</span><button type="button" disabled={(previewPage + 1) * 50 >= count} onClick={() => setPreviewPage(page => page + 1)}>صفحه بعد</button></div> : null;


  // Admin status
  const isAdmin = currentUser?.role === 'admin' || currentUser?.username === 'admin' || currentUser?.name?.includes('مدیریت');
  const [isManualEditEnabled, setIsManualEditEnabled] = useState(false);
  const [selectedKasraPeriodId, setSelectedKasraPeriodId] = useState(() => canonicalEvaluationPeriodId(db.getMiscData<string>('pe_active_period', '')));
  const [selectedDynamicPeriodId, setSelectedDynamicPeriodId] = useState(() => canonicalEvaluationPeriodId(db.getMiscData<string>('pe_active_period', '')));
  const [selectedDynamicProfileId, setSelectedDynamicProfileId] = useState('all');
  const [isKasraConfirmOpen, setIsKasraConfirmOpen] = useState(false);
  const [isKasraApplying, setIsKasraApplying] = useState(false);
  const [kasraApplySummary, setKasraApplySummary] = useState<{ rowsRead: number; employeesMatched: number; evaluationsUpdated: number; scoresUpdated: number; skipped: number; invalid: number; failed: number } | null>(null);

  // Dynamic Import State
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<any[][]>([]);
  const [columnMappings, setColumnMappings] = useState<DynamicColumnMapping[]>([]);
  const [dynamicRecords, setDynamicRecords] = useState<DynamicExcelRowRecord[]>([]);
  const [dynamicWarnings, setDynamicWarnings] = useState<string[]>([]);
  const [dynamicMatchedCount, setDynamicMatchedCount] = useState<number>(0);
  const [showMappingConfig, setShowMappingConfig] = useState(false);

  // Validation Report State
  const [validationSummary, setValidationSummary] = useState<{
    source: string;
    totalProcessed: number;
    newEvaluations: number;
    updatedEvaluations: number;
    slotsPopulated: number;
    warnings: string[];
  } | null>(null);
  const [showValidationWarnings, setShowValidationWarnings] = useState(false);

  // Kasra & MIS Direct State (Legacy support)
  const [kasraRecords, setKasraRecords] = useState<KasraAttendanceRecord[]>([]);
  const [misRecords, setMisRecords] = useState<MISProductionRecord[]>([]);
  const [kasraErrors, setKasraErrors] = useState<string[]>([]);
  const [misErrors, setMisErrors] = useState<string[]>([]);
  const [misIssues, setMisIssues] = useState<MISImportIssue[]>([]);
  const [misCounts, setMisCounts] = useState({ valid: 0, invalid: 0, duplicate: 0, unknown: 0, missingMapping: 0, warning: 0 });
  const [misExpectedPeriod, setMisExpectedPeriod] = useState(() => db.getMiscData<string>('pe_active_period', '').trim());
  const [isMisConfirmOpen, setIsMisConfirmOpen] = useState(false);
  const activePeriodLabel = db.getMiscData<string>('pe_active_period', '').trim();
  const periodOptions = useMemo(() => {
    const byId = new Map<string, string>();
    evaluations.forEach(evaluation => {
      const id = getEvaluationPeriodId(evaluation);
      if (id && !byId.has(id)) byId.set(id, evaluation.period);
    });
    if (activePeriodLabel) {
      const id = canonicalEvaluationPeriodId(activePeriodLabel);
      if (!byId.has(id)) byId.set(id, activePeriodLabel);
    }
    if (!byId.size) byId.set(canonicalEvaluationPeriodId(CURRENT_ACTIVE_PERIOD), CURRENT_ACTIVE_PERIOD);
    return Array.from(byId, ([id, label]) => ({ id, label }));
  }, [evaluations, activePeriodLabel]);
  const selectedKasraPeriod = periodOptions.find(period => period.id === selectedKasraPeriodId);
  const selectedDynamicPeriod = periodOptions.find(period => period.id === selectedDynamicPeriodId);
  const dynamicPeriodLabel = selectedDynamicPeriod?.label || activePeriodLabel || CURRENT_ACTIVE_PERIOD;
  const selectedDynamicProfile = profiles.find(profile => profile.id === selectedDynamicProfileId);
  const dynamicCriteria = useMemo(() => {
    const profileCriterionIds = selectedDynamicProfile && new Set(selectedDynamicProfile.items.flatMap(item => {
      const match = criteria.find(criterion => criterion.id === item.cid || criterion.code === item.cid);
      return [item.cid, ...(match ? [match.id, match.code] : [])];
    }));
    const registeredIds = new Set(buildCriterionImportRegistry(criteria, 'FILE_IMPORT', profileCriterionIds).map(item => item.criterionId));
    return criteria.filter(criterion => registeredIds.has(criterion.id) && criterion.scoringSource !== 'mis' && criterion.scoringSource !== 'kasra');
  }, [criteria, selectedDynamicProfile]);
  const kasraImportAllowed = Boolean(currentUser && canImport(currentUser, 'kasra', undefined, readGranularPermissionPolicy()).allowed);
  const misImportAllowed = Boolean(currentUser && canImport(currentUser, 'mis', undefined, readGranularPermissionPolicy()).allowed);
  const misCriterionRegistry = useMemo(() => buildCriterionImportRegistry(criteria, 'MIS'), [criteria]);
  const kasraCriterionRegistry = useMemo(() => buildCriterionImportRegistry(criteria, 'KASRA'), [criteria]);
  useEffect(() => {
    if (!isOpen || !currentUser) return;
    let active = true;
    fetch('/api/email/status', { credentials: 'same-origin' })
      .then(async response => response.ok ? response.json() as Promise<{ configured?: boolean }> : { configured: false })
      .then(result => { if (active) setEmailConfigured(result.configured === true); })
      .catch(() => { if (active) setEmailConfigured(false); });
    return () => { active = false; };
  }, [isOpen, currentUser?.id]);
  const misEligibility = useMemo(() => {
    const people = new Map(employees.map(person => [normalizePersonnelCode(person.code), person]));
    const records = new Map(evaluations.map(record => [`${record.empId}\u0000${getEvaluationPeriodId(record)}`, record]));
    const jobs = new Map(profiles.map(profile => [profile.id, profile]));
    const criteriaMap = new Map(criteria.map(criterion => [criterion.id, criterion]));
    const policy = readGranularPermissionPolicy();
    return misRecords.map(record => {
      const employee = people.get(normalizePersonnelCode(record.empCode));
      const evaluation = employee && records.get(`${employee.id}\u0000${canonicalEvaluationPeriodId(record.period)}`);
      const profile = evaluation && jobs.get(evaluation.profileId);
      const reason = !employee ? 'کارمند ناشناخته' : !currentUser || !canImport(currentUser, 'mis', employee, policy).allowed ? 'خارج از مجوز یا محدوده' : !evaluation ? 'ارزیابی این دوره شروع نشده است' : evaluation.status === 'locked' || evaluation.stage === 'completed' ? 'پرونده نهایی و محافظت‌شده' : !profile?.items.some(item => {
        const criterion = criteriaMap.get(item.cid);
        return misCriterionRegistry.some(registration => registration.criterionId === criterion?.id) && criterion?.autoPopulate !== false && evaluation.scores.some(score => score.cid === item.cid);
      }) ? 'معیار MIS قابل ثبت ندارد' : '';
      return { record, reason };
    });
  }, [misRecords, employees, evaluations, profiles, criteria, currentUser, permissionRevision, misCriterionRegistry]);
  const misEligibleCount = misEligibility.filter(row => !row.reason).length;
  const kasraPreviewRows: KasraPreviewRow[] = useMemo(() => buildKasraPreviewRows({
    records: kasraRecords,
    selectedPeriodId: selectedKasraPeriodId,
    employees,
    profiles,
    criteria,
    evaluations,
    actor: currentUser,
    policy: readGranularPermissionPolicy(),
  }), [kasraRecords, selectedKasraPeriodId, employees, profiles, criteria, evaluations, currentUser, permissionRevision]);
  const kasraCounts = useMemo(() => countKasraPreview(kasraPreviewRows), [kasraPreviewRows]);
  const filteredKasraPreviewRows = useMemo(() => {
    const query = normalizeSearchText(searchTerm);
    if (!query) return kasraPreviewRows;
    return kasraPreviewRows.filter(row => matchesPersonnelCode(row.record.empCode, query) ||
      normalizeSearchText(row.employee?.name || row.record.empName || '').includes(query));
  }, [kasraPreviewRows, searchTerm]);
  const filteredMisRecords = useMemo(() => {
    const query = normalizeSearchText(searchTerm);
    if (!query) return misRecords;
    return misRecords.filter(record => matchesPersonnelCode(record.empCode, query) || normalizeSearchText(record.empName).includes(query));
  }, [misRecords, searchTerm]);

  // Template Builder State
  const [builderPeriod, setBuilderPeriod] = useState('نیمه اول ۱۴۰۵');
  const [builderProfileId, setBuilderProfileId] = useState('all');
  const [builderUnit, setBuilderUnit] = useState('all');
  const [builderIncludeDocs, setBuilderIncludeDocs] = useState(true);
  const [builderSelectedCriteria, setBuilderSelectedCriteria] = useState<string[]>(() => criteria.map(c => c.id));
  const [builderCategoryFilter, setBuilderCategoryFilter] = useState<'ALL' | 'K' | 'Q' | 'B' | 'S' | 'L'>('ALL');

  // File Inputs
  const dynamicFileInputRef = useRef<HTMLInputElement>(null);
  const kasraFileInputRef = useRef<HTMLInputElement>(null);
  const misFileInputRef = useRef<HTMLInputElement>(null);

  // Sync criteria when criteria prop changes
  useEffect(() => {
    if (builderSelectedCriteria.length === 0 && criteria.length > 0) {
      setBuilderSelectedCriteria(criteria.map(c => c.id));
    }
  }, [criteria]);

  useEffect(() => {
    if (selectedKasraPeriodId && periodOptions.some(period => period.id === selectedKasraPeriodId)) return;
    const activeId = canonicalEvaluationPeriodId(activePeriodLabel);
    setSelectedKasraPeriodId(periodOptions.some(period => period.id === activeId) ? activeId : periodOptions[0]?.id || '');
  }, [periodOptions, selectedKasraPeriodId, activePeriodLabel]);
  useEffect(() => {
    if (selectedDynamicPeriodId && periodOptions.some(period => period.id === selectedDynamicPeriodId)) return;
    const activeId = canonicalEvaluationPeriodId(activePeriodLabel);
    setSelectedDynamicPeriodId(periodOptions.some(period => period.id === activeId) ? activeId : periodOptions[0]?.id || '');
  }, [periodOptions, selectedDynamicPeriodId, activePeriodLabel]);
  useEffect(() => {
    if (selectedDynamicProfileId !== 'all' && !profiles.some(profile => profile.id === selectedDynamicProfileId)) setSelectedDynamicProfileId('all');
  }, [profiles, selectedDynamicProfileId]);
  useEffect(() => {
    if (!rawHeaders.length) return;
    const eligible = new Set(dynamicCriteria.flatMap(criterion => [criterion.id, criterion.code]));
    const next = columnMappings.map(mapping => mapping.targetType === 'criterion' && mapping.targetCriterionId && !eligible.has(mapping.targetCriterionId)
      ? { ...mapping, targetType: 'ignore' as const, targetCriterionId: undefined }
      : mapping);
    if (next.some((mapping, index) => mapping !== columnMappings[index])) setColumnMappings(next);
  }, [dynamicCriteria, rawHeaders.length, columnMappings]);
  useEffect(() => {
    if (!rawRows.length || !rawHeaders.length) return;
    const calculated = recalculateDynamicRows({ rawRows, headers: rawHeaders, mappings: columnMappings, employees, criteria: dynamicCriteria, profiles, defaultPeriod: dynamicPeriodLabel });
    setDynamicRecords(calculated.records);
    setDynamicMatchedCount(calculated.matchedEmployeesCount);
    setDynamicWarnings(includeUnmappedWarnings(calculated.warnings, columnMappings));
  }, [selectedDynamicPeriodId, selectedDynamicProfileId, dynamicPeriodLabel, dynamicCriteria, rawRows, rawHeaders, columnMappings, employees, profiles]);

  // --- 1. DYNAMIC UNIVERSAL EXCEL UPLOAD ---
  const handleDynamicFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    setErrorMessage('');
    setSuccessMessage('');
    setDynamicWarnings([]);
    setValidationSummary(null);
    dynamicOperationId.current = crypto.randomUUID();

    try {
      const result = await parseUniversalExcelFile(file, employees, dynamicCriteria);
      const safeMappings = result.suggestedMappings.map(mapping => mapping.targetType === 'attendance_metric' || mapping.targetType === 'mis_metric'
        ? { ...mapping, targetType: 'ignore' as const, targetMetricKey: undefined }
        : mapping);
      setRawHeaders(result.headers);
      setRawRows(result.rawRows);
      setColumnMappings(safeMappings);

      // Immediately calculate rows in real-time
      const calculated = recalculateDynamicRows({
        rawRows: result.rawRows,
        headers: result.headers,
        mappings: safeMappings,
        employees,
        criteria: dynamicCriteria,
        profiles,
        defaultPeriod: dynamicPeriodLabel
      });

      setDynamicRecords(calculated.records);
      setDynamicMatchedCount(calculated.matchedEmployeesCount);
      setDynamicWarnings(includeUnmappedWarnings(calculated.warnings, safeMappings));
      setSuccessMessage(`فایل اکسل با موفقیت بارگذاری شد: ${calculated.records.length} ردیف داده تحلیل گردید (${calculated.matchedEmployeesCount} پرسنل تطبیق یافت).`);
      setShowMappingConfig(false);

      // Preview is local only; do not sync an audit mutation before confirmation.
    } catch (err: any) {
      setErrorMessage(err.message || 'خطا در تحلیل فایل اکسل داینامیک');
    } finally {
      setIsProcessing(false);
      if (dynamicFileInputRef.current) dynamicFileInputRef.current.value = '';
    }
  };

  const handleCancelDynamicPreview = () => {
    if (importSubmitting.current) return;
    setRawRows([]);
    setRawHeaders([]);
    setColumnMappings([]);
    setDynamicRecords([]);
    setDynamicMatchedCount(0);
    setDynamicWarnings([]);
    setSearchTerm('');
    setShowMappingConfig(false);
    setIsManualEditEnabled(false);
    setValidationSummary(null);
    setSuccessMessage('پیش‌نمایش لغو شد؛ هیچ تغییری در سرور ثبت نشد.');
    setErrorMessage('');
    dynamicOperationId.current = crypto.randomUUID();
  };

  // --- 2. COLUMN MAPPING CHANGE (REAL-TIME RECALCULATION) ---
  const handleUpdateColumnMapping = (colName: string, updated: Partial<DynamicColumnMapping>) => {
    const nextMappings = columnMappings.map(m => {
      if (m.excelColumn === colName) {
        return { ...m, ...updated };
      }
      return m;
    });

    setColumnMappings(nextMappings);
    dynamicOperationId.current = crypto.randomUUID();

    // Instant real-time recalculation of rows
    const calculated = recalculateDynamicRows({
      rawRows,
      headers: rawHeaders,
      mappings: nextMappings,
      employees,
      criteria: dynamicCriteria,
      profiles,
      defaultPeriod: dynamicPeriodLabel
    });

    setDynamicRecords(calculated.records);
    setDynamicMatchedCount(calculated.matchedEmployeesCount);
    setDynamicWarnings(includeUnmappedWarnings(calculated.warnings, nextMappings));
  };

  // --- 3. MANUAL EDIT HANDLERS (ADMIN ONLY) ---
  const handleAdminScoreEdit = (recordId: string, criterionId: string, newScore: number) => {
    if (!isAdmin) {
      alert('فقط مدیر ارشد سیستم مجاز به ویرایش دستی مقادیر است.');
      return;
    }

    const boundScore = Math.max(1, Math.min(5, Number(newScore) || 1));
    dynamicOperationId.current = crypto.randomUUID();

    setDynamicRecords(prev => prev.map(rec => {
      if (rec.id === recordId) {
        return {
          ...rec,
          scores: { ...rec.scores, [criterionId]: boundScore },
          isModifiedManually: true
        };
      }
      return rec;
    }));

  };

  const handleAdminDocEdit = (recordId: string, criterionId: string, newDoc: string) => {
    if (!isAdmin) return;
    dynamicOperationId.current = crypto.randomUUID();

    setDynamicRecords(prev => prev.map(rec => {
      if (rec.id === recordId) {
        return {
          ...rec,
          docs: { ...rec.docs, [criterionId]: newDoc },
          isModifiedManually: true
        };
      }
      return rec;
    }));
  };

  const handleAdminNoteEdit = (recordId: string, newNote: string) => {
    if (!isAdmin) return;
    dynamicOperationId.current = crypto.randomUUID();

    setDynamicRecords(prev => prev.map(rec => {
      if (rec.id === recordId) {
        return {
          ...rec,
          overallNote: newNote,
          isModifiedManually: true
        };
      }
      return rec;
    }));
  };

  const handleAdminDeleteRow = (recordId: string) => {
    if (!isAdmin) return;
    dynamicOperationId.current = crypto.randomUUID();
    setDynamicRecords(prev => prev.filter(r => r.id !== recordId));
  };

  const handleAdminResetToOriginal = () => {
    if (!isAdmin) return;
    const calculated = recalculateDynamicRows({
      rawRows,
      headers: rawHeaders,
      mappings: columnMappings,
      employees,
      criteria: dynamicCriteria,
      profiles,
      defaultPeriod: dynamicPeriodLabel
    });
    setDynamicRecords(calculated.records);
    setSuccessMessage('تمام ویرایش‌های دستی لغو و مقادیر به داده‌های اولیه فایل اکسل بازگردانی شدند.');
  };

  // --- 4. APPLY DYNAMIC RECORDS TO EVALUATIONS (LIVE SYNC & VALIDATION LAYER) ---
  const handleApplyDynamicRecords = async () => {
    if (importSubmitting.current) return;
    if (dynamicRecords.length === 0) {
      alert('هیچ داده‌ای برای ثبت موجود نیست.');
      return;
    }

    importSubmitting.current = true;
    setIsProcessing(true);
    setErrorMessage('');
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const updatedEvaluations = [...evaluations];
      const employeesByCode = new Map(employees.map(employee => [normalizePersonnelCode(employee.code), employee]));
      const evaluationIndices = new Map(updatedEvaluations.map((evaluation, index) => [`${evaluation.empId}\u0000${getEvaluationPeriodId(evaluation)}`, index]));
      const profilesById = new Map(profiles.map(profile => [profile.id, profile]));
      const criteriaById = new Map<string, Criterion>(dynamicCriteria.flatMap(criterion => [[criterion.id, criterion], [criterion.code, criterion]] as Array<[string, Criterion]>));
      const permissionPolicy = readGranularPermissionPolicy();
      let updatedEvalsCount = 0;
      let newEvalsCount = 0;
      let slotsPopulated = 0;
      const warnings: string[] = [];

      dynamicRecords.forEach((rec, idx) => {
        const rowNum = idx + 1;
        const employee = employeesByCode.get(normalizePersonnelCode(rec.empCode)) || employees.find(person =>
          (rec.empCode && person.username.toLowerCase() === rec.empCode.toLowerCase()) ||
          (rec.empName && (person.name.trim() === rec.empName.trim() || person.name.includes(rec.empName.trim())))
        );
        if (!employee) { warnings.push(`ردیف ${rowNum}: پرسنل با کد «${rec.empCode || 'نامشخص'}» یا نام «${rec.empName || 'نامشخص'}» پیدا نشد.`); return; }
        if (!rec.isValid) { warnings.push(`ردیف ${rowNum} (${employee.name}): ${rec.validationError || 'ردیف نامعتبر است.'}`); return; }
        if (selectedDynamicProfileId !== 'all' && employee.profileId !== selectedDynamicProfileId) {
          warnings.push(`ردیف ${rowNum} (${employee.name}): پروفایل کارمند با پروفایل انتخاب‌شده هم‌خوانی ندارد؛ پروفایل کارمند تغییر نکرد.`); return;
        }
        if (canonicalEvaluationPeriodId(rec.period) !== selectedDynamicPeriodId) {
          warnings.push(`ردیف ${rowNum} (${employee.name}): دوره فایل با دوره انتخاب‌شده تطبیق ندارد و این ردیف نادیده گرفته شد.`); return;
        }
        const canImport = currentUser?.role === 'admin' || Boolean(currentUser && (
          authorize(currentUser, 'evaluations', 'bulk_score', employee, permissionPolicy).allowed ||
          authorize(currentUser, 'evaluations', 'edit', employee, permissionPolicy).allowed
        ));
        if (!canImport) { warnings.push(`ردیف ${rowNum} (${employee.name}): مجوز تغییر ارزیابی یا محدوده پرسنلی اجازه ورود این ردیف را نمی‌دهد.`); return; }

        const periodKey = `${employee.id}\u0000${selectedDynamicPeriodId}`;
        const targetIndex = evaluationIndices.get(periodKey) ?? -1;
        const existing = targetIndex >= 0 ? updatedEvaluations[targetIndex] : undefined;
        if (existing && (existing.status === 'locked' || existing.stage === 'completed')) {
          warnings.push(`ردیف ${rowNum} (${employee.name}): پرونده نهایی یا قفل است.`); return;
        }
        const profile = existing ? profilesById.get(existing.profileId) : profilesById.get(employee.profileId);
        if (!profile || profile.items.length === 0) { warnings.push(`ردیف ${rowNum} (${employee.name}): پروفایل واقعی پرونده در دسترس نیست.`); return; }
        if (selectedDynamicProfileId !== 'all' && profile.id !== selectedDynamicProfileId) {
          warnings.push(`ردیف ${rowNum} (${employee.name}): پروفایل پرونده با پروفایل انتخاب‌شده متفاوت است.`); return;
        }
        const existingScoreMap = new Map((existing?.scores || []).map(score => [score.cid, score]));
        let rowSlots = 0;
        const scores = profile.items.map(item => {
          const criterion = criteriaById.get(item.cid);
          const old = existingScoreMap.get(item.cid);
          if (criterion?.scoringSource === 'mis' || criterion?.scoringSource === 'kasra') {
            return old || { cid: item.cid, weight: item.weight, value: 0, self: 0, doc: '' };
          }
          const imported = rec.scores[item.cid] ?? (criterion ? rec.scores[criterion.id] ?? rec.scores[criterion.code] : undefined);
          const importedDoc = rec.docs[item.cid] || (criterion ? rec.docs[criterion.id] || rec.docs[criterion.code] : '') || '';
          if (imported === undefined) return old || { cid: item.cid, weight: item.weight, value: 0, self: 0, doc: '' };
          const numeric = Number(imported);
          if (!Number.isFinite(numeric) || numeric < 0 || numeric > 5) { warnings.push(`ردیف ${rowNum} (${employee.name}): نمره شاخص «${criterion?.name || item.cid}» معتبر نیست.`); return old || { cid: item.cid, weight: item.weight, value: 0, self: 0, doc: '' }; }
          rowSlots++;
          return { ...(old || {}), cid: item.cid, weight: item.weight, value: Math.round(numeric * 10) / 10, self: old?.self || 0, doc: importedDoc || old?.doc || '' };
        });
        const note = rec.overallNote?.trim();
        if (!rowSlots && !note) { warnings.push(`ردیف ${rowNum} (${employee.name}): هیچ شاخص قابل‌ورود یا توضیح تازه‌ای ندارد.`); return; }
        const nextNote = note && !(existing?.note || '').includes(note) ? (existing?.note ? `${existing.note}\n${note}` : note) : existing?.note || note || '';
        if (existing) {
          updatedEvaluations[targetIndex] = { ...existing, scores, note: nextNote };
          updatedEvalsCount++;
        } else {
          const initialWorkflow = resolveInitialEvaluationWorkflow(employee, employees, db.getMiscData('pe_route_rules', DEFAULT_ROUTE_RULES), profile.id);
          const created: Evaluation = { id: `eval-${crypto.randomUUID()}`, empId: employee.id, profileId: profile.id, period: dynamicPeriodLabel, status: 'draft', ...initialWorkflow, scores, note: nextNote, created: Date.now() };
          evaluationIndices.set(periodKey, updatedEvaluations.length);
          updatedEvaluations.push(created);
          newEvalsCount++;
        }
        slotsPopulated += rowSlots;
      });

      const changedRows = updatedEvaluations.filter(record => JSON.stringify(record) !== JSON.stringify(evaluations.find(existing => existing.id === record.id)));
      if (!changedRows.length) {
        setErrorMessage(warnings.length ? `پیش‌نمایش بدون تغییر باقی ماند: ${warnings.slice(0, 3).join(' · ')}` : 'ردیف تازه‌ای برای ثبت وجود ندارد.');
        return;
      }
      const sourceImport: EvaluationSourceImportContext = {
        importType: 'FILE_IMPORT',
        operationId: dynamicOperationId.current,
        evaluationPeriodId: selectedDynamicPeriodId,
        rowsRead: dynamicRecords.length,
      };
      if (await onUpdateEvaluations(updatedEvaluations, sourceImport) !== true) {
        setErrorMessage('سرور ذخیره را تأیید نکرد؛ پیش‌نمایش شما حفظ شده است. بررسی دسترسی، دوره و نسخه سرور را انجام دهید.');
        return;
      }
      setValidationSummary({ source: 'ورود داینامیک شاخص‌های دستی', totalProcessed: newEvalsCount + updatedEvalsCount, newEvaluations: newEvalsCount, updatedEvaluations: updatedEvalsCount, slotsPopulated, warnings });
      setSuccessMessage(`ذخیره شد: ${newEvalsCount} پرونده تازه، ${updatedEvalsCount} پرونده به‌روزشده، ${slotsPopulated} نمره؛ یک درخواست ابری.`);
      dynamicOperationId.current = crypto.randomUUID();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'ذخیره داینامیک ناموفق بود؛ پیش‌نمایش حفظ شد.');
    } finally {
      importSubmitting.current = false;
      setIsProcessing(false);
    }
  };

  // --- 5. KASRA FILE UPLOAD ---

  const handleKasraFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!kasraImportAllowed) {
      setErrorMessage('برای درون‌ریزی کسری مجوز جداگانه ندارید.');
      return;
    }
    if (!selectedKasraPeriodId) {
      setErrorMessage('ابتدا دوره ارزیابی را انتخاب کنید.');
      return;
    }
    setIsProcessing(true);
    setErrorMessage('');
    setSuccessMessage('');
    setKasraErrors([]);
    setKasraApplySummary(null);
    setValidationSummary(null);
    try {
      kasraOperationId.current = crypto.randomUUID(); setPreviewPage(0);
      const result = await parseKasraExcelFile(file, employees, criteria);
      setKasraRecords(result.records);
      setKasraErrors(result.errors);
      setSuccessMessage(`فایل کسری خوانده شد: ${result.records.length} ردیف؛ دوره انتخاب‌شده: ${selectedKasraPeriod?.label || selectedKasraPeriodId}. هنوز تغییری ذخیره نشده است.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'خطا در پردازش فایل کسری');
    } finally {
      setIsProcessing(false);
      if (kasraFileInputRef.current) kasraFileInputRef.current.value = '';
    }
  };

  const handleApplyKasraRecords = async () => {
    if (importSubmitting.current) return;
    importSubmitting.current = true;
    try {
    if (isKasraApplying || !selectedKasraPeriodId) return;
    const validRows = kasraPreviewRows.filter(row => row.status === 'valid' && row.updatedEvaluation);
    if (!validRows.length) return;
    const updates = new Map(validRows.map(row => [row.updatedEvaluation!.id, row.updatedEvaluation!]));
    const updatedEvaluations = evaluations.map(evaluation => updates.get(evaluation.id) || evaluation);
    const sourceImport: ProtectedSourceImportContext = {
      importType: 'KASRA',
      operationId: kasraOperationId.current,
      evaluationPeriodId: selectedKasraPeriodId,
      rowsRead: kasraCounts.total,
    };
    setIsKasraApplying(true);
    setErrorMessage('');
    try {
      const accepted = await onUpdateEvaluations(updatedEvaluations, sourceImport);
      if (accepted !== true) {
        setErrorMessage('سرور ذخیره کسری را تأیید نکرد؛ تغییر در ارزیابی‌ها ثبت نشد. بررسی کنید مجوز و اتصال برقرار باشد.');
        return;
      }
      setLastAcceptedImport({ operationId: sourceImport.operationId, importType: 'KASRA' });
      const scoresUpdated = validRows.reduce((total, row) => total + row.changedScores.length, 0);
      setKasraApplySummary({
        rowsRead: kasraPreviewRows.length,
        employeesMatched: new Set(validRows.map(row => row.employee?.id).filter(Boolean)).size,
        evaluationsUpdated: updates.size,
        scoresUpdated,
        skipped: kasraCounts.invalid,
        invalid: kasraCounts.invalid,
        failed: 0,
      });
      setValidationSummary({
        source: 'سامانه حضور و غیاب کسری',
        totalProcessed: updates.size,
        newEvaluations: 0,
        updatedEvaluations: updates.size,
        slotsPopulated: scoresUpdated,
        warnings: kasraPreviewRows.filter(row => row.status !== 'valid').map(row => `ردیف ${row.rowNumber}: ${row.issue || row.status}`),
      });
      setIsKasraConfirmOpen(false);
      setSuccessMessage(`درون‌ریزی کسری ذخیره شد: ${kasraPreviewRows.length} ردیف خوانده‌شده، ${updates.size} ارزیابی موجود به‌روزرسانی‌شده، ${scoresUpdated} نمره و یک ذخیره ابری.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'ذخیره درون‌ریزی کسری ناموفق بود.');
    } finally {
      setIsKasraApplying(false);
    }
    } catch (error) { setErrorMessage(error instanceof Error ? error.message : 'ذخیره ابری ناموفق بود؛ پیش‌نمایش حفظ شد.'); }
    finally { importSubmitting.current = false; setIsProcessing(false); setIsKasraApplying(false); }

  };

  // --- 6. MIS FILE UPLOAD (LEGACY DIRECT) ---
  const handleMISFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    setErrorMessage('');
    setSuccessMessage('');
    setMisErrors([]);
    setValidationSummary(null);

    try {
      const selectedPeriod = db.getMiscData<string>('pe_active_period', '').trim();
      setMisExpectedPeriod(selectedPeriod);
      if (!selectedPeriod) {
        setErrorMessage('دوره ارزیابی فعالی وجود ندارد. ابتدا از بخش دوره‌ها یک دوره را فعال کنید.');
        setMisRecords([]);
        setMisIssues([]);
        setMisCounts({ valid: 0, invalid: 0, duplicate: 0, unknown: 0, missingMapping: 0, warning: 0 });
        return;
      }
      misOperationId.current = crypto.randomUUID(); setPreviewPage(0);
      const result = await parseMISExcelFile(file, employees, selectedPeriod, criteria);
      setMisRecords(result.records);
      setMisErrors(result.errors);
      setMisIssues(result.issues);
      setMisCounts({ valid: result.validCount, invalid: result.invalidCount, duplicate: result.duplicateCount, unknown: result.unknownEmployeeCount, missingMapping: result.missingMappingCount, warning: 0 });
      setSuccessMessage(`دوره: ${selectedPeriod} · معتبر: ${result.validCount} · نامعتبر: ${result.invalidCount} · تکراری: ${result.duplicateCount} · کد ناشناخته: ${result.unknownEmployeeCount} · نگاشت ناقص: ${result.missingMappingCount}`);
    } catch (err: any) {
      setErrorMessage(err.message || 'خطا در پردازش فایل MIS');
    } finally {
      setIsProcessing(false);
      if (misFileInputRef.current) misFileInputRef.current.value = '';
    }
  };

  const handleApplyMISRecords = async () => {
    if (importSubmitting.current) return;
    importSubmitting.current = true;
    try {
    if (misRecords.length === 0 || !currentUser || !misImportAllowed) return;
    const currentlyActivePeriod = db.getMiscData<string>('pe_active_period', '').trim();
    if (!currentlyActivePeriod || misRecords.some(record => record.period !== currentlyActivePeriod)) {
      setErrorMessage('دوره فعال پس از پیش‌نمایش تغییر کرده است. فایل را با دوره فعال تازه دوباره اعتبارسنجی کنید.');
      setIsMisConfirmOpen(false);
      setMisRecords([]);
      return;
    }
    const selectedPeriodId = canonicalEvaluationPeriodId(currentlyActivePeriod);

    setIsProcessing(true);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    let updatedEvaluations = [...evaluations];
    const employeesByCode = new Map(employees.map(employee => [normalizePersonnelCode(employee.code), employee]));
    const evaluationIndices = new Map(evaluations.map((evaluation, index) => [`${evaluation.empId}\u0000${getEvaluationPeriodId(evaluation)}`, index]));
    const profilesById = new Map(profiles.map(profile => [profile.id, profile]));
    const criteriaById = new Map(criteria.flatMap(criterion => [[criterion.id, criterion], [criterion.code, criterion]] as Array<[string, Criterion]>));
    const permissionPolicy = readGranularPermissionPolicy();
    let updatedEvalsCount = 0;
    let newEvalsCount = 0;
    let slotsPopulated = 0;
    const warnings: string[] = [];

    misEligibility.forEach(({ record: rec, reason }, idx) => {
      const rowNum = idx + 1;
      if (reason) { warnings.push(`ردیف ${rowNum}: ${reason}`); return; }
      const emp = employeesByCode.get(normalizePersonnelCode(rec.empCode));

      if (!emp) {
        warnings.push(`ردیف ${rowNum}: پرسنل با کد «${rec.empCode || 'نامشخص'}» و نام «${rec.empName || 'نامشخص'}» یافت نشد.`);
        return;
      }

      if (!canImport(currentUser, 'mis', emp, permissionPolicy).allowed) {
        warnings.push(`ردیف ${rowNum}: مجوز MIS برای محدوده این کارمند وجود ندارد.`);
        return;
      }

      const evalPeriod = rec.period;
      const targetIndex = evaluationIndices.get(`${emp.id}\u0000${selectedPeriodId}`) ?? -1;
      if (targetIndex === -1) {
        warnings.push(`ردیف ${rowNum} (${emp.name}): ارزیابی دوره ${evalPeriod} شروع نشده است؛ ابتدا از عملیات شروع دوره، پرونده واجد شرایط را ایجاد کنید.`);
        return;
      }
      const targetEval = updatedEvaluations[targetIndex];
      if (targetEval.status === 'locked' || targetEval.stage === 'completed') { warnings.push(`ردیف ${rowNum}: پرونده نهایی محافظت شد.`); return; }
      const prof = profilesById.get(targetEval.profileId);
      if (!prof?.items?.length) {
        warnings.push(`ردیف ${rowNum} (${emp.name}): پروفایل ارزیابی موجود شاخصی ندارد یا پیدا نشد.`);
        return;
      }

      // Helper function to calculate precise score from MIS record based on misMetricKey
      const computeScoreForMisCriterion = (crit: Criterion) => {
        let scoreVal = 0;
        let docVal = '';
        let rawVal: number = 0;

        if (crit.misMetricKey === 'custom' && crit.customMetricField) {
          const customRaw = rec.customMetrics?.[crit.id];
          if (customRaw === undefined) return null;
          const configuredScore = scoreConfiguredMetric(crit, customRaw);
          if (configuredScore === null) return null;
          rawVal = customRaw;
          scoreVal = configuredScore;
          docVal = `داده خودکار MIS: ${crit.name} ${customRaw}${crit.unit ? ` ${crit.unit}` : ''}`;
        } else if (crit.misMetricKey === 'efficiency') {
          rawVal = Number(rec.efficiencyRate) || 0;
          if (rawVal >= 104) scoreVal = 5;
          else if (rawVal >= 99) scoreVal = 4;
          else if (rawVal >= 92) scoreVal = 3;
          else if (rawVal >= 80) scoreVal = 2;
          else scoreVal = 1;
          docVal = `داده خودکار MIS: درصد راندمان خط ${rawVal}٪ (هدف: ۱۰۰٪)`;
        } else if (crit.misMetricKey === 'scrap_rate') {
          rawVal = Number(rec.scrapRate) || 0;
          if (rawVal <= 1.1) scoreVal = 5;
          else if (rawVal <= 2.0) scoreVal = 4;
          else if (rawVal <= 3.2) scoreVal = 3;
          else if (rawVal <= 5.0) scoreVal = 2;
          else scoreVal = 1;
          docVal = `داده خودکار MIS: نرخ ضایعات ${rawVal}٪ (سقف مجاز: ۲٪)`;
        } else if (crit.misMetricKey === 'quality_score') {
          rawVal = Number(rec.qualityScore) || 0;
          if (rawVal >= 98) scoreVal = 5;
          else if (rawVal >= 95) scoreVal = 4;
          else if (rawVal >= 90) scoreVal = 3;
          else if (rawVal >= 85) scoreVal = 2;
          else scoreVal = 1;
          docVal = `داده خودکار MIS: آزمون کیفی QC به میزان ${rawVal}٪`;
        } else if (crit.misMetricKey === 'output_qty') {
          const produced = Number(rec.producedUnits);
          const target = Number(rec.targetUnits);
          const ratio = target > 0 ? (produced / target) : 1;
          if (ratio >= 1.04) scoreVal = 5;
          else if (ratio >= 0.98) scoreVal = 4;
          else if (ratio >= 0.90) scoreVal = 3;
          else if (ratio >= 0.80) scoreVal = 2;
          else scoreVal = 1;
          rawVal = ratio;
          docVal = `داده خودکار MIS: تیراژ تولید واقعی ${produced} قطعه (برنامه مصوب: ${target})`;
        } else if (crit.misMetricKey === 'downtime') {
          rawVal = Number(rec.downtimeHours) || 0;
          if (rawVal <= 2) scoreVal = 5;
          else if (rawVal <= 4) scoreVal = 4;
          else if (rawVal <= 6) scoreVal = 3;
          else if (rawVal <= 9) scoreVal = 2;
          else scoreVal = 1;
          docVal = `داده خودکار MIS: توقفات فنی دستگاه ${rawVal} ساعت`;
        } else {
          scoreVal = Math.max(0, Math.min(5, Math.round(Number(rec.calculatedKpiScore) * 10) / 10));
          rawVal = Number(rec.calculatedKpiScore);
          docVal = `داده خودکار MIS: راندمان ${rec.efficiencyRate}٪ | ضایعات ${rec.scrapRate}٪ | کیفیت ${rec.qualityScore}٪`;
        }

        return { scoreVal, docVal, rawVal };
      };

      {
        const profileCriterionIds = new Set(prof.items.map(item => item.cid));
        const updatedScores = targetEval.scores.map(existingScore => {
          const criterion = criteriaById.get(existingScore.cid);
          if (!profileCriterionIds.has(existingScore.cid) || criterion?.scoringSource !== 'mis' || criterion.autoPopulate === false) return existingScore;
          const computed = computeScoreForMisCriterion(criterion);
          if (!computed) return existingScore;
          slotsPopulated++;
          return {
            ...existingScore,
            value: computed.scoreVal,
            doc: computed.docVal,
            sourceType: 'mis' as const,
            autoPopulated: true,
            rawMetricValue: computed.rawVal,
            rawMetricLabel: criterion.misMetricKey === 'custom' ? `mis_custom_metric:${criterion.id}` : criterion.misMetricKey === 'output_qty' ? 'output_qty_ratio' :
              ['efficiency', 'scrap_rate', 'quality_score', 'downtime'].includes(criterion.misMetricKey || '') ? criterion.misMetricKey! : 'mis_composite_score',
          };
        });

        updatedEvaluations[targetIndex] = {
          ...targetEval,
          scores: updatedScores
        };
        updatedEvalsCount++;
      }
    });

    const totalProcessed = newEvalsCount + updatedEvalsCount;
    if (!totalProcessed || !slotsPopulated) {
      setErrorMessage('هیچ معیار MIS معتبر در ارزیابی‌های موجود برای این فایل پیدا نشد.');
      return;
    }
    setIsProcessing(true);
    const sourceImport: ProtectedSourceImportContext = {
      importType: 'MIS',
      operationId: misOperationId.current,
      evaluationPeriodId: selectedPeriodId,
      rowsRead: misRecords.length + misCounts.invalid,
    };
    const accepted = await onUpdateEvaluations(updatedEvaluations, sourceImport);
    setIsProcessing(false);
    if (accepted !== true) {
      setErrorMessage('سرور ذخیره MIS را تأیید نکرد؛ تغییر در ارزیابی‌ها ثبت نشد. بررسی کنید مجوز و اتصال برقرار باشد.');
      return;
    }
    setLastAcceptedImport({ operationId: sourceImport.operationId, importType: 'MIS' });
    setValidationSummary({
      source: 'سامانه تولید و کیفیت MIS',
      totalProcessed,
      newEvaluations: newEvalsCount,
      updatedEvaluations: updatedEvalsCount,
      slotsPopulated,
      warnings
    });

    setSuccessMessage(`داده‌های تولید و کیفیت MIS با موفقیت در شاخص‌های تولیدی ${totalProcessed} پرونده ارزیابی نشست و پایدار شد (${slotsPopulated} اسلات نمره). معیارهای دستی سرپرست بدون تغییر محافظت شدند.`);
    setIsMisConfirmOpen(false);
    } catch (error) { setErrorMessage(error instanceof Error ? error.message : 'ذخیره ابری ناموفق بود؛ پیش‌نمایش حفظ شد.'); }
    finally { importSubmitting.current = false; setIsProcessing(false); setIsKasraApplying(false); }

  };

  // Filtered Dynamic Records for table
  const filteredDynamicRecords = useMemo(() => {
    if (!searchTerm.trim()) return dynamicRecords;
    const term = normalizeSearchText(searchTerm);
    return dynamicRecords.filter(r =>
      matchesPersonnelCode(r.empCode, term) ||
      (r.empName && normalizeSearchText(r.empName).includes(term)) ||
      (r.jobTitle && normalizeSearchText(r.jobTitle).includes(term)) ||
      (r.unit && normalizeSearchText(r.unit).includes(term))
    );
  }, [dynamicRecords, searchTerm]);

  // Dynamic columns list for display
  const dynamicCriterionColumns = useMemo(() => {
    const critIds = new Set<string>();
    columnMappings.forEach(m => {
      if (m.targetType === 'criterion' && m.targetCriterionId) {
        critIds.add(m.targetCriterionId);
      }
    });
    return dynamicCriteria.filter(c => critIds.has(c.id));
  }, [columnMappings, dynamicCriteria]);

  // Unique units for builder
  const availableUnits = useMemo(() => {
    const set = new Set<string>();
    employees.forEach(e => { if (e.unit) set.add(e.unit); });
    return Array.from(set);
  }, [employees]);

  const isImportSource = activeTab === 'dynamic' || activeTab === 'mis' || activeTab === 'kasra' || activeTab === 'email';
  const sourceHasPreview = activeTab === 'dynamic' ? rawRows.length > 0
    : activeTab === 'mis' ? misRecords.length > 0 || misErrors.length > 0
      : activeTab === 'kasra' ? kasraRecords.length > 0 || kasraErrors.length > 0
        : false;
  const sourceWasAccepted = Boolean(validationSummary && (
    (activeTab === 'dynamic' && validationSummary.source.includes('داینامیک')) ||
    (activeTab === 'mis' && validationSummary.source.includes('MIS')) ||
    (activeTab === 'kasra' && validationSummary.source.includes('کسری'))
  ));
  const sourceScopeIsReady = activeTab === 'dynamic' ? Boolean(selectedDynamicPeriodId)
    : activeTab === 'mis' ? Boolean(activePeriodLabel)
      : activeTab === 'kasra' ? Boolean(selectedKasraPeriodId)
        : emailConfigured === true;
  const importFlowStep = sourceWasAccepted ? 4 : sourceHasPreview ? 3 : sourceScopeIsReady ? 2 : 1;

  if (!isOpen) return null;

  return (
    <div className={embedded ? "w-full" : "fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fade-in"} dir="rtl">
      <div className="bg-slate-900 border border-slate-800 w-full max-w-6xl max-h-[92vh] rounded-3xl shadow-2xl flex flex-col overflow-hidden text-slate-100">
        
        {/* MODAL HEADER */}
        <div className="px-6 py-4.5 border-b border-slate-800 flex items-center justify-between bg-slate-900/90 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-teal-500/10 border border-teal-500/30 flex items-center justify-center text-teal-400">
              <FileSpreadsheet className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-black text-slate-100">ورود داده از اکسل</h1>
                <span className="max-w-full whitespace-normal break-words rounded-full border border-teal-500/30 bg-teal-500/20 px-2.5 py-1 text-right text-[10px] font-bold leading-4 text-teal-300 [overflow-wrap:anywhere]">
                  همگام‌سازی فعال
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                ورود داده بر پایه شاخص‌ها، نگاشت ستون‌ها و بررسی دسترسی‌ها
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Admin Badge */}
            {isAdmin ? (
              <div className="hidden min-w-0 max-w-56 items-start gap-1.5 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-xs font-bold leading-5 text-indigo-300 sm:flex">
                <ShieldCheck className="w-3.5 h-3.5 text-indigo-400" />
                <span className="min-w-0"><span className="block">دسترسی کامل</span><span className="block text-[10px] font-medium text-indigo-200/80">ویرایش دستی فعال است</span></span>
              </div>
            ) : (
              <div className="hidden min-w-0 max-w-56 items-start gap-1.5 rounded-xl bg-slate-800 px-3 py-2 text-xs leading-5 text-slate-300 sm:flex">
                <Lock className="w-3.5 h-3.5 text-slate-500" />
                <span className="min-w-0"><span className="block">مشاهده داده‌ها</span><span className="block text-[10px] text-slate-400">ویرایش دستی در دسترس نیست</span></span>
              </div>
            )}

            <button
              onClick={onClose}
              className="p-2 rounded-xl text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* SHARED IMPORT WORKFLOW */}
        <div className="shrink-0 border-b border-slate-800 bg-slate-900/60 px-5 py-4 sm:px-6">
          {isImportSource && <>
            <ol aria-label="مراحل ورود داده" className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {['انتخاب منبع', 'دوره و نگاشت', 'پیش‌نمایش و بررسی', 'تأیید و ذخیره'].map((label, index) => {
                const step = index + 1;
                const complete = step < importFlowStep;
                const current = step === importFlowStep;
                return <li key={label} aria-current={current ? 'step' : undefined} className={`flex min-h-10 items-center gap-2 rounded-xl border px-3 py-2 text-[10px] font-bold sm:text-xs ${current ? 'border-teal-400/50 bg-teal-500/10 text-teal-200' : complete ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-200' : 'border-slate-800 bg-slate-950/40 text-slate-500'}`}>
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-950/70 text-[10px]">{complete ? <Check className="h-3 w-3" /> : step}</span>{label}
                </li>;
              })}
            </ol>
            <div role="group" aria-label="انتخاب منبع ورود داده" className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <button type="button" aria-pressed={activeTab === 'dynamic'} onClick={() => { setActiveTab('dynamic'); setErrorMessage(''); }} className={`min-h-20 rounded-2xl border p-3 text-right transition-colors ${activeTab === 'dynamic' ? 'border-teal-400/50 bg-teal-500/10' : 'border-slate-800 bg-slate-950/40 hover:border-slate-600'}`}>
                <span className="flex items-center gap-2 text-xs font-black text-slate-100"><Sparkles className="h-4 w-4 text-teal-300" />اکسل شاخص‌های ارزیابی</span><span className="mt-1 block text-[10px] leading-5 text-slate-400">{dynamicCriteria.length} معیار قابل نگاشت برای دوره و پروفایل انتخاب‌شده</span>
              </button>
              <button type="button" aria-pressed={activeTab === 'mis'} onClick={() => { setActiveTab('mis'); setErrorMessage(''); }} className={`min-h-20 rounded-2xl border p-3 text-right transition-colors ${activeTab === 'mis' ? 'border-emerald-400/50 bg-emerald-500/10' : 'border-slate-800 bg-slate-950/40 hover:border-slate-600'}`}>
                <span className="flex items-center gap-2 text-xs font-black text-slate-100"><Database className="h-4 w-4 text-emerald-300" />سامانه MIS (تولید و کیفیت)</span><span className="mt-1 block text-[10px] leading-5 text-slate-400">{misCriterionRegistry.length} معیار متصل · {misImportAllowed ? 'دسترسی مجاز' : 'نیازمند مجوز'}</span>
              </button>
              <button type="button" aria-pressed={activeTab === 'kasra'} onClick={() => { setActiveTab('kasra'); setErrorMessage(''); }} className={`min-h-20 rounded-2xl border p-3 text-right transition-colors ${activeTab === 'kasra' ? 'border-cyan-400/50 bg-cyan-500/10' : 'border-slate-800 bg-slate-950/40 hover:border-slate-600'}`}>
                <span className="flex items-center gap-2 text-xs font-black text-slate-100"><Database className="h-4 w-4 text-cyan-300" />سامانه کسری (حضور/غیاب)</span><span className="mt-1 block text-[10px] leading-5 text-slate-400">{kasraCriterionRegistry.length} معیار متصل · {kasraImportAllowed ? 'دسترسی مجاز' : 'نیازمند مجوز'}</span>
              </button>
              <button type="button" aria-pressed={activeTab === 'email'} onClick={() => { setActiveTab('email'); setErrorMessage(''); }} className={`min-h-20 rounded-2xl border p-3 text-right transition-colors ${activeTab === 'email' ? 'border-violet-400/50 bg-violet-500/10' : 'border-slate-800 bg-slate-950/40 hover:border-slate-600'}`}>
                <span className="flex items-center gap-2 text-xs font-black text-slate-100"><Mail className="h-4 w-4 text-violet-300" />ورود امن از ایمیل</span><span className="mt-1 block text-[10px] leading-5 text-slate-400">{emailConfigured === true ? 'فعال · نیازمند بازبینی' : emailConfigured === false ? 'اتصال تنظیم نشده' : 'در حال بررسی اتصال'}</span>
              </button>
            </div>
          </>}

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-800/80 pt-3" aria-label="ابزارهای اکسل">
            <span className="ml-1 text-[10px] font-bold text-slate-500">ابزارها:</span>
            <button type="button" onClick={() => { setBuilderPeriod(dynamicPeriodLabel); setBuilderProfileId(selectedDynamicProfileId); setBuilderSelectedCriteria(dynamicCriteria.map(criterion => criterion.id)); setActiveTab('builder'); }} className={`min-h-9 rounded-xl border px-3 text-[10px] font-bold transition-colors ${activeTab === 'builder' ? 'border-indigo-400/40 bg-indigo-500/15 text-indigo-200' : 'border-slate-800 text-slate-400 hover:bg-slate-800'}`}><Layers className="ml-1 inline h-3.5 w-3.5" />سازنده قالب اکسل سفارشی</button>
            <button type="button" onClick={() => setActiveTab('production_calc')} className={`min-h-9 rounded-xl border px-3 text-[10px] font-bold transition-colors ${activeTab === 'production_calc' ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200' : 'border-slate-800 text-slate-400 hover:bg-slate-800'}`}><Gauge className="ml-1 inline h-3.5 w-3.5" />محاسبه‌گر تولید و سایکل‌تایم</button>
          </div>

          {/* Quick Action Button */}
          {activeTab === 'dynamic' && dynamicRecords.length > 0 && (
            <div className="flex items-center gap-2 py-1">
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setIsManualEditEnabled(!isManualEditEnabled)}
                  className={`text-xs font-bold px-3 py-1.5 rounded-xl border flex items-center gap-1.5 transition-all cursor-pointer ${
                    isManualEditEnabled
                      ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  <Edit3 className="w-3.5 h-3.5 text-amber-400" />
                  <span>{isManualEditEnabled ? 'حالت ویرایش دستی فعال است' : 'فعال‌سازی ویرایش دستی (ادمین)'}</span>
                </button>
              )}

              <button
                type="button"
                onClick={handleApplyDynamicRecords}
                className="bg-teal-500 hover:bg-teal-400 text-slate-950 font-black text-xs px-4 py-1.5 rounded-xl shadow-lg shadow-teal-500/20 flex items-center gap-1.5 cursor-pointer transition-all"
              >
                <Save className="w-3.5 h-3.5" />
                <span>اعمال آنی بر پرونده‌ها ({dynamicRecords.length} رکورد)</span>
              </button>
            </div>
          )}
        </div>

        {/* FEEDBACK MESSAGES */}
        {isProcessing && <p role="status" className="p-3 text-teal-300">در حال پردازش فایل یا ذخیره ابری؛ نتیجه پس از تأیید سرور نمایش داده می‌شود…</p>}
      {successMessage && (
          <div className="mx-6 mt-4 p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 rounded-2xl text-xs font-bold flex items-center justify-between gap-2 shrink-0 animate-fade-in">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{successMessage}</span>
            </div>
            <button onClick={() => setSuccessMessage('')} className="text-emerald-400 hover:text-emerald-200">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {errorMessage && (
          <div className="mx-6 mt-4 p-3 bg-rose-500/10 border border-rose-500/20 text-rose-300 rounded-2xl text-xs font-bold flex items-center justify-between gap-2 shrink-0 animate-fade-in">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{errorMessage}</span>
            </div>
            <button onClick={() => setErrorMessage('')} className="text-rose-400 hover:text-rose-200">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* VALIDATION & INJECTION AUDIT REPORT */}
        {validationSummary && (
          <div className="mx-6 mt-4 p-4 bg-slate-900/90 border border-teal-500/30 rounded-2xl text-xs space-y-3 shrink-0 animate-fade-in shadow-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-teal-400" />
                <span className="font-black text-slate-100 text-sm">
                  گزارش اعتبارسنجی و تزریق به اسلات‌ها ({validationSummary.source})
                </span>
              </div>
              <button 
                type="button"
                onClick={() => setValidationSummary(null)} 
                className="text-slate-400 hover:text-slate-200 p-1 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700/60">
                <span className="text-[11px] text-slate-400 block mb-1">کل پرسنل پردازش‌شده</span>
                <span className="text-base font-black text-slate-100">{validationSummary.totalProcessed} نفر</span>
              </div>
              <div className="bg-emerald-500/10 p-3 rounded-xl border border-emerald-500/20">
                <span className="text-[11px] text-emerald-400 block mb-1">ارزیابی‌های جدید</span>
                <span className="text-base font-black text-emerald-300">{validationSummary.newEvaluations} پرونده</span>
              </div>
              <div className="bg-teal-500/10 p-3 rounded-xl border border-teal-500/20">
                <span className="text-[11px] text-teal-400 block mb-1">ارزیابی‌های به‌روزرسانی‌شده</span>
                <span className="text-base font-black text-teal-300">{validationSummary.updatedEvaluations} پرونده</span>
              </div>
              <div className="bg-indigo-500/10 p-3 rounded-xl border border-indigo-500/20">
                <span className="text-[11px] text-indigo-400 block mb-1">اسلات‌های نمره تکمیل‌شده</span>
                <span className="text-base font-black text-indigo-300">{validationSummary.slotsPopulated} اسلات</span>
              </div>
            </div>

            {validationSummary.warnings.length > 0 && (
              <div className="mt-2 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowValidationWarnings(!showValidationWarnings)}
                  className="flex items-center gap-1.5 text-amber-400 hover:text-amber-300 font-bold text-xs cursor-pointer"
                >
                  <AlertTriangle className="w-4 h-4" />
                  <span>مشاهده هشدارهای اعتبارسنجی اسلات‌ها ({validationSummary.warnings.length} مورد)</span>
                  <span className="text-[10px] underline">{showValidationWarnings ? 'بستن' : 'نمایش'}</span>
                </button>
                {showValidationWarnings && (
                  <ul className="mt-2 space-y-1.5 max-h-36 overflow-y-auto pr-2 bg-slate-950/60 p-3 rounded-xl border border-amber-500/20 text-slate-300 text-[11px]">
                    {validationSummary.warnings.map((warn, wIdx) => (
                      <li key={wIdx} className="flex items-start gap-1.5 text-amber-300/90">
                        <span className="text-amber-400 font-black">•</span>
                        <span>{warn}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {/* MAIN BODY AREA */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">

          {/* ======================================================== */}
          {/* TAB 1: DYNAMIC CRITERIA MATRIX (UNIVERSAL) */}
          {/* ======================================================== */}
          {activeTab === 'dynamic' && (
            <div className="space-y-6">
              
              {/* Upload & Action Bar */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-4 bg-slate-950/60 border border-slate-800 rounded-3xl p-5 items-center">
                <div className="md:col-span-7 space-y-1.5">
                  <h3 className="text-xs font-black text-teal-300 flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-teal-400" />
                    <span>بارگذاری فایل اکسل ماتریس ارزیابی شاخص‌ها</span>
                  </h3>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    فایل اکسل ارزیابی یا خروجی اختصاصی را انتخاب فرمایید. سیستم تمام ستون‌ها و کدهای شاخص (C-BEH-01, S-01, ...) را به صورت خودکار شناسایی و نمرات را در لحظه محاسبه می‌نماید.
                  </p>
                </div>

                <div className="md:col-span-5 flex flex-wrap items-center justify-end gap-2.5">
                  <input
                    type="file"
                    ref={dynamicFileInputRef}
                    onChange={handleDynamicFileUpload}
                    accept=".xlsx, .csv"
                    className="hidden"
                  />

                  <button
                    onClick={() => dynamicFileInputRef.current?.click()}
                    disabled={isProcessing}
                    className="bg-teal-500 hover:bg-teal-400 text-slate-950 font-black text-xs py-2.5 px-4 rounded-xl shadow-lg shadow-teal-500/20 flex items-center gap-2 cursor-pointer transition-all"
                  >
                    <Upload className="w-4 h-4" />
                    <span>{isProcessing ? 'در حال پردازش...' : 'انتخاب و آپلود اکسل شاخص‌ها'}</span>
                  </button>

                  <button
                    onClick={() => { setBuilderPeriod(dynamicPeriodLabel); setBuilderProfileId(selectedDynamicProfileId); setBuilderSelectedCriteria(dynamicCriteria.map(criterion => criterion.id)); setActiveTab('builder'); }}
                    className="bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs py-2.5 px-3.5 rounded-xl border border-slate-700 flex items-center gap-1.5 cursor-pointer transition-all"
                  >
                    <Download className="w-3.5 h-3.5 text-indigo-400" />
                    <span>دانلود قالب با شاخص‌های دلخواه</span>
                  </button>

                  {rawHeaders.length > 0 && (
                    <>
                      <button type="button" onClick={() => setShowMappingConfig(!showMappingConfig)} className={`min-h-10 text-xs font-bold py-2.5 px-3 rounded-xl border flex items-center gap-1.5 transition-all ${showMappingConfig ? 'bg-teal-500/20 border-teal-500 text-teal-300' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}`}>
                        <Settings2 className="w-3.5 h-3.5" />
                        <span>نگاشت ستون‌ها ({columnMappings.length})</span>
                      </button>
                      <button type="button" onClick={handleCancelDynamicPreview} disabled={isProcessing} data-testid="cancel-dynamic-preview" className="min-h-10 rounded-xl border border-rose-500/40 px-3 py-2.5 text-xs font-bold text-rose-300 hover:bg-rose-500/10 disabled:opacity-50">لغو پیش‌نمایش · بدون ذخیره</button>
                    </>
                  )}
                </div>
              </div>

              <div className="grid gap-3 rounded-2xl border border-slate-800 bg-slate-900/50 p-4 sm:grid-cols-2 xl:grid-cols-4">
                <label className="text-xs font-bold">دوره ارزیابی ورود داینامیک<select aria-label="دوره ارزیابی ورود داینامیک" value={selectedDynamicPeriodId} onChange={event => { setSelectedDynamicPeriodId(event.target.value); dynamicOperationId.current = crypto.randomUUID(); }} className="mt-2 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 p-2 text-slate-100">{periodOptions.map(period => <option key={period.id} value={period.id}>{period.label}</option>)}</select></label>
                <label className="text-xs font-bold">پروفایل هدف ورود داینامیک<select aria-label="پروفایل هدف ورود داینامیک" value={selectedDynamicProfileId} onChange={event => { setSelectedDynamicProfileId(event.target.value); dynamicOperationId.current = crypto.randomUUID(); }} className="mt-2 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 p-2 text-slate-100"><option value="all">پروفایل هر کارمند</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.title} · {profile.code}</option>)}</select></label>
                <div className="text-xs"><span className="font-bold">منبع داده</span><div className="mt-2 flex flex-wrap gap-2"><span className="rounded-lg bg-teal-500/15 px-3 py-2 font-bold text-teal-200">شاخص‌های دستی</span><button type="button" onClick={() => setActiveTab('mis')} className="min-h-10 rounded-lg border border-slate-700 px-3 py-2">MIS</button><button type="button" onClick={() => setActiveTab('kasra')} className="min-h-10 rounded-lg border border-slate-700 px-3 py-2">کسری</button></div><p className="mt-1 text-[10px] text-slate-400">MIS و کسری از مسیرهای منبع‌محافظت‌شده وارد می‌شوند.</p></div>
                <div className="text-xs"><span className="font-bold">دامنهٔ پیش‌نمایش</span><p className="mt-2 leading-6 text-slate-300">{dynamicPeriodLabel} · {selectedDynamicProfile?.title || 'پروفایل هر کارمند'} · {dynamicCriteria.length} شاخص مجاز</p></div>
              </div>

              {/* Column Mapping Configurator Panel */}
              {showMappingConfig && rawHeaders.length > 0 && (
                <div className="bg-slate-900 border border-teal-500/30 rounded-3xl p-5 space-y-4 animate-fade-in shadow-xl">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                    <div className="flex items-center gap-2">
                      <SlidersHorizontal className="w-4 h-4 text-teal-400" />
                      <h4 className="text-xs font-black text-slate-100">تنظیم و اصلاح نحوه نگاشت ستون‌های فایل اکسل به شاخص‌ها</h4>
                    </div>
                    <span className="text-[11px] text-teal-300 font-mono">تغییرات در لحظه در جدول زیر اعمال می‌شوند</span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 max-h-60 overflow-y-auto pr-1">
                    {columnMappings.map((mapping, idx) => (
                      <div key={idx} className="bg-slate-950/80 border border-slate-800 p-3 rounded-2xl space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-slate-200 truncate max-w-[180px]" title={mapping.excelColumn}>
                            {mapping.excelColumn}
                          </span>
                          <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-mono">
                            ستون {idx + 1}
                          </span>
                        </div>

                        <select
                          value={
                            mapping.targetType === 'criterion' && mapping.targetCriterionId
                              ? `crit:${mapping.targetCriterionId}`
                              : mapping.targetType === 'attendance_metric' && mapping.targetMetricKey
                              ? `att:${mapping.targetMetricKey}`
                              : mapping.targetType === 'mis_metric' && mapping.targetMetricKey
                              ? `mis:${mapping.targetMetricKey}`
                              : mapping.targetType
                          }
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val.startsWith('crit:')) {
                              handleUpdateColumnMapping(mapping.excelColumn, {
                                targetType: 'criterion',
                                targetCriterionId: val.replace('crit:', '')
                              });
                            } else if (val.startsWith('att:')) {
                              handleUpdateColumnMapping(mapping.excelColumn, {
                                targetType: 'attendance_metric',
                                targetMetricKey: val.replace('att:', '') as any
                              });
                            } else if (val.startsWith('mis:')) {
                              handleUpdateColumnMapping(mapping.excelColumn, {
                                targetType: 'mis_metric',
                                targetMetricKey: val.replace('mis:', '') as any
                              });
                            } else {
                              handleUpdateColumnMapping(mapping.excelColumn, {
                                targetType: val as any,
                                targetCriterionId: undefined,
                                targetMetricKey: undefined
                              });
                            }
                          }}
                          className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-xl p-2 focus:outline-none focus:border-teal-500"
                        >
                          <optgroup label="مشخصات پرسنلی">
                            <option value="staffCode">کد پرسنلی (Staff Code)</option>
                            <option value="staffName">نام و نام خانوادگی</option>
                            <option value="period">دوره ارزیابی (Period)</option>
                            <option value="note">توضیحات و بازخورد کلی</option>
                          </optgroup>

                          <optgroup label="شاخص‌های عملکردی و رفتاری">
                            {dynamicCriteria.map(c => (
                              <option key={c.id} value={`crit:${c.id}`}>
                                شاخص: [{c.code}] {c.name}
                              </option>
                            ))}
                          </optgroup>

                          <optgroup label="سایر">
                            <option value="ignore">نادیده گرفتن این ستون</option>
                          </optgroup>
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Dynamic Live Table Preview */}
              {dynamicRecords.length > 0 ? (
                <div className="bg-slate-950/70 border border-slate-800 rounded-3xl overflow-hidden shadow-xl space-y-4">
                  {/* Table Control Bar */}
                  <div className="p-4 border-b border-slate-800 flex flex-col md:flex-row items-center justify-between gap-4">
                    <div className="flex items-center gap-3 w-full md:w-auto">
                      <div className="relative w-full md:w-64">
                        <SearchInput resultCount={filteredDynamicRecords.length}
                          type="text"
                          placeholder="جستجو در پرسنل یا کد..."
                          value={searchTerm}
                          onChange={(e) => setSearchTerm(e.target.value)}
                         
                        />
                        <Search className="w-4 h-4 text-slate-500 absolute right-3 top-1/2 -translate-y-1/2" />
                      </div>

                      <div className="text-xs text-slate-400 whitespace-nowrap">
                        نمایش <span className="font-bold text-teal-400">{filteredDynamicRecords.length}</span> از {dynamicRecords.length} رکورد
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {isAdmin && isManualEditEnabled && (
                        <button
                          type="button"
                          onClick={handleAdminResetToOriginal}
                          className="text-xs font-bold text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 py-2 px-3 rounded-xl border border-slate-700 flex items-center gap-1.5 cursor-pointer transition-all"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>بازگردانی به اکسل اولیه</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={handleApplyDynamicRecords}
                        className="bg-teal-500 hover:bg-teal-400 text-slate-950 font-black text-xs py-2 px-4 rounded-xl shadow-lg shadow-teal-500/20 flex items-center gap-1.5 cursor-pointer transition-all"
                      >
                        <Save className="w-4 h-4" />
                        <span>ثبت در فرم‌های ارزیابی</span>
                      </button>
                    </div>
                  </div>

                  {/* Table Scrollable Container */}
                  <PreviewPages count={filteredDynamicRecords.length} />
                <div className="overflow-x-auto max-h-[500px]">
                    <table className="w-full text-right text-xs border-collapse">
                      <thead className="bg-slate-900/90 text-slate-300 sticky top-0 z-10 border-b border-slate-800">
                        <tr>
                          <th className="p-3 font-bold text-center w-12">#</th>
                          <th className="p-3 font-bold">کد پرسنلی</th>
                          <th className="p-3 font-bold">نام و نام خانوادگی</th>
                          <th className="p-3 font-bold">پست و واحد</th>
                          <th className="p-3 font-bold text-center">دوره</th>
                          
                          {/* Criterion Columns */}
                          {dynamicCriterionColumns.map(crit => (
                            <th key={crit.id} className="p-3 font-bold text-center border-r border-slate-800/60 min-w-[130px]">
                              <div className="text-[10px] text-teal-400 font-mono">[{crit.code}]</div>
                              <div className="truncate max-w-[140px]" title={crit.name}>{crit.name}</div>
                            </th>
                          ))}

                          <th className="p-3 font-bold min-w-[200px]">توضیحات و مستندات</th>
                          {isAdmin && isManualEditEnabled && <th className="p-3 font-bold text-center w-16">عملیات</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/50 text-slate-300">
                        {filteredDynamicRecords.slice(previewPage * 50, previewPage * 50 + 50).map((rec, rIdx) => {
                          const isInvalid = !rec.isValid;

                          return (
                            <tr
                              key={rec.id}
                              className={`hover:bg-slate-900/50 transition-colors ${
                                isInvalid ? 'bg-rose-500/5' : rec.isModifiedManually ? 'bg-amber-500/5' : ''
                              }`}
                            >
                              <td className="p-3 text-center text-slate-500 font-mono text-[11px]">
                                {rIdx + 1}
                              </td>

                              <td className="p-3 font-mono font-bold text-slate-100">
                                <div className="flex items-center gap-1.5">
                                  <span>{rec.empCode}</span>
                                  {isInvalid && (
                                    <AlertTriangle className="w-3.5 h-3.5 text-rose-400" title={rec.validationError} />
                                  )}
                                  {rec.isModifiedManually && (
                                    <span className="text-[9px] bg-amber-500/20 text-amber-300 px-1 py-0.5 rounded font-mono" title="ویرایش دستی ادمین">
                                      ادمین
                                    </span>
                                  )}
                                </div>
                              </td>

                              <td className="p-3 font-bold text-slate-200">
                                {rec.empName || <span className="text-rose-400">نامشخص</span>}
                              </td>

                              <td className="p-3 text-slate-400">
                                <div className="truncate max-w-[140px]">{rec.jobTitle}</div>
                                <div className="text-[10px] text-slate-500">{rec.unit}</div>
                              </td>

                              <td className="p-3 text-center text-slate-400 font-mono">
                                {rec.period}
                              </td>

                              {/* Scores for Each Criterion */}
                              {dynamicCriterionColumns.map(crit => {
                                const currentScore = rec.scores[crit.id] || 0;
                                const doc = rec.docs[crit.id] || '';

                                return (
                                  <td key={crit.id} className="p-3 text-center border-r border-slate-800/40">
                                    {isAdmin && isManualEditEnabled ? (
                                      <div className="flex flex-col items-center gap-1">
                                        <select
                                          value={currentScore}
                                          onChange={(e) => handleAdminScoreEdit(rec.id, crit.id, Number(e.target.value))}
                                          className="bg-slate-900 border border-amber-500/50 text-amber-300 font-bold text-xs rounded-lg py-1 px-2 focus:outline-none"
                                        >
                                          <option value={0}>ثبت نشده (۰)</option>
                                          <option value={1}>۱ (غیرقابل قبول)</option>
                                          <option value={2}>۲ (نیازمند بهبود)</option>
                                          <option value={3}>۳ (مطابق انتظار)</option>
                                          <option value={4}>۴ (بالاتر از انتظار)</option>
                                          <option value={5}>۵ (فراتر از انتظار)</option>
                                        </select>

                                        {doc && (
                                          <span className="text-[10px] text-slate-400 truncate max-w-[100px]" title={doc}>
                                            {doc}
                                          </span>
                                        )}
                                      </div>
                                    ) : (
                                      <div className="flex flex-col items-center gap-0.5">
                                        <span className={`inline-block font-mono font-bold px-2 py-0.5 rounded text-xs ${
                                          currentScore >= 4
                                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                            : currentScore === 3
                                            ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                                            : currentScore > 0
                                            ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                                            : 'bg-slate-800 text-slate-500'
                                        }`}>
                                          {currentScore > 0 ? `${currentScore} از ۵` : '-'}
                                        </span>
                                        {doc && (
                                          <span className="text-[9px] text-slate-400 truncate max-w-[110px]" title={doc}>
                                            {doc}
                                          </span>
                                        )}
                                      </div>
                                    )}
                                  </td>
                                );
                              })}

                              <td className="p-3">
                                {isAdmin && isManualEditEnabled ? (
                                  <input
                                    type="text"
                                    value={rec.overallNote || ''}
                                    placeholder="ملاحظات سرپرست..."
                                    onChange={(e) => handleAdminNoteEdit(rec.id, e.target.value)}
                                    className="w-full bg-slate-900 border border-slate-700 text-xs rounded-lg p-1.5 text-slate-200 focus:outline-none"
                                  />
                                ) : (
                                  <div className="text-slate-400 truncate max-w-[200px]" title={rec.overallNote}>
                                    {rec.overallNote || '-'}
                                  </div>
                                )}
                              </td>

                              {isAdmin && isManualEditEnabled && (
                                <td className="p-3 text-center">
                                  <button
                                    type="button"
                                    onClick={() => handleAdminDeleteRow(rec.id)}
                                    className="text-rose-400 hover:text-rose-200 p-1.5 rounded-lg hover:bg-rose-500/10 transition-colors"
                                    title="حذف این ردیف"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="bg-slate-950/40 border border-dashed border-slate-800 rounded-3xl p-12 text-center space-y-3">
                  <div className="w-14 h-14 rounded-3xl bg-teal-500/10 border border-teal-500/20 text-teal-400 flex items-center justify-center mx-auto">
                    <Upload className="w-7 h-7" />
                  </div>
                  <h4 className="text-sm font-black text-slate-200">هنوز فایلی بارگذاری نشده است</h4>
                  <p className="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
                    فایل اکسل ارزیابی واحد یا پرسنل را آپلود کنید تا تمام شاخص‌ها و نمرات به صورت خودکار تحلیل و نگاشت شوند.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ======================================================== */}
          {/* TAB 2: CUSTOM EXCEL BUILDER */}
          {/* ======================================================== */}
          {activeTab === 'builder' && (
            <div className="space-y-6">
              <div className="bg-gradient-to-r from-slate-900 to-indigo-950/40 border border-indigo-500/30 rounded-3xl p-6 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                    <Layers className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-slate-100">سازنده قالب اکسل اختصاصی بر اساس بانک شاخص‌ها</h3>
                    <p className="text-xs text-indigo-300 mt-0.5">شاخص‌های مدنظرتان را انتخاب کنید و قالب استاندارد متناسب با دوره و واحد سازمانی را بسازید</p>
                  </div>
                </div>

                {/* Filters */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
                  <div className="space-y-1.5">
                    <label className="block text-xs font-bold text-slate-300">دوره ارزیابی (Period)</label>
                    <select
                      value={builderPeriod}
                      onChange={(e) => setBuilderPeriod(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 text-slate-200 text-xs rounded-xl p-2.5 focus:outline-none focus:border-indigo-500"
                    >
                      <option value="نیمه اول ۱۴۰۵">نیمه اول ۱۴۰۵</option>
                      <option value="نیمه دوم ۱۴۰۵">نیمه دوم ۱۴۰۵</option>
                      <option value="بهار ۱۴۰۵">بهار ۱۴۰۵</option>
                      <option value="تابستان ۱۴۰۵">تابستان ۱۴۰۵</option>
                      <option value="پاییز ۱۴۰۵">پاییز ۱۴۰۵</option>
                      <option value="زمستان ۱۴۰۵">زمستان ۱۴۰۵</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-bold text-slate-300">فیلتر بر اساس عنوان شغلی</label>
                    <select
                      value={builderProfileId}
                      onChange={(e) => setBuilderProfileId(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 text-slate-200 text-xs rounded-xl p-2.5 focus:outline-none focus:border-indigo-500"
                    >
                      <option value="all">همه عنوان‌های شغلی ({employees.length} پرسنل)</option>
                      {profiles.map(p => (
                        <option key={p.id} value={p.id}>{p.title} ({p.code} - {p.family === 'B' ? 'عملیاتی' : 'ستادی'})</option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-xs font-bold text-slate-300">فیلتر بر اساس واحد سازمانی</label>
                    <select
                      value={builderUnit}
                      onChange={(e) => setBuilderUnit(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 text-slate-200 text-xs rounded-xl p-2.5 focus:outline-none focus:border-indigo-500"
                    >
                      <option value="all">همه واحدهای سازمانی</option>
                      {availableUnits.map(u => (
                        <option key={u} value={u}>{u}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Criteria Selection Checklist */}
                <div className="space-y-3 pt-3 border-t border-slate-800">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-200">انتخاب شاخص‌های مدنظر برای ستون‌های اکسل:</span>
                      <span className="text-xs text-indigo-400 font-mono font-bold">({builderSelectedCriteria.length} از {criteria.length} شاخص انتخاب شده)</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setBuilderSelectedCriteria(criteria.map(c => c.id))}
                        className="text-[11px] font-bold text-teal-400 hover:text-teal-300 bg-teal-500/10 px-2.5 py-1 rounded-lg border border-teal-500/30"
                      >
                        انتخاب همه شاخص‌ها
                      </button>
                      <button
                        type="button"
                        onClick={() => setBuilderSelectedCriteria([])}
                        className="text-[11px] font-bold text-slate-400 hover:text-slate-200 bg-slate-800 px-2.5 py-1 rounded-lg"
                      >
                        لغو انتخاب همه
                      </button>
                    </div>
                  </div>

                  {/* Category Filter Pills */}
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    {[
                      { key: 'ALL', label: 'همه دسته‌ها' },
                      { key: 'K', label: 'نتایج کمی (KPI)' },
                      { key: 'Q', label: 'کیفیت و انطباق' },
                      { key: 'B', label: 'رفتارهای شایستگی' },
                      { key: 'S', label: 'ایمنی و بهداشت HSE' },
                      { key: 'L', label: 'رهبری و مدیریت' }
                    ].map(tab => (
                      <button
                        key={tab.key}
                        type="button"
                        onClick={() => setBuilderCategoryFilter(tab.key as any)}
                        className={`text-xs font-bold px-3 py-1 rounded-xl transition-all cursor-pointer ${
                          builderCategoryFilter === tab.key
                            ? 'bg-indigo-600 text-white'
                            : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-800'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>

                  {/* Criteria Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 max-h-72 overflow-y-auto pr-1">
                    {criteria
                      .filter(c => builderCategoryFilter === 'ALL' || c.cat === builderCategoryFilter)
                      .map(crit => {
                        const isSelected = builderSelectedCriteria.includes(crit.id);
                        return (
                          <label
                            key={crit.id}
                            className={`flex items-start gap-2.5 p-3 rounded-2xl border transition-all cursor-pointer select-none ${
                              isSelected
                                ? 'bg-indigo-950/40 border-indigo-500/50 text-slate-100'
                                : 'bg-slate-950/60 border-slate-800/80 text-slate-400 hover:bg-slate-900'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => {
                                if (isSelected) {
                                  setBuilderSelectedCriteria(builderSelectedCriteria.filter(id => id !== crit.id));
                                } else {
                                  setBuilderSelectedCriteria([...builderSelectedCriteria, crit.id]);
                                }
                              }}
                              className="mt-0.5 rounded border-slate-700 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                            />
                            <div className="space-y-0.5 overflow-hidden">
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] font-mono font-bold text-teal-400 bg-slate-900 px-1.5 py-0.5 rounded">
                                  {crit.code}
                                </span>
                                <span className="text-xs font-bold truncate">{crit.name}</span>
                              </div>
                              <p className="text-[10px] text-slate-400 truncate">{crit.def}</p>
                            </div>
                          </label>
                        );
                      })}
                  </div>
                </div>

                {/* Options & Download */}
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-4 border-t border-slate-800">
                  <label className="flex items-center gap-2 text-xs font-bold text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={builderIncludeDocs}
                      onChange={(e) => setBuilderIncludeDocs(e.target.checked)}
                      className="rounded border-slate-700 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span>شامل ستون شواهد و مستندات برای هر شاخص در اکسل</span>
                  </label>

                  <button
                    type="button"
                    disabled={builderSelectedCriteria.length === 0}
                    onClick={() => {
                      downloadDynamicCriteriaExcelTemplate({
                        employees,
                        criteria,
                        profiles,
                        selectedCriteriaIds: builderSelectedCriteria,
                        selectedProfileId: builderProfileId,
                        selectedUnit: builderUnit,
                        period: builderPeriod,
                        includeDocColumns: builderIncludeDocs,
                        existingEvaluations: evaluations
                      });
                      setSuccessMessage('قالب اختصاصی اکسل با شاخص‌های انتخابی شما با موفقیت دانلود شد.');
                    }}
                    className="w-full sm:w-auto bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 disabled:opacity-50 text-white font-black text-xs py-3 px-6 rounded-2xl shadow-lg shadow-indigo-600/30 flex items-center justify-center gap-2 cursor-pointer transition-all"
                  >
                    <Download className="w-4 h-4" />
                    <span>دانلود قالب اکسل داینامیک (.xlsx)</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ======================================================== */}
          {/* TAB 3: KASRA ATTENDANCE SYSTEM */}
          {/* ======================================================== */}
          {activeTab === 'kasra' && (
            <div className="space-y-6">
              <div className="rounded-2xl border border-teal-500/20 bg-teal-500/5 p-4">
                <div className="text-xs font-black text-teal-200">شاخص‌های متصل به کسری ({kasraCriterionRegistry.length})</div>
                <div className="mt-2 flex flex-wrap gap-2">{kasraCriterionRegistry.map(item => <span key={item.criterionId} className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-200">{item.title}</span>)}</div>
              </div>
              <div className="bg-slate-950/60 border border-slate-800 rounded-3xl p-6 space-y-4">
                <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                  <div className="space-y-1">
                    <h3 className="text-sm font-black text-slate-100">دریافت و پردازش فایل حضور و غیاب سامانه کسری</h3>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      دوره را انتخاب کنید، فایل را اعتبارسنجی و پیش‌نمایش کنید، سپس فقط اسلات‌های کسری در ارزیابی‌های موجود ذخیره می‌شوند.
                    </p>
                    <p className="text-[11px] text-teal-200">دوره انتخاب‌شده: <strong>{selectedKasraPeriod?.label || 'انتخاب نشده'}</strong> · شناسه: <span className="font-mono">{selectedKasraPeriodId || '—'}</span></p>
                  </div>

                  <div className="flex items-center gap-2.5">
                    <label className="text-[10px] text-slate-400">دوره ارزیابی
                      <select aria-label="دوره ارزیابی کسری" value={selectedKasraPeriodId} onChange={event => { setSelectedKasraPeriodId(event.target.value); setKasraApplySummary(null); }} className="mt-1 block rounded-lg border border-slate-700 bg-slate-950 p-2 text-xs text-slate-100">
                        <option value="">انتخاب دوره</option>
                        {periodOptions.map(period => <option key={period.id} value={period.id}>{period.label}</option>)}
                      </select>
                    </label>
                    <input
                      type="file"
                      ref={kasraFileInputRef}
                      onChange={handleKasraFileChange}
                      accept=".xlsx, .csv"
                      className="hidden"
                    />

                    <button
                      onClick={() => downloadKasraExcelTemplate(employees)}
                      className="bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs py-2.5 px-4 rounded-xl border border-slate-700 flex items-center gap-2 cursor-pointer"
                    >
                      <Download className="w-4 h-4 text-teal-400" />
                      <span>دانلود قالب اکسل کسری</span>
                    </button>

                    <button
                      onClick={() => kasraFileInputRef.current?.click()}
                      disabled={isProcessing || !kasraImportAllowed || !selectedKasraPeriodId}
                      className="bg-teal-500 hover:bg-teal-400 text-slate-950 font-black text-xs py-2.5 px-4 rounded-xl shadow-lg shadow-teal-500/20 flex items-center gap-2 cursor-pointer"
                    >
                      <Upload className="w-4 h-4" />
                      <span>{kasraImportAllowed ? 'بارگذاری اکسل کسری' : 'مجوز کسری لازم است'}</span>
                    </button>
                  </div>
                </div>

                {kasraErrors.length > 0 && <div className="max-h-32 overflow-auto rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-[10px] leading-5 text-amber-200" role="status">{kasraErrors.slice(0, 12).map((error, index) => <p key={`${index}:${error}`}>{error}</p>)}</div>}

                {kasraRecords.length > 0 && <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8" aria-label="خلاصه اعتبارسنجی کسری">
                  {[
                    ['کل ردیف‌ها', kasraCounts.total], ['معتبر', kasraCounts.valid], ['نامعتبر', kasraCounts.invalid], ['تکراری', kasraCounts.duplicate],
                    ['کارمند ناشناخته', kasraCounts.unknownEmployee], ['ارزیابی موجود نیست', kasraCounts.missingEvaluation], ['معیار کسری نیست', kasraCounts.missingCriterion], ['ناسازگاری دوره', kasraCounts.periodMismatch],
                  ].map(([label, count]) => <div key={String(label)} className="rounded-xl border border-slate-800 bg-slate-900/70 p-2.5 text-[10px] text-slate-400">{label}<strong className="mt-1 block text-sm text-slate-100">{count}</strong></div>)}
                </div>}

                {kasraApplySummary && <div role="status" className="grid grid-cols-2 gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-[10px] text-emerald-100 sm:grid-cols-4 lg:grid-cols-7">
                  {Object.entries({ 'ردیف خوانده‌شده': kasraApplySummary.rowsRead, 'کارمند منطبق': kasraApplySummary.employeesMatched, 'ارزیابی به‌روز': kasraApplySummary.evaluationsUpdated, 'نمره به‌روز': kasraApplySummary.scoresUpdated, 'ردیف ردشده': kasraApplySummary.skipped, 'نامعتبر': kasraApplySummary.invalid, 'ناموفق': kasraApplySummary.failed }).map(([label, count]) => <div key={label}>{label}<strong className="mt-1 block text-sm">{count}</strong></div>)}
                </div>}

                {/* Kasra Records Table */}
                {kasraRecords.length > 0 && (
                  <div className="space-y-3 pt-4 border-t border-slate-800">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-200">اعتبارسنجی و پیش‌نمایش کسری ({kasraCounts.valid} ردیف آماده از {kasraRecords.length})</span>
                      <button
                        onClick={() => setIsKasraConfirmOpen(true)}
                        disabled={kasraCounts.valid === 0 || isKasraApplying}
                        className="bg-teal-500 hover:bg-teal-400 text-slate-950 font-black text-xs py-1.5 px-4 rounded-xl shadow cursor-pointer flex items-center gap-1.5 disabled:opacity-40"
                      >
                        <Save className="w-3.5 h-3.5" />
                        <span>بازبینی و تأیید</span>
                      </button>
                    </div>

                    <label className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs"><SearchInput resultCount={filteredKasraPreviewRows.length} aria-label="جستجوی پیش‌نمایش کسری با کد پرسنلی" value={searchTerm} onChange={event => setSearchTerm(event.target.value)} placeholder="جستجو با نام یا کد پرسنلی" /></label>
                    <PreviewPages count={filteredKasraPreviewRows.length} />

                <div className="overflow-x-auto max-h-80 rounded-2xl border border-slate-800">
                      <table className="w-full text-right text-xs">
                        <thead className="bg-slate-900 text-slate-300">
                          <tr>
                            <th className="p-2.5">کد</th>
                            <th className="p-2.5">نام</th>
                            <th className="p-2.5 text-center">دوره انتخاب‌شده</th>
                            <th className="p-2.5 text-center">معیار کسری</th>
                            <th className="p-2.5 text-center">خام</th>
                            <th className="p-2.5 text-center">نمره قبل ← بعد</th>
                            <th className="p-2.5 text-center">اعتبارسنجی</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/50">
                          {filteredKasraPreviewRows.slice(previewPage * 50, previewPage * 50 + 50).map(row => (
                            <tr key={row.record.id} className={row.status === 'valid' ? 'hover:bg-slate-900/40' : 'bg-rose-500/5'}>
                              <td className="p-2.5 font-mono font-bold text-teal-400">{row.record.empCode}</td>
                              <td className="p-2.5 font-bold text-slate-200">{row.employee?.name || row.record.empName || '—'}</td>
                              <td className="p-2.5 text-center text-slate-400">{selectedKasraPeriod?.label || '—'}</td>
                              <td className="p-2.5 text-center text-slate-300">{row.changedScores.map(score => score.criterion.name).join('، ') || '—'}</td>
                              <td className="p-2.5 text-center text-slate-300">{row.changedScores.map(score => score.rawMetricValue).join('، ') || '—'}</td>
                              <td className="p-2.5 text-center font-bold text-emerald-400">{row.changedScores.map(score => `${score.previousValue} ← ${score.nextValue}`).join('، ') || '—'}</td>
                              <td className={`p-2.5 text-center ${row.status === 'valid' ? 'text-emerald-300' : 'text-rose-300'}`}>{row.status === 'valid' ? 'معتبر' : row.issue}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {isKasraConfirmOpen && <div className="fixed inset-0 z-[100000] flex items-center justify-center bg-slate-950/80 p-4" role="dialog" aria-modal="true" aria-labelledby="kasra-confirm-title">
                  <div className="w-full max-w-lg space-y-4 rounded-2xl border border-teal-500/30 bg-slate-900 p-5 text-right shadow-2xl">
                    <h3 id="kasra-confirm-title" className="text-sm font-black text-slate-100">تأیید درون‌ریزی کسری</h3>
                    <p className="text-xs leading-6 text-slate-300">دوره: <strong>{selectedKasraPeriod?.label}</strong> · شناسه دوره: <code>{selectedKasraPeriodId}</code>. پس از تأیید، {kasraCounts.valid} ردیف معتبر در ارزیابی‌های موجود به‌روزرسانی می‌شود؛ {kasraCounts.invalid} ردیف رد می‌شود. پیش از این دکمه هیچ ارزیابی ذخیره نشده است.</p>
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={() => setIsKasraConfirmOpen(false)} disabled={isKasraApplying} className="rounded-xl bg-slate-700 px-4 py-2 text-xs font-bold text-white">لغو؛ بدون ذخیره</button>
                      <button type="button" onClick={handleApplyKasraRecords} disabled={isKasraApplying || kasraCounts.valid === 0} className="rounded-xl bg-teal-500 px-4 py-2 text-xs font-black text-slate-950 disabled:opacity-50">{isKasraApplying ? 'در حال ذخیره…' : `تأیید ${kasraCounts.valid} ردیف`}</button>
                    </div>
                  </div>
                </div>}
              </div>
            </div>
          )}

          {/* ======================================================== */}
          {/* TAB 4: MIS PRODUCTION SYSTEM */}
          {/* ======================================================== */}
          {activeTab === 'mis' && (
            <div className="space-y-6">
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                <div className="text-xs font-black text-emerald-200">شاخص‌های متصل به MIS ({misCriterionRegistry.length})</div>
                <div className="mt-2 flex flex-wrap gap-2">{misCriterionRegistry.map(item => <span key={item.criterionId} className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-200">{item.title}{item.unit ? ` · ${item.unit}` : ''}</span>)}</div>
                <p className="mt-2 text-[10px] text-slate-400">معیار تازه پس از ذخیره در همین نگاشت دیده می‌شود؛ معیار سفارشی باید نام ستون و روش امتیازدهی داشته باشد.</p>
              </div>
              <div className="bg-slate-950/60 border border-slate-800 rounded-3xl p-6 space-y-4">
                <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-3 text-xs text-slate-300">
                  <strong className="text-sky-200">دوره ارزیابی فعال:</strong> {db.getMiscData<string>('pe_active_period', '').trim() || 'هیچ دوره‌ای فعال نیست'}
                  <span className="block mt-1 text-slate-400">شناسه تطبیق، کد پرسنلی است. پس از ثبت، مقادیر MIS به عنوان داده سامانه‌ای ذخیره و در فرم ارزیابی فقط‌خواندنی می‌شوند؛ این مقادیر در محاسبه امتیاز معیارهای MIS مشارکت دارند.</span>
                </div>
                <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                  <div className="space-y-1">
                    <h3 className="text-sm font-black text-slate-100">دریافت و پردازش فایل تولید و کیفیت سامانه MIS</h3>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      محاسبه نمرات شاخص‌های کمی و کیفی بر اساس راندمان خط، نرخ ضایعات، تیراژ تولید و نمره QC
                    </p>
                  </div>

                  <div className="flex items-center gap-2.5">
                    <input
                      type="file"
                      data-testid="mis-file-input"
                      ref={misFileInputRef}
                      onChange={handleMISFileChange}
                      accept=".xlsx, .csv"
                      className="hidden"
                    />

                    <button
                      onClick={() => downloadMISExcelTemplate(employees, db.getMiscData<string>('pe_active_period', '').trim())}
                      disabled={!db.getMiscData<string>('pe_active_period', '').trim()}
                      className="bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs py-2.5 px-4 rounded-xl border border-slate-700 flex items-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Download className="w-4 h-4 text-emerald-400" />
                      <span>دانلود قالب اکسل MIS</span>
                    </button>

                    <button
                      onClick={() => misFileInputRef.current?.click()}
                      disabled={isProcessing || !misImportAllowed || !db.getMiscData<string>('pe_active_period', '').trim()}
                      className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs py-2.5 px-4 rounded-xl shadow-lg shadow-emerald-500/20 flex items-center gap-2 cursor-pointer"
                    >
                      <Upload className="w-4 h-4" />
                      <span>{misImportAllowed ? 'بارگذاری اکسل MIS' : 'مجوز MIS لازم است'}</span>
                    </button>
                  </div>
                </div>

                {(misExpectedPeriod || misCounts.invalid > 0) && <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2" aria-label="خلاصه اعتبارسنجی MIS">
                  {[
                    ['معتبر', misCounts.valid], ['نامعتبر', misCounts.invalid], ['تکراری', misCounts.duplicate],
                    ['کارمند ناشناخته', misCounts.unknown], ['نگاشت ناقص', misCounts.missingMapping], ['هشدار', misCounts.warning],
                  ].map(([label, count]) => <div key={String(label)} className="rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-[11px] text-slate-400">{label}<strong className="mt-1 block text-sm text-slate-100">{count}</strong></div>)}
                </div>}

                {misIssues.length > 0 && <div className="max-h-52 overflow-auto rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
                  <h4 className="mb-2 text-xs font-bold text-amber-200">خطاهای قابل اصلاح در فایل</h4>
                  <div className="space-y-2">{misIssues.map((issue, index) => <div key={`${issue.row}:${issue.column}:${index}`} className="rounded-lg bg-slate-950/70 p-2 text-[10px] leading-5 text-slate-300"><strong>ردیف {issue.row} · ستون {issue.column}</strong>{issue.employee && <span> · پرسنل {issue.employee}</span>}<span className="block">{issue.issue} — اصلاح: {issue.correction}</span></div>)}</div>
                </div>}

                {/* MIS Records Table */}
                {misRecords.length > 0 && (
                  <div className="space-y-3 pt-4 border-t border-slate-800">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-200">پیش‌نمایش داده‌های تولید MIS ({misRecords.length} پرسنل)</span>
                      <button
                        onClick={() => setIsMisConfirmOpen(true)}
                        className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs py-1.5 px-4 rounded-xl shadow cursor-pointer flex items-center gap-1.5"
                      >
                        <Save className="w-3.5 h-3.5" />
                        <span>بازبینی و تأیید اعمال</span>
                      </button>
                    </div>

                    <label className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs"><SearchInput resultCount={filteredMisRecords.length} aria-label="جستجوی پیش‌نمایش MIS با کد پرسنلی" value={searchTerm} onChange={event => setSearchTerm(event.target.value)} placeholder="جستجو با نام یا کد پرسنلی" /></label>
                    <PreviewPages count={filteredMisRecords.length} />

                <div className="overflow-x-auto max-h-80 rounded-2xl border border-slate-800">
                      <table className="w-full text-right text-xs">
                        <thead className="bg-slate-900 text-slate-300">
                          <tr>
                            <th className="p-2.5">کد</th>
                            <th className="p-2.5">نام</th>
                            <th className="p-2.5 text-center">دوره</th>
                            <th className="p-2.5 text-center">راندمان</th>
                            <th className="p-2.5 text-center">ضایعات</th>
                            <th className="p-2.5 text-center">کیفیت QC</th>
                            <th className="p-2.5 text-center">نمره KPI (۱-۵)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/50">
                          {filteredMisRecords.slice(previewPage * 50, previewPage * 50 + 50).map(r => (
                            <tr key={r.id} className="hover:bg-slate-900/40">
                              <td className="p-2.5 font-mono font-bold text-emerald-400">{r.empCode}</td>
                              <td className="p-2.5 font-bold text-slate-200">{r.empName}</td>
                              <td className="p-2.5 text-center text-slate-400">{r.period}</td>
                              <td className="p-2.5 text-center text-slate-300">{r.efficiencyRate}٪</td>
                              <td className="p-2.5 text-center text-slate-300">{r.scrapRate}٪</td>
                              <td className="p-2.5 text-center text-slate-300">{r.qualityScore}٪</td>
                              <td className="p-2.5 text-center font-bold text-emerald-400">{r.calculatedKpiScore} از ۵</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {isMisConfirmOpen && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 p-4" role="dialog" aria-modal="true" aria-labelledby="mis-confirm-title">
                  <div className="w-full max-w-lg space-y-4 rounded-2xl border border-emerald-500/30 bg-slate-900 p-5 text-right shadow-2xl">
                    <h3 id="mis-confirm-title" className="text-sm font-black text-slate-100">تأیید درون‌ریزی داده‌های MIS</h3>
                    <p className="text-xs leading-6 text-slate-300">دوره: <strong>{misExpectedPeriod}</strong> · رکوردهای معتبر: <strong>{misRecords.length}</strong> · واجد شرایط: <strong>{misEligibleCount}</strong> · ردشده: <strong>{misRecords.length - misEligibleCount}</strong>. فقط مقادیر MIS با کد پرسنلی منطبق در ارزیابی‌های همین دوره ثبت می‌شوند؛ امتیازهای دستی سرپرست حفظ و مقادیر MIS پس از ثبت فقط‌خواندنی خواهند بود.</p>
                    <div className="flex justify-end gap-2"><button type="button" onClick={() => setIsMisConfirmOpen(false)} className="rounded-xl bg-slate-700 px-4 py-2 text-xs font-bold text-white">بازگشت به پیش‌نمایش</button><button type="button" onClick={handleApplyMISRecords} disabled={isProcessing || !misEligibleCount} className="rounded-xl bg-emerald-500 px-4 py-2 text-xs font-black text-slate-950">تأیید و اعمال {misEligibleCount} رکورد</button></div>
                  </div>
                </div>}
              </div>
            </div>
          )}

          {activeTab === 'email' && (
            <section className="mx-auto max-w-3xl space-y-4 rounded-3xl border border-violet-500/20 bg-slate-950/60 p-6" aria-label="ورود داده ارزیابی از ایمیل">
              <div className="flex items-center gap-3"><Mail className="h-6 w-6 text-violet-300" /><div><h3 className="text-sm font-black text-slate-100">دریافت امن داده از ایمیل</h3><p className="mt-1 text-xs text-slate-400">پیام‌ها و فایل‌ها ابتدا در صف بررسی می‌مانند و به‌تنهایی نمره‌ای را تغییر نمی‌دهند.</p></div></div>
              {emailConfigured === true ? (
                <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm font-bold text-emerald-200">ایمیل فعال · پیام‌های ورودی با فرستنده مجاز به قرنطینه می‌روند و پیش از ورود اطلاعات باید بازبینی و تأیید شوند.</div>
              ) : emailConfigured === false ? (
                <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm font-bold text-amber-100">اتصال ایمیل تنظیم نشده است</div>
              ) : (
                <div role="status" className="rounded-xl border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300">در حال بررسی تنظیم اتصال ایمیل…</div>
              )}
              <p className="text-xs leading-6 text-slate-400">اتصال فقط پس از تنظیم وب‌هوک امن سمت سرور و فهرست فرستندگان مجاز فعال می‌شود. عنوان ایمیل یا نام پیوست مجوز ورود داده نیست؛ فرستنده، نوع فایل، دوره، کد پرسنلی و نگاشت شاخص باید اعتبارسنجی شوند.</p>
              <EmailQuarantineReview isAdmin={isAdmin} enabled={emailConfigured === true} acceptedImport={lastAcceptedImport} />
            </section>
          )}

          {/* TAB 5: PRODUCTION & CYCLE TIME ENGINE */}
          {activeTab === 'production_calc' && (
            <div className="p-2">
              <ProductionCycleTimeCalculator
                employees={employees}
                criteria={criteria}
                profiles={profiles}
                evaluations={evaluations}
                onUpdateEvaluations={(nextEvals) => {
                  onUpdateEvaluations(nextEvals);
                  setSuccessMessage('محاسبات خودکار تولید و سایکل‌تایم با موفقیت انجام و در کارنامه‌ها ثبت شد.');
                }}
                currentUser={currentUser}
                onClose={onClose}
              />
            </div>
          )}

        </div>

        <div className="px-6 pb-4"><ImportHistoryPanel /></div>

        {/* FOOTER */}
        <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-900/90 flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <Info className="w-4 h-4 text-teal-400 shrink-0" />
            <span>پیش‌نمایش تغییری ذخیره نمی‌کند؛ فقط تأیید نهایی پس از پاسخ موفق سرور ثبت می‌شود.</span>
          </div>

          <button
            onClick={onClose}
            className="w-full sm:w-auto bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold px-5 py-2 rounded-xl border border-slate-700 cursor-pointer transition-colors"
          >
            بستن پنجره
          </button>
        </div>

      </div>
    </div>
  );
}




