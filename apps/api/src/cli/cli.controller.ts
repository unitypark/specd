import { Body, Controller, Get, Header, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { CliAllowed } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { TokenClaims } from '../auth/auth.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { RepositoriesService } from '../projects/repositories.service.js';
import { SpecsService } from '../specs/specs.service.js';
import { BoardService } from '../board/board.service.js';

class ConnectRepoDto {
  @IsString() path!: string;
  @IsString() name!: string;
  @IsOptional() @IsIn(['true', 'false']) primary?: string;
}

/**
 * The CLI's surface. Deliberately thin (D13): it fetches, registers and
 * reports. It never authors, reviews or approves — those live in the app,
 * because a gate you can drive from a script is not a gate.
 *
 * Every route here is marked @CliAllowed; everything else refuses a CLI token
 * outright.
 */
@Controller('cli')
@CliAllowed()
export class CliController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly repositories: RepositoriesService,
    private readonly specs: SpecsService,
    private readonly board: BoardService,
  ) {}

  private async scope(slug: string, user: TokenClaims) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer', 'reviewer']);
    return project;
  }

  @Get('projects')
  list(@CurrentUser() user: TokenClaims) {
    return this.projects.listForUser(user.sub);
  }

  /**
   * `specd spec pull <id>` — approved specs only. The refusal happens here,
   * server-side, so no CLI version can route around the gate.
   */
  @Get('projects/:slug/specs/:ref/pull')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  async pull(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @CurrentUser() user: TokenClaims,
  ): Promise<string> {
    const project = await this.scope(slug, user);
    return this.specs.pullMarkdown(project.id, ref);
  }

  /** `specd spec status <id>` — CI-friendly. */
  @Get('projects/:slug/specs/:ref/status')
  async status(
    @Param('slug') slug: string,
    @Param('ref') ref: string,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user);
    return this.specs.statusOf(project.id, ref);
  }

  /** `specd specs list` */
  @Get('projects/:slug/specs')
  async listSpecs(
    @Param('slug') slug: string,
    @Query('status') status: string | undefined,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user);
    const cards = await this.board.cards(project.id);
    return cards
      .filter((c) => c.spec && (!status || c.spec.status === status))
      .map((c) => ({
        key: c.key,
        title: c.title,
        specId: c.spec!.id,
        version: c.spec!.version,
        status: c.spec!.status,
        approvedBy: c.spec!.approvedBy,
        citations: c.spec!.citationCount,
        unverified: c.spec!.unverifiedCount,
      }));
  }

  /** `specd connect` — registers a local repo with the project (P2 surface). */
  @Post('projects/:slug/connect')
  async connect(
    @Param('slug') slug: string,
    @Body() dto: ConnectRepoDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer']);

    const inspected = await this.repositories.inspectLocalPath(dto.path);
    if (!inspected.ok) {
      return { ok: false, reason: inspected.reason };
    }

    const repo = await this.repositories.add({
      projectId: project.id,
      provider: 'local',
      name: dto.name,
      localPath: dto.path,
      defaultBranch: inspected.branch,
      isPrimary: dto.primary === 'true',
    });

    return {
      ok: true,
      repository: { id: repo.id, name: repo.name, isPrimary: repo.isPrimary },
      clean: inspected.clean,
    };
  }
}
