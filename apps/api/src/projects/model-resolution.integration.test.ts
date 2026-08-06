import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connections, createDb, projects, type DbHandle } from '@specd/db';
import { ConnectionsService } from './connections.service.js';
import { Vault } from '../common/vault.js';
import { Config } from '../config.js';

/**
 * Model resolution, against a real database.
 *
 * The model used to be stored twice — on the project and mirrored onto the AI
 * connection — and the connection copy won. Changing the model in project
 * settings was therefore silently ignored. These tests pin the fix: the
 * project is the single source of truth, and a legacy mirror is inert.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://specd:specd@localhost:5433/specd';

let handle: DbHandle | null = null;
let service: ConnectionsService;
let projectId = '';

const reachable = await (async () => {
  try {
    const probe = createDb(DATABASE_URL, { max: 1 });
    await probe.sql`SELECT 1`;
    await probe.close();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!reachable)('AI model resolution (integration)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.JWT_SECRET ??= 'test';
    process.env.VAULT_MASTER_KEY = Buffer.alloc(32, 3).toString('base64');

    handle = createDb(DATABASE_URL, { max: 2 });
    const config = new Config();
    service = new ConnectionsService(handle.db, new Vault(config), config);

    const [project] = await handle.db
      .insert(projects)
      .values({ slug: `model-${Date.now()}`, name: 'Model Test', defaultModel: 'claude-opus-5' })
      .returning();
    projectId = project!.id;

    await service.upsert({
      projectId,
      kind: 'ai',
      provider: 'anthropic',
      settings: { mode: 'subscription_runner' },
    });
  });

  afterAll(async () => {
    if (handle) {
      if (projectId) await handle.db.delete(projects).where(eq(projects.id, projectId));
      await handle.close();
    }
  });

  it('uses the project’s model', async () => {
    const resolved = await service.resolveAi(projectId, 'claude-opus-5');
    expect(resolved.model).toBe('claude-opus-5');
    expect(resolved.mode).toBe('subscription_runner');
  });

  it('follows the project when the model changes', async () => {
    // The bug: this returned the stale connection copy forever.
    const resolved = await service.resolveAi(projectId, 'claude-haiku-4-5');
    expect(resolved.model).toBe('claude-haiku-4-5');
  });

  it('ignores a legacy model mirrored onto the connection', async () => {
    // Simulate a row written before the fix.
    await handle!.sql`
      UPDATE connections
      SET settings = settings || '{"model":"claude-haiku-4-5"}'::jsonb
      WHERE project_id = ${projectId} AND kind = 'ai'
    `;

    const resolved = await service.resolveAi(projectId, 'claude-opus-5');
    expect(resolved.model).toBe('claude-opus-5');
  });

  it('does not write a model onto the connection', async () => {
    await service.upsert({
      projectId,
      kind: 'ai',
      provider: 'anthropic',
      settings: { mode: 'api_key' },
    });

    const [row] = await handle!.db
      .select({ settings: connections.settings })
      .from(connections)
      .where(eq(connections.projectId, projectId))
      .limit(1);

    expect(row?.settings).not.toHaveProperty('model');
  });

  it('falls back to a valid model when the project holds nonsense', async () => {
    // Set the mode explicitly: api_key mode refuses without a stored key, and
    // that refusal would mask what this test is actually about.
    await service.upsert({
      projectId,
      kind: 'ai',
      provider: 'anthropic',
      settings: { mode: 'subscription_runner' },
    });

    const resolved = await service.resolveAi(projectId, 'gpt-4');
    expect(resolved.model).toBe('claude-opus-5');
  });

  it('never resolves a credential for subscription mode', async () => {
    await service.upsert({
      projectId,
      kind: 'ai',
      provider: 'anthropic',
      settings: { mode: 'subscription_runner' },
    });
    const resolved = await service.resolveAi(projectId, 'claude-sonnet-5');
    // D2: the platform holds no subscription credential, by construction.
    expect(resolved.apiKey).toBeNull();
  });

  it('refuses api_key mode with no stored key rather than running anyway', async () => {
    await service.upsert({
      projectId,
      kind: 'ai',
      provider: 'anthropic',
      settings: { mode: 'api_key' },
    });
    await expect(service.resolveAi(projectId, 'claude-opus-5')).rejects.toThrow(/No API key/);
  });
});
