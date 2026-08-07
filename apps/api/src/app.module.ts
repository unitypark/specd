import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Config } from './config.js';
import { DbModule } from './db/db.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AuthGuard } from './auth/auth.guard.js';
import { Vault } from './common/vault.js';
import { HealthController } from './health.controller.js';

import { ProjectsService } from './projects/projects.service.js';
import { ProjectsController } from './projects/projects.controller.js';
import { RepositoriesService } from './projects/repositories.service.js';
import { ConnectionsService } from './projects/connections.service.js';

import { LocalGitAdapter } from './vcs/local-git.adapter.js';
import { VcsService } from './vcs/vcs.service.js';
import { GitHubAppService } from './vcs/github-app.service.js';
import { GitHubWebhookService } from './vcs/github-webhook.service.js';
import { GitHubController } from './vcs/github.controller.js';
import { GitLabWebhookService } from './vcs/gitlab-webhook.service.js';
import { GitLabController } from './vcs/gitlab.controller.js';

import { EmbeddingService } from './knowledge/embeddings.js';
import { KnowledgeService } from './knowledge/knowledge.service.js';

import { BoardService } from './board/board.service.js';
import { BoardController } from './board/board.controller.js';
import { SpecsService } from './specs/specs.service.js';

import { RunsService } from './runs/runs.service.js';
import { RunsController } from './runs/runs.controller.js';

import { AnthropicService } from './agents/anthropic.service.js';
import { ClaudeCodeProvider } from './agents/claude-code.provider.js';
import { ModelRouter } from './agents/model.router.js';
import { OnboardingAgent } from './agents/onboarding.agent.js';
import { SpecAgent } from './agents/spec.agent.js';
import { BuildAgent } from './agents/build.agent.js';
import { WorkspaceService } from './vcs/workspace.js';
import { PipelineService } from './agents/pipeline.service.js';

import { CliController } from './cli/cli.controller.js';

/**
 * One module. The system is small enough that splitting it into a dozen
 * feature modules would add ceremony without adding a boundary anyone
 * enforces — the real boundaries here are the adapter interfaces (VcsAdapter,
 * EmbeddingProvider), not Nest modules.
 */
@Module({
  imports: [DbModule, AuthModule],
  controllers: [
    HealthController,
    ProjectsController,
    BoardController,
    RunsController,
    CliController,
    GitHubController,
    GitLabController,
  ],
  providers: [
    Config,
    Vault,
    ProjectsService,
    RepositoriesService,
    ConnectionsService,
    LocalGitAdapter,
    VcsService,
    GitHubAppService,
    GitHubWebhookService,
    GitLabWebhookService,
    EmbeddingService,
    KnowledgeService,
    BoardService,
    SpecsService,
    RunsService,
    AnthropicService,
    ClaudeCodeProvider,
    ModelRouter,
    OnboardingAgent,
    SpecAgent,
    BuildAgent,
    WorkspaceService,
    PipelineService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
