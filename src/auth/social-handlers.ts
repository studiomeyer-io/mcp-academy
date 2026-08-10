/**
 * HTTP handlers fuer den Social-Login-Redirect-Roundtrip.
 *
 * Zwei Routen pro Provider:
 *   GET /authorize/{provider}            — start; redirect zur Provider-Auth-URL
 *   GET /authorize/{provider}/callback   — callback; mintet unseren auth_code,
 *                                          redirect zum urspruenglichen Client.
 *
 * Die PKCE-Kette bleibt intakt: die Client-PKCE-Challenge aus /authorize wird
 * in `academy_oauth_provider_states` geparkt und beim Minten des auth_codes
 * nach erfolgreichem Provider-Callback wiederverwendet. Der Client loest den
 * auth_code an /token mit seinem eigenen code_verifier ein — exakt wie im
 * Magic-Link-Flow.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type Provider,
  buildProviderAuthorizeUrl,
  createProviderState,
  consumeProviderState,
  exchangeProviderCode,
  fetchProviderProfile,
  isProviderEnabled,
} from "./social-providers.js";
import { findOrCreateUserBySocial, isUserAllowed, markUserEmailVerified } from "./users.js";
import { detectLocale, t } from "./i18n.js";
import { brandedPageShell } from "./page-shell.js";
import { getBaseUrl } from "../core/base-url.js";

export interface SocialHandlerDeps {
  /** Map of registered MCP clients — same Map used by oauth.ts. */
  clients: Map<string, { client_id: string; redirect_uris: string[] }>;
  /** Issue an auth_code bound to the (client_id, email, redirect_uri, pkce_challenge) tuple. */
  issueAuthCode: (opts: {
    client_id: string;
    redirect_uri: string;
    pkce_challenge: string;
    email: string;
  }) => Promise<string>;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * GET /authorize/{provider}
 *
 * Query params (same as /authorize for the magic-link flow):
 *   client_id, redirect_uri, state (optional client-side state),
 *   code_challenge (PKCE S256)
 */
export async function handleProviderStart(
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
  deps: SocialHandlerDeps,
): Promise<void> {
  if (!isProviderEnabled(provider)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`provider_not_configured: ${provider}`);
    return;
  }

  const url = new URL(req.url || "/", getBaseUrl());
  const clientId = url.searchParams.get("client_id") || "";
  const redirectUri = url.searchParams.get("redirect_uri") || "";
  const clientState = url.searchParams.get("state") || "";
  const codeChallenge = url.searchParams.get("code_challenge") || "";

  const client = deps.clients.get(clientId);
  if (!client) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Unknown client_id — register via POST /register first");
    return;
  }
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("redirect_uri not registered for this client");
    return;
  }
  if (!codeChallenge || codeChallenge.length < 43 || codeChallenge.length > 128) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("code_challenge required (PKCE S256, 43-128 chars)");
    return;
  }

  let state: string;
  try {
    state = await createProviderState({
      provider,
      client_id: clientId,
      redirect_uri: redirectUri,
      pkce_challenge: codeChallenge,
      client_state: clientState || null,
    });
  } catch (err) {
    console.error(`[academy-social] createProviderState failed (${provider}):`, err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("state_persistence_failed");
    return;
  }

  const authorizeUrl = buildProviderAuthorizeUrl({ provider, baseUrl: getBaseUrl(), state });
  res.writeHead(302, {
    Location: authorizeUrl,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end();
}

/**
 * GET /authorize/{provider}/callback
 *
 * 1. Look up + consume the state row (atomic).
 * 2. Exchange code → access_token.
 * 3. Fetch profile.
 * 4. findOrCreateUserBySocial.
 * 5. Mint auth_code bound to the original client-PKCE.
 * 6. 302 to the original client redirect_uri with code + client_state.
 */
export async function handleProviderCallback(
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
  deps: SocialHandlerDeps,
): Promise<void> {
  const url = new URL(req.url || "/", getBaseUrl());
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const errorParam = url.searchParams.get("error");
  const locale = detectLocale(req, getBaseUrl());

  if (errorParam) {
    console.error(`[academy-social] provider returned error: ${provider} ${errorParam}`);
    renderProviderError(res, locale);
    return;
  }
  if (!code || !state) {
    renderProviderError(res, locale);
    return;
  }

  const stateRow = await consumeProviderState(state);
  if (!stateRow || stateRow.provider !== provider) {
    console.error(`[academy-social] consumeProviderState: missing or wrong-provider for state=${state.slice(0, 12)}`);
    renderProviderError(res, locale);
    return;
  }

  let accessToken: string;
  try {
    accessToken = await exchangeProviderCode({ provider, baseUrl: getBaseUrl(), code });
  } catch (err) {
    console.error(`[academy-social] exchangeProviderCode failed (${provider}):`, err);
    renderProviderError(res, locale);
    return;
  }

  let profile: Awaited<ReturnType<typeof fetchProviderProfile>>;
  try {
    profile = await fetchProviderProfile({ provider, access_token: accessToken });
  } catch (err) {
    console.error(`[academy-social] fetchProviderProfile failed (${provider}):`, err);
    renderProviderError(res, locale);
    return;
  }

  // Sperre VOR jedem Schreibzugriff pruefen (Fable-R1 #7): vorher griff
  // `suspended` nur auf dem Magic-Link-Pfad — ein gesperrter Account konnte
  // sich per Google/Discord frische Tokens holen.
  try {
    if (!(await isUserAllowed(profile.email))) {
      console.error(`[academy-social] ${provider} sign-in blocked — account suspended`);
      renderProviderError(res, locale);
      return;
    }
  } catch (err) {
    console.error(`[academy-social] isUserAllowed failed (fail-closed):`, err);
    renderProviderError(res, locale);
    return;
  }

  let userEmail: string;
  try {
    const result = await findOrCreateUserBySocial({
      provider,
      providerId: profile.providerId,
      email: profile.email,
      displayName: profile.displayName,
    });
    userEmail = result.user.email;
    console.error(`[academy-social] ${provider} sign-in: ${userEmail} via ${result.path}`);
    await markUserEmailVerified(userEmail);
  } catch (err) {
    console.error(`[academy-social] findOrCreateUserBySocial failed:`, err);
    renderProviderError(res, locale);
    return;
  }

  let authCode: string;
  try {
    authCode = await deps.issueAuthCode({
      client_id: stateRow.client_id,
      redirect_uri: stateRow.redirect_uri,
      pkce_challenge: stateRow.pkce_challenge,
      email: userEmail,
    });
  } catch (err) {
    console.error(`[academy-social] issueAuthCode failed:`, err);
    renderProviderError(res, locale);
    return;
  }

  const sep = stateRow.redirect_uri.includes("?") ? "&" : "?";
  const stateQs = stateRow.client_state ? `&state=${encodeURIComponent(stateRow.client_state)}` : "";
  const location = `${stateRow.redirect_uri}${sep}code=${encodeURIComponent(authCode)}${stateQs}`;
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end();
}

function renderProviderError(res: ServerResponse, locale: Parameters<typeof t>[1]): void {
  res.writeHead(400, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end(
    brandedPageShell(
      locale,
      t("provider_error_title", locale),
      `<div class="icon">&#9888;</div>
<h2>${esc(t("provider_error_title", locale))}</h2>
<p>${esc(t("provider_error_body", locale))}</p>`,
    ),
  );
}
