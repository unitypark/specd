import { Body, Controller, Get, Header, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { citationRef } from '@specd/shared';
import { CliAllowed } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { TokenClaims } from '../auth/auth.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { RepositoriesService } from '../projects/repositories.service.js';
import { SpecsService } from '../specs/specs.service.js';
import { BoardService } from '../board/board.service.js';
import { KnowledgeService } from '../knowledge/knowledge.service.js';

class ConnectRepoDto {
  @IsString() path!: string;
  @IsString() name!: string;
  @IsOptional() @IsIn(['true', 'false']) primary?: string;
}

class SearchDto {
  @IsString() @MinLength(2) q!: string;
  /**
   * Bounded here as well as in retrieval. An agent asking for 500 chunks is
   * asking for the whole knowledge base, which is the request the three-stage
   * budget exists to refuse.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30) limit?: number;
}

class DocPathDto {
  @IsString() @MinLength(1) path!: string;
}

class CitationDto {
  @IsString() @MinLength(1) citation!: string;
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
    private readonly knowledge: KnowledgeService,
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

  /**
   * The knowledge engine, for an agent working in an editor (0017).
   *
   * These four routes serve what the SpecAgent already sees — the same three
   * retrieval stages, the same coverage, the same verdicts — because an agent
   * that has to re-derive the codebase by grepping is the problem the
   * knowledge base was built to solve, and it cannot use what it cannot reach.
   *
   * They are reads. That is not a convention here, it is the class decorator:
   * `@CliAllowed` is what lets a CLI-audience token through at all, and
   * nothing that mutates may be added under it.
   */
  @Get('projects/:slug/knowledge/search')
  async search(
    @Param('slug') slug: string,
    @Query() dto: SearchDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user);
    const result = await this.knowledge.retrieve(project.id, dto.q, dto.limit ?? 12);
    return {
      chunks: result.chunks.map((chunk) => ({
        // The string a design claim would cite. Handing back the chunk without
        // it makes every caller re-implement `citationRef`, and a citation
        // assembled by hand is a citation that fails its own verification.
        citeAs: citationRef(chunk),
        repoName: chunk.repoName,
        path: chunk.path,
        heading: chunk.heading,
        text: chunk.text,
        score: chunk.score,
        via: chunk.via,
        viaEdge: chunk.viaEdge ?? null,
        viaEdgeId: chunk.viaEdgeId ?? null,
      })),
      matchedCount: result.matchedCount,
      // Announced, not hidden: a cut that reads as an absence is how an agent
      // concludes the knowledge base has nothing to say (S-102).
      truncatedCount: result.truncatedCount,
    };
  }

  @Get('projects/:slug/knowledge/doc')
  async doc(
    @Param('slug') slug: string,
    @Query() dto: DocPathDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user);
    const doc = await this.knowledge.getDocByPath(project.id, dto.path);
    if (!doc) throw new NotFoundException(`No indexed knowledge doc at "${dto.path}"`);
    const links = await this.knowledge.docLinks(project.id, doc.id);
    return {
      path: doc.path,
      kind: doc.kind,
      title: doc.title,
      content: doc.content,
      hasUnverified: doc.hasUnverified,
      isStub: doc.isStub,
      docUpdatedAt: doc.docUpdatedAt,
      indexedAt: doc.indexedAt,
      ...links,
    };
  }

  @Get('projects/:slug/knowledge/verify')
  async verify(
    @Param('slug') slug: string,
    @Query() dto: CitationDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user);
    return this.knowledge.verifyCitation(project.id, dto.citation);
  }

  @Get('projects/:slug/knowledge/health')
  async knowledgeHealth(@Param('slug') slug: string, @CurrentUser() user: TokenClaims) {
    const project = await this.scope(slug, user);
    return this.knowledge.health(project.id);
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
