import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { repositories, type Db, type Repository } from '@specd/db';
import { DB } from '../db/db.module.js';
import { Config } from '../config.js';
import { GitLabAdapter } from '../vcs/gitlab.adapter.js';
import { VcsService } from '../vcs/vcs.service.js';

@Injectable()
export class RepositoriesService {
  private readonly logger = new Logger(RepositoriesService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly vcs: VcsService,
    private readonly config: Config,
  ) {}

  async list(projectId: string) {
    return this.db
      .select()
      .from(repositories)
      .where(eq(repositories.projectId, projectId))
      .orderBy(repositories.name);
  }

  async get(projectId: string, repoId: string) {
    const [row] = await this.db
      .select()
      .from(repositories)
      .where(and(eq(repositories.id, repoId), eq(repositories.projectId, projectId)))
      .limit(1);
    if (!row) throw new NotFoundException('Repository not found');
    return row;
  }

  async primary(projectId: string) {
    const [row] = await this.db
      .select()
      .from(repositories)
      .where(and(eq(repositories.projectId, projectId), eq(repositories.isPrimary, true)))
      .limit(1);
    return row ?? null;
  }

  async add(input: {
    projectId: string;
    connectionId?: string | null;
    provider: string;
    name: string;
    localPath?: string | null;
    externalId?: string | null;
    defaultBranch?: string;
    isPrimary?: boolean;
  }) {
    if (input.provider === 'local') {
      if (!input.localPath) {
        throw new BadRequestException('Local repositories need a path');
      }
      const described = await this.vcs.localAdapter.describe(input.localPath);
      if (!described) {
        throw new BadRequestException(
          `${input.localPath} is not a git repository. Run \`git init\` there first.`,
        );
      }
    }

    // Exactly one primary per project (D8) — demote the incumbent first.
    if (input.isPrimary) {
      await this.db
        .update(repositories)
        .set({ isPrimary: false })
        .where(eq(repositories.projectId, input.projectId));
    }

    const existingCount = (await this.list(input.projectId)).length;

    const [row] = await this.db
      .insert(repositories)
      .values({
        projectId: input.projectId,
        connectionId: input.connectionId ?? null,
        provider: input.provider,
        name: input.name,
        localPath: input.localPath ?? null,
        externalId: input.externalId ?? null,
        defaultBranch: input.defaultBranch ?? 'main',
        // The first repo added is primary by default; someone has to be.
        isPrimary: input.isPrimary ?? existingCount === 0,
      })
      .returning();

    if (!row) throw new Error('failed to add repository');

    if (row.provider === 'gitlab') {
      return this.registerGitLabWebhook(row);
    }

    return row;
  }

  /**
   * Register specd's webhook on a newly-added GitLab repository (§11). Unlike
   * GitHub's App-level webhook, GitLab needs one API call per project — and
   * that call can fail on a token below Maintainer, so it must never fail the
   * add itself. It degrades the same way local mode does: the repository
   * works, merges just are not detected until someone fixes the token's role,
   * and `webhookStatus` says so rather than staying silently wrong.
   */
  private async registerGitLabWebhook(row: Repository) {
    if (!this.config.gitlabWebhookSecret) {
      this.logger.warn(
        `not registering a webhook for ${row.name} — GITLAB_WEBHOOK_SECRET is not set`,
      );
      return row;
    }

    try {
      const { token, instanceUrl } = await this.vcs.gitlabCredential(row.projectId);
      const adapter = new GitLabAdapter(token, instanceUrl);
      await adapter.registerWebhook(
        row.name,
        `${this.config.apiPublicUrl}/api/gitlab/webhook`,
        this.config.gitlabWebhookSecret,
      );

      const [updated] = await this.db
        .update(repositories)
        .set({ webhookStatus: 'registered' })
        .where(eq(repositories.id, row.id))
        .returning();
      return updated ?? row;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`could not register a webhook for ${row.name}: ${message}`);

      const [updated] = await this.db
        .update(repositories)
        .set({ webhookStatus: 'failed' })
        .where(eq(repositories.id, row.id))
        .returning();
      return updated ?? row;
    }
  }

  async setPrimary(projectId: string, repoId: string) {
    await this.get(projectId, repoId);
    await this.db
      .update(repositories)
      .set({ isPrimary: false })
      .where(eq(repositories.projectId, projectId));
    const [row] = await this.db
      .update(repositories)
      .set({ isPrimary: true })
      .where(eq(repositories.id, repoId))
      .returning();
    return row!;
  }

  async markSetupMerged(projectId: string, repoId: string) {
    const [row] = await this.db
      .update(repositories)
      .set({ setupState: 'merged' })
      .where(and(eq(repositories.id, repoId), eq(repositories.projectId, projectId)))
      .returning();
    if (!row) throw new NotFoundException('Repository not found');
    return row;
  }

  async remove(projectId: string, repoId: string) {
    await this.get(projectId, repoId);
    await this.db.delete(repositories).where(eq(repositories.id, repoId));
  }

  /** Inspect a candidate local path before registering it (wizard step 2). */
  async inspectLocalPath(path: string) {
    const described = await this.vcs.localAdapter.describe(path);
    if (!described) return { ok: false as const, reason: 'not a git repository' };
    return { ok: true as const, ...described };
  }
}
