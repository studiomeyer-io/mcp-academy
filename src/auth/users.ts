/**
 * users.ts — identity for the hosted Academy course server.
 *
 * DELIBERATELY THIN. The Academy website already owns the user table (Prisma
 * `User`, unique `email`, and Google/Discord/GitHub/magic-link all resolve into
 * the same row via email matching). If this server kept its own user table we
 * would have built a second identity silo: someone signing in through the
 * connector would collect progress that their website account never sees.
 *
 * So: we verify the email, and that is all. Account creation stays with the
 * Academy — the REST bridge upserts by email on first write. What lives here is
 * only what OAuth itself needs:
 *
 *   - isValidEmail / normalizeEmail   input hygiene
 *   - getUserByEmail                  "is this a known recipient?" — feeds the
 *                                     magic-link mail budget, which treats
 *                                     strangers far more strictly than customers
 *   - isUserAllowed                   the block list (see below)
 *   - upsertUser / markUserEmailVerified   no-ops, kept so the copied oauth.ts
 *                                     flow reads identically to its reference
 *
 * BLOCK LIST: the reference implementation enforces `suspended` at four points
 * in the flow. The Academy's Prisma `User` has no such column, and adding one
 * would mean a schema migration against the live course database for a field
 * only this server reads. Instead we keep our own tiny table in the same
 * database. Same protection, no migration of somebody else's table.
 */

import { getDb } from "../db.js";

export interface AcademyUser {
  email: string;
  known: boolean;
  suspended: boolean;
}

// Deliberately conservative: one @, no whitespace, a dot in the domain, and a
// length cap so a pathological address cannot become a rate-limit bucket key.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,24}$/;

export function isValidEmail(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length <= 254 && EMAIL_RE.test(raw.trim());
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Looks the address up in the Academy's own user table (read-only) and in our
 * block list. Returns `known: false` rather than throwing when the database is
 * unreachable — the caller uses `known` only to pick the stricter mail budget,
 * and "treat as stranger" is the safe direction to fail in.
 */
export async function getUserByEmail(email: string): Promise<AcademyUser | null> {
  const addr = normalizeEmail(email);
  try {
    const db = getDb();
    const [user, blocked] = await Promise.all([
      db.query('SELECT 1 FROM "User" WHERE lower(email) = $1 LIMIT 1', [addr]),
      db.query("SELECT 1 FROM academy_mcp_blocked WHERE email = $1 LIMIT 1", [addr]),
    ]);
    const known = (user.rowCount ?? 0) > 0;
    const suspended = (blocked.rowCount ?? 0) > 0;
    if (!known && !suspended) return null;
    return { email: addr, known, suspended };
  } catch (e) {
    console.warn(`[academy-oauth] user lookup failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Fail-closed on database errors: if we cannot prove the account is unblocked,
 * we do not let it through. The caller answers 503, not 200.
 */
export async function isUserAllowed(email: string): Promise<boolean> {
  const db = getDb();
  const r = await db.query("SELECT 1 FROM academy_mcp_blocked WHERE email = $1 LIMIT 1", [
    normalizeEmail(email),
  ]);
  return (r.rowCount ?? 0) === 0;
}

/**
 * No-op by design — the Academy creates the account, not us. Kept so the copied
 * authorization flow keeps its original shape (and so a future change of mind
 * has an obvious place to live).
 */
export async function upsertUser(_email: string): Promise<void> {
  /* intentionally empty — see file header */
}

/** No-op: the email was just proven by magic link or by the social provider. */
export async function markUserEmailVerified(_email: string): Promise<void> {
  /* intentionally empty — see file header */
}

/**
 * Social sign-in resolves to an email and nothing else.
 *
 * The reference implementation matches on provider id first, then email, then
 * creates. We deliberately keep only the email step: the Academy already links
 * `googleSub` / `discordId` / `githubId` onto its own `User` row when someone
 * signs in on the website, and it matches by email exactly as we do here. Two
 * systems writing provider links into one row is how you get a hijack window;
 * one writer and one reader is how you avoid it.
 *
 * Consequence worth stating plainly: identity here is the *verified email* the
 * provider hands us. That is the same anchor the website uses, so a person who
 * signs into the connector with Google and into the website with a magic link
 * is one account with one progress record.
 */
export async function findOrCreateUserBySocial(params: {
  provider: string;
  providerId: string;
  email: string;
  displayName?: string | null;
}): Promise<{ user: { email: string }; path: "email" }> {
  const lowered = normalizeEmail(params.email);
  if (!isValidEmail(lowered)) throw new Error(`invalid_email: ${params.email}`);
  return { user: { email: lowered }, path: "email" };
}

/** Best-effort last-seen bookkeeping on the Academy's own row. Never throws. */
export async function touchLastSeen(email: string): Promise<void> {
  try {
    const db = getDb();
    await db.query('UPDATE "User" SET "lastActiveAt" = NOW() WHERE lower(email) = $1', [
      normalizeEmail(email),
    ]);
  } catch {
    /* bookkeeping only */
  }
}
