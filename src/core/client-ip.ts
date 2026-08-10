/**
 * Caller-IP fuer Rate-Limits + Audit.
 *
 * ZWEI RUNDEN GEBRAUCHT, deshalb ausfuehrlich:
 *
 * R1-Befund: `X-Forwarded-For.split(",")[0]` — der vom Client frei gewaehlte
 * Token. Jedes IP-Limit per Header umgehbar (live belegt), und der ungepruefte
 * String war zugleich Bucket-Key (436 MB fuer 50k Keys gegen ein 512-MB-Limit).
 *
 * R2-Befund am ERSTEN Fix: der Header war nur UMGEZOGEN. `CF-Connecting-IP`
 * und `X-Real-IP` wurden bedingungslos als hoechste Quelle genommen, waehrend
 * ausgerechnet XFF ein Trust-Flag bekam. Beide sind aber gewoehnliche
 * Request-Header: kein Fleet-Vhost fasst `CF-Connecting-IP` an, nginx reicht
 * ihn unveraendert durch — wer den Origin direkt anspricht, setzt ihn frei.
 * Live belegt: 12/12 Requests 200 statt 10×200 + 2×429.
 *
 * DIE REGEL, die daraus folgt: **Kein Header wird vertraut, es sei denn, der
 * Betreiber benennt genau einen — und uebernimmt damit die Zusicherung, dass
 * sein Proxy diesen Header ueberschreibt.** Ohne Konfiguration zaehlt nur die
 * TCP-Gegenstelle. Das ist die einzige Quelle, die nicht vom Client stammt.
 *
 * Betrieb hinter nginx (+Cloudflare): `ACADEMY_MCP_TRUSTED_IP_HEADER=x-real-ip`
 * (nginx setzt es aus `$remote_addr` und ueberschreibt Client-Werte).
 * Hinter Cloudflare MIT Origin-Lockdown (nur CF-IPs duerfen den Origin
 * erreichen): `cf-connecting-ip` ist dann ebenfalls vertretbar.
 * Ohne Lockdown ist `x-real-ip` die sichere Wahl.
 */

import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

const MAX_IP_LEN = 45; // laengste IPv6-Textform mit IPv4-Suffix

/**
 * Echte IP-Pruefung statt Form-Regex: `aaa.bbb`, `dead:beef` und `::::`
 * passierten die alte `[0-9a-fA-F:.]`-Regex und blaehten den Schluesselraum
 * weiter auf (R2 #2).
 */
function sane(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().replace(/^\[|\]$/g, "");
  if (!v || v.length > MAX_IP_LEN) return null;
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) ist gueltig und bleibt wie es ist.
  return isIP(v) === 0 ? null : v;
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const h = req.headers[name];
  if (Array.isArray(h)) return h[0];
  return h;
}

/** Der EINE Header, dem der Betreiber ausdruecklich vertraut (oder keiner). */
function trustedHeaderName(): string | null {
  const raw = process.env.ACADEMY_MCP_TRUSTED_IP_HEADER?.trim().toLowerCase();
  return raw ? raw : null;
}

let warnedAboutLoopbackOnly = false;

export function clientIp(req: IncomingMessage): string {
  const header = trustedHeaderName();
  if (header) {
    // Genau EIN benannter Header. Traegt er mehrere Werte (XFF-Kette), gilt
    // der RECHTESTE — den haengt der eigene Proxy an, die linken kommen vom
    // Client.
    const raw = firstHeader(req, header);
    if (raw) {
      const parts = raw.split(",");
      const rightmost = sane(parts[parts.length - 1]);
      if (rightmost) return rightmost;
    }
    // Header konfiguriert, aber nicht angekommen → NICHT auf einen anderen
    // Header ausweichen (das war der R2-Fehler). Socket ist die Wahrheit.
  }

  const socketIp = sane(req.socket?.remoteAddress);
  if (socketIp) {
    // Betriebs-Warnung an der RICHTIGEN Bedingung (R3 #4): sie haengt am
    // Symptom "Socket ist Loopback", nicht an "kein Header konfiguriert".
    // Vorher schwieg sie ausgerechnet im wahrscheinlichsten Fehlerfall —
    // Header konfiguriert, kommt aber nie an (vhost setzt ihn nicht, Name
    // vertippt) — und genau dort landen alle Nutzer in einem Bucket.
    if (!warnedAboutLoopbackOnly && (socketIp === "127.0.0.1" || socketIp === "::1")) {
      warnedAboutLoopbackOnly = true;
      console.error(
        header
          ? `[academy-ip] WARNUNG: ACADEMY_MCP_TRUSTED_IP_HEADER="${header}" ist gesetzt, aber der ` +
              "Header kommt nicht an — es zaehlt die Loopback-Socket-IP. Damit landen ALLE " +
              "Nutzer im selben Rate-Limit-Bucket. Pruefe Header-Name und vhost " +
              "(nginx: proxy_set_header X-Real-IP $remote_addr)."
          : "[academy-ip] WARNUNG: Requests kommen von Loopback und ACADEMY_MCP_TRUSTED_IP_HEADER " +
              "ist nicht gesetzt. Hinter einem Proxy landen dadurch ALLE Nutzer im selben " +
              "Rate-Limit-Bucket. Setze ACADEMY_MCP_TRUSTED_IP_HEADER=x-real-ip (nginx) oder " +
              "cf-connecting-ip (nur mit Cloudflare-Origin-Lockdown).",
      );
    }
    return socketIp;
  }
  return "unknown";
}

/** Test-only: die Einmal-Warnung zuruecksetzen. */
export function __resetIpWarningForTest(): void {
  warnedAboutLoopbackOnly = false;
}
