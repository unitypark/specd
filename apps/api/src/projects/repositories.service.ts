import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { repositories, type Db } from '@specd/db';
import { DB } from '../db/db.module.js';
import { VcsService } from '../vcs/vcs.service.js';

@Injectable()
export class RepositoriesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly vcs: VcsService,
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
    return row;
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
