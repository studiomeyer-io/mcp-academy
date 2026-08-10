/**
 * Alles, was beim Start geprueft sein muss, an EINER Stelle.
 *
 * Warum eigenes Modul (Fable-R10 #1): Die Regler dieses Projekts werden teils
 * beim Import gelesen (dann bricht ein ungueltiger Wert den Start von selbst
 * ab — gut) und teils traege beim Gebrauch (testbar, ohne Rebuild justierbar —
 * auch gut, aber dann faellt ein Tippfehler erst im Betrieb auf). Fuer die
 * traegen brauchte es eine Pruefung beim Start, und die war zuletzt eine
 * handgepflegte Fuenfer-Liste in `rate-limit.ts`. Als in Runde 9 zwei neue
 * traege Regler fuers Audit-Log dazukamen, standen sie dort nicht drin: ein
 * falscher Wert haette den Dienst eine Stunde nach dem Start in einen
 * stuendlichen Absturz-Kreislauf geschickt.
 *
 * Das ist dieselbe Klasse, gegen die Runde 9 den parseInt-Waechter auf die
 * Flaeche umgestellt hat — nur eine Ebene hoeher. Deshalb hier zwei Dinge:
 * die Sammelstelle UND ein Flaechen-Test daneben
 * (`tests/fable-r10-fixes.test.ts`), der jeden traegen Regler im Quelltext
 * findet und nachweist, dass ein kaputter Wert den Start abbricht. Eine neue
 * Sammelstelle allein waere nur eine neue Liste zum Vergessen.
 */

import { assertBaseUrlUsable, getPort } from "./base-url.js";
import { validateRateLimitEnv } from "../safety/rate-limit.js";
import { validateMailEnv } from "../auth/email-magic.js";

export function validateEnvAtStartup(): void {
  assertBaseUrlUsable();
  getPort();          // ACADEMY_MCP_PORT
  validateRateLimitEnv();
  // Kein validateAuditEnv(): dieser Server fuehrt kein eigenes Audit-Log —
  // jeder Schreibvorgang laeuft ueber die Academy-Bruecke, die selbst protokolliert.
  validateMailEnv();  // SMTP_PORT — sonst faellt ein Tippfehler erst beim
                      // ersten Anmeldeversuch auf, also am Kunden.
}
