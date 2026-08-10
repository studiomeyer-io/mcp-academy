/**
 * Token hashing helper. Storage-at-rest defense:
 * die academy_oauth_* Tabellen sehen nur SHA-256(token), nie Klartext.
 *
 * In-memory Maps in oauth.ts halten Klartext fuer schnellen Bearer-Vergleich;
 * persistierte DB-Rows tragen nur den Hash. Beim Boot-Rehydrate koennen
 * Klartext-Tokens nicht wiederhergestellt werden — by design: ein DB-Leak
 * allein kompromittiert keine Live-Sessions. Clients mit gueltigem
 * Refresh-Token minten einfach neu.
 */

import { createHash } from "node:crypto";

export function hashToken(plain: string): string {
  return createHash("sha256").update(plain, "utf8").digest("hex");
}
