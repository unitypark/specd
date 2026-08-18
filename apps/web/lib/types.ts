export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  repoCount: number;
  vcsProvider: string | null;
  trackerKind: string;
  specsInReview: number;
  specsBuilding: number;
  spendCents: number;
  spendCapCents: number;
  knowledgeHealth: number;
  defaultModel: string;
  /** null = every station keeps its own default. */
  effort: string | null;
  agentsPaused: boolean;
  setupComplete: boolean;
}
