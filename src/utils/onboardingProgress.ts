import type { Employee } from '../types';

export interface OnboardingPreferences {
  version: 1;
  seen: boolean;
  completed: string[];
  dismissed: boolean;
  dontShowAutomatically: boolean;
}

const emptyPreferences = (): OnboardingPreferences => ({ version: 1, seen: false, completed: [], dismissed: false, dontShowAutomatically: false });
export function onboardingPreferenceKey(user: Pick<Employee, 'id' | 'role'>): string { return `pe_onboarding_v5_${user.id}_${user.role}`; }

export function readOnboardingPreferences(user: Pick<Employee, 'id' | 'role'>): OnboardingPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(onboardingPreferenceKey(user)) || 'null') as Partial<OnboardingPreferences> | null;
    if (!parsed || parsed.version !== 1) return emptyPreferences();
    return {
      version: 1,
      seen: parsed.seen === true,
      completed: Array.isArray(parsed.completed) ? parsed.completed.filter((item): item is string => typeof item === 'string') : [],
      dismissed: parsed.dismissed === true,
      dontShowAutomatically: parsed.dontShowAutomatically === true,
    };
  } catch { return emptyPreferences(); }
}

export function saveOnboardingPreferences(user: Pick<Employee, 'id' | 'role'>, update: Partial<OnboardingPreferences>): OnboardingPreferences {
  const next = { ...readOnboardingPreferences(user), ...update, version: 1 as const };
  try { localStorage.setItem(onboardingPreferenceKey(user), JSON.stringify(next)); } catch { /* Keep the guide usable when browser storage is unavailable. */ }
  return next;
}

export function hasSeenOnboarding(user: Pick<Employee, 'id' | 'role'>): boolean { return readOnboardingPreferences(user).seen; }

export function markOnboardingStep(user: Pick<Employee, 'id' | 'role'>, stepId: string): OnboardingPreferences {
  const current = readOnboardingPreferences(user);
  return saveOnboardingPreferences(user, { seen: true, completed: [...new Set([...current.completed, stepId])], dismissed: false });
}
