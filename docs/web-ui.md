# Web UI (M4-WP5)

Single page application React 19 + TypeScript (Vite), compilata e incorporata nel binario cloud. In M4 contiene solo l'**area utente**; la console admin arriva in M5 (`/admin` è un segnaposto visibile solo al ruolo realm `memobrain-admin`).

## Struttura

| Percorso                   | Contenuto                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/`                     | App (`@memobrain/web`): `src/auth` (OIDC, guardie), `src/api` (hook react-query), `src/pages`, `src/layout`, `src/i18n` (it/en), `e2e/` (Playwright) |
| `packages/ui`              | Design system (`@memobrain/ui`): token CSS chiaro/scuro, tabella, form, bottone, dialog, badge, barra quota, empty state, toast, errore inline       |
| `packages/api-client`      | Client openapi-fetch generato da `api/openapi.yaml`; `unwrap()` lancia `ApiError` con `status` e `code` RFC 9457                                     |
| `services/cloud/web-embed` | Pacchetto Go con `go:embed` di `dist/`, fallback SPA, CSP, header di sicurezza, cache                                                                |

Rotte: `/usage` (Spazio utilizzato), `/vaults`, `/devices`, `/shares`, `/admin` (placeholder), `/auth/callback` (pubblica). Il download ZIP è rinviato a M5.

## Flusso di autenticazione

1. All'avvio la SPA legge `GET /api/v1/client-config` (pubblico): `issuer`, `web_client_id` (default `memobrain-web`, env `OIDC_WEB_CLIENT_ID`), `audience`.
2. `oidc-client-ts` esegue Authorization Code + PKCE (S256) contro Keycloak con il client pubblico `memobrain-web`; redirect `<origin>/auth/callback`. Le redirect URI del realm (`deploy/keycloak/realm-memobrain.json`) coprono `http://localhost:5174/*` e `http://localhost:18081/*`.
3. Token e stato PKCE stanno solo in `sessionStorage` (spariscono alla chiusura della scheda). Il rinnovo è automatico con il refresh token (nessun iframe: la CSP lo vieterebbe); se il rinnovo fallisce, a scadenza del token l'utente viene scollegato localmente e la guardia lo rimanda al login. Una risposta `401` dall'API riavvia il login.
4. `RequireAuth` reindirizza gli anonimi al login ricordando il percorso richiesto (`state.returnTo`, accettati solo percorsi same-origin). `RequireRole` mostra "Non consentito" senza il ruolo; l'admin è letto da `realm_access.roles` dell'access token (solo per la UI: l'autorizzazione vera resta sul server).

## CSP, SRI, cache

`web-embed` risponde con `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' <origine dell'issuer>; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`, più `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy`. HSTS non è impostato dall'app (il TLS termina all'ingress).

- Niente script o stile inline: la barra quota usa `<progress>` (nativo), il build non emette `<style>`/`style=`, `modulePreload.polyfill` è disattivato.
- **SRI**: il plugin `web/vite-plugin-sri.ts` aggiunge `integrity="sha384-…"` e `crossorigin` a script e stylesheet di `index.html` dopo la scrittura del bundle.
- Cache: `/assets/*` (nome con hash) `public, max-age=31536000, immutable`; `index.html` e gli altri file `no-cache`. Percorsi non-API senza estensione → `index.html` (fallback SPA); file mancante con estensione → 404; `/api/*` non è mai oscurato (404 `problem+json` dell'API).
- Il router monta la SPA nel `NotFound` (`httpserver.Deps.WebUI`), quindi `/api/*`, `/metrics` e `/events` restano invariati.

Hook di test OIDC: con `VITE_E2E=1` (solo `vite dev`/Playwright) `main.tsx` carica `auth/e2e.ts`, che legge l'utente da `sessionStorage['memobrain.e2e.user']`. `import.meta.env.VITE_E2E` è una costante di build: nei build di produzione il ramo e il modulo spariscono (verificabile con `grep -r "memobrain.e2e" web/dist`).

## Comandi

```sh
make dev-web          # vite su :5174, proxy /api -> :18081 (serve make stack-up + make dev-cloud)
make web-build        # build + copia in services/cloud/web-embed/dist (poi make build-cloud)
make web-clean        # ripristina il placeholder index.html (richiede il file tracciato in git)
yarn workspace @memobrain/web run test     # Vitest + Testing Library
yarn workspace @memobrain/ui run test
make e2e-web          # Playwright (Chromium), API mockata con page.route
```

`dist/` è ignorato da git tranne il placeholder `services/cloud/web-embed/dist/index.html`, così `go build` funziona senza costruire la SPA (la pagina mostra solo un avviso). Dopo `make web-build` il placeholder risulta modificato: non committarlo.

Sviluppo con login reale: `make stack-up`, `make dev-cloud` (WEB_UI_ORIGIN=http://localhost:5174), `make dev-web`, poi `http://localhost:5174` (utenti `user1`/`user2`/`admin`, password `memobrain-dev-password`). Per provare il binario con la SPA incorporata: `make web-build build-cloud` e aprire `http://127.0.0.1:18081`.
