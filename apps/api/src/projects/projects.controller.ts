import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { EFFORT_LEVELS, MODEL_IDS, MODELS } from '@specd/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { TokenClaims } from '../auth/auth.service.js';
import { ProjectsService } from './projects.service.js';
import { RepositoriesService } from './repositories.service.js';
import { ConnectionsService } from './connections.service.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { ModelRouter } from '../agents/model.router.js';
import { Vault } from '../common/vault.js';
import { JiraAdapter } from '../tracker/jira.adapter.js';
import { VcsError, normalizeInstanceUrl } from '../vcs/vcs.types.js';
import { instanceUrlFromRemote, resolveGitLabRoot } from '../vcs/local-review.js';
import { LocalGitAdapter } from '../vcs/local-git.adapter.js';
import { GitHubAdapter } from '../vcs/github.adapter.js';
import { GitLabAdapter } from '../vcs/gitlab.adapter.js';

class CreateProjectDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsInt() @Min(0) spendCapCents?: number;
  @IsOptional() @IsIn(MODEL_IDS) defaultModel?: string;
  /** The wizard sends true: the project is a draft until setup completes. */
  @IsOptional() @IsBoolean() draft?: boolean;
}

class UpdateProjectDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsInt() @Min(0) spendCapCents?: number;
  @IsOptional() @IsIn(MODEL_IDS) defaultModel?: string;
  /**
   * `null` clears the override and puts every station back on its own
   * default — which is why this is nullable rather than merely optional: an
   * omitted field means "unchanged", and there has to be a way to say "none".
   */
  @IsOptional() @IsIn([...EFFORT_LEVELS, null]) effort?: string | null;
  @IsOptional() @IsBoolean() agentsPaused?: boolean;
  /** One-way: true marks setup finished; false is ignored. */
  @IsOptional() @IsBoolean() setupComplete?: boolean;
}

class AddRepoDto {
  @IsIn(['local', 'github', 'gitlab']) provider!: string;
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() localPath?: string;
  @IsOptional() @IsString() externalId?: string;
  @IsOptional() @IsString() defaultBranch?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

class ConnectAiDto {
  @IsIn(['api_key', 'subscription_runner', 'managed_cloud']) mode!:
    | 'api_key'
    | 'subscription_runner'
    | 'managed_cloud';
  @IsOptional() @IsString() apiKey?: string;
  @IsOptional() @IsIn(MODEL_IDS) model?: string;
}

class ConnectVcsDto {
  @IsIn(['local', 'github', 'gitlab']) provider!: string;
  @IsOptional() @IsString() token?: string;
  @IsOptional() @IsString() instanceUrl?: string;
  /**
   * Local mode only: the host to open pull/merge requests on, if any. Absent
   * keeps local mode exactly as it was — a branch, and no credential held.
   */
  @IsOptional() @IsIn(['github', 'gitlab']) reviewProvider?: 'github' | 'gitlab';
}

class ConnectTrackerDto {
  @IsIn(['board', 'jira']) provider!: string;
  @IsOptional() @IsString() projectKey?: string;
  /** Jira Cloud only: `https://your-team.atlassian.net`. */
  @IsOptional() @IsString() siteUrl?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() apiToken?: string;
  /**
   * specd lifecycle state → Jira status name. Optional and empty by default;
   * an unmapped status simply is not mirrored (decision 0010).
   */
  @IsOptional() @IsObject() statusMap?: Record<string, string>;
}

@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly repositories: RepositoriesService,
    private readonly connections: ConnectionsService,
    private readonly knowledge: KnowledgeService,
    private readonly modelRouter: ModelRouter,
    private readonly local: LocalGitAdapter,
  ) {}

  @Get()
  list(@CurrentUser() user: TokenClaims) {
    return this.projects.listForUser(user.sub);
  }

  @Post()
  async create(@Body() dto: CreateProjectDto, @CurrentUser() user: TokenClaims) {
    const project = await this.projects.create({ userId: user.sub, ...dto });
    return this.projects.summarize(project);
  }

  /** Can this machine run subscription mode? Asked before the wizard offers it. */
  @Get('ai-modes')
  async aiModes() {
    return {
      api_key: await this.modelRouter.describeMode('api_key'),
      subscription_runner: await this.modelRouter.describeMode('subscription_runner'),
      managed_cloud: await this.modelRouter.describeMode('managed_cloud'),
    };
  }

  @Get('models')
  models() {
    return MODEL_IDS.map((id) => ({
      id,
      label: MODELS[id].label,
      note: MODELS[id].note,
      inputUsdPerMTok: MODELS[id].inputUsdPerMTok,
      outputUsdPerMTok: MODELS[id].outputUsdPerMTok,
    }));
  }

  @Get(':slug')
  async get(@Param('slug') slug: string, @CurrentUser() user: TokenClaims) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer', 'reviewer']);
    return this.projects.summarize(project);
  }

  @Patch(':slug')
  async update(
    @Param('slug') slug: string,
    @Body() dto: UpdateProjectDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer']);
    const updated = await this.projects.update(project.id, dto);
    return this.projects.summarize(updated);
  }

  /**
   * Owner-only, and the UI double-confirms with a typed project name. The
   * cascade semantics (what dies with it, what survives) live on
   * `ProjectsService.remove`.
   */
  @Delete(':slug')
  async remove(@Param('slug') slug: string, @CurrentUser() user: TokenClaims) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner']);
    await this.projects.remove(project.id);
    return { deleted: true };
  }

  // ─── repositories ───────────────────────────────────────────────────────────

  @Get(':slug/repositories')
  async listRepos(@Param('slug') slug: string, @CurrentUser() user: TokenClaims) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer', 'reviewer']);
    return this.repositories.list(project.id);
  }

  @Post(':slug/repositories')
  async addRepo(
    @Param('slug') slug: string,
    @Body() dto: AddRepoDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer']);
    const conn = await this.connections.get(project.id, 'vcs');
    return this.repositories.add({
      projectId: project.id,
      connectionId: conn?.id ?? null,
      ...dto,
    });
  }

  @Post(':slug/repositories/:repoId/primary')
  async setPrimary(
    @Param('slug') slug: string,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer']);
    return this.repositories.setPrimary(project.id, repoId);
  }

  @Post(':slug/repositories/:repoId/setup-merged')
  async markMerged(
    @Param('slug') slug: string,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer']);
    return this.repositories.markSetupMerged(project.id, repoId);
  }

  @Delete(':slug/repositories/:repoId')
  async removeRepo(
    @Param('slug') slug: string,
    @Param('repoId', ParseUUIDPipe) repoId: string,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer']);
    await this.repositories.remove(project.id, repoId);
    return { ok: true };
  }

  /** Wizard step 2, Local mode: is this path actually a clean git repo? */
  @Get(':slug/inspect-path')
  async inspectPath(
    @Param('slug') slug: string,
    @Query('path') path: string,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer']);
    return this.repositories.inspectLocalPath(path);
  }

  // ─── connections ────────────────────────────────────────────────────────────

  @Get(':slug/connections')
  async listConnections(@Param('slug') slug: string, @CurrentUser() user: TokenClaims) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer', 'reviewer']);
    return this.connections.list(project.id);
  }

  @Post(':slug/connections/ai')
  async connectAi(
    @Param('slug') slug: string,
    @Body() dto: ConnectAiDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer']);

    // Validate live before storing — a key that does not work should fail in
    // the wizard, not in the first agent run.
    let validation = { ok: true, detail: 'No key needed for this mode.' };

    if (dto.mode === 'subscription_runner') {
      // Fail here rather than in the first agent run: subscription mode only
      // works where specd runs beside the user's Claude Code (D2), or where a
      // runner is already paired to this project and can dispatch for it.
      validation = await this.modelRouter.describeMode('subscription_runner', project.id);
      if (!validation.ok) return validation;
    }

    if (dto.mode === 'api_key') {
      if (!dto.apiKey) {
        return { ok: false, detail: 'An API key is required for this mode.' };
      }
      validation = await this.connections.validateAnthropicKey(dto.apiKey);
      if (!validation.ok) return validation;
    }

    await this.connections.upsert({
      projectId: project.id,
      kind: 'ai',
      provider: 'anthropic',
      label: dto.mode === 'api_key' && dto.apiKey ? Vault.mask(dto.apiKey) : dto.mode,
      // Deliberately no `model` here — it lives on the project only, so
      // changing it later actually takes effect.
      settings: { mode: dto.mode },
      secret: dto.mode === 'api_key' ? dto.apiKey : null,
    });

    if (dto.model) await this.projects.update(project.id, { defaultModel: dto.model });
    return validation;
  }

  @Post(':slug/connections/vcs')
  async connectVcs(
    @Param('slug') slug: string,
    @Body() dto: ConnectVcsDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer']);

    // Normalized before it is stored, so the complaint lands on the field
    // somebody just typed into rather than on the repository list one call
    // later — and so every later caller (webhooks, indexing, builds) reads a
    // URL that is already in a shape `fetch` accepts.
    let instanceUrl: string | null = null;
    if (dto.instanceUrl?.trim()) {
      try {
        instanceUrl = normalizeInstanceUrl(dto.instanceUrl);
      } catch (err) {
        throw new BadRequestException(err instanceof VcsError ? err.message : String(err));
      }
    }

    // Local mode may carry a credential used for one thing: opening the
    // review. It is proved here, live, because the wizard must not claim a
    // connection that fails later inside a run (§6 guardrail) — and because
    // "the merge request never appeared" is a bad way to learn a token is
    // wrong.
    let connectedAs: string | undefined;
    const reviewProvider = dto.provider === 'local' ? dto.reviewProvider ?? null : null;
    if (reviewProvider === 'github' && !dto.token) {
      // GitHub has no way to open a pull request except the API.
      throw new BadRequestException(
        'A GitHub token is needed to open pull requests from local mode. Leave the review host ' +
          'unset to keep local mode credential-free.',
      );
    }

    // A GitLab project with no token is a supported, and preferred, setup:
    // push options open the merge request over the git transport. There is
    // nothing to verify in that case, so nothing is checked.
    if (reviewProvider && dto.token) {
      // Verified against the host the repository names, not against whatever
      // the adapter would default to. A check that passes against gitlab.com
      // for a self-managed project is worse than no check at all.
      const root = instanceUrl ?? (await this.derivedReviewHost(project.id, reviewProvider));
      if (!root) {
        throw new BadRequestException(
          'specd could not work out which host to open reviews on. Add a repository with an ' +
            '`origin` remote first, or give the instance URL explicitly.',
        );
      }

      try {
        const identity =
          reviewProvider === 'gitlab'
            ? await new GitLabAdapter(dto.token, root).verify()
            : await new GitHubAdapter(
                dto.token,
                /^https:\/\/github\.com$/.test(root) ? undefined : `${root}/api/v3`,
              ).verify();
        connectedAs = `${identity.username} on ${root}`;
      } catch (err) {
        throw new BadRequestException(
          err instanceof VcsError ? err.message : err instanceof Error ? err.message : String(err),
        );
      }
    }

    await this.connections.upsert({
      projectId: project.id,
      kind: 'vcs',
      provider: dto.provider,
      label: dto.provider === 'local' ? 'local runner' : instanceUrl ?? dto.provider,
      settings: { instanceUrl, reviewProvider },
      secret: dto.token ?? null,
    });
    return connectedAs ? { ok: true, connectedAs } : { ok: true };
  }

  /**
   * The review host a project's own checkouts point at.
   *
   * Local mode already holds a clone, and a clone knows its origin — so the
   * instance URL is something specd can read rather than something a person
   * has to retype. Only *which software* the host runs cannot be read off a
   * remote, which is why the provider is still chosen by hand.
   */
  private async derivedReviewHost(
    projectId: string,
    provider: 'github' | 'gitlab',
  ): Promise<string | null> {
    const repos = await this.repositories.list(projectId);
    for (const repo of repos) {
      if (!repo.localPath) continue;
      const origin = await this.local.originUrl(repo.localPath);
      const derived = origin ? instanceUrlFromRemote(origin) : null;
      if (!derived) continue;
      // A subpath-hosted instance is indistinguishable from a group by string
      // alone, so GitLab is asked rather than guessed at.
      return provider === 'gitlab' ? resolveGitLabRoot(derived, origin!) : derived;
    }
    return null;
  }

  @Post(':slug/connections/tracker')
  async connectTracker(
    @Param('slug') slug: string,
    @Body() dto: ConnectTrackerDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer']);

    if (dto.provider !== 'jira') {
      await this.connections.upsert({
        projectId: project.id,
        kind: 'tracker',
        provider: dto.provider,
        label: 'built-in board',
        settings: { projectKey: dto.projectKey ?? null },
      });
      return { ok: true };
    }

    if (!dto.siteUrl || !dto.email || !dto.apiToken) {
      throw new BadRequestException(
        'Jira needs siteUrl, email and apiToken. Create a token at id.atlassian.com → Security → API tokens.',
      );
    }

    // Prove the credential here, in front of whoever is connecting it, rather
    // than letting it fail later inside a spec run where nobody is looking.
    const identity = await new JiraAdapter(dto.siteUrl, dto.email, dto.apiToken)
      .verify()
      .catch((err: unknown) => {
        throw new BadRequestException(
          `Jira rejected that credential: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    await this.connections.upsert({
      projectId: project.id,
      kind: 'tracker',
      provider: 'jira',
      label: `Jira ${dto.projectKey ?? ''}`.trim(),
      settings: {
        projectKey: dto.projectKey ?? null,
        siteUrl: dto.siteUrl.replace(/\/+$/, ''),
        email: dto.email,
        statusMap: dto.statusMap ?? {},
      },
      secret: dto.apiToken,
    });

    return { ok: true, connectedAs: identity.displayName };
  }

  // ─── knowledge ──────────────────────────────────────────────────────────────

  @Get(':slug/knowledge')
  async knowledgeTree(
    @Param('slug') slug: string,
    @Query('repositoryId') repositoryId: string | undefined,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer', 'reviewer']);
    const [docs, health, grounding, indexRuns] = await Promise.all([
      this.knowledge.listDocs(project.id, repositoryId),
      this.knowledge.health(project.id),
      this.knowledge.groundingQuality(project.id),
      // What the recent runs changed, not only where they ended up.
      this.knowledge.indexRuns(project.id, 5),
    ]);
    return { docs, health, grounding, indexRuns };
  }

  /**
   * What this project already decided about something like this.
   *
   * A reviewer standing at the gate has the same question the SpecAgent had
   * while drafting — has this ground been walked before, and how did it go?
   * The drawer asks this so that answer is on screen *before* the approval,
   * which is the only moment it can still change anything.
   *
   * Declared above `:docId` on purpose: `precedents` would otherwise be
   * captured as a document id and fail its uuid parse.
   */
  @Get(':slug/knowledge/precedents')
  async precedents(
    @Param('slug') slug: string,
    @Query('q') q: string | undefined,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer', 'reviewer']);
    if (!q || q.trim().length < 2) return [];
    return this.knowledge.findPrecedents(project.id, q.trim());
  }

  @Get(':slug/knowledge/:docId')
  async knowledgeDoc(
    @Param('slug') slug: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer', 'reviewer']);
    const doc = await this.knowledge.getDoc(project.id, docId);
    if (!doc) return null;
    // Links and backlinks ride the doc view (S-102): where this doc points,
    // what points here, and which of its links are broken.
    const links = await this.knowledge.docLinks(project.id, docId);
    // What history says this doc moves with (0013) — the code to compare it
    // against when it looks stale.
    const coupledTo = await this.knowledge.docCoupling(project.id, docId);
    return { ...doc, ...links, coupledTo };
  }
}
