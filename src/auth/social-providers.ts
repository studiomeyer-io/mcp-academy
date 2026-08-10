/**
 * Social-Login providers — Google + Discord.
 *
 * GitHub bleibt bewusst draussen (Matthias-Entscheidung S1109): eine
 * OAuth-App pro Domain ist zu viel Reibung, kaum Conversion-Lift ueber
 * Google+Discord. Magic-Link Email bleibt der universelle Fallback.
 *
 * Provider-State wird in `academy_mcp_oauth_provider_states` persistiert, damit
 * ein Server-Restart waehrend des Redirect-Roundtrips ueberlebt wird. Die
 * originale Client-PKCE-Challenge liegt in der Row, so dass wir nach dem
 * Callback einen auth_code an dieselbe PKCE-Kette binden koennen.
 */

import { randomBytes } from "node:crypto";
import { getDb } from "../db.js";
import { safeFetchPublic } from "./safe-fetch.js";
import { isValidEmail, normalizeEmail } from "./users.js";

export type Provider = "google" | "discord";

export const PROVIDERS: readonly Provider[] = ["google", "discord"] as const;

export interface ProviderProfile {
  /** Stable provider-side identifier (Google `sub`, Discord `id`). */
  providerId: string;
  email: string;
  displayName: string | null;
}

interface ProviderConfig {
  authorize_url: string;
  token_url: string;
  userinfo_url: string;
  scope: string;
  /** Extra query params merged into the authorize URL. */
  extra_authorize_params?: Record<string, string>;
}

const CONFIG: Record<Provider, ProviderConfig> = {
  google: {
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    userinfo_url: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid email profile",
    // `prompt=select_account` erzwingt den Account-Picker — sonst werden
    // Multi-Account-Haushalte still auf den falschen Account geleitet.
    extra_authorize_params: { prompt: "select_account" },
  },
  discord: {
    authorize_url: "https://discord.com/oauth2/authorize",
    token_url: "https://discord.com/api/oauth2/token",
    userinfo_url: "https://discord.com/api/users/@me",
    scope: "identify email",
  },
};

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — same as magic-link

/** True wenn die Env-Vars fuer diesen Provider konfiguriert sind. */
export function isProviderEnabled(provider: Provider): boolean {
  const id = process.env[`${provider.toUpperCase()}_CLIENT_ID`];
  const secret = process.env[`${provider.toUpperCase()}_CLIENT_SECRET`];
  return Boolean(id && secret);
}

/** Liste der aktiven Provider — steuert das Rendern der Login-Buttons. */
export function enabledProviders(): Provider[] {
  return PROVIDERS.filter(isProviderEnabled);
}

export function getClientCredentials(provider: Provider): { client_id: string; client_secret: string } {
  const client_id = process.env[`${provider.toUpperCase()}_CLIENT_ID`] || "";
  const client_secret = process.env[`${provider.toUpperCase()}_CLIENT_SECRET`] || "";
  if (!client_id || !client_secret) {
    throw new Error(`provider_not_configured: ${provider}`);
  }
  return { client_id, client_secret };
}

export function callbackUrl(baseUrl: string, provider: Provider): string {
  return `${baseUrl.replace(/\/$/, "")}/authorize/${provider}/callback`;
}

/**
 * Persist a one-time state row for the redirect roundtrip.
 * Returns the random `state` value to put in the provider authorize URL.
 */
export async function createProviderState(opts: {
  provider: Provider;
  client_id: string;
  redirect_uri: string;
  pkce_challenge: string;
  client_state: string | null;
}): Promise<string> {
  const state = `sk_${randomBytes(24).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);
  await getDb().query(
    `INSERT INTO academy_mcp_oauth_provider_states
       (state, provider, client_id, redirect_uri, pkce_challenge, client_state, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [state, opts.provider, opts.client_id, opts.redirect_uri, opts.pkce_challenge, opts.client_state, expiresAt],
  );
  return state;
}

export interface ConsumedProviderState {
  provider: Provider;
  client_id: string;
  redirect_uri: string;
  pkce_challenge: string;
  client_state: string | null;
}

/**
 * Atomically claim a provider state row. Returns null when the row is
 * missing, expired or already used. Guarded UPDATE mit RETURNING — zwei
 * parallele Callbacks (Doppelklick) koennen nicht beide gewinnen.
 */
export async function consumeProviderState(state: string): Promise<ConsumedProviderState | null> {
  if (!state || typeof state !== "string" || state.length > 200) return null;
  const result = await getDb().query<{
    provider: Provider;
    client_id: string;
    redirect_uri: string;
    pkce_challenge: string;
    client_state: string | null;
  }>(
    `UPDATE academy_mcp_oauth_provider_states
        SET used = TRUE
      WHERE state = $1
        AND used = FALSE
        AND expires_at > NOW()
      RETURNING provider, client_id, redirect_uri, pkce_challenge, client_state`,
    [state],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    provider: row.provider,
    client_id: row.client_id,
    redirect_uri: row.redirect_uri,
    pkce_challenge: row.pkce_challenge,
    client_state: row.client_state,
  };
}

/**
 * Reaper fuer abgelaufene / verbrauchte Provider-States. Laeuft im
 * OAuth-Cleanup-Intervall. Idempotent.
 */
export async function cleanupExpiredProviderStates(): Promise<number> {
  try {
    const result = await getDb().query(
      `DELETE FROM academy_mcp_oauth_provider_states
        WHERE (used = TRUE OR expires_at < NOW())
          AND created_at < NOW() - INTERVAL '1 hour'`,
    );
    return result.rowCount ?? 0;
  } catch (err) {
    console.error("[academy-social] cleanupExpiredProviderStates failed:", err);
    return 0;
  }
}

/** Build the provider's authorize URL with our redirect + state. */
export function buildProviderAuthorizeUrl(opts: {
  provider: Provider;
  baseUrl: string;
  state: string;
}): string {
  const cfg = CONFIG[opts.provider];
  const { client_id } = getClientCredentials(opts.provider);
  const params = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: callbackUrl(opts.baseUrl, opts.provider),
    scope: cfg.scope,
    state: opts.state,
    ...(cfg.extra_authorize_params ?? {}),
  });
  return `${cfg.authorize_url}?${params.toString()}`;
}

/**
 * Exchange `code` for the provider's access_token.
 * Throws on any failure — caller logs + returns generic error to user.
 */
export async function exchangeProviderCode(opts: {
  provider: Provider;
  baseUrl: string;
  code: string;
}): Promise<string> {
  const cfg = CONFIG[opts.provider];
  const { client_id, client_secret } = getClientCredentials(opts.provider);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: callbackUrl(opts.baseUrl, opts.provider),
    client_id,
    client_secret,
  });

  const res = await safeFetchPublic(cfg.token_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    timeoutMs: 10_000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`provider_token_exchange_failed: ${opts.provider} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as { access_token?: string; token_type?: string };
  if (!json.access_token || typeof json.access_token !== "string") {
    throw new Error(`provider_token_exchange_no_token: ${opts.provider}`);
  }
  return json.access_token;
}

/** Fetch and normalize the user profile after we have an access_token. */
export async function fetchProviderProfile(opts: {
  provider: Provider;
  access_token: string;
}): Promise<ProviderProfile> {
  const cfg = CONFIG[opts.provider];
  const res = await safeFetchPublic(cfg.userinfo_url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${opts.access_token}`,
      Accept: "application/json",
    },
    timeoutMs: 10_000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`provider_userinfo_failed: ${opts.provider} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const raw = (await res.json()) as unknown;
  return normalizeProfile(opts.provider, raw);
}

/**
 * Normalize provider-specific JSON shapes into our common ProviderProfile.
 * Discord kann die Email als unverifiziert flaggen — dann lehnen wir ab
 * (der Sinn von Social-Login ist die Provider-Verifikation).
 */
export function normalizeProfile(provider: Provider, raw: unknown): ProviderProfile {
  const r = (raw ?? {}) as Record<string, unknown>;

  if (provider === "google") {
    // OIDC userinfo: { sub, email, email_verified, name, picture, ... }
    const sub = typeof r.sub === "string" ? r.sub : "";
    const email = typeof r.email === "string" ? normalizeEmail(r.email) : "";
    const verified = r.email_verified === true || r.email_verified === "true";
    const name = typeof r.name === "string" ? r.name : null;
    if (!sub) throw new Error("provider_profile_no_sub: google");
    if (!email || !isValidEmail(email)) throw new Error("provider_profile_no_email: google");
    if (!verified) throw new Error("provider_email_not_verified: google");
    return { providerId: sub, email, displayName: name };
  }

  if (provider === "discord") {
    // /users/@me: { id, username, global_name, email, verified, ... }
    const id = typeof r.id === "string" ? r.id : "";
    const email = typeof r.email === "string" ? normalizeEmail(r.email) : "";
    const verified = r.verified === true;
    const name =
      typeof r.global_name === "string" && r.global_name
        ? r.global_name
        : typeof r.username === "string"
        ? r.username
        : null;
    if (!id) throw new Error("provider_profile_no_sub: discord");
    if (!email || !isValidEmail(email)) throw new Error("provider_profile_no_email: discord");
    if (!verified) throw new Error("provider_email_not_verified: discord");
    return { providerId: id, email, displayName: name };
  }

  throw new Error(`unsupported_provider: ${provider}`);
}

/** True if `p` is a recognised provider name. */
export function isProvider(p: unknown): p is Provider {
  return p === "google" || p === "discord";
}
