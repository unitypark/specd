import {
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
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MODEL_IDS, MODELS } from '@specd/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { TokenClaims } from '../auth/auth.service.js';
import { ProjectsService } from './projects.service.js';
import { RepositoriesService } from './repositories.service.js';
import { ConnectionsService } from './connections.service.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';
import { ModelRouter } from '../agents/model.router.js';
import { Vault } from '../common/vault.js';

class CreateProjectDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsInt() @Min(0) spendCapCents?: number;
  @IsOptional() @IsIn(MODEL_IDS) defaultModel?: string;
}

class UpdateProjectDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsInt() @Min(0) spendCapCents?: number;
  @IsOptional() @IsIn(MODEL_IDS) defaultModel?: string;
  @IsOptional() @IsBoolean() agentsPaused?: boolean;
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
}

class ConnectTrackerDto {
  @IsIn(['board', 'jira']) provider!: string;
  @IsOptional() @IsString() projectKey?: string;
}

@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly repositories: RepositoriesService,
    private readonly connections: ConnectionsService,
    private readonly knowledge: KnowledgeService,
    private readonly modelRouter: ModelRouter,
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
    await this.connections.upsert({
      projectId: project.id,
      kind: 'vcs',
      provider: dto.provider,
      label: dto.provider === 'local' ? 'local runner' : dto.instanceUrl ?? dto.provider,
      settings: { instanceUrl: dto.instanceUrl ?? null },
      secret: dto.token ?? null,
    });
    return { ok: true };
  }

  @Post(':slug/connections/tracker')
  async connectTracker(
    @Param('slug') slug: string,
    @Body() dto: ConnectTrackerDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer']);
    await this.connections.upsert({
      projectId: project.id,
      kind: 'tracker',
      provider: dto.provider,
      label: dto.provider === 'jira' ? `Jira ${dto.projectKey ?? ''}`.trim() : 'built-in board',
      settings: { projectKey: dto.projectKey ?? null },
    });
    return { ok: true };
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
    const [docs, health, grounding] = await Promise.all([
      this.knowledge.listDocs(project.id, repositoryId),
      this.knowledge.health(project.id),
      this.knowledge.groundingQuality(project.id),
    ]);
    return { docs, health, grounding };
  }

  @Get(':slug/knowledge/:docId')
  async knowledgeDoc(
    @Param('slug') slug: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer', 'reviewer']);
    return this.knowledge.getDoc(project.id, docId);
  }
}
