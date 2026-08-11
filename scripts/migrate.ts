/**
 * Schema-Migration: scripts/schema.sql idempotent einspielen.
 * Laeuft beim Container-Start (vor dem http-server) und via `npm run db:schema`.
 * Optional: `--seed-dev` spielt zusaetzlich scripts/seed-dev.sql ein
 * (NUR Platzhalter-Daten — nie in Prod verwenden).
 *
 * Versions-Waechter (Fable-R8, Finding 6): `CREATE TABLE IF NOT EXISTS` ist auf
 * einer bestehenden Tabelle ein No-op. Eine nachtraeglich ergaenzte Spalte oder
 * geaenderte CHECK-Bedingung wird also NIE angewandt — frueher meldete der
 * Start trotzdem „schema.sql applied", der Healthcheck war gruen, und der
 * Fehler kam als `column ... does not exist` beim Kunden an. Darum traegt
 * schema.sql eine SCHEMA_VERSION im Kopf und die DB eine in
 * academy_mcp_schema_meta. Weichen sie ab, bricht der Start ab und sagt, was fehlt.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "../src/db.js";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * schema.sql liegt beim Quelltext neben dieser Datei, im gebauten Stand aber
 * eine Ebene ueber dem kompilierten Skript (dist-scripts/scripts/migrate.js ->
 * scripts/schema.sql im Arbeitsverzeichnis). Beide Wege pruefen, statt sich auf
 * einen zu verlassen: sonst startet der Container, findet die Datei nicht und
 * bricht mit ENOENT ab — was wie ein Datenbank-Problem aussieht, aber keines ist.
 */
function findSqlFile(name: string): string {
  const candidates = [
    join(SCRIPTS_DIR, name),
    join(SCRIPTS_DIR, "..", "..", "scripts", name),
    join(process.cwd(), "scripts", name),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    `[academy-migrate] ${name} nicht gefunden. Gesucht in:\n  ${candidates.join("\n  ")}`,
  );
}

/** Liest `-- SCHEMA_VERSION: N` aus dem Kopf von schema.sql. */
export function parseSchemaVersion(sql: string): number {
  const match = /^--\s*SCHEMA_VERSION:\s*(\d+)\s*$/m.exec(sql);
  if (!match) {
    throw new Error(
      "schema.sql hat keine `-- SCHEMA_VERSION: N`-Zeile. Ohne sie laesst sich " +
        "nicht pruefen, ob die Datenbank zum Schema passt.",
    );
  }
  return parseInt(match[1] as string, 10);
}

export type SchemaAction =
  | { kind: "record"; version: number }
  | { kind: "aktuell"; version: number }
  | { kind: "abbruch"; message: string };

/**
 * Die Entscheidung als eigene, reine Funktion — damit sie pruefbar ist.
 *
 * Als das noch als Kette von `else if` in runMigration stand, konnte die
 * Mutations-Matrix die Bedingung durch `if (false)` ersetzen, ohne dass ein
 * Test rot wurde: die Tests prueften nur, ob der Wortlaut „Schema-Drift" in
 * der Datei vorkommt — und der stand ja weiterhin im toten Zweig. Eine
 * Zusicherung ueber Text ist keine Zusicherung ueber Verhalten.
 */
export function decideSchemaAction(
  dbVersion: number | undefined,
  fileVersion: number,
  /**
   * Gab es in dieser Datenbank schon Daten, BEVOR die Meta-Tabelle entstand?
   * (Fable-R9, Finding 4.)
   *
   * Ohne diese Unterscheidung bedeutet `dbVersion === undefined` zweierlei:
   * „frische Datenbank" — dann ist das Eintragen der Version richtig — oder
   * „bestehende Datenbank, die die Meta-Tabelle noch nicht kennt". Im zweiten
   * Fall wurde bisher stillschweigend die aktuelle Version eingetragen,
   * obwohl kein einziges ALTER gelaufen war: der Start meldete Erfolg, und der
   * Fehler tauchte als fehlende Spalte beim Kunden auf. Genau das Bild, das
   * dieser Waechter verhindern soll. Trifft zu bei einem Restore aus der Zeit
   * vor dieser Aenderung, auf einem zweiten Host oder wenn jemand die Zeile
   * geloescht hat.
   */
  hatBestandsdaten = false,
): SchemaAction {
  if (dbVersion === undefined) {
    if (hatBestandsdaten && fileVersion > 1) {
      return {
        kind: "abbruch",
        message:
          `Diese Datenbank enthaelt bereits Daten, aber keine Versionsangabe, und ` +
          `schema.sql steht auf ${fileVersion}. Ob die Aenderungen der Versionen 2..${fileVersion} ` +
          `jemals angewandt wurden, laesst sich hier nicht feststellen — und stillschweigend ` +
          `${fileVersion} einzutragen wuerde genau den Fehler verdecken, gegen den diese ` +
          `Pruefung existiert.\nStimmt das Schema wirklich, dann von Hand bestaetigen:\n` +
          `  INSERT INTO academy_mcp_schema_meta (id, version) VALUES (TRUE, ${fileVersion});`,
      };
    }
    return { kind: "record", version: fileVersion };
  }
  if (dbVersion < fileVersion) {
    return {
      kind: "abbruch",
      message:
        `Schema-Drift: die Datenbank steht auf Version ${dbVersion}, ` +
        `schema.sql verlangt ${fileVersion}. CREATE TABLE IF NOT EXISTS aendert ` +
        `bestehende Tabellen NICHT — die noetigen ALTER-Anweisungen muessen von ` +
        `Hand laufen, danach:\n` +
        `  UPDATE academy_mcp_schema_meta SET version = ${fileVersion}, applied_at = NOW() WHERE id = TRUE;\n` +
        `Bis dahin startet der Server nicht, statt mit halbem Schema zu laufen.`,
    };
  }
  if (dbVersion > fileVersion) {
    return {
      kind: "abbruch",
      message:
        `Die Datenbank steht auf Version ${dbVersion}, dieser Code ` +
        `erwartet ${fileVersion}. Das ist ein zurueckgerollter Deploy gegen eine ` +
        `neuere Datenbank — abgebrochen, bevor etwas kaputtgeht.`,
    };
  }
  return { kind: "aktuell", version: fileVersion };
}

/**
 * @param schemaSql Nur fuer Pruefungen: Schema-Text statt der Datei. Der
 * Bestandsdaten-Waechter greift erst ab Version 2 — mit der echten Datei
 * (Version 1) laesst er sich also gar nicht beobachten, und eine Zusicherung,
 * die man nicht ausloesen kann, ist keine (Fable-R9, Mutations-Zeile 4b).
 */
export async function runMigration(schemaSql?: string): Promise<void> {
  const db = getDb();
  const schema = schemaSql ?? readFileSync(findSqlFile("schema.sql"), "utf8");
  const fileVersion = parseSchemaVersion(schema);

  await db.query(schema);

  // Erst NACH dem Anwenden lesen — auf einer frischen Datenbank entsteht die
  // Meta-Tabelle ja gerade eben in diesem Lauf.
  const current = await db.query<{ version: number }>(
    `SELECT version FROM academy_mcp_schema_meta WHERE id = TRUE`,
  );
  // Bestandsdaten erkennen: gibt es schon registrierte Clients oder lebende
  // Tokens, obwohl keine Versionsangabe existiert? Dann ist die Datenbank nicht
  // frisch, und das Eintragen der Datei-Version waere geraten statt gewusst
  // (Fable-R9 #4). Wir pruefen nur eigene Tabellen — die Prisma-Tabellen der
  // Academy gehoeren uns nicht und sind auf einer frischen Installation
  // ohnehin gefuellt, was hier ein falsches „Bestand" ergaebe.
  const bestand = await db.query<{ vorhanden: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM academy_mcp_oauth_clients
                    UNION ALL SELECT 1 FROM academy_mcp_oauth_access_tokens) AS vorhanden`,
  );

  const action = decideSchemaAction(
    current.rows[0]?.version,
    fileVersion,
    bestand.rows[0]?.vorhanden === true,
  );

  if (action.kind === "abbruch") throw new Error(action.message);
  if (action.kind === "record") {
    await db.query(
      `INSERT INTO academy_mcp_schema_meta (id, version) VALUES (TRUE, $1)
       ON CONFLICT (id) DO NOTHING`,
      [action.version],
    );
    console.error(`[academy-migrate] Schema angelegt, Version ${action.version}`);
  } else {
    console.error(`[academy-migrate] Schema aktuell (Version ${action.version}), nichts anzuwenden`);
  }

  if (process.argv.includes("--seed-dev")) {
    const seed = readFileSync(findSqlFile("seed-dev.sql"), "utf8");
    await db.query(seed);
    console.error("[academy-migrate] seed-dev.sql applied (Platzhalter-Tenant test-agentur)");
  }
}

// Nur laufen lassen, wenn direkt gestartet — sonst kann ein Test die
// Hilfsfunktionen importieren, ohne eine Migration auszuloesen.
const isDirectRun =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  runMigration()
    .then(() => closeDb())
    .catch((err) => {
      console.error("[academy-migrate] FAILED:", (err as Error)?.message ?? err);
      process.exitCode = 1;
      return closeDb();
    });
}
