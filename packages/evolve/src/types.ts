export type ExperienceType = 'true-positive' | 'false-positive' | 'fix-applied' | 'best-practice';
export type RuleState = 'active' | 'deprecated' | 'experimental' | 'promoted';

export interface ExperienceEntry {
  id: string;
  projectId: string;
  type: ExperienceType;
  ruleId: string;
  issueId?: string;
  pattern: string;
  message: string;
  feedback: string;
  source: 'user' | 'auto';
  confidence: number;
  verified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface RuleStateEntry {
  ruleId: string;
  state: RuleState;
  reason: string;
  changedAt: Date;
  changedBy: string;
}

export interface RuleWeightEntry {
  ruleId: string;
  weight: number;
  falsePositiveRate: number;
  totalSamples: number;
  lastAdjustedAt: Date;
}

export interface Suggestion {
  ruleId: string;
  message: string;
  confidence: number;
  source: string;
}

export interface SyncPayload {
  clientId: string;
  syncedAt: string;
  experiences: ExperienceEntry[];
  weights: RuleWeightEntry[];
  ruleStates: RuleStateEntry[];
  totalSynced: number;
}
