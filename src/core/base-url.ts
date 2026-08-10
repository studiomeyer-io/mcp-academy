/**
 * BASE_URL — EINE Quelle der Wahrheit (Fable-R1 #6).
 *
 * Vorher hatten http-server, oauth.ts und social-handlers.ts je eigene
 * Defaults (`HOST:PORT` bzw. hart `http://localhost:3116`). Ohne gesetztes
 * ACADEMY_MCP_BASE_URL lieferte dieselbe Antwort-Familie drei verschiedene, alle
 * falschen URLs: WWW-Authenticate zeigte auf `http://0.0.0.0:3116`, Metadata
 * auf `http://localhost:3116`, Magic-Link-Mails ebenso — still, ohne Fehler.
 *
 * Regel: Alles, was eine oeffentliche URL braucht, ruft getBaseUrl().
 * Bindet der Server auf einer Nicht-Loopback-Adresse (Container: 0.0.0.0),
 * ist ACADEMY_MCP_BASE_URL PFLICHT — sonst Start-Abbruch statt stiller Fehl-URL.
 */

import { numEnv } from "./env.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Bindet der Server nur lokal? EINE Quelle fuer diese Frage (Fable-R12).
 *
 * `email-magic.ts` hatte die Liste kopiert — und mit ihr eine leicht andere
 * Normalisierung (`?? "" + trim` statt `|| Default`). Folge: ein leeres
 * `ACADEMY_MCP_HOST=` in der `.env` — ein durchaus uebliches Muster — liess den
 * Start mit „bindet auf  (nicht Loopback)" abbrechen, obwohl real auf
 * 127.0.0.1 gebunden worden waere. Zwei Kopien derselben Wahrheit driften
 * nicht in den Inhalten, sondern in dem, was drumherum passiert.
 */
export function isLoopbackHost(host: string = getHost()): boolean {
  return LOOPBACK.has(host.trim());
}

export function getPort(): number {
  return numEnv("ACADEMY_MCP_PORT", 3116, { min: 1, max: 65535 });
}

export function getHost(): string {
  return process.env.ACADEMY_MCP_HOST || "127.0.0.1";
}

/**
 * Oeffentliche Basis-URL. Ohne ACADEMY_MCP_BASE_URL nur im lokalen
 * Loopback-Betrieb ableitbar.
 */
export function getBaseUrl(): string {
  const explicit = process.env.ACADEMY_MCP_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return `http://${getHost()}:${getPort()}`;
}

/**
 * Startup-Guard (nur der HTTP-Entry ruft das).
 *
 * Prueft ZWEI Dinge — die erste Fassung pruefte nur das erste, und der Name
 * versprach mehr als der Code hielt (R2 #6):
 *   1. Bindet der Server nicht auf Loopback, ist ACADEMY_MCP_BASE_URL Pflicht.
 *   2. Der Wert muss eine BRAUCHBARE http(s)-URL sein. `academy.studiomeyer.io`
 *      ohne Schema passierte den alten Guard, der Server startete — und dann
 *      warf `new URL(req.url, base)` bei JEDEM Request: /health, /mcp, alles
 *      500. Container-Healthcheck rot, `restart: unless-stopped` startet bei
 *      *unhealthy* NICHT neu → der Dienst steht tot, aber laufend. Und die
 *      Compose-Datei erzwingt den Handeintrag jetzt per `:?`, macht den
 *      Tippfehler also wahrscheinlicher.
 */
export function assertBaseUrlUsable(): void {
  const explicit = process.env.ACADEMY_MCP_BASE_URL?.trim();

  if (!explicit) {
    if (LOOPBACK.has(getHost())) return;
    throw new Error(
      `ACADEMY_MCP_BASE_URL ist Pflicht, wenn ACADEMY_MCP_HOST=${getHost()} (nicht Loopback) ist. ` +
        "Ohne sie zeigen OAuth-Metadata, WWW-Authenticate, Magic-Link-Mails und " +
        "Social-Callbacks auf eine nicht erreichbare Adresse. " +
        "Beispiel: ACADEMY_MCP_BASE_URL=https://academy.studiomeyer.io",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(explicit);
  } catch {
    throw new Error(
      `ACADEMY_MCP_BASE_URL="${explicit}" ist keine gueltige URL — vermutlich fehlt das Schema. ` +
        "Erwartet: https://academy.studiomeyer.io (mit https://).",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `ACADEMY_MCP_BASE_URL="${explicit}" hat das Schema "${parsed.protocol}" — erlaubt sind nur http:// und https://.`,
    );
  }
}
