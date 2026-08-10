import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { TokenClaims } from '../auth/auth.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { BoardService } from '../board/board.service.js';
import { TrackerService } from './tracker.service.js';

class ImportIssuesDto {
  /** Defaults to the project key stored on the connection. */
  @IsOptional() @IsString() projectKey?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) limit?: number;
}

/**
 * The Jira half of the tracker connection.
 *
 * Reading Jira (projects, issues) is a deliberate action a person takes in the
 * app, so it lives on its own routes rather than happening implicitly. Writing
 * *to* Jira is not here at all — that happens as a side effect of spec
 * lifecycle events, best-effort, in `TrackerService`.
 */
@Controller('projects/:slug/tracker')
export class TrackerController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly tracker: TrackerService,
    private readonly board: BoardService,
  ) {}

  /** Jira projects this credential can see — the picker for `projectKey`. */
  @Get('jira/projects')
  async jiraProjects(@Param('slug') slug: string, @CurrentUser() user: TokenClaims) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer']);

    const { jira } = await this.tracker.requireJira(project.id);
    return { projects: await jira.listProjects() };
  }

  /** Open issues, without importing them — so a person can see what they would get. */
  @Get('jira/issues')
  async jiraIssues(@Param('slug') slug: string, @CurrentUser() user: TokenClaims) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer', 'reviewer']);

    const { jira, settings } = await this.tracker.requireJira(project.id);
    if (!settings.projectKey) {
      return { issues: [], detail: 'No Jira project key is set on this connection.' };
    }
    return { issues: await jira.listOpenIssues(settings.projectKey) };
  }

  @Post('jira/import')
  async importIssues(
    @Param('slug') slug: string,
    @Body() dto: ImportIssuesDto,
    @CurrentUser() user: TokenClaims,
  ) {
    const project = await this.projects.bySlug(slug);
    await this.projects.requireRole(user.sub, project.id, ['owner', 'maintainer']);

    const { jira, settings } = await this.tracker.requireJira(project.id);
    const key = dto.projectKey ?? settings.projectKey;
    if (!key) {
      return { imported: 0, updated: 0, detail: 'No Jira project key given or stored.' };
    }

    const issues = await jira.listOpenIssues(key, dto.limit ?? 50);
    const result = await this.board.importExternal({
      projectId: project.id,
      source: 'jira',
      issues,
    });

    return { ...result, seen: issues.length };
  }
}
