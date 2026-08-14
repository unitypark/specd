import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { policyExceptions, projects, type Db } from '@specd/db';
import { countUnverified, type CitationDrift, type SpecView } from '@specd/shared';
import { DB } from '../db/db.module.js';
import { PolicyRefusedBuild } from '../common/errors.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';

/** A rule that refused, in the words the person who has to act on it needs. */
export interface PolicyRefusal {
  policy: string;
  detail: string;
}

/**
 * House rules on the gate, as data.
 *
 * The gate itself is binary and stays that way: approved, by a named human, or
 * not. What a team can add on top is a floor — "not below 60% knowledge
 * health", "not with eight UNVERIFIED claims" — and until now expressing that
 * meant editing specd.
 *
 * Two properties keep this from becoming the thing everyone switches off:
 *
 *   - **NULL means no rule**, never zero. A project that never set a floor is
 *     not silently held to one.
 *   - **Every override is a record.** A rule with no way past it gets disabled
 *     the first time it is wrong; a rule with a silent way past it is
 *     decoration. So the way past is a named human and a typed justification,
 *     attributed by a database constraint the same way an approval is.
 */
@Injectable()
export class PolicyService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly knowledge: KnowledgeService,
  ) {}

  /**
   * Which rules refuse this build, if any. Returns them rather than throwing,
   * because the caller decides whether an override was offered.
   */
  async refusalsForBuild(
    projectId: string,
    spec: SpecView,
    drifted: CitationDrift[],
  ): Promise<PolicyRefusal[]> {
    const [project] = await this.db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) return [];

    const refusals: PolicyRefusal[] = [];

    if (project.policyMaxUnverified !== null) {
      const unverified = countUnverified(spec.content);
      if (unverified > project.policyMaxUnverified) {
        refusals.push({
          policy: 'max_unverified',
          detail:
            `${spec.ticketKey} carries ${unverified} UNVERIFIED claim(s); this project allows ` +
            `at most ${project.policyMaxUnverified}.`,
        });
      }
    }

    if (project.policyMinHealth !== null) {
      const health = await this.knowledge.health(projectId);
      if (health.score < project.policyMinHealth) {
        refusals.push({
          policy: 'min_health',
          detail:
            `Knowledge health is ${health.score.toFixed(0)}%; this project will not build ` +
            `below ${project.policyMinHealth.toFixed(0)}%.`,
        });
      }
    }

    if (project.policyBlockOnDrift && drifted.length > 0) {
      refusals.push({
        policy: 'block_on_drift',
        detail:
          `${drifted.length} of ${spec.ticketKey}'s citation(s) no longer stand where they did ` +
          'at approval, and this project treats that as blocking.',
      });
    }

    return refusals;
  }

  /** Turn refusals into the 409 a caller sees when no override was offered. */
  refuse(refusals: PolicyRefusal[]): never {
    throw new PolicyRefusedBuild(
      refusals.map((r) => r.policy).join(', '),
      refusals.map((r) => r.detail).join(' '),
    );
  }

  /**
   * Record that a human took responsibility for proceeding anyway.
   *
   * Written before the work starts, not after: an override that is only
   * recorded on success is missing exactly when someone will want to read it.
   */
  async recordException(input: {
    projectId: string;
    specId: string;
    runId: string | null;
    ticketKey: string;
    refusals: PolicyRefusal[];
    approvedByUserId: string;
    approvedByName: string;
    justification: string;
  }): Promise<void> {
    await this.db.insert(policyExceptions).values(
      input.refusals.map((r) => ({
        projectId: input.projectId,
        specId: input.specId,
        runId: input.runId,
        ticketKey: input.ticketKey,
        policy: r.policy,
        detail: r.detail,
        approvedByUserId: input.approvedByUserId,
        approvedByName: input.approvedByName,
        justification: input.justification,
      })),
    );
  }

  /** The overrides on this project, newest first — the audit read. */
  async exceptions(projectId: string, limit = 50) {
    return this.db
      .select()
      .from(policyExceptions)
      .where(eq(policyExceptions.projectId, projectId))
      .orderBy(desc(policyExceptions.createdAt))
      .limit(limit);
  }
}
