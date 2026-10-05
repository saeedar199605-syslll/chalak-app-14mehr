import type { Employee, WorkflowStageKey } from '../types';

/** The stages from which a manager may request an HSE review. */
export const HSE_ROUTEABLE_STAGES: readonly WorkflowStageKey[] = [
  'supervisor_review', 'peer_review', 'calibration_review',
];

/** HSE can return a file only to a stage from which it could have been routed. */
export const HSE_RETURNABLE_STAGES: readonly WorkflowStageKey[] = HSE_ROUTEABLE_STAGES;

const stageNext: Partial<Record<WorkflowStageKey, WorkflowStageKey[]>> = {
  self_review: ['supervisor_review'],
  supervisor_review: ['peer_review', 'calibration_review'],
  peer_review: ['calibration_review'],
  calibration_review: ['hr_approval'],
  hr_approval: ['feedback_meeting'],
  feedback_meeting: ['completed'],
  rejected: ['supervisor_review'],
  appealed: ['feedback_meeting'],
};

/** Shared edge policy used by both the UI action resolver and Pages write validation. */
export function isValidWorkflowEdge(from: WorkflowStageKey, to: WorkflowStageKey, action: string, role: Employee['role']): boolean {
  if (from === 'hse_review' || to === 'hse_review') {
    if (action === 'route_hse') return (role === 'admin' || role === 'supervisor') &&
      HSE_ROUTEABLE_STAGES.includes(from) && to === 'hse_review';
    if (action === 'complete_hse_review') return from === 'hse_review' && HSE_RETURNABLE_STAGES.includes(to);
    return false;
  }
  if (action === 'admin_override') return role === 'admin';
  if (action === 'reassign_assignee') return from === to;
  if (action === 'reject_to_supervisor' || action === 'reject_to_employee') return to === 'rejected' && ['supervisor_review', 'peer_review', 'calibration_review', 'hr_approval'].includes(from);
  if (action === 'submit_appeal') return role === 'employee' && ['supervisor_review', 'feedback_meeting', 'completed'].includes(from) && to === 'appealed';
  if (action === 'resolve_appeal') return from === 'appealed' && to === 'feedback_meeting';
  if (action === 'submit_self') return role === 'employee' && from === 'self_review' && to === 'supervisor_review';
  if (action === 'submit_supervisor') return role === 'employee'
    ? from === 'rejected' && to === 'supervisor_review'
    : (from === 'supervisor_review' || from === 'rejected') && ['calibration_review', 'peer_review'].includes(to);
  if (action === 'submit_peer') return from === 'peer_review' && to === 'calibration_review';
  if (action === 'approve_calibration') return from === 'calibration_review' && to === 'hr_approval';
  if (action === 'approve_hr') return from === 'hr_approval' && to === 'feedback_meeting';
  if (action === 'complete_feedback') return from === 'feedback_meeting' && to === 'completed';
  if (action === 'advance') return (stageNext[from] || []).includes(to);
  return false;
}
