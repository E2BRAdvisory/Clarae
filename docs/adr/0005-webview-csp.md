# ADR-0005 — Content Security Policy nel webview (SPIKE-05)

|                       |                                                                       |
| --------------------- | --------------------------------------------------------------------- |
| **Stato**             | accettata (verifica manuale CodeMirror/KaTeX/Mermaid sotto CSP in M1) |
| **Data**              | 2026-10-23                                                            |
| **Riferimenti spec**  | §3.7 (CSP restrittiva, niente `unsafe-eval`), D-01                    |
| **Devia dallo spec?** | no                                                                    |

## Contesto

Il frontend è servito dall'asset server di Wails; in sviluppo passa dal dev server Vite (HMR via WebSocket, stili inline). Serve una CSP stretta in produzione senza rompere lo sviluppo.

## Decisione

Due costanti `app.ContentSecurityPolicy` selezionate dal build tag `production` (che `wails build` imposta):

- **Produzione** (`csp_prod.go`): `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`. Niente `unsafe-eval`; `wasm-unsafe-eval` serve all'Argon2id WASM (M2); `style-src 'unsafe-inline'` è richiesto dagli stili calcolati di CodeMirror/KaTeX — non è CSS dell'utente (D-01: nessun CSS personalizzato viene mai caricato).
- **Sviluppo** (`csp_dev.go`): aggiunge `unsafe-inline`/`unsafe-eval` per gli script e `ws://localhost:*` per HMR.

Gli header sono applicati dal middleware `cspMiddleware` in `main.go` (anche `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`). Le chiamate al cloud non passano dal webview (vanno dal backend Go), quindi `connect-src 'self'` basta.

## Alternative considerate

- **Nonce per gli stili** — scartata: CodeMirror e KaTeX impostano `style` dinamicamente; i nonce non coprono gli attributi di stile.
- **CSP via `<meta>`** — scartata: l'header dell'asset server copre tutte le risorse e non dipende dall'HTML.

## Conseguenze

Mermaid in M1 va eseguito con `securityLevel: 'strict'` e senza `unsafe-eval`; se un elemento di rendering richiedesse `eval`, la risposta è isolarlo in un worker, non allargare la CSP.
