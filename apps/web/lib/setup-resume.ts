export interface ResumeConnection {
  kind: string;
  provider: string;
}

/**
 * Which wizard step an unfinished draft resumes at. Connections are the
 * durable trace of progress — each wizard step persists one kind — so the
 * first missing kind is the first unfinished step. Repositories don't factor
 * in: local mode adds repos before its connection exists, and a repo without
 * a VCS connection still means step 2 is where work stopped.
 */
export function deriveResumeStep(connections: ResumeConnection[]): 2 | 3 | 4 | 5 {
  const has = (kind: string) => connections.some((c) => c.kind === kind);
  if (!has('vcs')) return 2;
  if (!has('ai')) return 3;
  if (!has('tracker')) return 4;
  return 5;
}
