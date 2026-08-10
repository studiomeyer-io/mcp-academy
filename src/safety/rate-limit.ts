/**
 * Hierarchical rate-limit (in-memory, single-process, V1).
 *
 * Layers (most-specific first):
 *   1. per-user write    (10/min, only counted when WRITE_TOOLS hit)
 *   2. per-user global   (30/min)
 *   3. per-IP minute     (60/min)   — applies to anonymous + authenticated
 *   4. per-IP hour       (600/h)    — sustained-abuse catcher
 *   5. per-IP day        (5000/d)   — long-tail cap
 *
 * Public MCP server → IP-layer is the load-bearing defense.
 * Repliziert aus ki-station src/safety/rate-limit.ts.
 *
 * V2 (multi-container): swap minute/hour buckets onto Postgres — V1 ist
 * single-container, in-memory reicht.
 */

import { numEnv } from "../core/env.js";

const IP_PER_MIN  = numEnv("ACADEMY_MCP_RATE_IP_PER_MIN",  60);
const IP_PER_HOUR = numEnv("ACADEMY_MCP_RATE_IP_PER_HOUR", 600);
const IP_PER_DAY  = numEnv("ACADEMY_MCP_RATE_IP_PER_DAY",  5000);
const USER_PER_MIN       = numEnv("ACADEMY_MCP_RATE_USER_PER_MIN",       30);
const USER_WRITE_PER_MIN = numEnv("ACADEMY_MCP_RATE_WRITE_USER_PER_MIN", 10);

/**
 * Hard cap on Map size — IP-spray could otherwise OOM the process.
 * We evict the oldest 5% (insertion-order) once the cap is hit.
 */
const MAX_BUCKETS_PER_MAP = numEnv("ACADEMY_MCP_RATE_MAX_BUCKETS", 50_000, { min: 1000 });
const EVICT_BATCH = Math.max(1024, Math.floor(MAX_BUCKETS_PER_MAP * 0.05));

interface Bucket { count: number; resetAt: number }

const ipMinuteBuckets = new Map<string, Bucket>();
const ipHourBuckets   = new Map<string, Bucket>();
const ipDayBuckets    = new Map<string, Bucket>();
const userMinuteBuckets = new Map<string, Bucket>();
const userWriteBuckets  = new Map<string, Bucket>();

const MINUTE_MS = 60_000;
const HOUR_MS   = 60 * 60_000;
const DAY_MS    = 24 * 60 * 60_000;

export type RateLimitReason =
  | "ip_minute"
  | "ip_hour"
  | "ip_day"
  | "user_minute"
  | "user_write_minute";

export interface RateLimitResult {
  ok: boolean;
  reason?: RateLimitReason;
  retry_after_seconds?: number;
  /**
   * Nur bei `ok: false`: dies ist die ERSTE Ablehnung im laufenden Fenster.
   * Teure Nebenwirkungen (DB-Schreibzugriff, Alarm) gehoeren an diesen
   * Uebergang, nicht an jeden abgewiesenen Request (Fable-R9 #2).
   */
  first?: boolean;
}

/**
 * Tool names whose handlers mutate state — counted against the per-user write
 * bucket. Magic-link + token endpoints have their own limits in auth/oauth.ts.
 *
 * FLAECHEN-VERTRAG (Codex-R3 Finding 3): diese Liste MUSS exakt die Menge
 * aller Registry-Tools mit access != 'read' sein — ein Test erzwingt die
 * Gleichheit in beide Richtungen (tests/audit-rate.test.ts). Ein neues
 * Write-Tool ohne Eintrag hier macht die Suite rot statt still unbudgetiert.
 */
export const WRITE_TOOLS = new Set<string>([
  "suite_request",
  "memory_save",
]);

// ─── Per-recipient cooldown (externe Zustellung: Mail + Telegram) ──────

const MAX_RECIPIENT_BUCKETS = 50_000;

interface RecipientEntry { last_sent_at: number }
const recipientCooldownMap = new Map<string, RecipientEntry>();

export interface RecipientCooldownResult {
  ok: boolean;
  retry_after_seconds?: number;
}

/** Per-Absender-Cooldown fuer den Wunsch-Kanal-Telegram-Push. */
// min 0 = "keine Sperrzeit" ist hier eine gueltige Einstellung (Wartezeit,
// keine Zaehlgrenze).
const REQUEST_PUSH_COOLDOWN_MS = numEnv("ACADEMY_MCP_REQUEST_PUSH_COOLDOWN_MS", 30_000, { min: 0 });

// ─── Magic-Link-Mail: Empfaenger-Budget (Fable-R1 #1, CRITICAL) ────────
//
// `POST /authorize` schickt eine gebrandete Mail an JEDE formal gueltige
// Adresse. Vorher war die einzige Bremse ein IP-Limit — und die IP war
// spoofbar (#2). Ergebnis: Mail-Bombing an fremde Adressen ueber unseren
// Absender, dazu beliebig erzeugbare Hard-Bounces (Reputations-Historie
// S725/S738/S881). Deshalb ein Budget, das am EMPFAENGER haengt und
// unabhaengig von Absender-IP/Client greift:
//   - Cooldown zwischen zwei Mails an dieselbe Adresse (Default 60s)
//   - harte Obergrenze pro Adresse und Tag (Default 5)
// Der HTTP-Antwort-Text bleibt identisch, egal ob gesendet wurde — sonst
// waere das Limit ein Enumerations-Oracle.
//
// Der Aufbau ist in SECHS Verify-Runden gewachsen; jede Schicht schliesst
// eine Form, die die vorige offen liess — und zweimal war der Fehler, eine
// Schranke zu ERSETZEN statt sie zu ergaenzen:
//   (0) Cooldown pro (Postfach x Quelle) — eine Quelle kann ein fremdes
//       Postfach nicht fluten (R4)
//   (1) Cooldown + Tages-Budget pro Postfach, GETRENNT nach bekannt/unbekannt
//       — fremde Anliegen koennen das Kontingent eines Kunden nicht
//       verbrauchen (R4; vorher sperrten fuenf Requests einen Kunden 24h aus)
//   (2) im unbekannt-Zweig ZWEI Deckel gleichzeitig: eng je Quelle (haelt die
//       Erstanmeldung eines Interessenten frei, R5) UND weit je Postfach mit
//       Alarm (begrenzt, wieviel viele Quellen zusammen dorthin richten
//       koennen, R6 — sonst skalierte die Menge linear mit der Zahl der IPs)
//   (3) globales Stundenlimit, nur fuer UNBEKANNTE — gegen Sprayen, ohne
//       echte Kunden auszusperren (R3)
// Fuer bekannte Kunden ist der Tages-Cap eine hohe Notbremse MIT Alarm,
// keine Wand.

// Pro Aufruf gelesen, nicht beim Import eingefroren: so ist jede Schranke
// einzeln testbar (der Cooldown verdeckte sonst den Tages-Cap — eine
// Pruefung, die nichts prueft) und im Betrieb ohne Rebuild justierbar.
function mailCooldownMs(): number {
  // Wartezeit, keine Zaehlgrenze: 0 heisst eindeutig "keine Sperrzeit".
  return numEnv("ACADEMY_MCP_MAIL_COOLDOWN_MS", 60_000, { min: 0 });
}
function mailPerDay(): number {
  return numEnv("ACADEMY_MCP_MAIL_PER_RECIPIENT_PER_DAY", 5);
}
/**
 * Tages-Cap fuer BEKANNTE Kunden — bewusst hoch: er ist eine Notbremse mit
 * Alarm, kein Anmelde-Ausschluss. Ein echter Kunde darf nie an eine
 * 24-Stunden-Wand laufen (R4).
 */
function mailKnownPerDay(): number {
  return numEnv("ACADEMY_MCP_MAIL_KNOWN_PER_DAY", 30);
}
/**
 * POSTFACHWEITE Notbremse fuer unbekannte Empfaenger (R6).
 *
 * Der R5-Fix band den unbekannt-Tagescap an die Quelle — richtig, aber er
 * ERSETZTE damit die einzige postfachweite Obergrenze, statt sie zu
 * ergaenzen. Folge: die Menge auf EIN fremdes Postfach skalierte linear mit
 * der Zahl der Quell-IPs (gemessen: 12 Quellen = 60 Mails/h; ueber den Tag
 * rotiert ~1440 statt 5). Das war das Ausgangs-Primitiv aus Runde 1 zurueck,
 * nur getaktet. Jetzt gelten BEIDE Deckel gleichzeitig — derselbe Aufbau wie
 * bei `known`: enger Cap je Quelle, weite Notbremse je Postfach, mit Alarm.
 */
function mailUnknownPerDay(): number {
  return numEnv("ACADEMY_MCP_MAIL_UNKNOWN_PER_DAY", 25);
}
/** Serverweite Obergrenze pro Stunde — die Schranke gegen SPRAYEN (s.u.). */
function mailGlobalPerHour(): number {
  return numEnv("ACADEMY_MCP_MAIL_GLOBAL_PER_HOUR", 100);
}

/**
 * Alle traege gelesenen Mail-Regler EINMAL anfassen.
 *
 * Die Regler oben werden bewusst pro Aufruf gelesen (testbar, ohne Rebuild
 * justierbar) — dadurch wuerde ein unbrauchbarer Wert aber erst beim ersten
 * Anmeldeversuch auffliegen, also im Betrieb statt beim Start. Der Entry-Point
 * ruft das hier auf, damit ein Tippfehler in der `.env` den Start abbricht und
 * nicht den ersten Kunden trifft (Fable-R8).
 */
export function validateRateLimitEnv(): void {
  mailCooldownMs();
  mailPerDay();
  mailKnownPerDay();
  mailUnknownPerDay();
  mailGlobalPerHour();
}

const mailCooldownMap = new Map<string, RecipientEntry>();
const mailDayBuckets = new Map<string, Bucket>();
const mailGlobalBucket = new Map<string, Bucket>();
/** Cooldown pro (Postfach x anfragender Quelle) — trifft nur den Flutenden. */
const requesterCooldownMap = new Map<string, RecipientEntry>();
const GLOBAL_KEY = "__global__";

/**
 * Meldekanal fuer die Erschoepfung des globalen Spray-Budgets. Wird vom
 * HTTP-Entry mit dem Telegram-Push verdrahtet — eine `console.error`-Zeile
 * allein sieht niemand (R3 #1). Selbst gedrosselt, damit der Alarm nicht
 * zum zweiten Spray-Kanal wird.
 */
let onGlobalMailLimit: ((limit: number) => void) | null = null;
let lastGlobalAlert = 0;
const GLOBAL_ALERT_COOLDOWN_MS = 15 * 60_000;

export function setGlobalMailLimitHandler(fn: ((limit: number) => void) | null): void {
  onGlobalMailLimit = fn ? throttled(fn, () => lastGlobalAlert, (t) => { lastGlobalAlert = t; }) : null;
}

/**
 * Meldekanal fuer eine erreichte POSTFACH-Notbremse. Beide Faelle sind
 * scharfe Signale: bei `known` wird gerade ein echter Kunde ausgebremst
 * (R4), bei `unknown` wird gerade ein fremdes Postfach bombardiert (R6).
 * Getrennte Drosseln, damit ein Alarm den anderen nicht verdeckt.
 */
export type NotbremsenScope = "known" | "unknown";
let onRecipientNotbremse: ((scope: NotbremsenScope, limit: number) => void) | null = null;
let lastKnownAlert = 0;
let lastUnknownAlert = 0;

export function setRecipientNotbremseHandler(
  fn: ((scope: NotbremsenScope, limit: number) => void) | null,
): void {
  if (!fn) { onRecipientNotbremse = null; return; }
  const knownThrottled = throttled((l) => fn("known", l), () => lastKnownAlert, (t) => { lastKnownAlert = t; });
  const unknownThrottled = throttled((l) => fn("unknown", l), () => lastUnknownAlert, (t) => { lastUnknownAlert = t; });
  onRecipientNotbremse = (scope, limit) => {
    if (scope === "known") knownThrottled(limit);
    else unknownThrottled(limit);
  };
}

function throttled(
  fn: (limit: number) => void,
  getLast: () => number,
  setLast: (t: number) => void,
): (limit: number) => void {
  return (limit: number) => {
    const now = Date.now();
    if (now - getLast() < GLOBAL_ALERT_COOLDOWN_MS) return;
    setLast(now);
    fn(limit);
  };
}

/**
 * Budget-Schluessel einer Mailadresse — AGGRESSIV kanonisiert (R2 #1).
 *
 * Der erste Fix schluesselte auf `trim().toLowerCase()`. Fuer den Mailserver
 * sind `opfer+1@gmail.com`, `opfer+2@gmail.com` und `o.p.f.e.r@gmail.com`
 * EIN Postfach — fuer die Map waren es drei Empfaenger. Live belegt: 6 Mails
 * ins selbe Postfach, nur der woertliche Doppelgaenger wurde geblockt. Der
 * Tag-Raum ist unbegrenzt, das Budget war damit gegen genau sein Szenario
 * wirkungslos. Zusatzgewicht: plus-getaggte Adressen bouncen bei mehreren
 * Providern HART (Grund fuer `sender-domain-block.sh`) — also ausgerechnet
 * die Form, die Reputation kostet.
 *
 * PROVIDER-ABHAENGIG (R3 #3): Plus-Tag ist ueberall Subadressierung und wird
 * immer abgeschnitten. Punkte NUR bei der Gmail-Familie — global entfernt
 * kollidierten `a.bauer@firma.de` und `ab.auer@firma.de`, zwei echte
 * Postfaecher mit vorname.nachname-Konvention. `-` nur bei Yahoo & Co.
 */
/**
 * Provider, die `-` als Subadressierungs-Trenner fuehren (qmail-Erbe).
 * Yahoo betreibt ~25 Laender-TLDs — deshalb praefix-basiert statt Liste
 * (R4: `yahoo.co.jp`/`yahoo.com.au` fielen sonst durch und oeffneten
 * zusaetzliche Wege auf denselben Tages-Bucket).
 */
const DASH_SUBADDRESS_SUFFIXES = ["ymail.com", "rocketmail.com"];
function usesDashSubaddressing(domain: string): boolean {
  if (domain === "yahoo.com" || domain.startsWith("yahoo.")) return true;
  return DASH_SUBADDRESS_SUFFIXES.includes(domain);
}
/** Gmail-Familie: Punkte sind bedeutungslos, googlemail == gmail. */
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
/** Apple: icloud/me/mac sind dasselbe Postfach (R5-Nachtrag). */
const APPLE_DOMAINS = new Set(["icloud.com", "me.com", "mac.com"]);

export function mailBudgetKey(rawEmail: string): string {
  const lowered = rawEmail.trim().toLowerCase();
  const at = lowered.lastIndexOf("@");
  if (at <= 0) return lowered;
  let local = lowered.slice(0, at);
  // Abschliessender FQDN-Punkt (`gmail.com.`) waere sonst ein zweiter
  // Schluessel fuer dasselbe Postfach (R4).
  let domain = lowered.slice(at + 1).replace(/\.+$/, "");

  // Plus-Tag: praktisch ueberall Subadressierung (Gmail, Outlook, Yahoo,
  // iCloud, Fastmail, Proton) — immer abschneiden.
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);

  if (GMAIL_DOMAINS.has(domain)) {
    // Punkte NUR hier entfernen (R3 #3): global entfernt kollidierten
    // `a.bauer@firma.de` und `ab.auer@firma.de` — zwei echte Postfaecher mit
    // vorname.nachname-Konvention teilten sich Cooldown und Tages-Cap, und
    // Kollege B bekam keinen Login-Link, wenn A gerade einen angefordert hat.
    local = local.replace(/\./g, "");
    domain = "gmail.com"; // googlemail == gmail, sonst zwei Schluessel
  } else if (APPLE_DOMAINS.has(domain)) {
    domain = "icloud.com";
  } else if (usesDashSubaddressing(domain)) {
    // Yahoos dokumentierte Wegwerf-Adressen (`basis-schlagwort@`) — und
    // ausgerechnet Yahoo steht in sender-domain-block.sh als Hard-Bounce-
    // Provider, also genau die Form, die Reputation kostet.
    const dash = local.indexOf("-");
    if (dash > 0) local = local.slice(0, dash);
  }
  return `${local}@${domain}`;
}

/**
 * Darf jetzt eine Magic-Link-Mail raus?
 *
 * DREI Schranken, weil zwei davon jeweils nur die halbe Angriffsform decken:
 *   1. Cooldown pro Postfach — gegen Wiederholung an dieselbe Adresse
 *   2. Tages-Cap pro Postfach — gegen geduldiges Nachfeuern
 *   3. GLOBALES Stunden-Budget — gegen SPRAYEN (viele verschiedene Adressen,
 *      je eine Mail). Gegen diese Form kann ein Per-Empfaenger-Budget
 *      grundsaetzlich nichts ausrichten (R2 #1: 34 Mails an 34 frische
 *      Adressen, kein einziger Block) — und genau das ist der
 *      Reputations-Vektor: frei erzeugbare Hard-Bounces ueber unseren Relay.
 *      Der Wert ist bewusst niedrig: ein echter Dienst mit N Kunden schickt
 *      Magic-Links im Bereich weniger pro Stunde.
 *
 * Zaehlt beim Erfolg direkt hoch (Verbrauch = Aufruf). Der Aufrufer sendet
 * nur bei `ok:true`, antwortet nach aussen aber in beiden Faellen gleich.
 */
export function checkMagicLinkMailBudget(
  rawEmail: string,
  opts: { knownRecipient?: boolean; requesterIp?: string } = {},
): RecipientCooldownResult {
  const key = mailBudgetKey(rawEmail);
  if (!key) return { ok: false };
  const now = Date.now();
  const known = Boolean(opts.knownRecipient);

  // (0) Schranke am ANFRAGENDEN (R4): Cooldown pro (Postfach x Quelle).
  // Ohne sie kann eine einzelne Quelle ein fremdes Postfach fluten — und
  // dessen Kontingent verbrauchen. Trifft nur den Flutenden selbst.
  if (opts.requesterIp) {
    const rKey = `${key}|${opts.requesterIp}`;
    const rCooled = requesterCooldownMap.get(rKey);
    if (rCooled && now - rCooled.last_sent_at < mailCooldownMs()) {
      return {
        ok: false,
        retry_after_seconds: Math.max(1, Math.ceil((mailCooldownMs() - (now - rCooled.last_sent_at)) / 1000)),
      };
    }
  }

  // (1) Getrennte Budgets fuer bekannte und unbekannte Anliegen (R4, der
  // Kern des Fixes). Bekanntheit wird an der ROHEN Adresse gemessen, das
  // Budget am KANONISCHEN Schluessel — dadurch zahlte ein Angreifer mit
  // `kunde+1@…` auf das Konto von `kunde@…` ein und sperrte den echten
  // Kunden 24 Stunden aus (fuenf Requests genuegten, lautlos). Getrennte
  // Buckets machen das unmoeglich: fremde Anliegen koennen das Kontingent
  // eines bekannten Kunden nicht mehr anfassen.
  const scope = known ? "known" : "unknown";
  const scopedKey = `${scope}:${key}`;

  const cooldown = mailCooldownMs();
  const cooled = mailCooldownMap.get(scopedKey);
  if (cooled && now - cooled.last_sent_at < cooldown) {
    return {
      ok: false,
      retry_after_seconds: Math.max(1, Math.ceil((cooldown - (now - cooled.last_sent_at)) / 1000)),
    };
  }

  // (2) Tages-Cap.
  //
  // Fuer BEKANNTE Kunden: hohe Notbremse mit Alarm — ein echter Kunde soll
  // nie an eine 24-Stunden-Wand laufen.
  //
  // Fuer UNBEKANNTE: eng, aber AN DIE ANFRAGENDE QUELLE gebunden (R5). Ohne
  // diese Bindung war der letzte Rest derselben Waffe uebrig: ein Dritter
  // konnte mit fuenf Requests (getaktet ~5 Minuten) das Tageskontingent
  // eines fremden Postfachs leeren und damit die ERSTE Anmeldung eines
  // Interessenten 24 Stunden lang verhindern — lautlos. Jetzt verbraucht
  // ein Angreifer nur sein eigenes Kontingent; die Quelle des Interessenten
  // hat immer ihre frischen fuenf. Die Spray-Abwehr bleibt unberuehrt, weil
  // das globale Stundenbudget die Gesamtmenge weiter deckelt.
  if (known) {
    // Bekannt: EINE postfachweite Notbremse, hoch angesetzt, mit Alarm.
    const limit = mailKnownPerDay();
    const day = checkBucket(mailDayBuckets, scopedKey, limit, DAY_MS);
    if (day.exceeded) {
      console.error(
        `[academy-mail-budget] Notbremse: bekanntes Postfach hat ${limit} Magic-Links/Tag erreicht. ` +
          "Das ist ungewoehnlich — Missbrauchs-Verdacht.",
      );
      onRecipientNotbremse?.("known", limit);
      return { ok: false, retry_after_seconds: day.retry };
    }
  } else {
    // Unbekannt: ZWEI Deckel gleichzeitig (R6 — vorher ersetzte der eine den
    // anderen). Der enge je Quelle haelt die Erstanmeldung eines
    // Interessenten frei; die weite Notbremse je Postfach begrenzt, wieviel
    // ein Angreifer mit vielen Quellen ueberhaupt dorthin richten kann.
    const perSource = mailPerDay();
    const sourceKey = opts.requesterIp ? `${scopedKey}|${opts.requesterIp}` : scopedKey;
    const bySource = checkBucket(mailDayBuckets, sourceKey, perSource, DAY_MS);
    if (bySource.exceeded) return { ok: false, retry_after_seconds: bySource.retry };

    const mailboxLimit = mailUnknownPerDay();
    const byMailbox = checkBucket(mailDayBuckets, `${scopedKey}|__mailbox__`, mailboxLimit, DAY_MS);
    if (byMailbox.exceeded) {
      console.error(
        `[academy-mail-budget] Notbremse: unbekanntes Postfach hat ${mailboxLimit} Magic-Links/Tag erreicht ` +
          "(ueber alle Quellen). Sieht nach gezieltem Bombardieren aus.",
      );
      onRecipientNotbremse?.("unknown", mailboxLimit);
      return { ok: false, retry_after_seconds: byMailbox.retry };
    }
  }

  // Das globale Budget gilt NUR fuer unbekannte Empfaenger (R3 #1).
  //
  // Ohne diese Ausnahme war die Spray-Bremse ein Anmelde-Ausschalter: eine
  // einzige IP verbraucht das Stundenkontingent mit Wegwerf-Adressen (~10 Min
  // bei Defaults) und sperrt damit ALLE echten Kunden aus dem Login — die
  // sehen "Schau in dein Postfach" und warten auf eine Mail, die nie kommt.
  // Sind Google/Discord nicht konfiguriert, ist das ein vollstaendiger
  // Authentifizierungs-Ausfall auf Zuruf.
  //
  // Ein bekannter Empfaenger (User-Row existiert) ist per Definition kein
  // Spray-Ziel: seine Adresse steht schon in unserer DB. Er verbraucht das
  // Kontingent nicht und wird von dessen Erschoepfung nicht getroffen. Seine
  // eigenen Schranken (Cooldown + Tages-Cap) hat er oben bereits passiert.
  if (!opts.knownRecipient) {
    const global = checkBucket(mailGlobalBucket, GLOBAL_KEY, mailGlobalPerHour(), HOUR_MS);
    if (global.exceeded) {
      console.error(
        `[academy-mail-budget] GLOBALES Stundenlimit erreicht (${mailGlobalPerHour()}/h) fuer ` +
          "UNBEKANNTE Empfaenger — Spray-Verdacht. Bekannte Kunden koennen sich weiter anmelden. " +
          "Wenn das kein Angriff ist: ACADEMY_MCP_MAIL_GLOBAL_PER_HOUR anheben.",
      );
      onGlobalMailLimit?.(mailGlobalPerHour());
      return { ok: false, retry_after_seconds: global.retry };
    }
  }

  if (!cooled && mailCooldownMap.size >= MAX_RECIPIENT_BUCKETS) {
    evictOldest(mailCooldownMap as unknown as Map<string, Bucket>);
  }
  mailCooldownMap.set(scopedKey, { last_sent_at: now });
  if (opts.requesterIp) {
    if (requesterCooldownMap.size >= MAX_RECIPIENT_BUCKETS) {
      evictOldest(requesterCooldownMap as unknown as Map<string, Bucket>);
    }
    requesterCooldownMap.set(`${key}|${opts.requesterIp}`, { last_sent_at: now });
  }
  return { ok: true };
}

/** Test-only. */
export function __clearMailBudgetForTest(): void {
  mailCooldownMap.clear();
  mailDayBuckets.clear();
  mailGlobalBucket.clear();
  requesterCooldownMap.clear();
  lastGlobalAlert = 0;
  lastKnownAlert = 0;
  lastUnknownAlert = 0;
}

/**
 * Cooldown pro Schluessel (Absender-Email). Stoppt schnelles Nachfeuern eines
 * externen Side-Effects an einen FESTEN Empfaenger — hier der Operator-
 * Telegram-Kanal in suite_request. Der DB-Write des Wunschs bleibt
 * davon unberuehrt — nur der Alarm-Push wird gedrosselt.
 */
export function checkRecipientCooldown(rawKey: string, windowMs = REQUEST_PUSH_COOLDOWN_MS): RecipientCooldownResult {
  const key = rawKey.trim().toLowerCase();
  if (!key) return { ok: true };
  const now = Date.now();
  const entry = recipientCooldownMap.get(key);
  if (entry && now - entry.last_sent_at < windowMs) {
    return {
      ok: false,
      retry_after_seconds: Math.max(1, Math.ceil((windowMs - (now - entry.last_sent_at)) / 1000)),
    };
  }
  if (!entry && recipientCooldownMap.size >= MAX_RECIPIENT_BUCKETS) {
    evictOldest(recipientCooldownMap as unknown as Map<string, Bucket>);
  }
  recipientCooldownMap.set(key, { last_sent_at: now });
  return { ok: true };
}

/** Test-only helper. */
export function __clearRecipientCooldownForTest(): void {
  recipientCooldownMap.clear();
}

function evictOldest(map: Map<string, Bucket>): number {
  let evicted = 0;
  for (const key of map.keys()) {
    map.delete(key);
    if (++evicted >= EVICT_BATCH) break;
  }
  return evicted;
}

function checkBucket(
  map: Map<string, Bucket>,
  key: string,
  max: number,
  windowMs: number,
): { exceeded: boolean; retry: number; first: boolean } {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now > entry.resetAt) {
    // Bucket-size cap before insert.
    if (!entry && map.size >= MAX_BUCKETS_PER_MAP) {
      evictOldest(map);
    }
    map.set(key, { count: 1, resetAt: now + windowMs });
    return { exceeded: false, retry: 0, first: false };
  }
  entry.count++;
  if (entry.count > max) {
    // `first` = die ERSTE Ablehnung in diesem Fenster. Der Zaehler laeuft
    // danach weiter, `max + 1` trifft also genau einmal zu. Damit kann der
    // Aufrufer teure Nebenwirkungen (Protokollzeile, Alarm) an den Uebergang
    // haengen statt an jeden abgewiesenen Request — siehe Fable-R9 #2.
    return {
      exceeded: true,
      retry: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      first: entry.count === max + 1,
    };
  }
  return { exceeded: false, retry: 0, first: false };
}

export interface RateLimitInput {
  ip: string;
  email: string | null;
  toolName: string;
}

/**
 * HTTP-Layer-Gate (VOR Body-Parse): IP-Schichten + per-User-Minute. Der
 * Tool-Name ist hier noch unbekannt (der steckt im ungeparsten Body), deshalb
 * gibt es hier KEINEN Write-Bucket-Check — der lebt in `checkWriteRateLimit`,
 * das der Dispatch mit dem echten Tool-Namen aufruft.
 */
/**
 * NUR die IP-Schichten. Getrennt aufrufbar, damit der HTTP-Entry sie VOR der
 * Bearer-Pruefung anwenden kann (Fable-R8, Finding 5): vorher lief der
 * 401-Pfad — der einzige oeffentlich erreichbare Rechenweg des Dienstes — ganz
 * am Limiter vorbei, gemessen 70 Requests, 70x 401, kein einziges 429.
 * Das widersprach der Zusicherung in Zeile 7 („applies to anonymous").
 *
 * Wer beides braucht, nimmt `checkRateLimit` — NICHT beide nacheinander,
 * sonst zaehlt jeder Request doppelt gegen die IP-Eimer.
 */
export function checkIpRateLimit(ip: string): RateLimitResult {
  const ipMin = checkBucket(ipMinuteBuckets, ip, IP_PER_MIN, MINUTE_MS);
  if (ipMin.exceeded) return { ok: false, reason: "ip_minute", retry_after_seconds: ipMin.retry, first: ipMin.first };

  const ipHour = checkBucket(ipHourBuckets, ip, IP_PER_HOUR, HOUR_MS);
  if (ipHour.exceeded) return { ok: false, reason: "ip_hour", retry_after_seconds: ipHour.retry, first: ipHour.first };

  const ipDay = checkBucket(ipDayBuckets, ip, IP_PER_DAY, DAY_MS);
  if (ipDay.exceeded) return { ok: false, reason: "ip_day", retry_after_seconds: ipDay.retry, first: ipDay.first };

  return { ok: true };
}

/** NUR die User-Schicht. Setzt einen authentifizierten Aufrufer voraus. */
export function checkUserRateLimit(email: string): RateLimitResult {
  const userMin = checkBucket(userMinuteBuckets, email, USER_PER_MIN, MINUTE_MS);
  if (userMin.exceeded) return { ok: false, reason: "user_minute", retry_after_seconds: userMin.retry, first: userMin.first };
  return { ok: true };
}

export function checkRateLimit(input: RateLimitInput): RateLimitResult {
  const { ip, email } = input;

  // IP-level (covers anonymous + authenticated)
  const ipResult = checkIpRateLimit(ip);
  if (!ipResult.ok) return ipResult;

  // User-level (only when authenticated)
  if (email) return checkUserRateLimit(email);

  return { ok: true };
}

/**
 * Write-Gate im Tool-Dispatch (server.ts) — hier IST der Tool-Name bekannt.
 * Prueft NUR den Write-Bucket (keine Doppelzaehlung mit checkRateLimit).
 * Greift nur fuer WRITE_TOOLS.
 */
export function checkWriteRateLimit(email: string, toolName: string): RateLimitResult {
  if (!WRITE_TOOLS.has(toolName)) return { ok: true };
  const w = checkBucket(userWriteBuckets, email, USER_WRITE_PER_MIN, MINUTE_MS);
  if (w.exceeded) return { ok: false, reason: "user_write_minute", retry_after_seconds: w.retry };
  return { ok: true };
}

export function cleanupRateLimitMaps(): { reaped: number } {
  const now = Date.now();
  let reaped = 0;
  for (const map of [ipMinuteBuckets, ipHourBuckets, ipDayBuckets, userMinuteBuckets, userWriteBuckets]) {
    for (const [k, b] of map.entries()) {
      if (now > b.resetAt) { map.delete(k); reaped++; }
    }
  }
  // Sweep recipient cooldowns older than 2x the window.
  const cutoff = now - 2 * REQUEST_PUSH_COOLDOWN_MS;
  for (const [k, e] of recipientCooldownMap.entries()) {
    if (e.last_sent_at < cutoff) { recipientCooldownMap.delete(k); reaped++; }
  }
  const mailCutoff = now - 2 * mailCooldownMs();
  for (const [k, e] of mailCooldownMap.entries()) {
    if (e.last_sent_at < mailCutoff) { mailCooldownMap.delete(k); reaped++; }
  }
  for (const [k, b] of mailDayBuckets.entries()) {
    if (now > b.resetAt) { mailDayBuckets.delete(k); reaped++; }
  }
  for (const [k, e] of requesterCooldownMap.entries()) {
    if (e.last_sent_at < mailCutoff) { requesterCooldownMap.delete(k); reaped++; }
  }
  return { reaped };
}

/** Test-only helpers. */
export function __clearRateLimitForTest(): void {
  ipMinuteBuckets.clear();
  ipHourBuckets.clear();
  ipDayBuckets.clear();
  userMinuteBuckets.clear();
  userWriteBuckets.clear();
}
export function __getRateLimitState(): { ipMin: number; ipHour: number; ipDay: number; userMin: number; userWrite: number } {
  return {
    ipMin: ipMinuteBuckets.size,
    ipHour: ipHourBuckets.size,
    ipDay: ipDayBuckets.size,
    userMin: userMinuteBuckets.size,
    userWrite: userWriteBuckets.size,
  };
}
