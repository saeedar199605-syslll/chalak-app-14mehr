/** Business events are invalidation signals; persisted state remains the source of truth. */
export type DomainEventType =
  | 'evaluation.updated'
  | 'workflow.transitioned'
  | 'workflow.owner_changed'
  | 'criterion.created'
  | 'criterion.updated'
  | 'import.completed'
  | 'permission.updated'
  | 'calibration.updated'
  | 'notification.updated'
  | 'notification.resolved'
  | 'employee.updated'
  | 'profile.updated'
  | 'period.updated';

export type DomainSurface =
  | 'evaluations' | 'workflow' | 'cartable' | 'quick_actions' | 'notifications'
  | 'dashboard' | 'criteria' | 'import_center' | 'templates' | 'reports'
  | 'permissions' | 'navigation' | 'calibration' | 'employee_directory' | 'profiles';

export interface DomainEvent {
  type: DomainEventType;
  operationId?: string;
  revision?: number;
  source: 'accepted_write' | 'remote_revision';
  changedKeys: string[];
  occurredAt: string;
}

/** Explicit surfaces that must recompute when a persisted domain changes. */
export const DOMAIN_EVENT_INVALIDATION_MAP: Record<DomainEventType, readonly DomainSurface[]> = {
  'evaluation.updated': ['evaluations', 'workflow', 'cartable', 'quick_actions', 'notifications', 'dashboard', 'calibration', 'reports'],
  'workflow.transitioned': ['workflow', 'cartable', 'quick_actions', 'notifications', 'evaluations', 'dashboard', 'calibration', 'reports'],
  'workflow.owner_changed': ['workflow', 'cartable', 'quick_actions', 'notifications', 'dashboard'],
  'criterion.created': ['criteria', 'import_center', 'templates', 'evaluations', 'reports'],
  'criterion.updated': ['criteria', 'import_center', 'templates', 'evaluations', 'dashboard', 'reports'],
  'import.completed': ['import_center', 'evaluations', 'dashboard', 'reports', 'workflow', 'cartable', 'notifications'],
  'permission.updated': ['permissions', 'navigation', 'workflow', 'cartable', 'import_center', 'evaluations'],
  'calibration.updated': ['calibration', 'evaluations', 'workflow', 'cartable', 'dashboard', 'reports'],
  'notification.updated': ['notifications', 'quick_actions', 'cartable', 'dashboard'],
  'notification.resolved': ['notifications', 'quick_actions', 'cartable', 'dashboard'],
  'employee.updated': ['employee_directory', 'evaluations', 'workflow', 'cartable', 'dashboard', 'reports'],
  'profile.updated': ['profiles', 'employee_directory', 'evaluations', 'import_center', 'templates', 'reports'],
  'period.updated': ['import_center', 'evaluations', 'dashboard', 'reports'],
};

const KEY_EVENT_MAP: Record<string, readonly DomainEventType[]> = {
  pe_evaluations: ['evaluation.updated'],
  pe_criteria: ['criterion.updated'],
  pe_notifications: ['notification.updated'],
  pe_granular_permissions: ['permission.updated'],
  pe_role_permissions: ['permission.updated'],
  pe_user_custom_permissions: ['permission.updated'],
  pe_manual_access_policy: ['permission.updated'],
  pe_employees: ['employee.updated'],
  pe_profiles: ['profile.updated'],
  pe_active_period: ['period.updated'],
  pe_archived_evaluations: ['evaluation.updated'],
  pe_workshop_targets: ['calibration.updated'],
};

export function domainEventsForChangedKeys(keys: readonly string[]): DomainEventType[] {
  const events = new Set<DomainEventType>();
  for (const key of keys) for (const event of KEY_EVENT_MAP[key] || []) events.add(event);
  return [...events];
}

export function domainEventTypesForStateChange(key: string, before: unknown, after: unknown): DomainEventType[] {
  const events = new Set(domainEventsForChangedKeys([key]));
  if (!Array.isArray(before) || !Array.isArray(after)) return [...events];
  const oldById = new Map(before.filter(item => item && typeof item.id === 'string').map(item => [item.id as string, item]));
  const nextById = new Map(after.filter(item => item && typeof item.id === 'string').map(item => [item.id as string, item]));
  if (key === 'pe_criteria') {
    if ([...nextById.keys()].some(id => !oldById.has(id))) events.add('criterion.created');
  }
  if (key === 'pe_notifications') {
    if ([...nextById].some(([id, value]) => {
      const oldValue = oldById.get(id) as Record<string, unknown> | undefined;
      return Boolean((value as Record<string, unknown>).resolvedAt && !oldValue?.resolvedAt);
    })) events.add('notification.resolved');
  }
  if (key === 'pe_evaluations') {
    for (const [id, nextValue] of nextById) {
      const oldValue = oldById.get(id) as Record<string, unknown> | undefined;
      const next = nextValue as Record<string, unknown>;
      if (!oldValue) continue;
      if (oldValue.stage !== next.stage || oldValue.status !== next.status) events.add('workflow.transitioned');
      if (oldValue.currentAssigneeId !== next.currentAssigneeId) events.add('workflow.owner_changed');
    }
  }
  return [...events];
}

export function createDomainEvents(args: {
  changedKeys: readonly string[];
  source: DomainEvent['source'];
  operationId?: string;
  revision?: number;
  occurredAt?: string;
}): DomainEvent[] {
  const changedKeys = [...new Set(args.changedKeys)].sort();
  return domainEventsForChangedKeys(changedKeys).map(type => ({
    type,
    changedKeys,
    source: args.source,
    ...(args.operationId ? { operationId: args.operationId } : {}),
    ...(Number.isInteger(args.revision) ? { revision: args.revision } : {}),
    occurredAt: args.occurredAt || new Date().toISOString(),
  }));
}
