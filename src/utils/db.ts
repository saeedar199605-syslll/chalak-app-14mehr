/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Centralized Database & Storage Service for Esfahan Chalak Performance System
 * Fully compatible with:
 * - Cloudflare Pages (Free tier static SPA & KV)
 * - Local & Containerized Node/Express Server
 * - Offline-first browser storage (resilient & persistent)
 */

import { Criterion, JobProfile, Employee, Evaluation, OKRGoal, OneOnOneMeeting, PraiseKudos } from '../types';
import { SEED_CRITERIA, SEED_PROFILES, SEED_EMPLOYEES, SEED_EVALUATIONS } from '../seedData';
import { INITIAL_OKRS, INITIAL_ONE_ON_ONES, INITIAL_KUDOS } from '../data/latticeKickidlerSeed';
import { CLOUD_SYNC_KEYS, CloudState, isCloudSyncKey } from '../../cloudflare/syncState';
import { DelegationRecord } from './workflowAuthorization';
import type { EvaluationSourceImportContext, MasterDataSourceImportContext, SourceImportContext } from './sourceImports';
import { planEmployeeBulkDeletion } from './employeeDeletion';
import { CLOUD_SYNC_MAX_RETRIES, CLOUD_SYNC_POLL_INTERVAL_MS, cloudWriteFingerprint, getCloudRetryDelay, isCurrentSyncGeneration, isSameRejectedSnapshot, isTerminalCloudWriteStatus, selectCloudSyncOperation, shouldAttemptSync, shouldRetryCloudStatus, shouldScheduleCloudSyncFollowup } from '../../cloudflare/syncPolicy';
import { createDomainEvents, domainEventTypesForStateChange, type DomainEvent, type DomainEventType } from './domainEvents';

export type ServerConnectionState = 'CONNECTED' | 'SYNCING' | 'LOCAL_CHANGES_PENDING' | 'DEGRADED' | 'OFFLINE' | 'AUTH_REQUIRED' | 'CONFLICT';

export interface CloudSyncDiagnostics {
  connectionState: ServerConnectionState;
  revision: number;
  lastSuccessfulReadAt: string | null;
  lastSuccessfulWriteAt: string | null;
  pendingOperationIds: string[];
  queueDepth: number;
  inFlightWrites: number;
  maxConcurrentWrites: number;
  lastFailureCode: string | null;
}

const STORAGE_KEYS = {
  EMPLOYEES: 'pe_employees',
  CRITERIA: 'pe_criteria',
  PROFILES: 'pe_profiles',
  EVALUATIONS: 'pe_evaluations',
  ARCHIVED_EVALUATIONS: 'pe_archived_evaluations',
  THEME: 'pe_theme',
  ACTIVE_PERIOD: 'pe_active_period',
  BACKUP_TIMESTAMP: 'pe_last_backup_ts',
  OKRS: 'pe_lattice_okrs',
  ONE_ON_ONES: 'pe_lattice_one_on_ones',
  KUDOS: 'pe_lattice_kudos',
  WORKSHOP_TARGETS: 'pe_workshop_targets',
  DELEGATIONS: 'pe_delegations'
} as const;

export const CURRENT_ACTIVE_PERIOD = 'بهار ۱۴۰۵';

function cloudDenialMessage(reason?: string, fallback?: string): string {
  const messages: Record<string, string> = {
    permission_denied: 'برای این کار مجوز ندارید. تغییر شما حفظ شده است.',
    outside_scope: 'این پرونده خارج از محدوده دسترسی شماست. تغییر شما حفظ شده است.',
    workflow_owner_mismatch: 'این پرونده به مسئول دیگری واگذار شده است. تغییر شما حفظ شده است.',
    stage_not_authorized: 'این تغییر در مرحله فعلی گردش کار مجاز نیست. تغییر شما حفظ شده است.',
    source_owned_value_read_only: 'مقدار خودکار و محافظت‌شده قابل ویرایش دستی نیست.',
    finalized_record_locked: 'پرونده نهایی یا قفل‌شده قابل ویرایش نیست.',
    import_not_authorized: 'مجوز ورود این نوع اطلاعات را ندارید.',
    mis_import_not_authorized: 'مجوز ورود اطلاعات MIS را برای این محدوده ندارید.',
    kasra_import_not_authorized: 'مجوز ورود اطلاعات کسری را برای این محدوده ندارید.',
    employee_import_not_authorized: 'مجوز ورود اطلاعات کارکنان را ندارید.',
    criteria_import_not_authorized: 'مجوز ورود معیارها را ندارید.',
    source_import_invalid: 'منبع یا محدوده این ورود اطلاعات با پرونده تطبیق ندارد.',
    score_limit_exceeded: 'نمره واردشده از محدوده مجاز بیشتر است.',
    invalid_criterion_configuration: 'تنظیم نمره یا آستانه‌های این معیار معتبر نیست.',
  };
  return messages[reason || ''] || fallback || 'سرور این تغییر را به‌دلیل محدودیت ثبت نکرد. تغییر شما حفظ شده است.';
}

const BACKUP_COLLECTION_KEYS = [
  'employees', 'criteria', 'profiles', 'evaluations', 'archivedEvaluations', 'delegations',
] as const;

function isBackupRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateBackupTopLevel(data: unknown): asserts data is Record<string, any> {
  if (!isBackupRecord(data) || !isBackupRecord(data.meta)) throw new Error('Invalid backup top-level structure');
  const schemaVersion = (data.meta as Record<string, unknown>).schemaVersion;
  if (schemaVersion !== 1) throw new Error('Unsupported or invalid backup schema version');
  for (const key of BACKUP_COLLECTION_KEYS) if (!Array.isArray(data[key])) throw new Error(`Backup collection ${key} must be an array`);
}

function validateBackupCollectionShapes(data: Record<string, any>): void {
  for (const key of BACKUP_COLLECTION_KEYS) {
    for (const record of data[key]) {
      if (!isBackupRecord(record)) throw new Error(`Backup collection ${key} contains an invalid record`);
    }
  }
}

function requireString(record: Record<string, unknown>, key: string, collection: string): void {
  if (typeof record[key] !== 'string') throw new Error(`Backup ${collection}.${key} must be a string`);
}

function requireNumber(record: Record<string, unknown>, key: string, collection: string): void {
  if (typeof record[key] !== 'number') throw new Error(`Backup ${collection}.${key} must be a number`);
}

function validateBackupRequiredFields(data: Record<string, any>): void {
  for (const record of data.employees) for (const key of ['id', 'name', 'code', 'profileId', 'unit', 'role', 'username']) requireString(record, key, 'employees');
  for (const record of data.criteria) for (const key of ['id', 'code', 'cat', 'name', 'def']) requireString(record, key, 'criteria');
  for (const record of data.profiles) {
    for (const key of ['id', 'title', 'code', 'family']) requireString(record, key, 'profiles');
    if (typeof record.locked !== 'boolean' || !Array.isArray(record.items)) throw new Error('Backup profiles required shape is invalid');
    for (const item of record.items) {
      if (!isBackupRecord(item)) throw new Error('Backup profiles.items record is invalid');
      requireString(item, 'cid', 'profiles.items');
      requireNumber(item, 'weight', 'profiles.items');
    }
  }
  for (const record of [...data.evaluations, ...data.archivedEvaluations]) {
    for (const key of ['id', 'empId', 'profileId', 'period', 'status']) requireString(record, key, 'evaluations');
    requireNumber(record, 'created', 'evaluations');
    if (!Array.isArray(record.scores)) throw new Error('Backup evaluations.scores must be an array');
    for (const score of record.scores) {
      if (!isBackupRecord(score)) throw new Error('Backup evaluations.scores record is invalid');
      requireString(score, 'cid', 'evaluations.scores');
      for (const key of ['weight', 'value', 'self']) requireNumber(score, key, 'evaluations.scores');
    }
  }
  for (const record of data.delegations) {
    for (const key of ['id', 'delegatorId', 'delegateId', 'action', 'scope', 'status']) requireString(record, key, 'delegations');
    for (const key of ['startDate', 'endDate']) requireNumber(record, key, 'delegations');
  }
}

function validateBackupUniqueIds(data: Record<string, any>): void {
  for (const key of BACKUP_COLLECTION_KEYS) {
    const seen = new Set<string>();
    for (const record of data[key]) {
      if (seen.has(record.id)) throw new Error(`Backup collection ${key} contains duplicate id`);
      seen.add(record.id);
    }
  }
}

function validateBackupReferences(data: Record<string, any>): void {
  const employeeIds = new Set(data.employees.map((employee: Record<string, unknown>) => employee.id));
  for (const evaluation of data.evaluations) {
    if (!employeeIds.has(evaluation.empId)) throw new Error('Backup evaluation references an unknown employee');
  }
}

const OPTIONAL_BACKUP_KEYS = {
  permissions: 'pe_role_permissions',
  customUserPermissions: 'pe_user_custom_permissions',
  lockedUsers: 'pe_locked_users',
  logs: 'pe_system_logs',
} as const;

const PENDING_SYNC_BACKUP_PREFIX = 'pe_pending_cloud_write_v1_';

function hasBackupField(data: Record<string, any>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(data, key);
}

function validateOptionalBackupSettings(data: Record<string, any>): void {
  const requireBooleans = (record: Record<string, unknown>, keys: readonly string[], label: string) => {
    for (const key of keys) if (typeof record[key] !== 'boolean') throw new Error(`Backup ${label}.${key} must be a boolean`);
  };
  if (hasBackupField(data, 'permissions')) {
    if (!Array.isArray(data.permissions)) throw new Error('Backup permissions must be an array');
    for (const record of data.permissions) {
      if (!isBackupRecord(record)) throw new Error('Backup permissions record is invalid');
      requireString(record, 'role', 'permissions');
      requireBooleans(record, ['canEditCriteria', 'canEditProfiles', 'canEditEmployees', 'canStartEvaluations', 'canLockScores', 'canViewSalaries', 'canDefineTargets', 'canRestoreBackup'], 'permissions');
    }
  }
  if (hasBackupField(data, 'customUserPermissions')) {
    if (!isBackupRecord(data.customUserPermissions)) throw new Error('Backup customUserPermissions must be an object');
    for (const record of Object.values(data.customUserPermissions)) {
      if (!isBackupRecord(record)) throw new Error('Backup customUserPermissions record is invalid');
      requireString(record, 'userId', 'customUserPermissions');
      requireBooleans(record, ['canEditCriteria', 'canEditProfiles', 'canEditEmployees', 'canStartEvaluations', 'canLockScores', 'canDefineTargets', 'canViewReports', 'canRestoreBackup'], 'customUserPermissions');
    }
  }
  if (hasBackupField(data, 'lockedUsers')) {
    if (!Array.isArray(data.lockedUsers) || data.lockedUsers.some((id: unknown) => typeof id !== 'string')) throw new Error('Backup lockedUsers must be an array of strings');
  }
  if (hasBackupField(data, 'logs')) {
    if (!Array.isArray(data.logs)) throw new Error('Backup logs must be an array');
    for (const record of data.logs) {
      if (!isBackupRecord(record)) throw new Error('Backup logs record is invalid');
      for (const key of ['id', 'timestamp', 'operator', 'action', 'details', 'type']) requireString(record, key, 'logs');
    }
  }
}

/** Parse and validate without touching persistence, for restore previews/merges. */
export function validateBackupJSON(jsonStr: string): Record<string, any> {
  const data = JSON.parse(jsonStr) as Record<string, any>;
  validateBackupTopLevel(data);
  validateBackupCollectionShapes(data);
  validateBackupRequiredFields(data);
  validateBackupUniqueIds(data);
  validateBackupReferences(data);
  validateOptionalBackupSettings(data);
  return data;
}

/** Preserve the established code/id upsert semantics before one atomic commit. */
export function mergeBackupCollections(incoming: Record<string, any>, current: Record<string, any>): Record<string, any> {
  const byCode = (key: 'employees' | 'criteria' | 'profiles') => {
    const merged = new Map<string, any>();
    for (const record of current[key]) merged.set(record.code.toUpperCase(), record);
    for (const record of incoming[key]) merged.set(record.code.toUpperCase(), record);
    return Array.from(merged.values());
  };
  const byId = (key: 'evaluations' | 'archivedEvaluations' | 'delegations') => {
    const merged = new Map<string, any>();
    for (const record of current[key]) merged.set(record.id, record);
    for (const record of incoming[key]) merged.set(record.id, record);
    return Array.from(merged.values());
  };
  return {
    ...incoming,
    employees: byCode('employees'),
    criteria: byCode('criteria'),
    profiles: byCode('profiles'),
    evaluations: byId('evaluations'),
    archivedEvaluations: byId('archivedEvaluations'),
    delegations: byId('delegations'),
  };
}

export class AppDatabase {
  private remoteAuditHistory: unknown[] | null = null;
  private pendingSyncOperation?: { id: string; fingerprint: string; userId: string };
  private workflowContacts: Employee[] = [];

  public getWorkflowRoutingEmployees(employees: Employee[]): Employee[] {
    const directory = new Map(this.workflowContacts.map(person => [person.id, person]));
    employees.forEach(person => directory.set(person.id, person));
    return [...directory.values()];
  }
  private syncTimeout: any = null;
  private listeners: Set<(key: string, data: any) => void> = new Set();
  private domainEventListeners = new Set<(event: DomainEvent) => void>();
  private pendingDomainEventTypesByKey = new Map<string, Set<DomainEventType>>();
  private connectionState: ServerConnectionState = 'DEGRADED';
  private lastSuccessfulReadAt: string | null = null;
  private lastSuccessfulWriteAt: string | null = null;
  private lastFailureCode: string | null = null;
  private pendingOperationIds = new Set<string>();
  private managedCommitQueueDepth = 0;
  private activeManagedWrites = 0;
  private maxConcurrentManagedWrites = 0;
  private managedPostQueue: Promise<unknown> = Promise.resolve();
  private managedBulkNetworkRequest = false;
  private crossTabChannel: BroadcastChannel | null = null;
  private crossTabUserId: string | null = null;

  /**
   * Subscribe to real-time database state mutations
   */
  public subscribe(listener: (key: string, data: any) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public subscribeDomainEvents(listener: (event: DomainEvent) => void): () => void {
    this.domainEventListeners.add(listener);
    return () => this.domainEventListeners.delete(listener);
  }

  public getCloudSyncDiagnostics(): CloudSyncDiagnostics {
    const ids = new Set(this.pendingOperationIds);
    for (const id of [this.pendingBulkOperation?.id, this.pendingStateCommit?.id, this.pendingSyncOperation?.id]) if (id) ids.add(id);
    return {
      connectionState: this.connectionState,
      revision: this.cloudRevision,
      lastSuccessfulReadAt: this.lastSuccessfulReadAt,
      lastSuccessfulWriteAt: this.lastSuccessfulWriteAt,
      pendingOperationIds: [...ids],
      queueDepth: this.managedCommitQueueDepth,
      inFlightWrites: this.activeManagedWrites,
      maxConcurrentWrites: this.maxConcurrentManagedWrites,
      lastFailureCode: this.lastFailureCode,
    };
  }

  private setConnectionState(state: ServerConnectionState): void {
    this.connectionState = state;
  }

  private markDomainStateChange(key: string, before: unknown, after: unknown): void {
    const events = domainEventTypesForStateChange(key, before, after);
    if (!events.length) return;
    const pending = this.pendingDomainEventTypesByKey.get(key) || new Set<DomainEventType>();
    events.forEach(event => pending.add(event));
    this.pendingDomainEventTypesByKey.set(key, pending);
  }

  private publishAcceptedDomainChanges(keys: readonly string[], source: DomainEvent['source'], operationId?: string, revision?: number): void {
    const uniqueKeys = [...new Set(keys)];
    const types = new Set(createDomainEvents({ changedKeys: uniqueKeys, source, operationId, revision }).map(event => event.type));
    for (const key of uniqueKeys) {
      for (const type of this.pendingDomainEventTypesByKey.get(key) || []) types.add(type);
      this.pendingDomainEventTypesByKey.delete(key);
    }
    const events = [...types].map(type => ({
      type,
      changedKeys: [...uniqueKeys].sort(),
      source,
      ...(operationId ? { operationId } : {}),
      ...(Number.isInteger(revision) ? { revision } : {}),
      occurredAt: new Date().toISOString(),
    } satisfies DomainEvent));
    for (const event of events) {
      for (const listener of this.domainEventListeners) {
        try { listener(event); } catch (error) { console.error('Domain event listener failed', error); }
      }
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('pe_domain_event', { detail: event }));
    }
  }

  private openCrossTabChannel(userId: string): void {
    if (typeof BroadcastChannel === 'undefined' || this.crossTabUserId === userId) return;
    this.crossTabChannel?.close();
    this.crossTabChannel = null;
    this.crossTabUserId = userId;
    const channel = new BroadcastChannel('chalak-authoritative-state-v5');
    channel.onmessage = event => {
      const message = event.data as { userId?: string; keys?: unknown; revision?: unknown; operationId?: unknown } | null;
      if (!message || message.userId !== this.activeSyncUserId || !Array.isArray(message.keys)) return;
      const changedKeys: string[] = [];
      for (const key of message.keys) {
        if (typeof key !== 'string' || !isCloudSyncKey(key)) continue;
        if (key === 'pe_audit_logs') continue;
        const raw = localStorage.getItem(key);
        try {
          const previousRaw = this.lastSyncedValues.get(key) ?? null;
          const before = previousRaw === null ? undefined : JSON.parse(previousRaw);
          const after = raw === null ? undefined : JSON.parse(raw);
          this.markDomainStateChange(key, before, after);
          this.notifyChange(key, raw === null ? null : JSON.parse(raw));
          changedKeys.push(key);
        } catch { /* An unreadable cross-tab cache is left untouched for the next server read. */ }
      }
      const revision = Number.isInteger(message.revision) ? Number(message.revision) : undefined;
      if (revision !== undefined && revision > this.cloudRevision) this.cloudRevision = revision;
      if (changedKeys.length) {
        this.publishAcceptedDomainChanges(changedKeys, 'remote_revision', typeof message.operationId === 'string' ? message.operationId : undefined, revision);
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('pe_cloud_data_received'));
      }
    };
    this.crossTabChannel = channel;
  }

  private announceAcceptedCrossTabChange(keys: readonly string[], operationId?: string): void {
    if (!this.crossTabChannel || !this.activeSyncUserId) return;
    this.crossTabChannel.postMessage({ userId: this.activeSyncUserId, keys: [...new Set(keys)], revision: this.cloudRevision, operationId });
  }

  private async postManagedState(body: string, signal: AbortSignal, retryCount = 0): Promise<Response> {
    this.managedCommitQueueDepth += 1;
    const task = this.managedPostQueue.then(async () => {
      this.managedCommitQueueDepth = Math.max(0, this.managedCommitQueueDepth - 1);
      this.activeManagedWrites += 1;
      this.maxConcurrentManagedWrites = Math.max(this.maxConcurrentManagedWrites, this.activeManagedWrites);
      try {
        return await fetch('/api/state', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Chalak-Retry-Count': String(retryCount) },
          signal,
          body,
        });
      } finally {
        this.activeManagedWrites = Math.max(0, this.activeManagedWrites - 1);
      }
    });
    this.managedPostQueue = task.catch(() => undefined);
    return task;
  }

  public notifyChange(key: string, data: any): void {
    this.listeners.forEach(fn => {
      try { fn(key, data); } catch (e) { console.error('Error in db listener:', e); }
    });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('pe_db_updated', { detail: { key, data } }));
    }
  }

  // Safe JSON getter
  private getItem<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw) as T;
    } catch (e) {
      console.warn(`Error reading ${key} from storage:`, e);
      return fallback;
    }
  }

  // Safe JSON setter with synchronous notification
  private setItem<T>(key: string, value: T, scheduleSync = true): void {
    try {
      const stringVal = JSON.stringify(value);
      const currentVal = localStorage.getItem(key);
      if (currentVal === stringVal) return; // Prevent unnecessary cycles

      let previousValue: unknown = undefined;
      try { previousValue = currentVal === null ? undefined : JSON.parse(currentVal); } catch { previousValue = currentVal; }
      this.markDomainStateChange(key, previousValue, value);

      localStorage.setItem(key, stringVal);
      this.notifyChange(key, value);
      if (this.cloudSyncEnabled && isCloudSyncKey(key)) {
        this.dirtyKeys.add(key);
        this.emitCloudStatus('pending', 'تغییرات ذخیره‌نشده');
        if (scheduleSync) this.triggerCloudSyncDebounced();
      }
    } catch (e) {
      console.error(`Error saving ${key} to storage:`, e);
    }
  }

  private restoreRawStorage(rawValues: Map<string, string | null>): void {
    for (const [key, raw] of rawValues) {
      if (raw === null) localStorage.removeItem(key);
      else localStorage.setItem(key, raw);
    }
    for (const [key, raw] of rawValues) {
      if (localStorage.getItem(key) !== raw) throw new Error(`Rollback verification failed for ${key}`);
    }
  }

  // --- EMPLOYEES ---
  public getEmployees(): Employee[] {
    const raw = localStorage.getItem(STORAGE_KEYS.EMPLOYEES);
    if (raw === null) {
      this.setItem(STORAGE_KEYS.EMPLOYEES, SEED_EMPLOYEES);
      return SEED_EMPLOYEES;
    }
    return this.getItem<Employee[]>(STORAGE_KEYS.EMPLOYEES, []);
  }

  public saveEmployees(employees: Employee[]): void {
    this.setItem(STORAGE_KEYS.EMPLOYEES, employees);
  }

  public addEmployee(empData: Omit<Employee, 'id'>): { employee: Employee; evaluation: Evaluation | null } {
    const employees = this.getEmployees();
    
    // Generate clean username if empty
    let username = (empData.username || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
    if (!username) {
      const cleanCode = (empData.code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      username = `user_${cleanCode || Math.random().toString(36).substring(2, 7)}`;
    }

    // Ensure unique username
    let finalUsername = username;
    let counter = 1;
    while (employees.some(e => e.username.toLowerCase() === finalUsername.toLowerCase())) {
      finalUsername = `${username}_${counter}`;
      counter++;
    }

    const newEmp: Employee = {
      ...empData,
      id: `emp-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      username: finalUsername,
      code: empData.code.trim().toUpperCase()
    };

    const updatedEmployees = [...employees, newEmp];
    this.saveEmployees(updatedEmployees);

    // Evaluation creation is a deliberate period operation, never an employee-import side effect.
    return { employee: newEmp, evaluation: null };
  }

  public updateEmployee(id: string, empData: Omit<Employee, 'id'>): Employee | null {
    const employees = this.getEmployees();
    const index = employees.findIndex(e => e.id === id);
    if (index === -1) return null;

    const updated: Employee = {
      ...empData,
      id,
      code: empData.code.trim().toUpperCase(),
      username: empData.username.trim().toLowerCase()
    };

    employees[index] = updated;
    this.saveEmployees(employees);
    return updated;
  }

  public deleteEmployee(id: string): boolean {
    const employees = this.getEmployees();
    const target = employees.find(e => e.id === id);
    if (!target) return false;

    const deletionPlan = planEmployeeBulkDeletion([id], employees, this.getEvaluations(), this.getArchivedEvaluations());
    if (!deletionPlan.deletableIds.has(id)) return false;

    const filtered = employees.filter(e => e.id !== id);
    this.saveEmployees(filtered);

    return true;
  }

  /** Batch-delete employees only when history, open tasks, and remaining links permit removal. */
  public deleteEmployeesBatch(ids: string[]): { success: boolean; deletedCount: number; blockedCount: number } {
    if (!ids || ids.length === 0) return { success: true, deletedCount: 0, blockedCount: 0 };
    const employees = this.getEmployees();
    const deletionPlan = planEmployeeBulkDeletion(ids, employees, this.getEvaluations(), this.getArchivedEvaluations());
    const targetsToDelete = employees.filter(employee => deletionPlan.deletableIds.has(employee.id));
    const blockedCount = new Set(ids).size - targetsToDelete.length;
    if (targetsToDelete.length === 0) return { success: true, deletedCount: 0, blockedCount };

    const validDeleteIds = new Set(targetsToDelete.map(e => e.id));
    const remainingEmployees = employees.filter(e => !validDeleteIds.has(e.id));
    this.saveEmployees(remainingEmployees);

    return { success: true, deletedCount: targetsToDelete.length, blockedCount };
  }

  // --- CRITERIA (PARAMETERS) ---
  public getCriteria(): Criterion[] {
    const raw = localStorage.getItem(STORAGE_KEYS.CRITERIA);
    if (raw === null) {
      this.setItem(STORAGE_KEYS.CRITERIA, SEED_CRITERIA);
      return SEED_CRITERIA;
    }
    return this.getItem<Criterion[]>(STORAGE_KEYS.CRITERIA, []);
  }

  public saveCriteria(criteria: Criterion[]): void {
    this.setItem(STORAGE_KEYS.CRITERIA, criteria);
  }

  public addCriterion(critData: Omit<Criterion, 'id'>): Criterion {
    const criteria = this.getCriteria();
    const newCrit: Criterion = {
      ...critData,
      id: `crit-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      code: critData.code.trim().toUpperCase()
    };
    this.saveCriteria([...criteria, newCrit]);
    return newCrit;
  }

  public updateCriterion(id: string, critData: Omit<Criterion, 'id'>): Criterion | null {
    const criteria = this.getCriteria();
    const index = criteria.findIndex(c => c.id === id);
    if (index === -1) return null;

    const updated: Criterion = {
      ...critData,
      id,
      code: critData.code.trim().toUpperCase()
    };
    criteria[index] = updated;
    this.saveCriteria(criteria);
    return updated;
  }

  /**
   * Delete criterion with automatic CASCADE removal from profiles and evaluations.
   * This guarantees that any parameter can be deleted cleanly without blocking errors!
   */
  public deleteCriterion(id: string): { success: boolean; affectedProfiles: number; affectedEvaluations: number } {
    const criteria = this.getCriteria();
    const target = criteria.find(c => c.id === id);
    if (!target) return { success: false, affectedProfiles: 0, affectedEvaluations: 0 };

    const profilesUsing = this.getProfiles().filter(profile => profile.items.some(item => item.cid === id)).length;
    const evaluationsUsing = [...this.getEvaluations(), ...this.getArchivedEvaluations()]
      .filter(evaluation => evaluation.scores.some(score => score.cid === id)).length;
    if (profilesUsing > 0 || evaluationsUsing > 0) return { success: false, affectedProfiles: profilesUsing, affectedEvaluations: evaluationsUsing };

    // 1. Remove from criteria bank
    const updatedCriteria = criteria.filter(c => c.id !== id);
    this.saveCriteria(updatedCriteria);

    // 2. Cascade remove from all job profiles
    const profiles = this.getProfiles();
    let affectedProfiles = 0;
    const updatedProfiles = profiles.map(profile => {
      const hasItem = profile.items.some(item => item.cid === id);
      if (hasItem) {
        affectedProfiles++;
        const filteredItems = profile.items.filter(item => item.cid !== id);
        return {
          ...profile,
          items: filteredItems
        };
      }
      return profile;
    });
    if (affectedProfiles > 0) {
      this.saveProfiles(updatedProfiles);
    }

    // 3. Cascade remove from all evaluations
    const evals = this.getEvaluations();
    let affectedEvaluations = 0;
    const updatedEvals = evals.map(evaluation => {
      const hasScore = evaluation.scores.some(s => s.cid === id);
      if (hasScore) {
        affectedEvaluations++;
        return {
          ...evaluation,
          scores: evaluation.scores.filter(s => s.cid !== id)
        };
      }
      return evaluation;
    });
    if (affectedEvaluations > 0) {
      this.saveEvaluations(updatedEvals);
    }

    return { success: true, affectedProfiles, affectedEvaluations };
  }

  /**
   * Batch delete multiple criteria with cascading removal from all profiles and evaluations
   */
  public deleteCriteriaBatch(ids: string[]): { success: boolean; affectedProfiles: number; affectedEvaluations: number; deletedCount: number } {
    if (!ids || ids.length === 0) return { success: true, affectedProfiles: 0, affectedEvaluations: 0, deletedCount: 0 };
    const idSet = new Set(ids);
    const criteria = this.getCriteria();
    const profiles = this.getProfiles();
    const evals = this.getEvaluations();
    const archivedEvals = this.getArchivedEvaluations();
    const safeIds = new Set(criteria.filter(c => idSet.has(c.id) &&
      !profiles.some(profile => profile.items.some(item => item.cid === c.id)) &&
      !evals.some(evaluation => evaluation.scores.some(score => score.cid === c.id)) &&
      !archivedEvals.some(evaluation => evaluation.scores.some(score => score.cid === c.id))).map(c => c.id));
    const remainingCriteria = criteria.filter(c => !safeIds.has(c.id));
    const deletedCount = criteria.length - remainingCriteria.length;
    if (deletedCount === 0) return { success: true, affectedProfiles: 0, affectedEvaluations: 0, deletedCount: 0 };

    this.saveCriteria(remainingCriteria);

    // Cascade only IDs that passed the dependency checks above. A mixed bulk
    // request must leave protected criteria and their references intact.
    let affectedProfiles = 0;
    const updatedProfiles = profiles.map(profile => {
      const hasItem = profile.items.some(item => safeIds.has(item.cid));
      if (hasItem) {
        affectedProfiles++;
        return {
          ...profile,
          items: profile.items.filter(item => !safeIds.has(item.cid))
        };
      }
      return profile;
    });
    if (affectedProfiles > 0) {
      this.saveProfiles(updatedProfiles);
    }

    // Cascade remove from evaluations
    let affectedEvaluations = 0;
    const updatedEvals = evals.map(evaluation => {
      const hasScore = evaluation.scores.some(s => safeIds.has(s.cid));
      if (hasScore) {
        affectedEvaluations++;
        return {
          ...evaluation,
          scores: evaluation.scores.filter(s => !safeIds.has(s.cid))
        };
      }
      return evaluation;
    });
    if (affectedEvaluations > 0) {
      this.saveEvaluations(updatedEvals);
    }

    return { success: true, affectedProfiles, affectedEvaluations, deletedCount };
  }

  // --- JOB PROFILES ---
  public getProfiles(): JobProfile[] {
    const raw = localStorage.getItem(STORAGE_KEYS.PROFILES);
    if (raw === null) {
      this.setItem(STORAGE_KEYS.PROFILES, SEED_PROFILES);
      return SEED_PROFILES;
    }
    return this.getItem<JobProfile[]>(STORAGE_KEYS.PROFILES, []);
  }

  public saveProfiles(profiles: JobProfile[]): void {
    this.setItem(STORAGE_KEYS.PROFILES, profiles);
  }

  public addProfile(profData: Omit<JobProfile, 'id'>): JobProfile {
    const profiles = this.getProfiles();
    const newProf: JobProfile = {
      ...profData,
      id: `prof-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`
    };
    this.saveProfiles([...profiles, newProf]);
    return newProf;
  }

  public updateProfile(id: string, profData: Omit<JobProfile, 'id'>): JobProfile | null {
    const profiles = this.getProfiles();
    const index = profiles.findIndex(p => p.id === id);
    if (index === -1) return null;

    const updated: JobProfile = {
      ...profData,
      id
    };
    profiles[index] = updated;
    this.saveProfiles(profiles);
    return updated;
  }

  public deleteProfile(id: string, force = false): { success: boolean; error?: string; affectedEmployees?: number } {
    const employees = this.getEmployees();
    const assignedEmployees = employees.filter(e => e.profileId === id);
    
    if (assignedEmployees.length > 0) {
      return { success: false, error: `این رده شغلی به ${assignedEmployees.length} پرسنل منتسب است و ابتدا باید رده شغلی آن‌ها تغییر کند.` };
    }

    if (this.getEvaluations().some(evaluation => evaluation.profileId === id) || this.getArchivedEvaluations().some(evaluation => evaluation.profileId === id)) return { success: false, error: 'این پروفایل در سوابق ارزیابی استفاده شده و قابل حذف نیست.' };

    const profiles = this.getProfiles();
    this.saveProfiles(profiles.filter(p => p.id !== id));
    return { success: true, affectedEmployees: assignedEmployees.length };
  }

  public deleteProfilesBatch(ids: string[]): { success: boolean; deletedCount: number; affectedEmployees: number } {
    if (!ids || ids.length === 0) return { success: true, deletedCount: 0, affectedEmployees: 0 };
    const idSet = new Set(ids);

    const profiles = this.getProfiles();
    const employees = this.getEmployees();
    const evals = [...this.getEvaluations(), ...this.getArchivedEvaluations()];
    const safeIds = new Set(profiles.filter(profile => idSet.has(profile.id) && !employees.some(employee => employee.profileId === profile.id) && !evals.some(evaluation => evaluation.profileId === profile.id)).map(profile => profile.id));
    const remaining = profiles.filter(p => !safeIds.has(p.id));
    const deletedCount = profiles.length - remaining.length;
    const affectedEmployees = employees.filter(employee => idSet.has(employee.profileId)).length;
    if (deletedCount) this.saveProfiles(remaining);

    return { success: true, deletedCount, affectedEmployees };
  }

  // --- EVALUATIONS ---
  public getEvaluations(): Evaluation[] {
    const raw = localStorage.getItem(STORAGE_KEYS.EVALUATIONS);
    if (raw === null) {
      this.setItem(STORAGE_KEYS.EVALUATIONS, SEED_EVALUATIONS);
      return SEED_EVALUATIONS;
    }
    return this.getItem<Evaluation[]>(STORAGE_KEYS.EVALUATIONS, []);
  }

  public saveEvaluations(evaluations: Evaluation[]): void {
    this.setItem(STORAGE_KEYS.EVALUATIONS, evaluations);
  }

  private bulkCommitQueue: Promise<unknown> = Promise.resolve();
  private managedBulkCommit = false;
  private pendingBulkOperation: { id: string; updates: Evaluation[]; expected: Record<string, string | null> } | null = null;
  private pendingStateCommit: { id: string; state: CloudState } | null = null;
  private bulkRecoveryKey(): string { return `pe_bulk_pending_operation:${this.activeSyncUserId || 'anonymous'}`; }
  public hasPendingBulkOperation(): boolean { return Boolean(localStorage.getItem(this.bulkRecoveryKey())); }
  private async recordFingerprint(record: unknown): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(record) || 'missing');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  private pendingSyncOperationKey(userId = this.activeSyncUserId || 'anonymous'): string { return `pe_sync_pending_operation:${userId}`; }
  private async getOrCreateSyncOperationId(fingerprint: string): Promise<string> {
    const userId = this.activeSyncUserId || 'anonymous';
    if (this.pendingSyncOperation?.userId === userId && this.pendingSyncOperation.fingerprint === fingerprint) return this.pendingSyncOperation.id;
    const key = this.pendingSyncOperationKey(userId);
    try {
      const stored = JSON.parse(localStorage.getItem(key) || 'null');
      if (stored?.fingerprint === fingerprint && typeof stored.id === 'string') {
        this.pendingSyncOperation = { id: stored.id, fingerprint, userId };
        return stored.id;
      }
    } catch { /* Replace unreadable operation metadata with a fresh identifier. */ }
    const id = crypto.randomUUID();
    localStorage.setItem(key, JSON.stringify({ id, fingerprint }));
    this.pendingSyncOperation = { id, fingerprint, userId };
    return id;
  }
  /** Existing administrative bulk collections still pass the normal server guards. */
  public commitBulkState(state: CloudState, operationId: string, expectedRaw?: Record<string, string | null>, sourceImport?: SourceImportContext): Promise<boolean> {
    const task = this.bulkCommitQueue.then(async () => {
      while (this.isSyncing) await new Promise(resolve => setTimeout(resolve, 10));
      if (!this.cloudSyncEnabled || this.hasRevisionConflict) return false;
      const keys = Object.keys(state);
      if (!keys.length || keys.some(key => !isCloudSyncKey(key))) return false;
      if (expectedRaw && keys.some(key => expectedRaw[key] !== undefined && localStorage.getItem(key) !== expectedRaw[key])) return false;
      const previous = new Map(keys.map(key => [key, localStorage.getItem(key)]));
      const dirtyBefore = new Set(this.dirtyKeys);
      const generation = this.syncGeneration;
      const recoveryKey = this.bulkRecoveryKey();
      this.managedBulkCommit = true;
      this.pendingStateCommit = { id: operationId, state };
      this.pendingSourceImportContext = sourceImport || null;
      this.terminalRejectedSnapshot = null;
      if (this.syncTimeout) { clearTimeout(this.syncTimeout); this.syncTimeout = null; }
      try {
        for (const key of keys) {
          let before: unknown;
          try { before = previous.get(key) === null ? undefined : JSON.parse(previous.get(key)!); } catch { before = previous.get(key); }
          this.markDomainStateChange(key, before, state[key]);
        }
        const stateExpectedHashes = await Promise.all(Array.from(previous, async ([key, raw]) => [key, await this.recordFingerprint(raw)]));
        localStorage.setItem(recoveryKey, JSON.stringify({ operationId, state, stateExpectedHashes, sourceImport, createdAt: Date.now() }));
        for (const key of keys) { localStorage.setItem(key, JSON.stringify(state[key])); this.dirtyKeys.add(key); }
        if (keys.some(key => localStorage.getItem(key) !== JSON.stringify(state[key]))) return false;
        this.managedBulkNetworkRequest = true;
        const accepted = await this.pushStateToCloud(keys);
        this.managedBulkNetworkRequest = false;
        if (generation !== this.syncGeneration) return false;
        if (accepted) { localStorage.removeItem(recoveryKey); return true; }
        this.restoreRawStorage(previous);
        for (const key of keys) if (!dirtyBefore.has(key)) this.dirtyKeys.delete(key);
        return false;
      } catch {
        if (generation === this.syncGeneration) {
          this.restoreRawStorage(previous);
          for (const key of keys) if (!dirtyBefore.has(key)) this.dirtyKeys.delete(key);
        }
        return false;
      }
      finally { this.managedBulkNetworkRequest = false; this.clearCloudRetry(); this.pendingStateCommit = null; this.pendingSourceImportContext = null; this.managedBulkCommit = false; }
    });
    this.bulkCommitQueue = task.catch(() => false);
    return task.catch(() => false);
  }

  /** A changed-set commit. Local staging is not success; only a server ACK is. */
  public commitEvaluationChanges(updates: Evaluation[], operationId: string, sourceImport?: EvaluationSourceImportContext, expected?: Evaluation[], recoveredExpected?: Record<string, string | null>, recoveredExpectedHashes?: Array<[string, string]>): Promise<boolean> {
    const task = this.bulkCommitQueue.then(async () => {
      if (!this.cloudSyncEnabled || !updates.length) return false;
      while (this.isSyncing) await new Promise(resolve => setTimeout(resolve, 10));
      if (!this.cloudSyncEnabled || this.hasRevisionConflict) return false;
      const current = this.getEvaluations();
      const byId = new Map(current.map(record => [record.id, record]));
      if (!recoveredExpected && expected?.some(record => JSON.stringify(byId.get(record.id)) !== JSON.stringify(record))) {
        this.emitCloudStatus('conflict', 'پرونده پس از پیش‌نمایش تغییر کرده است؛ پیش‌نمایش را دوباره بررسی کنید.', { conflict: true });
        return false;
      }
      const changes = new Map(updates.map(record => [record.id, record]));
      if (changes.size !== updates.length) return false;
      const next = current.map(record => changes.get(record.id) || record);
      for (const record of updates) if (!byId.has(record.id)) next.push(record);
      const key = STORAGE_KEYS.EVALUATIONS;
      const requestGeneration = this.syncGeneration;
      const recoveryKey = this.bulkRecoveryKey();
      const previousRaw = localStorage.getItem(key);
      const wasDirty = this.dirtyKeys.has(key);
      const nextRaw = JSON.stringify(next);
      this.markDomainStateChange(key, current, next);
      if (this.syncTimeout) { clearTimeout(this.syncTimeout); this.syncTimeout = null; }
      this.managedBulkCommit = true;
      this.pendingSourceImportContext = sourceImport || null;
      this.terminalRejectedSnapshot = null;
      // A local, unsynchronized recovery record survives reload; it is never uploaded as state.
      try {
        // Store fingerprints rather than a second full copy of every original record.
        // Large previews otherwise exhaust the browser's local storage quota.
        const expectedRecords = new Map((expected || current.filter(record => changes.has(record.id))).map(record => [record.id, record]));
        const evaluationExpected = recoveredExpected || Object.fromEntries(await Promise.all(updates.map(async record => {
          const before = expectedRecords.get(record.id) ?? byId.get(record.id);
          return [record.id, before ? await this.recordFingerprint(before) : null] as const;
        })));
        const expectedHashes = recoveredExpectedHashes || await Promise.all(Array.from(expectedRecords.values(), async record => [record.id, await this.recordFingerprint(record)] as [string, string]));
        localStorage.setItem(recoveryKey, JSON.stringify({ operationId, updates, sourceImport, expectedHashes, evaluationExpected, createdAt: Date.now() }));
        this.pendingBulkOperation = { id: operationId, updates, expected: evaluationExpected };
        // Stage without publishing optimistic application state or a saved indicator.
        localStorage.setItem(key, nextRaw);
        this.dirtyKeys.add(key);
        if (localStorage.getItem(key) !== nextRaw) return false;
        this.managedBulkNetworkRequest = true;
        const accepted = await this.pushStateToCloud([key]);
        this.managedBulkNetworkRequest = false;
        if (requestGeneration !== this.syncGeneration) return false;
        if (accepted) { localStorage.removeItem(recoveryKey); return true; }
        if (localStorage.getItem(key) === nextRaw) {
          if (previousRaw === null) localStorage.removeItem(key); else localStorage.setItem(key, previousRaw);
          if (wasDirty) this.dirtyKeys.add(key); else this.dirtyKeys.delete(key);
        }
        return false;
      } catch (error) {
        if (requestGeneration === this.syncGeneration && localStorage.getItem(key) === nextRaw) {
          if (previousRaw === null) localStorage.removeItem(key); else localStorage.setItem(key, previousRaw);
          if (!wasDirty) this.dirtyKeys.delete(key);
        }
        this.emitCloudStatus('error', 'ذخیره تأیید نشد؛ فضای محلی و نتیجه ابری را پیش از تلاش دوباره بررسی کنید.');
        console.error('Bulk commit failed', error);
        return false;
      } finally {
        this.clearCloudRetry();
        this.managedBulkNetworkRequest = false;
        this.pendingBulkOperation = null;
        this.pendingSourceImportContext = null;
        this.managedBulkCommit = false;
      }
    });
    this.bulkCommitQueue = task.catch(() => false);
    return task.catch(() => false);
  }

  public async retryPendingBulkOperation(): Promise<boolean> {
    try {
      const pending = JSON.parse(localStorage.getItem(this.bulkRecoveryKey()) || 'null');
      if (pending?.state) {
        for (const [key, hash] of pending.stateExpectedHashes || []) {
          const raw = localStorage.getItem(key);
          if (raw !== JSON.stringify(pending.state[key]) && await this.recordFingerprint(raw) !== hash) return false;
        }
        return this.commitBulkState(pending.state, pending.operationId, undefined, pending.sourceImport);
      }
      if (!pending?.operationId || !Array.isArray(pending.updates)) return false;
      const current = new Map(this.getEvaluations().map(record => [record.id, record]));
      const intended = new Map<string, Evaluation>(pending.updates.map((record: Evaluation) => [record.id, record]));
      const expected = pending.evaluationExpected && !Array.isArray(pending.evaluationExpected)
        ? pending.evaluationExpected as Record<string, string | null>
        : Object.fromEntries(pending.evaluationExpected || []) as Record<string, string | null>;
      for (const id of intended.keys()) {
        const currentHash = current.has(id) ? await this.recordFingerprint(current.get(id)) : null;
        const intendedHash = await this.recordFingerprint(intended.get(id));
        if (currentHash !== expected[id] && currentHash !== intendedHash) return false;
      }
      return this.commitEvaluationChanges(pending.updates, pending.operationId, pending.sourceImport, undefined, expected, pending.expectedHashes || []);
    } catch { return false; }
  }

  /** Save one audited protected-source batch and wait for the Pages/KV decision. */
  private async saveStateWithSourceImport(key: string, value: unknown, sourceImport: SourceImportContext): Promise<boolean> {
    return this.commitBulkState({ [key]: value }, sourceImport.operationId, undefined, sourceImport);
  }

  public saveEvaluationsWithSourceImport(evaluations: Evaluation[], sourceImport: EvaluationSourceImportContext): Promise<boolean> {
    const current = this.getEvaluations();
    const existing = new Map(current.map(record => [record.id, record]));
    const changed = evaluations.filter(record => JSON.stringify(record) !== JSON.stringify(existing.get(record.id)));
    return this.commitEvaluationChanges(changed, sourceImport.operationId, sourceImport, current.filter(record => changed.some(update => update.id === record.id)));
  }

  public saveEmployeesWithSourceImport(employees: Employee[], sourceImport: MasterDataSourceImportContext): Promise<boolean> {
    return this.saveStateWithSourceImport(STORAGE_KEYS.EMPLOYEES, employees, sourceImport);
  }

  public saveCriteriaWithSourceImport(criteria: Criterion[], sourceImport: MasterDataSourceImportContext): Promise<boolean> {
    return this.saveStateWithSourceImport(STORAGE_KEYS.CRITERIA, criteria, sourceImport);
  }

  public deleteEvaluation(id: string): boolean {
    const evals = this.getEvaluations();
    const target = evals.find(e => e.id === id);
    if (target?.status === 'locked' || target?.stage === 'completed') return false;
    const filtered = evals.filter(e => e.id !== id);
    if (filtered.length === evals.length) return false;
    this.saveEvaluations(filtered);
    return true;
  }

  public deleteEvaluationsBatch(ids: string[]): { success: boolean; deletedCount: number } {
    if (!ids || ids.length === 0) return { success: true, deletedCount: 0 };
    const idSet = new Set(ids);
    const evals = this.getEvaluations();
    const filtered = evals.filter(e => !idSet.has(e.id) || e.status === 'locked' || e.stage === 'completed');
    const deletedCount = evals.length - filtered.length;
    if (deletedCount > 0) {
      this.saveEvaluations(filtered);
    }
    return { success: true, deletedCount };
  }

  public getArchivedEvaluations(): Evaluation[] {
    return this.getItem<Evaluation[]>(STORAGE_KEYS.ARCHIVED_EVALUATIONS, []);
  }

  public saveArchivedEvaluations(archived: Evaluation[]): void {
    this.setItem(STORAGE_KEYS.ARCHIVED_EVALUATIONS, archived);
  }

  public updateEvaluation(id: string, updatedEv: Evaluation): Evaluation {
    const evals = this.getEvaluations();
    const index = evals.findIndex(e => e.id === id);
    let nextList: Evaluation[];
    if (index >= 0) {
      nextList = [...evals];
      nextList[index] = updatedEv;
    } else {
      nextList = [...evals, updatedEv];
    }
    this.saveEvaluations(nextList);
    return updatedEv;
  }

  // --- DELEGATIONS ---
  public getDelegations(): DelegationRecord[] {
    return this.getItem<DelegationRecord[]>(STORAGE_KEYS.DELEGATIONS, []);
  }

  public saveDelegations(delegations: DelegationRecord[]): void {
    this.setItem(STORAGE_KEYS.DELEGATIONS, delegations);
  }

  public createDelegation(delegation: Omit<DelegationRecord, 'id' | 'createdAt'>): DelegationRecord {
    const delegations = this.getDelegations();
    const now = Date.now();
    const newDelegation: DelegationRecord = {
      ...delegation,
      id: `deleg-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      createdAt: now,
      status: 'active',
    };
    delegations.push(newDelegation);
    this.saveDelegations(delegations);
    return newDelegation;
  }

  public revokeDelegation(id: string, revokedById: string, reason?: string): boolean {
    const delegations = this.getDelegations();
    const index = delegations.findIndex(d => d.id === id);
    if (index === -1) return false;
    delegations[index] = {
      ...delegations[index],
      status: 'revoked',
      revokedAt: Date.now(),
      revokedById,
      ...(reason ? { reason: `${delegations[index].reason || ''}\nلغو توسط ${revokedById}: ${reason}` } : {}),
    };
    this.saveDelegations(delegations);
    return true;
  }

  public getActiveDelegations(): DelegationRecord[] {
    const now = Date.now();
    return this.getDelegations().filter(d => {
      if (d.status === 'revoked') return false;
      if (d.status === 'expired') return false;
      // 'future' delegations that have entered their date range are active
      if (d.status !== 'active' && d.status !== 'future') return false;
      if (now < d.startDate) return false;
      if (now > d.endDate) return false;
      return true;
    });
  }

  public getDelegationsByDelegate(delegateId: string): DelegationRecord[] {
    return this.getDelegations().filter(d => d.delegateId === delegateId);
  }

  public getDelegationsByDelegator(delegatorId: string): DelegationRecord[] {
    return this.getDelegations().filter(d => d.delegatorId === delegatorId);
  }

  // --- OKRS & GOALS MANAGEMENT --
  public getOkrs(): OKRGoal[] {
    const raw = localStorage.getItem(STORAGE_KEYS.OKRS);
    if (raw === null) {
      this.setItem(STORAGE_KEYS.OKRS, INITIAL_OKRS);
      return INITIAL_OKRS;
    }
    return this.getItem<OKRGoal[]>(STORAGE_KEYS.OKRS, []);
  }

  public saveOkrs(okrs: OKRGoal[]): void {
    this.setItem(STORAGE_KEYS.OKRS, okrs);
  }

  public updateOkr(id: string, partial: Partial<OKRGoal>): OKRGoal | null {
    const okrs = this.getOkrs();
    const index = okrs.findIndex(o => o.id === id);
    if (index === -1) return null;

    const existing = okrs[index];
    const updated: OKRGoal = {
      ...existing,
      ...partial
    };

    // Auto-recalculate progress if key results were supplied
    if (updated.keyResults && updated.keyResults.length > 0) {
      const sum = updated.keyResults.reduce((acc, kr) => {
        const range = kr.targetValue - kr.startValue;
        if (range === 0) return acc + 100;
        return acc + Math.min(100, Math.max(0, ((kr.currentValue - kr.startValue) / range) * 100));
      }, 0);
      updated.progress = Math.round(sum / updated.keyResults.length);
      if (updated.progress >= 100) updated.confidence = 'completed';
      else if (updated.progress < 50) updated.confidence = 'behind';
      else if (updated.progress < 75) updated.confidence = 'at_risk';
      else updated.confidence = 'on_track';
    }

    okrs[index] = updated;
    this.saveOkrs(okrs);
    return updated;
  }

  public addOkr(okrData: Omit<OKRGoal, 'id'>): OKRGoal {
    const okrs = this.getOkrs();
    const newOkr: OKRGoal = {
      ...okrData,
      id: `okr-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`
    };
    this.saveOkrs([newOkr, ...okrs]);
    return newOkr;
  }

  public deleteOkr(id: string): boolean {
    const okrs = this.getOkrs();
    const filtered = okrs.filter(o => o.id !== id);
    if (filtered.length === okrs.length) return false;
    this.saveOkrs(filtered);
    return true;
  }

  // --- WORKSHOP TARGETS ---
  public getWorkshopTargets<T = any>(fallback: T[] = []): T[] {
    return this.getItem<T[]>(STORAGE_KEYS.WORKSHOP_TARGETS, fallback);
  }

  public saveWorkshopTargets<T = any>(targets: T[]): void {
    this.setItem(STORAGE_KEYS.WORKSHOP_TARGETS, targets);
  }

  public getMiscData<T>(key: string, fallback: T): T {
    if (key === 'pe_audit_logs' && this.remoteAuditHistory) return this.remoteAuditHistory as T;
    return this.getItem<T>(key, fallback);
  }
  public saveMiscData<T>(key: string, value: T): void {
    this.setItem(key, value);
  }

  // --- BATCH CRITERIA MERGE / MULTI-SOURCE REGISTER ---
  public prepareCriteriaBatch(
    newCriteria: Array<Omit<Criterion, 'id'> & { id?: string }>,
    mode: 'merge' | 'replace' | 'skip_existing' = 'merge'
  ): { addedCount: number; updatedCount: number; totalCount: number; criteria: Criterion[] } {
    let currentCriteria = this.getCriteria();
    let addedCount = 0;
    let updatedCount = 0;

    if (mode === 'replace') {
      const formatted = newCriteria.map((c, idx) => ({
        ...c,
        id: c.id || `crit-${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 5)}`,
        code: c.code.trim().toUpperCase()
      } as Criterion));
      return { addedCount: formatted.length, updatedCount: 0, totalCount: formatted.length, criteria: formatted };
    }

    const updatedList = [...currentCriteria];

    newCriteria.forEach((critCandidate, idx) => {
      const cleanCode = critCandidate.code.trim().toUpperCase();
      const existingIdx = updatedList.findIndex(c => c.code.trim().toUpperCase() === cleanCode);

      if (existingIdx >= 0) {
        if (mode === 'merge') {
          // Merge fields, preserve existing ID
          const existing = updatedList[existingIdx];
          updatedList[existingIdx] = {
            ...existing,
            ...critCandidate,
            id: existing.id,
            code: cleanCode
          };
          updatedCount++;
        }
        // If mode === 'skip_existing', do nothing
      } else {
        // Add new
        const newCrit: Criterion = {
          ...critCandidate,
          id: critCandidate.id || `crit-${Date.now()}-${idx}-${Math.random().toString(36).substring(2, 5)}`,
          code: cleanCode
        };
        updatedList.push(newCrit);
        addedCount++;
      }
    });

    return { addedCount, updatedCount, totalCount: updatedList.length, criteria: updatedList };
  }

  public saveCriteriaBatch(
    newCriteria: Array<Omit<Criterion, 'id'> & { id?: string }>,
    mode: 'merge' | 'replace' | 'skip_existing' = 'merge'
  ): { addedCount: number; updatedCount: number; totalCount: number; criteria: Criterion[] } {
    const result = this.prepareCriteriaBatch(newCriteria, mode);
    this.saveCriteria(result.criteria);
    return result;
  }

  // --- CLOUD & CLOUDFLARE SYNC (Safe & Non-Destructive) ---
  private cloudSyncEnabled = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isSyncing = false;
  private isInitializingSync = false;
  private initializationPromise: Promise<void> | null = null;
  private syncGeneration = 0;
  private dirtyKeys = new Set<string>();
  private lastSyncedValues = new Map<string, string | null>();
  private cloudRevision = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private retryExhausted = false;
  private hasRevisionConflict = false;
  private activeRequestController: AbortController | null = null;
  private terminalRejectedSnapshot: { fingerprint: string; status: number; baseRevision: number; code?: string; reason?: string } | null = null;
  private lastCloudWriteFailure: { message: string; retryable: boolean; code?: string; reason?: string } | null = null;
  private activeSyncUserId: string | null = null;
  private authRequired = false;
  private restoredPendingBaseRevision: number | null = null;
  private visibilityHandler: (() => void) | null = null;
  private onlineHandler: (() => void) | null = null;
  private offlineHandler: (() => void) | null = null;
  private pendingSourceImportContext: SourceImportContext | null = null;
  
  public async initializeCloudSync(userId?: string): Promise<void> {
    if (userId) {
      this.activeSyncUserId = userId;
      this.authRequired = false;
      this.openCrossTabChannel(userId);
    }
    if (this.initializationPromise) {
      await this.initializationPromise;
      if (this.cloudSyncEnabled) return;
      return this.initializeCloudSync(userId);
    }
    const generation = this.syncGeneration;
    const initialization = this.initializeCloudSyncGeneration(generation);
    this.initializationPromise = initialization;
    try {
      await initialization;
    } finally {
      if (this.initializationPromise === initialization) this.initializationPromise = null;
    }
  }

  private async initializeCloudSyncGeneration(generation: number): Promise<void> {
    if (this.isInitializingSync) return;
    this.isInitializingSync = true;
    if (this.cloudSyncEnabled) this.detectDirectStorageChanges();
    this.restorePendingLocalSnapshot(this.activeSyncUserId);
    const pendingLocalKeys = new Set(this.dirtyKeys);
    clearTimeout(this.syncTimeout);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.activeRequestController?.abort();
    this.cloudSyncEnabled = false;
    if (this.visibilityHandler && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.visibilityHandler = null;
    if (this.onlineHandler && typeof window !== 'undefined') window.removeEventListener('online', this.onlineHandler);
    this.onlineHandler = null;
    if (this.offlineHandler && typeof window !== 'undefined') window.removeEventListener('offline', this.offlineHandler);
    this.offlineHandler = null;
    this.retryExhausted = false;
    this.retryAttempt = 0;
    this.terminalRejectedSnapshot = null;
    this.emitCloudStatus('syncing', 'در حال دریافت پایگاه داده ابری…');

    try {
      const cloudHadState = await this.runSyncCycle('pull');
      if (!isCurrentSyncGeneration(generation, this.syncGeneration)) return;
      if (this.authRequired) return;
      this.cloudSyncEnabled = true;
      if (cloudHadState === false) {
        for (const key of CLOUD_SYNC_KEYS) {
          if (localStorage.getItem(key) !== null) this.dirtyKeys.add(key);
        }
        await this.runSyncCycle('push');
      } else if (cloudHadState === true && pendingLocalKeys.size > 0) {
        if (this.restoredPendingBaseRevision !== null && this.cloudRevision === this.restoredPendingBaseRevision) {
          this.hasRevisionConflict = false;
          await this.runSyncCycle('push');
        } else {
          this.hasRevisionConflict = true;
          this.emitCloudStatus('error', 'تغییرات محلی همگام‌نشده با نسخه ابری مقایسه شده‌اند؛ برای جلوگیری از بازنویسی خودکار، نسخه نگه‌داشته‌شده را انتخاب کنید.', { conflict: true });
        }
      }
      this.restoredPendingBaseRevision = null;
      this.pollTimer = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        if (!shouldAttemptSync(this.retryExhausted, 'poll')) return;
        this.runSyncCycle('auto').catch(() => {});
      }, CLOUD_SYNC_POLL_INTERVAL_MS);
      this.visibilityHandler = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'visible' && shouldAttemptSync(this.retryExhausted, 'visible')) {
          if (this.retryExhausted) this.clearCloudRetry();
          this.runSyncCycle('auto').catch(() => {});
        }
      };
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visibilityHandler);
      this.onlineHandler = () => {
        if (!this.cloudSyncEnabled || !shouldAttemptSync(this.retryExhausted, 'online')) return;
        if (this.retryExhausted) this.clearCloudRetry();
        this.runSyncCycle('auto').catch(() => {});
      };
      if (typeof window !== 'undefined') window.addEventListener('online', this.onlineHandler);
      this.offlineHandler = () => {
        if (!this.cloudSyncEnabled) return;
        this.emitCloudStatus('offline', 'ارتباط با سرور برقرار نیست؛ تغییرات محلی حفظ می‌شوند.');
      };
      if (typeof window !== 'undefined') window.addEventListener('offline', this.offlineHandler);
      if (cloudHadState === null) this.scheduleCloudRetry();
    } finally {
      this.isInitializingSync = false;
    }
  }

  public stopCloudSync(): void {
    this.workflowContacts = [];
    this.remoteAuditHistory = null;
    this.syncGeneration += 1;
    this.cloudSyncEnabled = false;
    clearTimeout(this.syncTimeout);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.activeRequestController?.abort();
    this.activeRequestController = null;
    this.crossTabChannel?.close();
    this.crossTabChannel = null;
    this.crossTabUserId = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.visibilityHandler && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.visibilityHandler = null;
    if (this.onlineHandler && typeof window !== 'undefined') window.removeEventListener('online', this.onlineHandler);
    this.onlineHandler = null;
    if (this.offlineHandler && typeof window !== 'undefined') window.removeEventListener('offline', this.offlineHandler);
    this.offlineHandler = null;
    this.dirtyKeys.clear();
    this.hasRevisionConflict = false;
    this.terminalRejectedSnapshot = null;
    this.emitCloudStatus('idle', 'همگام‌سازی متوقف است.');
  }

  private pendingSyncBackupKey(userId: string): string {
    return `${PENDING_SYNC_BACKUP_PREFIX}${encodeURIComponent(userId)}`;
  }

  /** Keep rejected or otherwise unsynced writes across an auth-expiry cache clear. */
  private preservePendingLocalSnapshot(): void {
    const userId = this.activeSyncUserId;
    if (!userId || this.dirtyKeys.size === 0) return;
    try {
      const entries: Record<string, string | null> = {};
      for (const key of this.dirtyKeys) {
        if (isCloudSyncKey(key)) entries[key] = localStorage.getItem(key);
      }
      if (Object.keys(entries).length > 0) {
        localStorage.setItem(this.pendingSyncBackupKey(userId), JSON.stringify({ version: 1, baseRevision: this.cloudRevision, entries }));
      }
    } catch {
      // Keep the active local state intact if browser storage is unavailable.
    }
  }

  /** Restore pending keys only for the same account; never reuse another user's cache. */
  private restorePendingLocalSnapshot(userId: string | null): void {
    this.restoredPendingBaseRevision = null;
    if (!userId) return;
    const backupKey = this.pendingSyncBackupKey(userId);
    try {
      const raw = localStorage.getItem(backupKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown; baseRevision?: unknown };
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) return;
      for (const [key, value] of Object.entries(parsed.entries as Record<string, unknown>)) {
        if (!isCloudSyncKey(key) || (value !== null && typeof value !== 'string')) continue;
        if (typeof value === 'string') localStorage.setItem(key, value);
        else localStorage.removeItem(key);
        this.dirtyKeys.add(key);
      }
      if (Number.isInteger(parsed.baseRevision) && Number(parsed.baseRevision) >= 0) this.restoredPendingBaseRevision = Number(parsed.baseRevision);
    } catch {
      // Leave an unreadable snapshot in place for recovery rather than deleting it.
    }
  }

  private pauseCloudSyncForAuthentication(): void {
    this.authRequired = true;
    this.cloudSyncEnabled = false;
    clearTimeout(this.syncTimeout);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.visibilityHandler && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.visibilityHandler = null;
    if (this.onlineHandler && typeof window !== 'undefined') window.removeEventListener('online', this.onlineHandler);
    this.onlineHandler = null;
    if (this.offlineHandler && typeof window !== 'undefined') window.removeEventListener('offline', this.offlineHandler);
    this.offlineHandler = null;
  }

  private emitCloudStatus(
    status: 'idle' | 'pending' | 'syncing' | 'synced' | 'retrying' | 'offline' | 'error' | 'conflict' | 'authentication_required' | 'write_rejected',
    message: string,
    extra: Record<string, unknown> = {}
  ): void {
    if (status === 'synced') {
      this.lastCloudWriteFailure = null;
      this.lastFailureCode = null;
      this.setConnectionState(this.dirtyKeys.size ? 'LOCAL_CHANGES_PENDING' : 'CONNECTED');
    }
    else if (status === 'error' || status === 'conflict' || status === 'authentication_required' || status === 'write_rejected') {
      this.lastCloudWriteFailure = {
        message,
        retryable: status === 'error' && extra.retryable === true,
        code: typeof extra.code === 'string' ? extra.code : undefined,
        reason: typeof extra.reason === 'string' ? extra.reason : undefined,
      };
    }
    if (status === 'syncing') this.setConnectionState('SYNCING');
    else if (status === 'pending') this.setConnectionState('LOCAL_CHANGES_PENDING');
    else if (status === 'offline' || (status === 'retrying' && typeof navigator !== 'undefined' && navigator.onLine === false)) this.setConnectionState('OFFLINE');
    else if (status === 'retrying' || status === 'error' || status === 'write_rejected') this.setConnectionState('DEGRADED');
    else if (status === 'conflict' || extra.conflict === true) this.setConnectionState('CONFLICT');
    else if (status === 'authentication_required') this.setConnectionState('AUTH_REQUIRED');
    else if (status === 'idle') this.setConnectionState(this.authRequired ? 'AUTH_REQUIRED' : 'DEGRADED');
    if (typeof extra.code === 'string') this.lastFailureCode = extra.code;
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('pe_cloud_sync_status', {
      detail: { status, message, connectionState: this.connectionState, revision: this.cloudRevision, diagnostics: this.getCloudSyncDiagnostics(), ...extra }
    }));
  }

  public getLastCloudWriteFailure(): { message: string; retryable: boolean; code?: string; reason?: string } | null {
    return this.lastCloudWriteFailure;
  }

  private scheduleCloudRetry(): void {
    if (!this.cloudSyncEnabled || this.retryTimer || this.retryExhausted) return;
    if (this.retryAttempt >= CLOUD_SYNC_MAX_RETRIES) {
      this.retryExhausted = true;
      this.emitCloudStatus('error', 'تلاش‌های بازیابی به پایان رسید؛ پس از بازگشت اتصال یا فعال‌کردن صفحه دوباره تلاش می‌شود. تغییرات محلی حفظ شده‌اند.');
      return;
    }
    const delay = getCloudRetryDelay(this.retryAttempt++);
    this.emitCloudStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'retrying', `ارتباط ابری موقتاً برقرار نیست؛ تلاش مجدد تا ${Math.ceil(delay / 1000)} ثانیه دیگر.`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.cloudSyncEnabled) return;
      this.runSyncCycle('auto').catch(() => {});
    }, delay);
  }

  private clearCloudRetry(): void {
    this.retryAttempt = 0;
    this.retryExhausted = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private getClientId(): string {
    const key = 'chalak_cloud_client_id';
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(key, id);
    }
    return id;
  }

  private detectDirectStorageChanges(): void {
    if (!this.cloudSyncEnabled) return;
    for (const key of CLOUD_SYNC_KEYS) {
      const current = localStorage.getItem(key);
      const previous = this.lastSyncedValues.get(key) ?? null;
      if (current !== previous) this.dirtyKeys.add(key);
    }
  }

  private async runSyncCycle(mode: 'pull' | 'push' | 'auto', forceAll = false, explicitRetry = false, onlyKeys?: string[]): Promise<boolean | null> {
    if (this.isSyncing || (this.managedBulkCommit && !this.managedBulkNetworkRequest)) return null;
    this.isSyncing = true;
    this.detectDirectStorageChanges();
    const attemptedEntries = Array.from(this.dirtyKeys).map(key => [key, localStorage.getItem(key)] as [string, string | null]);
    const attemptedFingerprint = cloudWriteFingerprint(this.cloudRevision, attemptedEntries);
    try {
      if (mode === 'auto') {
        this.detectDirectStorageChanges();
        const operation = selectCloudSyncOperation(this.hasRevisionConflict, this.dirtyKeys.size);
        return operation === 'push' ? await this.pushStateToCloudInternal(false, true, explicitRetry) : await this.pullFromCloud();
      }
      if (mode === 'push') return this.pushStateToCloudInternal(forceAll, true, explicitRetry, onlyKeys);
      return this.pullFromCloud();
    } finally {
      this.isSyncing = false;
      this.detectDirectStorageChanges();
      const currentEntries = Array.from(this.dirtyKeys).map(key => [key, localStorage.getItem(key)] as [string, string | null]);
      const currentFingerprint = cloudWriteFingerprint(this.cloudRevision, currentEntries);
      if (shouldScheduleCloudSyncFollowup({
        enabled: this.cloudSyncEnabled && !this.managedBulkCommit,
        hasConflict: this.hasRevisionConflict,
        dirtyKeyCount: this.dirtyKeys.size,
        attemptedFingerprint,
        currentFingerprint,
        rejectedFingerprint: this.terminalRejectedSnapshot?.fingerprint || null,
      })) {
        this.triggerCloudSyncDebounced();
      }
    }
  }

  private applyRemoteState(remoteState: CloudState): string[] {
    this.workflowContacts = Array.isArray(remoteState.pe_workflow_contacts) ? remoteState.pe_workflow_contacts as Employee[] : [];
    let changed = false;
    const changedKeys: string[] = [];
    for (const key of CLOUD_SYNC_KEYS) {
      if (key === 'pe_audit_logs') {
        // Immutable server audit history can be much larger than browser storage.
        // Preserve the complete server response in memory; never upload a truncated cache.
        this.remoteAuditHistory = Array.isArray(remoteState[key]) ? remoteState[key] as unknown[] : [];
        localStorage.removeItem(key);
        this.dirtyKeys.delete(key);
        this.lastSyncedValues.set(key, null);
        this.notifyChange(key, this.remoteAuditHistory);
        continue;
      }
      if (this.dirtyKeys.has(key)) continue;
      const hasRemoteValue = Object.prototype.hasOwnProperty.call(remoteState, key);
      const nextRaw = hasRemoteValue ? JSON.stringify(remoteState[key]) : null;
      const localRaw = localStorage.getItem(key);
      if (nextRaw === null) {
        if (this.lastSyncedValues.has(key) && localRaw !== null) {
          localStorage.removeItem(key);
          this.notifyChange(key, null);
          changed = true;
          changedKeys.push(key);
        }
      } else if (localRaw !== nextRaw) {
        let before: unknown;
        try { before = localRaw === null ? undefined : JSON.parse(localRaw); } catch { before = localRaw; }
        this.markDomainStateChange(key, before, remoteState[key]);
        localStorage.setItem(key, nextRaw);
        this.notifyChange(key, remoteState[key]);
        changed = true;
        changedKeys.push(key);
      }
      this.lastSyncedValues.set(key, nextRaw);
    }
    if (changed) window.dispatchEvent(new CustomEvent('pe_cloud_data_received'));
    return changedKeys;
  }

  private async pullFromCloud(): Promise<boolean | null> {
    const requestGeneration = this.syncGeneration;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    try {
      controller = new AbortController();
      this.activeRequestController = controller;
      timeoutId = setTimeout(() => controller.abort(), 10_000);

      const res = await fetch('/api/state', { signal: controller.signal, credentials: 'same-origin' });
      if (!isCurrentSyncGeneration(requestGeneration, this.syncGeneration)) return null;
      clearTimeout(timeoutId);
      timeoutId = null;

      const contentType = res.headers.get('Content-Type') || '';
      if (!contentType.includes('application/json')) {
        this.emitCloudStatus('error', 'API فضای ابری در این اجرا فعال نیست؛ داده فقط محلی ذخیره می‌شود.');
        return null;
      }
      const result = contentType.includes('application/json')
        ? await res.json() as { state?: CloudState; revision?: number; updatedAt?: string; error?: string; code?: string; reason?: string; retryable?: boolean }
        : {};
      if (!isCurrentSyncGeneration(requestGeneration, this.syncGeneration)) return null;
      if (!res.ok) {
        if (res.status === 401) this.pauseCloudSyncForAuthentication();
        this.emitCloudStatus(res.status === 401 ? 'authentication_required' : 'error', result.error || `خطای دریافت داده ابری (${res.status})`);
        if (shouldRetryCloudStatus(res.status, result.retryable)) this.scheduleCloudRetry();
        return null;
      }

      const cloudState = result.state && typeof result.state === 'object' ? result.state : {};
      this.cloudRevision = Number.isInteger(result.revision) ? Number(result.revision) : this.cloudRevision;
      this.lastSuccessfulReadAt = result.updatedAt || new Date().toISOString();
      if (Object.keys(cloudState).length === 0 && this.cloudRevision === 0) return false;
      const changedKeys = this.applyRemoteState(cloudState);
      if (changedKeys.length) {
        this.publishAcceptedDomainChanges(changedKeys, 'remote_revision', undefined, this.cloudRevision);
        this.announceAcceptedCrossTabChange(changedKeys);
      }
      if (this.hasRevisionConflict) {
        this.emitCloudStatus('error', 'نسخه ابری تازه دریافت شد. تغییرات محلی متعارض نگه داشته شده‌اند؛ برای حل تعارض یکی از گزینه‌های «نسخه ابری» یا «نسخه محلی» را انتخاب کنید.', { conflict: true });
      } else {
        this.emitCloudStatus('synced', 'داده‌ها با فضای ابری همگام هستند.', {
          lastSyncedAt: result.updatedAt || new Date().toISOString()
        });
      }
      this.clearCloudRetry();
      return true;
    } catch (error) {
      if (!isCurrentSyncGeneration(requestGeneration, this.syncGeneration)) return null;
      const message = error instanceof DOMException && error.name === 'AbortError'
        ? 'پاسخ فضای ابری بیش از حد طول کشید.'
        : 'ارتباط با پایگاه داده ابری برقرار نشد.';
      this.emitCloudStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'retrying', message);
      this.scheduleCloudRetry();
      return null;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (controller && this.activeRequestController === controller) this.activeRequestController = null;
    }
  }

  private triggerCloudSyncDebounced(): void {
    if (!this.cloudSyncEnabled) return;
    clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(() => {
      this.runSyncCycle('auto').catch(() => {});
    }, 700);
  }

  public async syncToCloudNow(): Promise<boolean> {
    clearTimeout(this.syncTimeout);
    if (!this.cloudSyncEnabled) {
      this.emitCloudStatus(this.authRequired ? 'authentication_required' : 'error', this.authRequired ? 'نشست معتبر نیست؛ تغییر محلی حفظ شده و پس از ورود دوباره می‌توانید ذخیره را امتحان کنید.' : 'ابتدا باید با حساب معتبر وارد سامانه شوید.');
      return false;
    }
    return (await this.runSyncCycle('auto')) === true;
  }

  /** Explicit user retry clears only the terminal rejection latch; local dirty data remains intact. */
  public async retryRejectedCloudWrite(): Promise<boolean> {
    if (!this.cloudSyncEnabled) return false;
    this.terminalRejectedSnapshot = null;
    this.clearCloudRetry();
    return (await this.runSyncCycle('push', false, true)) === true;
  }

  /** Flush local edits first, then explicitly request and apply the latest cloud revision. */
  public async refreshFromCloudNow(): Promise<boolean> {
    clearTimeout(this.syncTimeout);
    if (!this.cloudSyncEnabled) {
      this.emitCloudStatus(this.authRequired ? 'authentication_required' : 'error', this.authRequired ? 'نشست معتبر نیست؛ تغییر محلی حفظ شده و پس از ورود دوباره می‌توانید ذخیره را امتحان کنید.' : 'ابتدا باید با حساب معتبر وارد سامانه شوید.');
      return false;
    }
    if (this.hasRevisionConflict) {
      this.emitCloudStatus('error', 'تعارض نسخه نیازمند انتخاب صریح شماست.', { conflict: true });
      return false;
    }
    if (this.isSyncing) return false;
    // Include any legacy/direct storage mutation that occurred since the last
    // successful sync before deciding whether it is safe to pull.
    this.detectDirectStorageChanges();
    if (this.dirtyKeys.size > 0) {
      const pushed = await this.runSyncCycle('push');
      if (pushed !== true) return false;
    }
    return (await this.runSyncCycle('pull')) === true;
  }

  /** Resolve a whole-key revision conflict only after the user chooses which copy to keep. */
  public async resolveCloudRevisionConflict(choice: 'local' | 'remote'): Promise<boolean> {
    if (!this.cloudSyncEnabled || !this.hasRevisionConflict) return false;
    if (choice === 'local') {
      this.hasRevisionConflict = false;
      this.terminalRejectedSnapshot = null;
      return (await this.runSyncCycle('push', false, true)) === true;
    }
    const preservedDirtyKeys = new Set(this.dirtyKeys);
    this.dirtyKeys.clear();
    this.hasRevisionConflict = false;
    const pulled = (await this.runSyncCycle('pull')) === true;
    if (!pulled) {
      preservedDirtyKeys.forEach(key => this.dirtyKeys.add(key));
      this.hasRevisionConflict = true;
    } else if (this.activeSyncUserId) {
      localStorage.removeItem(this.pendingSyncBackupKey(this.activeSyncUserId));
    }
    return pulled;
  }

  /** Remove only server-rehydratable shared data after sign-out; preferences remain local. */
  public clearAuthorizedCache(): void {
    try { this.detectDirectStorageChanges(); } catch { /* Preserve already tracked dirty keys. */ }
    this.preservePendingLocalSnapshot();
    this.stopCloudSync();
    for (const key of CLOUD_SYNC_KEYS) localStorage.removeItem(key);
    this.lastSyncedValues.clear();
    this.dirtyKeys.clear();
    this.terminalRejectedSnapshot = null;
    this.activeSyncUserId = null;
    this.authRequired = false;
    this.restoredPendingBaseRevision = null;
  }

  public async pushStateToCloud(onlyKeys?: string[]): Promise<boolean> {
    if (!this.cloudSyncEnabled) return false;
    return (await this.runSyncCycle('push', false, false, onlyKeys)) === true;
  }

  private async pushStateToCloudInternal(forceAll: boolean, allowConflictRetry = true, explicitRetry = false, onlyKeys?: string[]): Promise<boolean> {
    const requestGeneration = this.syncGeneration;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    try {
      if (this.hasRevisionConflict) {
        this.emitCloudStatus('error', 'تغییرات محلی تا زمان حل تعارض نسخه نگه داشته شده‌اند.', { conflict: true });
        return false;
      }
      this.detectDirectStorageChanges();
      if (forceAll) {
        for (const key of CLOUD_SYNC_KEYS) {
          if (localStorage.getItem(key) !== null) this.dirtyKeys.add(key);
        }
      }

      let keysToSend = onlyKeys ? onlyKeys.filter(key => this.dirtyKeys.has(key)) : Array.from(this.dirtyKeys);
      if (keysToSend.length === 0) {
        this.emitCloudStatus('synced', 'تغییری برای ارسال وجود ندارد.', { lastSyncedAt: new Date().toISOString() });
        return true;
      }

      const changes: CloudState = {};
      const sentRaw = new Map<string, string | null>();
      for (const key of keysToSend) {
        const raw = localStorage.getItem(key);
        sentRaw.set(key, raw);
        if (raw === null) changes[key] = null;
        else {
          try { changes[key] = JSON.parse(raw); }
          catch { changes[key] = raw; }
        }
      }

      const sourceImportContext = this.pendingSourceImportContext;
      const bulkOperation = this.pendingBulkOperation || this.pendingStateCommit;
      let evaluationPatch = false;
      let evaluationExpected: Record<string, string | null> | undefined;
      let evaluationDeleteIds: string[] = [];
      if (this.pendingBulkOperation) {
        changes.pe_evaluations = this.pendingBulkOperation.updates;
        evaluationPatch = true;
        evaluationExpected = this.pendingBulkOperation.expected;
      } else if (Array.isArray(changes.pe_evaluations)) {
        const key = STORAGE_KEYS.EVALUATIONS;
        let baseline: Evaluation[] = [];
        const baselineRaw = this.lastSyncedValues.get(key) ?? null;
        try { if (baselineRaw) baseline = JSON.parse(baselineRaw) as Evaluation[]; } catch { baseline = []; }
        const current = changes.pe_evaluations as Evaluation[];
        const oldById = new Map(baseline.map(record => [record.id, record]));
        const nextById = new Map(current.map(record => [record.id, record]));
        const updates = current.filter(record => JSON.stringify(oldById.get(record.id)) !== JSON.stringify(record));
        evaluationDeleteIds = baseline.filter(record => !nextById.has(record.id)).map(record => record.id);
        evaluationExpected = {};
        for (const record of updates) evaluationExpected[record.id] = oldById.has(record.id) ? await this.recordFingerprint(oldById.get(record.id)) : null;
        for (const id of evaluationDeleteIds) evaluationExpected[id] = await this.recordFingerprint(oldById.get(id));
        changes.pe_evaluations = updates;
        evaluationPatch = true;
        if (updates.length === 0 && evaluationDeleteIds.length === 0) {
          delete changes.pe_evaluations;
          sentRaw.delete(key);
          this.dirtyKeys.delete(key);
          // The request no longer contains evaluation data, so it must use the
          // ordinary state-write contract instead of an empty changed-set.
          evaluationPatch = false;
          evaluationExpected = undefined;
        }
      }
      keysToSend = Object.keys(changes);
      if (keysToSend.length === 0) {
        this.emitCloudStatus('synced', 'تغییری برای ذخیره وجود ندارد.', { lastSyncedAt: new Date().toISOString() });
        return true;
      }
      const fingerprintEntries: Array<[string, string | null]> = Array.from(sentRaw.entries());
      if (sourceImportContext) fingerprintEntries.push(['sourceImport', JSON.stringify(sourceImportContext)]);
      const fingerprint = cloudWriteFingerprint(this.cloudRevision, fingerprintEntries);
      if (this.terminalRejectedSnapshot && isSameRejectedSnapshot(this.terminalRejectedSnapshot.fingerprint, fingerprint) && !explicitRetry) {
        const status = this.terminalRejectedSnapshot.status === 401 ? 'authentication_required' : 'write_rejected';
        const message = this.terminalRejectedSnapshot.status === 403
          ? 'ذخیره ابری این تغییر به دلیل محدودیت دسترسی پذیرفته نشد. تغییر محلی حذف نشده است.'
          : this.terminalRejectedSnapshot.status === 401
            ? 'نشست معتبر نیست؛ تغییر محلی حفظ شده و پس از ورود دوباره می‌توانید ذخیره را امتحان کنید.'
            : 'این تغییر با پاسخ غیرقابل‌تکرار رد شد؛ داده محلی حفظ شده است.';
        this.emitCloudStatus(status, message, { code: this.terminalRejectedSnapshot.code, reason: this.terminalRejectedSnapshot.reason, rejectedStatus: this.terminalRejectedSnapshot.status, retryable: false });
        return false;
      }
      if (this.terminalRejectedSnapshot && this.terminalRejectedSnapshot.fingerprint !== fingerprint) this.terminalRejectedSnapshot = null;

      const requestFingerprint = await this.recordFingerprint({ changes, sourceImport: sourceImportContext, evaluationPatch, evaluationExpected, evaluationDeleteIds });
      const operationId = bulkOperation?.id || await this.getOrCreateSyncOperationId(requestFingerprint);
      this.pendingOperationIds.add(operationId);
      this.emitCloudStatus('syncing', 'در حال ذخیره…', { operationId });
      controller = new AbortController();
      this.activeRequestController = controller;
      timeoutId = setTimeout(() => controller.abort(), 15_000);
      const res = await this.postManagedState(JSON.stringify({
          state: changes,
          baseRevision: this.cloudRevision,
          clientId: this.getClientId(),
          operationId,
          ...(evaluationPatch ? { evaluationPatch: true, evaluationExpected, evaluationDeleteIds } : {}),
          ...(sourceImportContext ? { sourceImport: sourceImportContext } : {}),
        }), controller.signal, this.retryAttempt);
      if (!isCurrentSyncGeneration(requestGeneration, this.syncGeneration)) return false;
      clearTimeout(timeoutId);
      timeoutId = null;
      const contentType = res.headers.get('Content-Type') || '';
      if (!contentType.includes('application/json')) {
        this.emitCloudStatus('error', 'API فضای ابری در این اجرا فعال نیست؛ ذخیره فقط محلی انجام شد.');
        return false;
      }
      const result = contentType.includes('application/json')
        ? await res.json() as { state?: CloudState; revision?: number; updatedAt?: string; error?: string; code?: string; reason?: string; retryable?: boolean }
        : {};
      if (!isCurrentSyncGeneration(requestGeneration, this.syncGeneration)) return false;
      if (!res.ok) {
        if (!shouldRetryCloudStatus(res.status, result.retryable) && res.status !== 409 && res.status !== 401) this.pendingOperationIds.delete(operationId);
        if (res.status === 401) this.pauseCloudSyncForAuthentication();
        if (res.status === 409 && allowConflictRetry) {
          // Keep the local dirty values intact. Pulling and retrying the same
          // whole-key payload could silently overwrite another client's edit.
          this.cloudRevision = Number.isInteger(result.revision) ? Number(result.revision) : this.cloudRevision;
          this.hasRevisionConflict = true;
          this.emitCloudStatus('conflict', 'داده ابری در مرورگر دیگری تغییر کرده است. تغییر محلی نگه داشته شد؛ پیش از ادامه، نسخه ابری یا محلی را انتخاب کنید.', { conflict: true });
          return false;
        }
        if (isTerminalCloudWriteStatus(res.status)) {
          this.terminalRejectedSnapshot = { fingerprint, status: res.status, baseRevision: this.cloudRevision, code: result.code, reason: result.reason };
          const status = res.status === 401 ? 'authentication_required' : 'write_rejected';
          const message = res.status === 403
            ? cloudDenialMessage(result.reason, result.error)
            : result.error || `ذخیره ابری قابل تکرار نیست (${res.status}). تغییر محلی حفظ شده است.`;
          this.emitCloudStatus(status, message, { code: result.code, reason: result.reason, rejectedStatus: res.status, retryable: false });
        } else {
          const message = res.status === 409
            ? 'اطلاعات جدیدتری روی سرور وجود دارد. پیش‌نویس شما حفظ شده است؛ نسخه تازه را دریافت و تغییر را دوباره بررسی کنید.'
            : res.status === 503
              ? 'ذخیره موقتاً در دسترس نیست. تغییرات شما حفظ شده‌اند؛ تلاش مجدد انجام می‌شود.'
              : result.error || `ذخیره ابری ناموفق بود (${res.status}). تغییر شما حفظ شده است.`;
          this.emitCloudStatus('error', message, { code: result.code, reason: result.reason, rejectedStatus: res.status, retryable: result.retryable === true, operationId });
        }
        if (shouldRetryCloudStatus(res.status, result.retryable)) this.scheduleCloudRetry();
        return false;
      }

      for (const [key, raw] of sentRaw) {
        if (localStorage.getItem(key) === raw) {
          this.dirtyKeys.delete(key);
          this.lastSyncedValues.set(key, raw);
        }
      }
      this.cloudRevision = Number.isInteger(result.revision) ? Number(result.revision) : this.cloudRevision + 1;
      this.lastSuccessfulWriteAt = result.updatedAt || new Date().toISOString();
      this.pendingOperationIds.delete(operationId);
      const pendingKey = this.pendingSyncOperationKey();
      try {
        const pending = JSON.parse(localStorage.getItem(pendingKey) || 'null');
        if (pending?.id === operationId) localStorage.removeItem(pendingKey);
      } catch { localStorage.removeItem(pendingKey); }
      if (this.pendingSyncOperation?.id === operationId) this.pendingSyncOperation = undefined;
      this.terminalRejectedSnapshot = null;
      if (sourceImportContext && this.pendingSourceImportContext?.operationId === sourceImportContext.operationId) this.pendingSourceImportContext = null;
      const reconciledKeys = result.state && typeof result.state === 'object' ? this.applyRemoteState(result.state) : [];
      const acceptedKeys = [...new Set([...sentRaw.keys(), ...reconciledKeys])];
      this.publishAcceptedDomainChanges(acceptedKeys, 'accepted_write', operationId, this.cloudRevision);
      this.announceAcceptedCrossTabChange(acceptedKeys, operationId);
      this.emitCloudStatus('synced', 'ذخیره شد؛ همه تغییرات در پایگاه داده ابری ثبت شدند.', {
        lastSyncedAt: result.updatedAt || new Date().toISOString(), operationId
      });
      this.clearCloudRetry();
      if (this.dirtyKeys.size === 0 && this.activeSyncUserId) {
        localStorage.removeItem(this.pendingSyncBackupKey(this.activeSyncUserId));
      }
      if (this.dirtyKeys.size > 0) this.triggerCloudSyncDebounced();
      return true;
    } catch (error) {
      if (!isCurrentSyncGeneration(requestGeneration, this.syncGeneration)) return false;
      const message = error instanceof DOMException && error.name === 'AbortError'
        ? 'ذخیره ابری به‌دلیل پایان زمان انتظار انجام نشد.'
        : 'ذخیره ابری به‌دلیل خطای شبکه انجام نشد.';
      this.emitCloudStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'retrying', message);
      this.scheduleCloudRetry();
      return false;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (controller && this.activeRequestController === controller) this.activeRequestController = null;
    }
  }

  // --- BACKUP & RESTORE ---
  public exportBackupJSON(): string {
    const backupData = {
      meta: {
        app: 'اصفهان چالاک - سامانه ارزیابی عملکرد',
        version: '5.0.0-Cloudflare',
        exportedAt: new Date().toISOString(),
        schemaVersion: 1,
        recordCounts: {
          employees: this.getEmployees().length,
          criteria: this.getCriteria().length,
          profiles: this.getProfiles().length,
          evaluations: this.getEvaluations().length,
          archivedEvaluations: this.getArchivedEvaluations().length,
          delegations: this.getDelegations().length,
        },
      },
      employees: this.getEmployees(),
      criteria: this.getCriteria(),
      profiles: this.getProfiles(),
      evaluations: this.getEvaluations(),
      archivedEvaluations: this.getArchivedEvaluations(),
      delegations: this.getDelegations(),
    };
    return JSON.stringify(backupData, null, 2);
  }

  public importBackupJSON(jsonStr: string): { success: boolean; message: string } {
    try {
      const data = validateBackupJSON(jsonStr);
      if (!data || typeof data !== 'object') {
        return { success: false, message: 'فایل پشتیبان معتبر نیست.' };
      }

      // Schema version compatibility check (forward-compatible: warn but proceed)
      const currentSchema = 1;
      const meta = data.meta as Record<string, unknown>;
      if (meta.schemaVersion && Number(meta.schemaVersion) > currentSchema) {
        return {
          success: false,
          message: `نسخه اسکیمای فایل (${data.meta.schemaVersion}) جدیدتر از نسخه پشتیبانی شده (${currentSchema}) است. لطفاً ابتدا برنامه را به‌روزرسانی کنید.`,
        };
      }

      const restoreEntries: Array<[string, unknown]> = [
        [STORAGE_KEYS.EMPLOYEES, data.employees],
        [STORAGE_KEYS.CRITERIA, data.criteria],
        [STORAGE_KEYS.PROFILES, data.profiles],
        [STORAGE_KEYS.EVALUATIONS, data.evaluations],
        [STORAGE_KEYS.ARCHIVED_EVALUATIONS, data.archivedEvaluations],
        [STORAGE_KEYS.DELEGATIONS, data.delegations],
      ];
      for (const [field, key] of Object.entries(OPTIONAL_BACKUP_KEYS)) {
        if (hasBackupField(data, field)) restoreEntries.push([key, data[field]]);
      }
      const restoreKeys = restoreEntries.map(([key]) => key);
      const previousRaw = new Map(restoreKeys.map(key => [key, localStorage.getItem(key)]));
      try {
        for (const [key, value] of restoreEntries) {
          const serialized = JSON.stringify(value);
          if (localStorage.getItem(key) !== serialized) localStorage.setItem(key, serialized);
        }
      } catch (restoreError: any) {
        try {
          this.restoreRawStorage(previousRaw);
        } catch (rollbackError: any) {
          throw new Error(`Restore failed and rollback failed: ${rollbackError?.message || rollbackError}; original error: ${restoreError?.message || restoreError}`);
        }
        throw restoreError;
      }

      // Publish the restore as one committed change only after every storage
      // write succeeds. Failed writes and rollbacks must not leak partial state
      // to subscribers or schedule a cloud push of transient data.
      for (const [key, value] of restoreEntries) {
        const serialized = JSON.stringify(value);
        if (previousRaw.get(key) === serialized) continue;
        this.notifyChange(key, value);
        if (this.cloudSyncEnabled && isCloudSyncKey(key)) this.dirtyKeys.add(key);
      }
      if (this.dirtyKeys.size > 0) this.triggerCloudSyncDebounced();

      return { success: true, message: 'اطلاعات پشتیبان با موفقیت بازیابی شد.' };
    } catch (e: any) {
      return { success: false, message: `خطا در بازخوانی فایل: ${e?.message || 'فرمت نامعتبر'}` };
    }
  }

  public resetToFactoryDefaults(): void {
    this.saveEmployees(SEED_EMPLOYEES);
    this.saveCriteria(SEED_CRITERIA);
    this.saveProfiles(SEED_PROFILES);
    this.saveEvaluations(SEED_EVALUATIONS);
    this.saveArchivedEvaluations([]);
  }

  // --- STORAGE MONITORING ---
  /** Approximate total bytes used by localStorage keys this app manages. */
  public getStorageUsage(): { totalBytes: number; keyCount: number; byKey: Record<string, number> } {
    let totalBytes = 0;
    const byKey: Record<string, number> = {};
    if (typeof localStorage === 'undefined') return { totalBytes: 0, keyCount: 0, byKey: {} };

    // Gather all keys this app controls (STORAGE_KEYS + misc + templates + logs)
    const appKeys = new Set<string>([
      ...Object.values(STORAGE_KEYS),
      'pe_system_logs',
      'chalak_excel_templates',
      'chalak_onboarding_step_guest',
      'chalak_cloud_client_id',
    ]);

    // Also include any onboarding step keys and known prefix keys
    const allKeys = Object.keys(localStorage);
    for (const key of allKeys) {
      if (key.startsWith('chalak_') || key.startsWith('pe_')) {
        appKeys.add(key);
      }
    }

    const keyCount = appKeys.size;
    for (const key of appKeys) {
      const val = localStorage.getItem(key);
      if (val !== null) {
        const size = val.length + key.length;
        byKey[key] = size;
        totalBytes += size;
      }
    }

    return { totalBytes, keyCount, byKey };
  }

  /** Attempt to estimate storage quota (best-effort, browser-dependent). */
  public async getStorageQuota(): Promise<{ quota?: number; usage?: number; percentage?: number } | null> {
    if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) {
      return null;
    }
    try {
      const estimate = await navigator.storage.estimate();
      const usage = estimate.usage;
      const quota = estimate.quota;
      return {
        quota,
        usage,
        percentage: quota ? Math.round((usage / quota) * 100) : undefined,
      };
    } catch {
      return null;
    }
  }
}

export const db = new AppDatabase();

