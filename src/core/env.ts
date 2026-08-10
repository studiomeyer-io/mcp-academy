/**
 * Zahlen-Regler aus der Umgebung — fail-closed geparst.
 *
 * Warum das eine eigene Datei ist (Fable-R8, Finding 2):
 * `parseInt(process.env.X || "60", 10)` gibt bei jedem nicht-numerischen Wert
 * NaN zurueck, und JEDER Vergleich gegen NaN ist `false`. Eine Schranke mit
 * NaN-Limit laesst damit alles durch — lautlos, bei gruenem /health, ohne eine
 * einzige Warnzeile. Gemessen: `ACADEMY_MCP_RATE_IP_PER_MIN=off` liess 300 von 300
 * Requests aus EINER IP durch (statt 60); mit den Mail-Caps auf `none` gingen
 * 300 von 300 Magic-Links an EIN fremdes Postfach — also genau das Primitiv
 * zurueck, das die Runden R1 und R4 geschlossen hatten.
 *
 * `parseInt` hat eine zweite Falle: es schneidet stillschweigend ab.
 * `parseInt("60s")` ist 60. Bei `ACADEMY_MCP_MAIL_COOLDOWN_MS` steht die Einheit im
 * Namen, also schreibt frueher oder spaeter jemand `60s` und meint 60 Sekunden
 * — bekommt aber 60 Millisekunden und damit praktisch keinen Cooldown.
 * `Number("60s")` ist NaN und fliegt hier auf.
 *
 * Deshalb: ungueltiger Wert = Startabbruch, dieselbe Haltung wie
 * `assertBaseUrlUsable()`. Ein Dienst, der nicht hochkommt, ist ein sichtbares
 * Problem. Ein Dienst, der ohne Schranke laeuft, ist ein unsichtbares.
 */

export class EnvConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvConfigError";
  }
}

interface NumEnvOptions {
  /**
   * Kleinster zulaessiger Wert (inklusive). Default 1.
   *
   * Der Default ist bewusst 1 und nicht 0, weil die meisten Regler hier
   * ZAEHLGRENZEN sind ("wieviel ist erlaubt"). Dort ist eine 0 mehrdeutig —
   * sie liest sich als „nichts erlaubt", ist aber genauso gut als
   * „unbegrenzt" gemeint, und beim naechsten Leser kippt die Deutung.
   *
   * Bei WARTEZEITEN ist 0 dagegen eindeutig und nuetzlich ("keine Sperrzeit"):
   * die Pruefungen der Runden 4 und 5 setzen den Cooldown auf 0, um die
   * darunterliegende Tagesgrenze einzeln messen zu koennen — vorher verdeckte
   * der Cooldown sie, und die Pruefung prueft dann nichts. Solche Regler
   * setzen `min: 0` ausdruecklich.
   */
  min?: number;
  max?: number;
  /** Nicht-ganzzahlige Werte zulassen (Default: nein — alle Regler hier sind Zaehler/Millisekunden). */
  allowFloat?: boolean;
}

/**
 * Liest einen numerischen Regler. Fehlt er oder ist er leer, gilt `fallback`.
 * Ist er gesetzt aber unbrauchbar, wirft diese Funktion — der Aufrufer steht
 * auf Modulebene, ein Wurf dort bricht den Start ab.
 */
export function numEnv(name: string, fallback: number, opts: NumEnvOptions = {}): number {
  const { min = 1, max = Number.MAX_SAFE_INTEGER, allowFloat = false } = opts;

  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const trimmed = raw.trim();
  const value = Number(trimmed);

  if (!Number.isFinite(value)) {
    throw new EnvConfigError(
      `${name}="${trimmed}" ist keine Zahl. Eine Schranke mit ungueltigem Limit wuerde alles ` +
        `durchlassen, ohne das zu melden — deshalb startet der Server nicht. ` +
        `Erwartet: ganze Zahl zwischen ${min} und ${max}. Variable weglassen = Default ${fallback}.`,
    );
  }
  if (!allowFloat && !Number.isInteger(value)) {
    throw new EnvConfigError(`${name}="${trimmed}" muss eine ganze Zahl sein (bekommen: ${value}).`);
  }
  if (value < min || value > max) {
    throw new EnvConfigError(
      `${name}=${value} liegt ausserhalb des zulaessigen Bereichs ${min}..${max}. ` +
        `Ein Limit von 0 oder darunter waere eine abgeschaltete Schranke — die wird hier nicht ` +
        `stillschweigend akzeptiert.`,
    );
  }
  return value;
}
