import type { SpecStatus } from './lifecycle.js';
import type { ModelId } from './models.js';
import type { SpecContent } from './spec.js';

export type VcsProvider = 'local' | 'github' | 'gitlab';
export type AiMode = 'api_key' | 'subscription_runner' | 'managed_cloud';
export type TrackerKind = 'board' | 'jira';
export type ConnectionKind = 'vcs' | 'ai' | 'tracker';
export type MembershipRole = 'owner' | 'maintainer' | 'reviewer';

/** Every agent interaction is an auditable AgentRun (§10, §12). */
export type AgentRunKind = 'onboard' | 'spec' | 'index' | 'build';
export type AgentRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type RunnerKind = 'hosted' | 'self_hosted';

export type KnowledgeDocKind = 'doc' | 'adr' | 'runbook' | 'spec';

export interface KnowledgeFreshness {
  /** 0–100. Feeds the "knowledge health" number on the dashboard (§P6). */
  score: number;
  ageDays: number;
  stale: boolean;
  reason?: string;
}

export interface RetrievedChunk {
  docId: string;
  repoName: string;
  path: string;
  heading: string | null;
  text: string;
  score: number;
  /** How the chunk was found — hybrid retrieval reports its own provenance. */
  via: 'vector' | 'fulltext' | 'both' | 'graph';
  /**
   * For `via: 'graph'` only: the edge that pulled this chunk in, e.g.
   * `citation from knowledge/specs/S-104-….md#design`. Provenance for the
   * run log and the reviewer — an expanded chunk must be able to say WHY it
   * arrived (S-102).
   */
  viaEdge?: string;
}

/**
 * Retrieval result with its own honesty accounting (S-102): how many chunks
 * matched at all vs how many fit the budget, so prompt assembly can announce
 * truncation instead of letting an agent read a cut as an absence.
 */
export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /** Distinct chunks that matched either retrieval arm before the cut. */
  matchedCount: number;
  /** How many matched chunks were left out for budget. */
  truncatedCount: number;
}

/** A citation the SpecAgent may use: `knowledge/architecture.md#auth`. */
export function citationRef(chunk: RetrievedChunk): string {
  return chunk.heading ? `${chunk.path}#${chunk.heading}` : chunk.path;
}

export interface SpecDraftResult {
  content: SpecContent;
  model: ModelId;
  usedChunks: RetrievedChunk[];
}

export interface RunLogLine {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface ProjectSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  repoCount: number;
  vcsProvider: VcsProvider | null;
  trackerKind: TrackerKind;
  specsInReview: number;
  specsBuilding: number;
  spendCents: number;
  spendCapCents: number;
  knowledgeHealth: number;
  defaultModel: string;
}

export interface SpecView {
  id: string;
  ticketId: string;
  ticketKey: string;
  title: string;
  version: number;
  status: SpecStatus;
  content: SpecContent;
  citationCount: number;
  unverifiedCount: number;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  supersedes: string | null;
}
