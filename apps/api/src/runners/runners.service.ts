import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { projects, runners, type Db, type Runner } from '@specd/db';
import { DB } from '../db/db.module.js';

/**
 * Self-hosted runner pairing (§9, D1/D2's other half). A runner is a machine,
 * not a user — it presents a short pairing code shown once in the wizard,
 * exactly the shape `specd login`'s device flow already established for a
 * different audience (a human at a browser vs. a headless process), and gets
 * back a long-lived bearer token in return.
 *
 * The token is a high-entropy random value, not a password a person chose, so
 * it is hashed with a fast, one-way digest rather than scrypt — there is
 * nothing to slow an attacker down that 256 bits of randomness does not
 * already provide, and scrypt on every single job-poll request would be pure
 * cost for no benefit. `Vault` (AES envelope encryption) is the wrong tool
 * here too: this value is never decrypted, only compared.
 */
@Injectable()
export class RunnersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(projectId: string) {
    const rows = await this.db.select().from(runners).where(eq(runners.projectId, projectId));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      paired: Boolean(r.pairedAt),
      pairedAt: r.pairedAt,
      lastSeenAt: r.lastSeenAt,
      // The code is shown once, at creation, and never again — a runner row
      // still awaiting pairing says so rather than re-displaying the code, so
      // a stale browser tab cannot leak it after it has scrolled off screen.
      pending: !r.pairedAt,
    }));
  }

  /** Create a pairing code. Shown once — the caller must copy it now. */
  async createPairing(projectId: string, name: string) {
    const pairCode = formatPairCode(randomBytes(5));
    const [row] = await this.db
      .insert(runners)
      .values({ projectId, name, pairCode })
      .returning();
    if (!row) throw new Error('failed to create runner');
    return { id: row.id, name: row.name, pairCode: row.pairCode };
  }

  async remove(projectId: string, runnerId: string): Promise<void> {
    const [row] = await this.db
      .delete(runners)
      .where(and(eq(runners.id, runnerId), eq(runners.projectId, projectId)))
      .returning({ id: runners.id });
    if (!row) throw new NotFoundException('Runner not found');
  }

  /**
   * The runner presents the code once; a token comes back once. Pairing
   * codes expire after 30 minutes — long enough to `docker pull` and start
   * the container, short enough that a code copied into a chat log or a
   * screenshot is not still live days later. There is no separate
   * `expiresAt` column: the window is computed from `createdAt`, which is
   * enough for a value nobody is meant to reuse anyway.
   */
  async pair(
    pairCode: string,
  ): Promise<{ token: string; runnerId: string; projectId: string; projectSlug: string; name: string }> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);

    const [row] = await this.db
      .update(runners)
      .set({ pairedAt: new Date(), lastSeenAt: new Date(), tokenHash })
      .where(
        and(
          eq(runners.pairCode, pairCode.toUpperCase()),
          sql`${runners.pairedAt} IS NULL`,
          gt(runners.createdAt, cutoff),
        ),
      )
      .returning();

    if (!row) {
      throw new UnauthorizedException('That pairing code is unknown, already used, or expired');
    }

    const [project] = await this.db
      .select({ slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, row.projectId))
      .limit(1);

    return {
      token,
      runnerId: row.id,
      projectId: row.projectId,
      projectSlug: project?.slug ?? '',
      name: row.name,
    };
  }

  /** Verify a runner's bearer token and record that it is alive. */
  async authenticate(token: string): Promise<Runner> {
    const tokenHash = hashToken(token);
    const [row] = await this.db
      .select()
      .from(runners)
      .where(eq(runners.tokenHash, tokenHash))
      .limit(1);
    if (!row) throw new UnauthorizedException('Invalid or revoked runner token');

    await this.db.update(runners).set({ lastSeenAt: new Date() }).where(eq(runners.id, row.id));
    return row;
  }

  /**
   * Is there a runner worth dispatching to for this project? The most
   * recently paired one, on the theory that whoever paired last is most
   * likely still around — there is no liveness threshold here (a runner that
   * has never polled since pairing is still "available" in this sense; a
   * queued job simply waits). Job dispatch is what actually tests whether a
   * runner is alive; this is only ever asked "should a job be queued at all."
   */
  async pickPaired(projectId: string): Promise<Runner | null> {
    const [row] = await this.db
      .select()
      .from(runners)
      .where(and(eq(runners.projectId, projectId), sql`${runners.pairedAt} IS NOT NULL`))
      .orderBy(desc(runners.pairedAt))
      .limit(1);
    return row ?? null;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** XKF49-TR2QY — same unambiguous alphabet as the CLI's device-flow user code. */
function formatPairCode(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const b of bytes) {
    out += alphabet[b % alphabet.length];
    out += alphabet[(b >> 3) % alphabet.length];
  }
  return `${out.slice(0, 5)}-${out.slice(5, 10)}`;
}
