import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, eq, gte, sql } from 'drizzle-orm';
import {
  agentRuns,
  connections,
  knowledgeHealth,
  memberships,
  projects,
  repositories,
  specs,
  type Db,
} from '@specd/db';
import { isModelId, slugify, type ProjectSummary, type VcsProvider } from '@specd/shared';
import { RunsInFlight } from '../common/errors.js';
import { DB } from '../db/db.module.js';

@Injectable()
export class ProjectsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(input: {
    userId: string;
    name: string;
    description?: string | null;
    spendCapCents?: number;
    defaultModel?: string;
    /**
     * The wizard creates drafts — real only once setup completes. API
     * consumers (CLI, tests, the loop) omit this and get a live project,
     * because for them "created" and "set up" are the same moment.
     */
    draft?: boolean;
  }) {
    const slug = await this.uniqueSlug(slugify(input.name) || 'project');

    const [project] = await this.db
      .insert(projects)
      .values({
        slug,
        name: input.name,
        description: input.description ?? null,
        spendCapCents: input.spendCapCents ?? 10_000,
        defaultModel:
          input.defaultModel && isModelId(input.defaultModel)
            ? input.defaultModel
            : 'claude-opus-5',
        setupCompletedAt: input.draft ? null : new Date(),
      })
      .returning();
    if (!project) throw new Error('failed to create project');

    // The creator owns it; everyone else is invited in as a reviewer, because
    // reviewers are how the human gate stays real (§13).
    await this.db.insert(memberships).values({
      userId: input.userId,
      projectId: project.id,
      role: 'owner',
    });

    return project;
  }

  async listForUser(userId: string): Promise<ProjectSummary[]> {
    const rows = await this.db
      .select({ project: projects })
      .from(memberships)
      .innerJoin(projects, eq(projects.id, memberships.projectId))
      .where(eq(memberships.userId, userId))
      .orderBy(projects.createdAt);

    return Promise.all(rows.map((r) => this.summarize(r.project)));
  }

  async bySlug(slug: string) {
    const [row] = await this.db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
    if (!row) throw new NotFoundException(`No project "${slug}"`);
    return row;
  }

  async byId(id: string) {
    const [row] = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!row) throw new NotFoundException('Project not found');
    return row;
  }

  async requireRole(userId: string, projectId: string, allowed: readonly string[]): Promise<string> {
    const [row] = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.projectId, projectId)))
      .limit(1);
    if (!row) throw new NotFoundException('Project not found');
    if (!allowed.includes(row.role)) {
      throw new ForbiddenException(`Requires one of: ${allowed.join(', ')}`);
    }
    return row.role;
  }

  async update(
    projectId: string,
    patch: {
      name?: string;
      description?: string | null;
      spendCapCents?: number;
      defaultModel?: string;
      agentsPaused?: boolean;
      setupComplete?: boolean;
    },
  ) {
    const values: Record<string, unknown> = {};
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.spendCapCents !== undefined) values.spendCapCents = patch.spendCapCents;
    if (patch.agentsPaused !== undefined) values.agentsPaused = patch.agentsPaused;
    // One-way, and first-completion wins: re-finishing the wizard must not
    // rewrite when the project actually went live.
    if (patch.setupComplete === true) {
      values.setupCompletedAt = sql`coalesce(${projects.setupCompletedAt}, now())`;
    }
    if (patch.defaultModel !== undefined && isModelId(patch.defaultModel)) {
      values.defaultModel = patch.defaultModel;
    }
    if (Object.keys(values).length === 0) return this.byId(projectId);

    const [row] = await this.db
      .update(projects)
      .set(values)
      .where(eq(projects.id, projectId))
      .returning();
    if (!row) throw new NotFoundException('Project not found');
    return row;
  }

  /**
   * Deleting a project is the owner's act, and it is total: memberships,
   * connections (with their vaulted credentials), repositories, tickets,
   * specs, runs and the whole knowledge index go with it via FK cascade —
   * one delete, the schema does the rest. The exception is deliberate:
   * webhook deliveries survive with `project_id` nulled, because they are
   * the record of what GitHub/GitLab actually sent, and deleting a project
   * must not be able to erase the evidence of what specd did in response.
   *
   * Refused while a run is executing; a `queued` row that never started
   * simply dies with the project.
   */
  async remove(projectId: string): Promise<void> {
    const [running] = await this.db
      .select({ n: count() })
      .from(agentRuns)
      .where(and(eq(agentRuns.projectId, projectId), eq(agentRuns.status, 'running')));
    const runningCount = Number(running?.n ?? 0);
    if (runningCount > 0) throw new RunsInFlight('project', runningCount);

    await this.db.delete(projects).where(eq(projects.id, projectId));
  }

  /** Agent spend so far this calendar month, in cents (§10). */
  async monthlySpendCents(projectId: string): Promise<number> {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const [row] = await this.db
      .select({ total: sql<number>`coalesce(sum(${agentRuns.costCents}), 0)::int` })
      .from(agentRuns)
      .where(and(eq(agentRuns.projectId, projectId), gte(agentRuns.createdAt, monthStart)));

    return row?.total ?? 0;
  }

  async summarize(project: typeof projects.$inferSelect): Promise<ProjectSummary> {
    const [repoCountRow] = await this.db
      .select({ n: count() })
      .from(repositories)
      .where(eq(repositories.projectId, project.id));

    const [vcsConn] = await this.db
      .select({ provider: connections.provider })
      .from(connections)
      .where(and(eq(connections.projectId, project.id), eq(connections.kind, 'vcs')))
      .limit(1);

    const [trackerConn] = await this.db
      .select({ provider: connections.provider })
      .from(connections)
      .where(and(eq(connections.projectId, project.id), eq(connections.kind, 'tracker')))
      .limit(1);

    const statusCounts = await this.db
      .select({ status: specs.status, n: count() })
      .from(specs)
      .where(eq(specs.projectId, project.id))
      .groupBy(specs.status);

    const countOf = (...statuses: string[]) =>
      statusCounts
        .filter((r) => statuses.includes(r.status))
        .reduce((acc, r) => acc + Number(r.n), 0);

    const [health] = await this.db
      .select({ score: knowledgeHealth.score })
      .from(knowledgeHealth)
      .where(eq(knowledgeHealth.projectId, project.id))
      .limit(1);

    return {
      id: project.id,
      slug: project.slug,
      name: project.name,
      description: project.description,
      repoCount: Number(repoCountRow?.n ?? 0),
      vcsProvider: (vcsConn?.provider as VcsProvider | undefined) ?? null,
      trackerKind: trackerConn?.provider === 'jira' ? 'jira' : 'board',
      specsInReview: countOf('in_review', 'changes_requested'),
      specsBuilding: countOf('building'),
      spendCents: await this.monthlySpendCents(project.id),
      spendCapCents: project.spendCapCents,
      knowledgeHealth: Math.round(health?.score ?? 0),
      defaultModel: project.defaultModel,
      agentsPaused: project.agentsPaused,
      setupComplete: project.setupCompletedAt !== null,
    };
  }

  private async uniqueSlug(base: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const [existing] = await this.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.slug, candidate))
        .limit(1);
      if (!existing) return candidate;
    }
    return `${base}-${Date.now()}`;
  }
}
