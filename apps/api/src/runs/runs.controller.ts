import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  Sse,
} from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { formatEurCents, type RunLogLine } from '@specd/shared';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { TokenClaims } from '../auth/auth.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { RunsService } from './runs.service.js';
import { PipelineService } from '../agents/pipeline.service.js';

class OnboardDto {
  @IsArray() @IsString({ each: true }) repositoryIds!: string[];
}

class ReindexDto {
  @IsOptional() @IsArray() @IsString({ each: true }) repositoryIds?: string[];
}

@Controller('projects/:slug')
export class RunsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly runs: RunsService,
    private readonly pipeline: PipelineService,
  ) {}

  private async scope(slug: string, user: TokenClaims, roles = ['owner', 'maintainer', 'reviewer']) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, roles);
    return project;
  }

  @Get('runs')
  async list(@Param('slug') slug: string, @CurrentUser() user: TokenClaims) {
    const project = await this.scope(slug, user);
    const runs = await this.runs.list(project.id);
    const spent = await this.projects.monthlySpendCents(project.id);

    return {
      spend: {
        spentCents: spent,
        capCents: project.spendCapCents,
        display: `${formatEurCents(spent)} of ${formatEurCents(project.spendCapCents)}`,
        paused: project.agentsPaused,
      },
      runs: runs.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        model: r.model,
        runner: r.runner,
        triggeredBy: r.triggeredByName,
        costCents: r.costCents,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        error: r.error,
        durationMs:
          r.startedAt && r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
      })),
    };
  }

  @Get('runs/:runId')
  async get(
    @Param('slug') slug: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user);
    const run = await this.runs.get(project.id, runId);
    const logs = await this.runs.logs(runId);
    return { run, logs };
  }

  /**
   * Live run log. Replays everything already written, then follows — so a
   * viewer that opens mid-run still sees the whole story.
   */
  @Sse('runs/:runId/stream')
  async stream(
    @Param('slug') slug: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CurrentUser() user: TokenClaims,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Observable<{ data: string }>> {
    const project = await this.scope(slug, user);
    const run = await this.runs.get(project.id, runId);
    const history = await this.runs.logs(runId);

    res.setHeader('X-Accel-Buffering', 'no');

    return new Observable<{ data: string }>((subscriber) => {
      const emit = (line: RunLogLine) => subscriber.next({ data: JSON.stringify(line) });
      for (const line of history) emit(line);

      if (run.status !== 'running' && run.status !== 'queued') {
        subscriber.next({ data: JSON.stringify({ type: 'end', status: run.status }) });
        subscriber.complete();
        return;
      }

      const unsubscribe = this.runs.subscribe(
        runId,
        emit,
        (status) => {
          subscriber.next({ data: JSON.stringify({ type: 'end', status }) });
          subscriber.complete();
        },
      );

      return () => unsubscribe();
    });
  }

  /** Station 02 — open the setup PRs. */
  @Post('onboard')
  async onboard(
    @Param('slug') slug: string,
    @Body() dto: OnboardDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user, ['owner', 'maintainer']);
    return this.pipeline.runOnboarding({
      projectId: project.id,
      repositoryIds: dto.repositoryIds,
      actor: { userId: user.sub, name: user.name },
    });
  }

  /** Station 06 — Learn. Also runs automatically on merge. */
  @Post('reindex')
  async reindex(
    @Param('slug') slug: string,
    @Body() dto: ReindexDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.scope(slug, user, ['owner', 'maintainer']);
    return this.pipeline.enqueueReindex({
      projectId: project.id,
      repositoryIds: dto.repositoryIds,
      actor: { userId: user.sub, name: user.name },
    });
  }
}
