import { Injectable } from '@nestjs/common';
import type { AiMode } from '@specd/shared';
import { RunnersService } from '../runners/runners.service.js';
import { AnthropicService, type ModelCallOptions, type ModelCallResult } from './anthropic.service.js';
import { ClaudeCodeProvider } from './claude-code.provider.js';

/**
 * Chooses how a model call is made. Three modes (§P3), and the difference
 * between them is not cosmetic:
 *
 *   api_key / managed_cloud → Messages API. Schema-enforced output, streamed,
 *                             billed per token, works from anywhere.
 *   subscription_runner     → the local Claude Code CLI, on this machine, with
 *                             the user's own auth (D2). No schema guarantee,
 *                             no per-call billing, and only possible where
 *                             specd runs beside the user.
 *
 * Every agent goes through here, so the mode is decided once and metering
 * cannot be forgotten in a new agent.
 */
@Injectable()
export class ModelRouter {
  constructor(
    private readonly api: AnthropicService,
    private readonly claudeCode: ClaudeCodeProvider,
    private readonly runners: RunnersService,
  ) {}

  async call<T = unknown>(
    mode: AiMode,
    opts: ModelCallOptions,
  ): Promise<ModelCallResult<T> & { billable: boolean }> {
    if (mode === 'subscription_runner') {
      const result = await this.claudeCode.call<T>(opts);
      // Runs consume subscription quota, not euros. Recording an API list
      // price here would show the user money they were never charged.
      return { ...result, billable: false };
    }

    const result = await this.api.call<T>(opts);
    return { ...result, billable: true };
  }

  /**
   * Preflight: can subscription mode actually run for this project? Two
   * independent ways to say yes — local Claude Code on this machine (true for
   * a single-machine dev setup, never true for a genuinely hosted deployment),
   * or a runner already paired to `projectId` (the only way a hosted specd,
   * with no local `claude` of its own, can offer this mode at all). `projectId`
   * is optional because the wizard's very first AI-mode preflight
   * (`GET /projects/ai-modes`) runs before a project exists to pair a runner
   * against — that call can only ever see the local-machine answer.
   */
  async describeMode(mode: AiMode, projectId?: string): Promise<{ ok: boolean; detail: string }> {
    if (mode !== 'subscription_runner') {
      return { ok: true, detail: 'Uses the Messages API.' };
    }

    const pairedRunner = projectId ? await this.runners.pickPaired(projectId) : null;
    if (pairedRunner) {
      return {
        ok: true,
        detail: `Will dispatch to your paired runner "${pairedRunner.name}", which drives its own local Claude Code. No credential is stored by specd.`,
      };
    }

    const available = await this.claudeCode.isAvailable();
    if (!available) {
      return {
        ok: false,
        detail: projectId
          ? 'No runner is paired to this project, and the Claude Code CLI is not on this ' +
            'machine’s PATH either. Pair a runner in Settings, or pick another mode.'
          : 'The Claude Code CLI is not on this machine’s PATH. Subscription mode runs `claude` ' +
            'locally with your own login — install it and sign in, or pick another mode.',
      };
    }
    const version = await this.claudeCode.version();
    return {
      ok: true,
      detail: `Will drive the local Claude Code${version ? ` (${version})` : ''} with your own login. No credential is stored by specd.`,
    };
  }
}
