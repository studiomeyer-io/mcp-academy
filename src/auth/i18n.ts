/**
 * Tiny i18n helper fuer die OAuth-Login-Seiten.
 *
 * Locale aus Accept-Language, optionaler `?lang=`-Override, Fallback en.
 * Inline statt Library: ~20 Strings, keine Plural-Regeln.
 */

import type { IncomingMessage } from "node:http";

export type Locale = "de" | "en" | "es";

export const LOCALES: readonly Locale[] = ["de", "en", "es"] as const;

interface Strings {
  signin_title: string;
  signin_subtitle: string;
  permissions_header: string;
  permission_course: string;
  permission_progress: string;
  permission_tutor: string;
  continue_with_google: string;
  continue_with_discord: string;
  or_with_email: string;
  email_label: string;
  email_placeholder: string;
  send_magic_link: string;
  email_sent_title: string;
  email_sent_to: string;
  email_sent_body: string;
  email_sent_hint: string;
  footer_powered: string;
  footer_privacy: string;
  provider_error_title: string;
  provider_error_body: string;
}

const DICT: Record<Locale, Strings> = {
  de: {
    signin_title: "Bei der StudioMeyer Academy anmelden",
    signin_subtitle:
      "Der Kurs merkt sich dann, wo du stehst — Fortschritt, Quiz, Wiederholung und Zertifikat. Der Lehrstoff selbst ist und bleibt kostenlos.",
    permissions_header: "Dieser Client darf",
    permission_course: "Den Kurs in deiner KI lesen und mit ihr durcharbeiten",
    permission_progress: "Deinen Fortschritt speichern — Lektionen, Quiz, Wiederholungen, Zertifikate",
    permission_tutor: "Den KI-Tutor zu Lektionen befragen",
    continue_with_google: "Mit Google anmelden",
    continue_with_discord: "Mit Discord anmelden",
    or_with_email: "oder per Email",
    email_label: "E-Mail-Adresse",
    email_placeholder: "du@deinunternehmen.de",
    send_magic_link: "Magic Link senden",
    email_sent_title: "Schau in dein Postfach",
    email_sent_to: "Wir haben dir einen Sign-in-Link geschickt an",
    email_sent_body:
      "Klick den Link innerhalb von 10 Minuten, um dich anzumelden.",
    email_sent_hint: "Keine Mail bekommen? Spam-Ordner pruefen oder erneut versuchen.",
    footer_powered: "Powered by",
    footer_privacy: "Magic Links laufen in 10 Minuten ab",
    provider_error_title: "Login nicht moeglich",
    provider_error_body: "Der externe Login ist fehlgeschlagen. Versuch es bitte erneut oder nutze den Magic Link per E-Mail.",
  },
  en: {
    signin_title: "Sign in to StudioMeyer Academy",
    signin_subtitle:
      "Connect your AI to your StudioMeyer modules — memory, CRM, AI visibility, expert team and academy, right in your chat.",
    permissions_header: "This client will be able to",
    permission_course: "Read and work through the course inside your AI",
    permission_progress: "Keep your progress — lessons, quizzes, review, certificates",
    permission_tutor: "Ask the AI tutor about a lesson",
    continue_with_google: "Continue with Google",
    continue_with_discord: "Continue with Discord",
    or_with_email: "or with email",
    email_label: "Email address",
    email_placeholder: "you@yourcompany.com",
    send_magic_link: "Send magic link",
    email_sent_title: "Check your email",
    email_sent_to: "We sent a sign-in link to",
    email_sent_body:
      "Click the link within 10 minutes to sign in.",
    email_sent_hint: "No email? Check your spam folder or try again.",
    footer_powered: "Powered by",
    footer_privacy: "Magic links expire after 10 minutes",
    provider_error_title: "Sign-in failed",
    provider_error_body: "The external sign-in failed. Please try again or use the magic-link by email.",
  },
  es: {
    signin_title: "Entrar en StudioMeyer Academy",
    signin_subtitle:
      "El curso recordara donde lo dejaste — progreso, cuestionarios, repaso y certificado. El material en si es y sigue siendo gratuito.",
    permissions_header: "Este cliente podra",
    permission_course: "Leer y seguir el curso dentro de tu IA",
    permission_progress: "Guardar tu progreso — lecciones, cuestionarios, repaso, certificados",
    permission_tutor: "Preguntar al tutor de IA sobre una leccion",
    continue_with_google: "Continuar con Google",
    continue_with_discord: "Continuar con Discord",
    or_with_email: "o por email",
    email_label: "Direccion de email",
    email_placeholder: "tu@tuempresa.com",
    send_magic_link: "Enviar enlace magico",
    email_sent_title: "Revisa tu correo",
    email_sent_to: "Te enviamos un enlace de inicio a",
    email_sent_body:
      "Haz clic en el enlace en los proximos 10 minutos para entrar.",
    email_sent_hint: "Sin correo? Revisa la carpeta de spam o intentalo de nuevo.",
    footer_powered: "Desarrollado por",
    footer_privacy: "Los enlaces magicos expiran a los 10 minutos",
    provider_error_title: "Inicio de sesion fallido",
    provider_error_body: "El inicio de sesion externo fallo. Intentalo de nuevo o usa el enlace magico por email.",
  },
};

/**
 * Locale aus einem `Accept-Language`-Header. Erster Treffer aus de/en/es,
 * sonst "en". Robust gegen kaputte Header.
 */
export function detectLocaleFromHeader(acceptLanguage: string | undefined): Locale {
  if (!acceptLanguage) return "en";
  const tags = acceptLanguage
    .split(",")
    .map((t) => (t.trim().split(";")[0] ?? "").toLowerCase().split("-")[0] ?? "")
    .filter((t) => /^[a-z]{2,3}$/.test(t));
  for (const tag of tags) {
    if (LOCALES.includes(tag as Locale)) return tag as Locale;
  }
  return "en";
}

/** Locale aus dem Request: ?lang=de gewinnt, dann Accept-Language, dann en. */
export function detectLocale(req: IncomingMessage, baseUrl: string): Locale {
  try {
    const url = new URL(req.url || "/", baseUrl);
    const override = url.searchParams.get("lang")?.toLowerCase();
    if (override && LOCALES.includes(override as Locale)) return override as Locale;
  } catch {
    /* fall through */
  }
  return detectLocaleFromHeader(req.headers["accept-language"] as string | undefined);
}

/** Lookup mit en-Fallback + `{var}`-Interpolation. */
export function t(
  key: keyof Strings,
  locale: Locale,
  vars?: Record<string, string>,
): string {
  const dict = DICT[locale] ?? DICT.en;
  let value = dict[key] ?? DICT.en[key];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      value = value.replace(new RegExp(`\\{${k}\\}`, "g"), v);
    }
  }
  return value;
}

/** Test-only access. */
export const __DICT_FOR_TEST = DICT;
