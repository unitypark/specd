import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { and, eq } from 'drizzle-orm';
import { connections, type Db } from '@specd/db';
import { isModelId, type AiMode, type ConnectionKind } from '@specd/shared';
import { DB } from '../db/db.module.js';
import { Vault } from '../common/vault.js';
import { Config } from '../config.js';

export interface ResolvedAiCredential {
  mode: AiMode;
  apiKey: string | null;
  model: string;
}

@Injectable()
export class ConnectionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly vault: Vault,
    private readonly config: Config,
  ) {}

  async list(projectId: string) {
    const rows = await this.db
      .select()
      .from(connections)
      .where(eq(connections.projectId, projectId));

    // Secrets never leave the vault. The UI gets shape, not substance.
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      provider: row.provider,
      label: row.label,
      settings: row.settings,
      status: row.status,
      hasSecret: Boolean(row.encryptedSecret),
      lastValidatedAt: row.lastValidatedAt,
      createdAt: row.createdAt,
    }));
  }

  async upsert(input: {
    projectId: string;
    kind: ConnectionKind;
    provider: string;
    label?: string | null;
    settings?: Record<string, unknown>;
    secret?: string | null;
  }) {
    const [existing] = await this.db
      .select()
      .from(connections)
      .where(and(eq(connections.projectId, input.projectId), eq(connections.kind, input.kind)))
      .limit(1);

    const encryptedSecret = input.secret
      ? this.vault.encrypt(input.secret, `${input.projectId}:${input.kind}`)
      : (existing?.encryptedSecret ?? null);

    const values = {
      projectId: input.projectId,
      kind: input.kind,
      provider: input.provider,
      label: input.label ?? null,
      settings: input.settings ?? existing?.settings ?? {},
      encryptedSecret,
      status: 'connected',
    };

    if (existing) {
      const [row] = await this.db
        .update(connections)
        .set(values)
        .where(eq(connections.id, existing.id))
        .returning();
      return row!;
    }

    const [row] = await this.db.insert(connections).values(values).returning();
    return row!;
  }

  async get(projectId: string, kind: ConnectionKind) {
    const [row] = await this.db
      .select()
      .from(connections)
      .where(and(eq(connections.projectId, projectId), eq(connections.kind, kind)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Resolves the AI credential for a run. Three modes (§P3):
   *   api_key            — BYO key from the vault
   *   subscription_runner— the customer's own runner drives their Claude Code;
   *                        the platform never holds subscription credentials (D2)
   *   managed_cloud      — the platform's key, metered
   */
  async resolveAi(projectId: string, projectDefaultModel: string): Promise<ResolvedAiCredential> {
    const conn = await this.get(projectId, 'ai');
    const settings = (conn?.settings ?? {}) as { mode?: AiMode };
    const mode: AiMode = settings.mode ?? 'managed_cloud';

    // The project owns the model choice — single source of truth. It used to
    // be mirrored onto the connection too, which meant changing it in settings
    // was silently ignored because the stale connection copy won.
    const model = isModelId(projectDefaultModel) ? projectDefaultModel : 'claude-opus-5';

    if (mode === 'subscription_runner') {
      // By construction there is nothing to resolve here — the work happens on
      // the customer's runner, with their credentials, on their machine.
      return { mode, apiKey: null, model };
    }

    if (mode === 'api_key') {
      if (!conn?.encryptedSecret) {
        throw new BadRequestException('No API key stored for this project');
      }
      return {
        mode,
        apiKey: this.vault.decrypt(conn.encryptedSecret, `${projectId}:ai`),
        model,
      };
    }

    return { mode, apiKey: this.config.anthropicApiKey || null, model };
  }

  /** Live validation with a 1-token ping, exactly as the wizard promises. */
  async validateAnthropicKey(apiKey: string): Promise<{ ok: boolean; detail: string }> {
    if (!apiKey.startsWith('sk-ant-')) {
      return { ok: false, detail: 'That does not look like an Anthropic API key.' };
    }
    try {
      const client = new Anthropic({ apiKey });
      await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { ok: true, detail: 'Key valid — models listed.' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: message.slice(0, 200) };
    }
  }

  async remove(projectId: string, kind: ConnectionKind) {
    const conn = await this.get(projectId, kind);
    if (!conn) throw new NotFoundException('Connection not found');
    await this.db.delete(connections).where(eq(connections.id, conn.id));
  }
}
