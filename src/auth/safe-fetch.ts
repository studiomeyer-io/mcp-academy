/**
 * Outbound-Fetch mit Timeout — native fetch (Node 22), kein undici.
 *
 * Bewusst SCHLANK: hier gehen ausgehende Requests ausschliesslich an
 * HARTKODIERTE URLs (Google/Discord OAuth, Telegram-API) — kein User-Input
 * bestimmt das Ziel. Sobald ein Feature user-kontrollierte URLs fetcht,
 * MUSS der volle SSRF-Guard aus sm-service-mcp nachgezogen werden.
 */

export interface SafeFetchOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export async function safeFetchPublic(url: string, options: SafeFetchOptions = {}): Promise<Response> {
  const { method = "GET", headers, body, timeoutMs = 10_000 } = options;
  const parsed = new URL(url); // wirft bei kaputter URL
  if (parsed.protocol !== "https:") {
    throw new Error(`safe_fetch_https_only: ${parsed.protocol}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method, headers, body, signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
}
