/**
 * Gebrandete Seiten-Huelle — Familien-Design mit Wortmarke fuer ALLE
 * Auth-Folgeseiten (Check-Email, Verbunden, Provider-Fehler).
 *
 * S1909-Nachfix (Matthias-Fund): die erste Fassung hatte nur Farben gedreht,
 * ohne Wortmarke/Branding. Jede Nicht-Login-Seite laeuft jetzt hier durch,
 * damit strukturell keine Seite mehr am Familien-Design vorbei entstehen
 * kann. Referenz: mcp-nex saas/oauth.ts (das Login, das alle Schwester-
 * Server tragen). Ein Quelltext-Waechter (tests/) verbietet zusaetzlich
 * helle Alt-Farben in src/-HTML.
 */

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function brandedPageShell(locale: string, title: string, innerHtml: string): string {
  return `<!DOCTYPE html>
<html lang="${locale}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>StudioMeyer Academy — ${escHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Plus+Jakarta+Sans:wght@300;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,sans-serif;background:#0a0a0a;color:#fafafa;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
.card{background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.08);border-radius:1rem;padding:40px;max-width:440px;width:100%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.4),0 0 40px rgba(245,235,220,0.02)}
.brand{margin-bottom:18px;opacity:0.85;display:flex;justify-content:center}
.brand svg{display:block;height:14px;width:auto}
h1{font-family:'Plus Jakarta Sans',system-ui,sans-serif;font-size:1.5rem;font-weight:700;letter-spacing:-0.02em;margin-bottom:4px}
h2{font-family:'Plus Jakarta Sans',system-ui,sans-serif;font-size:1.2rem;font-weight:700;margin-bottom:8px}
.icon{font-size:48px;margin:16px 0}
.email{color:#C9A96E;font-weight:600}
p{color:#b5b5b5;line-height:1.6;margin-top:12px}
.hint{color:#525252;font-size:0.82rem;margin-top:20px}
pre{background:rgba(255,255,255,0.06);color:#C9A96E;padding:16px;display:inline-block;border-radius:8px;margin-top:12px;max-width:100%;overflow-x:auto}
</style></head><body>
<div class="card">
<div class="brand"><svg viewBox="0 0 420 50" xmlns="http://www.w3.org/2000/svg" aria-label="StudioMeyer"><text x="0" y="38" font-family="'Plus Jakarta Sans', sans-serif" font-weight="300" font-size="40" letter-spacing="3" fill="#f5efe6">studio meyer<tspan font-weight="600" fill="#c9a96e">.</tspan></text></svg></div>
<h1>StudioMeyer Academy</h1>
${innerHtml}
</div></body></html>`;
}
