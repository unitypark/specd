import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import { deviceCodes, memberships, users, type Db } from '@specd/db';
import { Config } from '../config.js';
import { DB } from '../db/db.module.js';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

/** What a CLI token may do — deliberately narrow (D13: thin client). */
export interface TokenClaims {
  sub: string;
  email: string;
  name: string;
  /** 'web' can do everything the user can; 'cli' is read + report only. */
  aud: 'web' | 'cli';
}

@Injectable()
export class AuthService {
  private readonly secret: Uint8Array;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly config: Config,
  ) {
    this.secret = new TextEncoder().encode(config.jwtSecret);
  }

  async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await scrypt(password, salt, 64);
    return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
  }

  async verifyPassword(password: string, stored: string): Promise<boolean> {
    const [scheme, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  async register(input: { email: string; name: string; password: string }): Promise<AuthUser> {
    const passwordHash = await this.hashPassword(input.password);
    const [row] = await this.db
      .insert(users)
      .values({ email: input.email, name: input.name, passwordHash })
      .returning({ id: users.id, email: users.email, name: users.name });
    if (!row) throw new Error('failed to create user');
    return row;
  }

  async login(email: string, password: string): Promise<AuthUser> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`)
      .limit(1);
    if (!row || !(await this.verifyPassword(password, row.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return { id: row.id, email: row.email, name: row.name };
  }

  async issueToken(user: AuthUser, audience: 'web' | 'cli', ttl: string): Promise<string> {
    return new SignJWT({ email: user.email, name: user.name })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(ttl)
      .sign(this.secret);
  }

  async verifyToken(token: string): Promise<TokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secret);
      const aud = payload.aud === 'cli' ? 'cli' : 'web';
      return {
        sub: String(payload.sub),
        email: String(payload.email ?? ''),
        name: String(payload.name ?? ''),
        aud,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /** Membership check — every project-scoped route runs through this. */
  async assertMember(userId: string, projectId: string): Promise<string> {
    const [row] = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.projectId, projectId)))
      .limit(1);
    if (!row) throw new UnauthorizedException('Not a member of this project');
    return row.role;
  }

  // ─── CLI device-code flow (§9) ──────────────────────────────────────────────
  // The CLI never sees a password. It gets a short-lived, audience-scoped token
  // only after a human confirms in the browser.

  async startDeviceFlow(): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  }> {
    const deviceCode = randomBytes(32).toString('base64url');
    const userCode = formatUserCode(randomBytes(4));
    const expiresIn = 600;

    await this.db.insert(deviceCodes).values({
      deviceCode,
      userCode,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    });

    return {
      deviceCode,
      userCode,
      verificationUri: `${this.config.webOrigin}/cli-login`,
      expiresIn,
      interval: 3,
    };
  }

  async approveDeviceCode(userCode: string, user: AuthUser): Promise<void> {
    const token = await this.issueToken(user, 'cli', '30d');
    const result = await this.db
      .update(deviceCodes)
      .set({ status: 'approved', userId: user.id, issuedToken: token })
      .where(
        and(
          eq(deviceCodes.userCode, userCode.toUpperCase()),
          eq(deviceCodes.status, 'pending'),
          gt(deviceCodes.expiresAt, new Date()),
        ),
      )
      .returning({ id: deviceCodes.id });
    if (result.length === 0) {
      throw new UnauthorizedException('That code is unknown, already used, or expired');
    }
  }

  /** Polled by the CLI. Returns null while the human has not confirmed yet. */
  async pollDeviceCode(deviceCode: string): Promise<{ token: string } | null> {
    const [row] = await this.db
      .select()
      .from(deviceCodes)
      .where(eq(deviceCodes.deviceCode, deviceCode))
      .limit(1);

    if (!row) throw new UnauthorizedException('Unknown device code');
    if (row.expiresAt < new Date()) throw new UnauthorizedException('Device code expired');
    if (row.status !== 'approved' || !row.issuedToken) return null;

    // Single use: burn it so a leaked poll response cannot be replayed.
    await this.db
      .update(deviceCodes)
      .set({ status: 'consumed', issuedToken: null })
      .where(eq(deviceCodes.id, row.id));

    return { token: row.issuedToken };
  }

  async userById(id: string): Promise<AuthUser | null> {
    const [row] = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return row ?? null;
  }
}

/** XKF4-9TR2 — unambiguous alphabet, no 0/O/1/I. */
function formatUserCode(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const b of bytes) {
    out += alphabet[b % alphabet.length];
    out += alphabet[(b >> 3) % alphabet.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

export function newId(): string {
  return randomUUID();
}
