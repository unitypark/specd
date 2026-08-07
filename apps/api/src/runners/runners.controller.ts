import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Public } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { TokenClaims } from '../auth/auth.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { RunnersService } from './runners.service.js';

class CreateRunnerDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
}

class PairRunnerDto {
  @IsString() @MinLength(1) @MaxLength(32) pairCode!: string;
}

/**
 * Self-hosted runner pairing (§9). Two audiences, kept visibly apart exactly
 * as `GitHubController` and `GitLabController` split "the routes a human
 * calls" from "the route the outside world calls" — here it is a signed-in
 * project member generating and revoking pairing codes, versus the runner
 * itself, which is never a signed-in user and authenticates with its own
 * bearer token instead.
 */
@Controller()
export class RunnersController {
  constructor(
    private readonly runners: RunnersService,
    private readonly projects: ProjectsService,
  ) {}

  // ─── the routes a human calls ──────────────────────────────────────────────

  @Post('projects/:slug/runners')
  async create(
    @Param('slug') slug: string,
    @Body() dto: CreateRunnerDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer']);
    return this.runners.createPairing(project.id, dto.name);
  }

  @Get('projects/:slug/runners')
  async list(@Param('slug') slug: string, @CurrentUser() user: TokenClaims) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer', 'reviewer']);
    return this.runners.list(project.id);
  }

  @Delete('projects/:slug/runners/:id')
  async remove(
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer']);
    await this.runners.remove(project.id, id);
    return { ok: true };
  }

  // ─── the routes a runner calls ─────────────────────────────────────────────

  /**
   * The runner's half of the handshake. Public because a runner is not a
   * signed-in user and has no session to present — the pairing code, minted
   * by a project member a moment ago, is the credential that proves it is
   * allowed to be here at all.
   */
  @Public()
  @Post('runners/pair')
  async pair(@Body() dto: PairRunnerDto) {
    const result = await this.runners.pair(dto.pairCode);
    return {
      token: result.token,
      runnerId: result.runnerId,
      project: result.projectSlug,
    };
  }

  /**
   * Liveness. Also public at the route level — a runner's bearer token is
   * verified here, not by the user-facing `AuthGuard`, which knows nothing
   * about runner tokens at all.
   */
  @Public()
  @Post('runners/heartbeat')
  async heartbeat(@Headers('authorization') authorization: string | undefined) {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Missing bearer token');
    const runner = await this.runners.authenticate(token);
    return { ok: true, name: runner.name };
  }
}
