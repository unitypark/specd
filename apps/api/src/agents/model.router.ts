import { Injectable } from '@nestjs/common';
import type { AiMode } from '@specd/shared';
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

  /** Preflight for the wizard: can this machine actually run subscription mode? */
  async describeMode(mode: AiMode): Promise<{ ok: boolean; detail: string }> {
    if (mode !== 'subscription_runner') {
      return { ok: true, detail: 'Uses the Messages API.' };
    }
    const available = await this.claudeCode.isAvailable();
    if (!available) {
      return {
        ok: false,
        detail:
          'The Claude Code CLI is not on this machine’s PATH. Subscription mode runs `claude` ' +
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
