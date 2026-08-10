/**
 * Magic-Link email sender. Faellt auf console.error zurueck wenn SMTP nicht
 * konfiguriert ist (Dev-Modus: Link steht dann im Server-Log).
 * Helles StudioMeyer-Layout (weiss + Gold-Akzent) — Mails sind bewusst hell
 * (Mail-Regel: Outlook/Spam/Lesbarkeit), das Web-Login ist dunkel.
 */

import { createTransport, type Transporter } from "nodemailer";
import { numEnv } from "../core/env.js";
import { getHost, isLoopbackHost } from "../core/base-url.js";

let transport: Transporter | null = null;

/**
 * Die Mail-Konfiguration beim Start pruefen (Fable-R10 #1, erweitert in R11 #3).
 *
 * R10 hat hier nur SMTP_PORT geprueft — also ausgerechnet den Regler, der
 * kaum je falsch ist. Die gefaehrliche Klasse liegt daneben und ist gar nicht
 * numerisch: faellt SMTP_PASS beim naechsten Passwort-Wechsel aus der `.env`
 * oder verrutscht der Name zu `SMTP_PASSWORD`, liefert `getTransport()` still
 * `null`, der Magic-Link landet nur im stderr — und der Anmelde-Handler zeigt
 * dem Nutzer trotzdem „Schau in dein Postfach". Jede Anmeldung schlaegt dann
 * lautlos fehl, bei gruenem Health-Endpunkt, ohne Alarm. Genau die Klasse
 * „faellt erst am Kunden auf", gegen die der R10-Fix gebaut war.
 *
 * Zwei Regeln, dieselbe Haltung wie `assertBaseUrlUsable`:
 *   - Eine TEILWEISE gesetzte SMTP-Konfiguration ist IMMER ein Fehler. Niemand
 *     setzt absichtlich Host und User, aber kein Passwort.
 *   - Wer nicht auf Loopback bindet, laeuft in Produktion und braucht Mail —
 *     ohne sie kann sich niemand anmelden, der Dienst waere eine Attrappe.
 *
 * Bewusst NICHT geaendert: die Antwort des Anmelde-Handlers. Sie ist absichtlich
 * unabhaengig davon, ob wirklich gesendet wurde (R1 — sonst waere sie ein
 * Orakel dafuer, welche Adressen es gibt). Der richtige Ort ist der Start.
 */
export function validateMailEnv(): void {
  numEnv("SMTP_PORT", 587, { min: 1, max: 65535 });

  const teile = { SMTP_HOST: process.env.SMTP_HOST, SMTP_USER: process.env.SMTP_USER, SMTP_PASS: process.env.SMTP_PASS };
  const gesetzt = Object.entries(teile).filter(([, v]) => (v ?? "").trim() !== "").map(([k]) => k);
  const fehlend = Object.keys(teile).filter((k) => !gesetzt.includes(k));

  if (gesetzt.length > 0 && fehlend.length > 0) {
    throw new Error(
      `SMTP ist nur halb konfiguriert: gesetzt sind ${gesetzt.join(", ")}, es fehlen ` +
        `${fehlend.join(", ")}. So verschickt der Server keine Magic-Links, zeigt dem ` +
        `Nutzer aber trotzdem „Schau in dein Postfach" — jede Anmeldung schluege still fehl. ` +
        `Entweder alle drei setzen oder alle drei weglassen (Dev-Modus: Link steht dann im Log).`,
    );
  }

  if (gesetzt.length === 0 && !isLoopbackHost()) {
    throw new Error(
      `Der Server bindet auf ${getHost()} (nicht Loopback), also produktiv — ` +
        `dann ist SMTP Pflicht (SMTP_HOST, SMTP_USER, SMTP_PASS). Ohne Mailversand kann sich ` +
        `niemand anmelden, und der Anmelde-Pfad wuerde das nicht anzeigen.`,
    );
  }
}

function getTransport(): Transporter | null {
  if (transport) return transport;
  const host = process.env.SMTP_HOST;
  const port = numEnv("SMTP_PORT", 587, { min: 1, max: 65535 });
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  transport = createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  return transport;
}

/** Test-only: Transport ersetzen (npm-test-mail-guard-Regel — nie echte Mails aus Tests). */
export function __setTransportForTest(replacement: Transporter | null): void {
  transport = replacement;
}

export async function sendMagicLinkEmail(email: string, verifyUrl: string): Promise<void> {
  const t = getTransport();
  if (!t) {
    console.error(`[academy-mail] SMTP not configured — magic link for ${email}: ${verifyUrl}`);
    return;
  }

  // WOERTLICH die Memory-Mail (mcp-nex email-verify.ts, Matthias: "mach es
  // halt wie beim memory") — nur Memory→Suite. S1909-Fund an der Vorfassung:
  // ein ERFUNDENES "S"-Logo-Badge (Vorschau las "SStudioMeyer…") und
  // Produktnamen-Mischmasch. Regel: die Marke ist IMMER ausgeschrieben,
  // nie ein Monogramm — und kein Wort weicht ohne Grund von der Referenz ab.
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #1a1a2e;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #C9A96E; font-size: 24px; margin: 0;">StudioMeyer Academy</h1>
    <p style="color: #666; margin: 5px 0 0;">Sign in to your course</p>
  </div>

  <div style="background: #f8f9fa; border-radius: 12px; padding: 30px; margin-bottom: 20px;">
    <h2 style="margin: 0 0 15px; font-size: 20px;">Sign in</h2>
    <p style="line-height: 1.6; margin: 0 0 20px;">
      Click the button below to connect the Academy course to Claude, ChatGPT, Cursor or your MCP client.
    </p>

    <div style="text-align: center; margin: 25px 0;">
      <a href="${verifyUrl}" style="display: inline-block; background: #C9A96E; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">
        Sign In &amp; Connect
      </a>
    </div>

    <p style="color: #666; font-size: 14px; margin: 0; word-break: break-all;">
      Or copy this link: <a href="${verifyUrl}" style="color: #C9A96E;">${verifyUrl}</a>
    </p>
  </div>

  <div style="text-align: center; padding: 20px 0; border-top: 1px solid #eee; color: #999; font-size: 13px;">
    <p style="margin: 0;">This link expires in 10 minutes. If you didn't request this, you can safely ignore it.</p>
    <p style="margin: 5px 0 0;">
      <a href="https://studiomeyer.io" style="color: #C9A96E; text-decoration: none;">StudioMeyer</a> &middot;
      <a href="https://mcp.studiomeyer.academy" style="color: #C9A96E; text-decoration: none;">mcp.studiomeyer.academy</a>
    </p>
  </div>
</body>
</html>`;

  await t.sendMail({
    from: process.env.SMTP_FROM || '"StudioMeyer Academy" <hello@studiomeyer.io>',
    to: email,
    subject: "Sign in to StudioMeyer Academy",
    html,
    text: `Sign in to StudioMeyer Academy\n\nClick this link to sign in:\n${verifyUrl}\n\nThis link expires in 10 minutes.\nIf you didn't request this, you can safely ignore it.\n\nhttps://mcp.studiomeyer.academy`,
  });
}
