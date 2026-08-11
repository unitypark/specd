import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { BOARD_COLUMNS, SPEC_STATUSES, type SpecStatus } from '@specd/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { TokenClaims } from '../auth/auth.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { BoardService } from './board.service.js';
import { SpecsService } from '../specs/specs.service.js';
import { PipelineService } from '../agents/pipeline.service.js';

class CreateTicketDto {
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(20_000) body?: string;
  @IsOptional() @IsString() assignee?: string;
}

class UpdateTicketDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(20_000) body?: string;
  @IsOptional() @IsString() assignee?: string;
  @IsOptional() @IsString() columnKey?: string;
}

class TransitionDto {
  @IsIn(SPEC_STATUSES) to!: SpecStatus;
}

class ReorderDto {
  @IsIn(BOARD_COLUMNS.map((c) => c.key)) columnKey!: string;
  @IsArray() @ArrayMaxSize(1_000) @IsUUID('4', { each: true }) ticketIds!: string[];
}

class CommentDto {
  @IsIn(['requirements', 'design', 'tasks']) section!: string;
  @IsOptional() @IsInt() @Min(0) itemIndex?: number;
  @IsString() @MinLength(1) @MaxLength(5_000) body!: string;
}

@Controller('projects/:slug/board')
export class BoardController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly board: BoardService,
    private readonly specs: SpecsService,
    private readonly pipeline: PipelineService,
  ) {}

  private async scope(slug: string, user: TokenClaims, roles = ['owner', 'maintainer', 'reviewer']) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, roles);
    return project;
  }

  @Get()
  async get(@Param('slug') slug: string, @CurrentUser() user: TokenClaims) {
    const project = await this.scope(slug, user);
    return {
      columns: this.board.columns(),
      cards: await this.board.cards(project.id),
    };
  }

  @Post('tickets')
  async createTicket(
    @Param('slug') slug: string,
    @Body() dto: CreateTicketDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user, ['owner', 'maintainer']);
    return this.board.createTicket({
      projectId: project.id,
      keyPrefix: BoardService.keyPrefix(project.name),
      title: dto.title,
      body: dto.body,
      assignee: dto.assignee ?? null,
    });
  }

  /**
   * Rank a lane. Separate from `PATCH tickets/:id` on purpose: reordering is a
   * statement about a whole column, not about one ticket, and expressing it as
   * n patches would let a dropped request leave the lane half-ranked.
   *
   * Scoped like `transition`, not like ticket editing: one drag is a move plus
   * a rank, and a reviewer who is allowed the move but refused the rank would
   * watch half their gesture fail with a 403.
   */
  @Post('reorder')
  async reorder(
    @Param('slug') slug: string,
    @Body() dto: ReorderDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user);
    await this.board.reorder(project.id, dto.columnKey, dto.ticketIds);
    return { ok: true };
  }

  @Get('tickets/:ticketId')
  async getTicket(
    @Param('slug') slug: string,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user);
    const ticket = await this.board.get(project.id, ticketId);
    const spec = await this.specs.latestForTicket(ticket.id);
    const versions = await this.specs.versionsForTicket(ticket.id);
    const comments = spec ? await this.specs.comments(spec.id) : [];
    return { ticket, spec, versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status })), comments };
  }

  @Patch('tickets/:ticketId')
  async updateTicket(
    @Param('slug') slug: string,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: UpdateTicketDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user, ['owner', 'maintainer']);
    return this.board.update(project.id, ticketId, dto);
  }

  @Delete('tickets/:ticketId')
  async removeTicket(
    @Param('slug') slug: string,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user, ['owner', 'maintainer']);
    await this.board.removeTicket(project.id, ticketId);
    return { deleted: true };
  }

  /**
   * "Generate spec" is a deliberate human click on a ticket — never automatic
   * for every ticket (§8 stage 1).
   */
  @Post('tickets/:ticketId/generate-spec')
  async generateSpec(
    @Param('slug') slug: string,
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user, ['owner', 'maintainer']);
    return this.pipeline.generateSpec({
      projectId: project.id,
      ticketId,
      actor: { userId: user.sub, name: user.name },
    });
  }

  @Post('specs/:specId/revise')
  async revise(
    @Param('slug') slug: string,
    @Param('specId', ParseUUIDPipe) specId: string,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user, ['owner', 'maintainer']);
    const previous = await this.specs.byId(project.id, specId);
    return this.pipeline.generateSpec({
      projectId: project.id,
      ticketId: previous.ticketId,
      actor: { userId: user.sub, name: user.name },
      reviseFromSpecId: specId,
    });
  }

  /** Station 05 — hand the approved spec to the hosted build runner. */
  @Post('specs/:specId/build')
  async build(
    @Param('slug') slug: string,
    @Param('specId', ParseUUIDPipe) specId: string,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user, ['owner', 'maintainer']);
    return this.pipeline.runBuild({
      projectId: project.id,
      specId,
      actor: { userId: user.sub, name: user.name },
    });
  }

  @Get('specs/:specId')
  async getSpec(
    @Param('slug') slug: string,
    @Param('specId', ParseUUIDPipe) specId: string,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user);
    const spec = await this.specs.byId(project.id, specId);
    const comments = await this.specs.comments(specId);
    return { spec, comments };
  }

  /**
   * The gate. `to: 'approved'` records who stamped it, at which version, and
   * when — and only ever from a signed-in human's request.
   */
  @Post('specs/:specId/transition')
  async transition(
    @Param('slug') slug: string,
    @Param('specId', ParseUUIDPipe) specId: string,
    @Body() dto: TransitionDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user);
    return this.specs.transition({
      projectId: project.id,
      specId,
      to: dto.to,
      actor: { userId: user.sub, name: user.name },
    });
  }

  @Post('specs/:specId/comments')
  async comment(
    @Param('slug') slug: string,
    @Param('specId', ParseUUIDPipe) specId: string,
    @Body() dto: CommentDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user);
    const spec = await this.specs.byId(project.id, specId);
    return this.specs.addComment({
      specId,
      specStatus: spec.status,
      section: dto.section,
      itemIndex: dto.itemIndex,
      authorUserId: user.sub,
      authorName: user.name,
      body: dto.body,
    });
  }
}
