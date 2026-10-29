# Web UI (M4-WP5)

Single page application React 19 + TypeScript (esbuild, ADR-0025), compilata e incorporata nel binario cloud. In M4 contiene solo l'**area utente**; la console admin arriva in M5 (`/admin` è un segnaposto visibile solo al ruolo realm `memobrain-admin`).

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
- **SRI**: lo script `web/scripts/esbuild.mjs` (plugin `index-html`) aggiunge `integrity="sha384-…"` e `crossorigin` a script e stylesheet di `index.html` dopo la scrittura del bundle.
- Cache: `/assets/*` (nome con hash) `public, max-age=31536000, immutable`; `index.html` e gli altri file `no-cache`. Percorsi non-API senza estensione → `index.html` (fallback SPA); file mancante con estensione → 404; `/api/*` non è mai oscurato (404 `problem+json` dell'API).
- Il router monta la SPA nel `NotFound` (`httpserver.Deps.WebUI`), quindi `/api/*`, `/metrics` e `/events` restano invariati.

Hook di test OIDC: con `MEMOBRAIN_E2E=1` (solo dev server/Playwright) `main.tsx` carica `auth/e2e.ts`, che legge l'utente da `sessionStorage['memobrain.e2e.user']`. `import.meta.env.MEMOBRAIN_E2E` è una costante (`define` di esbuild) di build: nei build di produzione il ramo e il modulo spariscono (verificabile con `grep -r "memobrain.e2e" web/dist`).

## Workbench del vault (M9-WP5, ADR-0029/0030)

Dalla Web UI si apre un vault nel browser con la stessa interfaccia del desktop. È una **pagina a sé** (`/vaults/:id/open`, con `?share=<id>` per un mount): ha un proprio HTML (`workbench.html`) e un proprio foglio di stile, perché lo stile globale della UI desktop non deve toccare la console. "Apri" nella tabella dei vault e nelle condivisioni accettate è un link, quindi un caricamento completo della pagina.

| Pezzo          | Dove                                     | Cosa fa                                                                                                                                |
| -------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Entry e lancio | `web/src/workbench/{main.tsx,launch.ts}` | login OIDC, blocco a una scheda (Web Locks), avvio del core, collegamento del vault (`OpenVault` + `LinkExisting`), montaggio della UI |
| Worker         | `web/src/workbench/worker.ts`            | file system su OPFS, SQLite (`opfs-sahpool`), host, programma Go                                                                       |
| `fs` su OPFS   | `web/src/workbench/opfs-fs.ts`           | fornisce a Go `fs`, `path` e `process`: il pacchetto `os` del core non cambia                                                          |
| Bridge         | `web/src/workbench/bridge.ts`            | RPC verso il worker, installa `window.go` e `window.runtime` per i moduli Wails generati                                               |
| Inattività     | `web/src/workbench/idle.ts`              | dopo 15 min senza input un vault **privato** si blocca, la copia in chiaro si cancella dal browser e si torna alla console             |

- **Build:** `make web-build` costruisce prima il core (`make wasm-core`) e i binding Wails (`packages/workbench/wailsjs`, se mancano), poi la SPA. `web/scripts/esbuild.mjs` emette `index.html` e `workbench.html`, il worker (`assets/core-worker-<hash>.js`) e `core/*.wasm.gz` con il nome contenente l'hash; l'integrità SHA-384 dei WASM è nel bundle e il worker la verifica con `fetch(..., { integrity })`. Senza il core (nessuna toolchain Go) la pagina lo dice invece di fallire.
- **Budget** (ADR-0020): console 700/1000 kB; workbench 2500/23000 kB; core ≤ 8 MB e sqlite ≤ 1,5 MB, misurati in gzip.
- **Serving** (`services/cloud/web-embed`): `/vaults/:id/open` risponde con `workbench.html` e una CSP dedicata (`style-src 'unsafe-inline'` per CodeMirror/KaTeX/Excalidraw, `worker-src 'self'`, `img-src data: blob:`, `connect-src` con l'issuer e `blob:`; mai script inline, mai `eval`, mai altre origini). I `.wasm` si conservano come `.wasm.gz` e si servono così a chi accetta gzip, decompressi agli altri. La console mantiene la CSP stretta.
- **Una scheda sola:** i file e i database del browser si tengono con handle sincroni esclusivi, quindi un solo workbench per browser (qualsiasi vault). La seconda scheda mostra "già aperto in un'altra scheda".
- **Test:** `web/e2e/opfs-fs.spec.ts` (lo shim `fs`, in un worker vero), `web/e2e/workbench.spec.ts` (UI + core vero: scrittura, ricerca FTS, link, rinomina, storia, download ZIP, grafo, persistenza al reload, blocco e cancellazione), `web/e2e-security/workbench-csp.spec.ts` (build minificata servita dall'handler Go di produzione, senza violazioni CSP né richieste esterne). In build E2E `?local` apre una cartella del browser senza cloud.

## Comandi

```sh
make dev-web          # esbuild su :5174, proxy /api -> :18081 (serve make stack-up + make dev-cloud)
make web-build        # build + copia in services/cloud/web-embed/dist (poi make build-cloud)
make web-clean        # ripristina il placeholder index.html (richiede il file tracciato in git)
yarn workspace @memobrain/web run test     # Vitest + Testing Library
yarn workspace @memobrain/ui run test
make e2e-web          # Playwright (Chromium), API mockata con page.route
```

`dist/` è ignorato da git tranne il placeholder `services/cloud/web-embed/dist/index.html`, così `go build` funziona senza costruire la SPA (la pagina mostra solo un avviso). Dopo `make web-build` il placeholder risulta modificato: non committarlo.

Sviluppo con login reale: `make stack-up`, poi `make dev-cloud` (avvia anche la Web UI su :5174, `WEB=0` per saltarla; log in `.dev/logs/web.log`) oppure `yarn dev:cloud:k3d` (stessa cosa, `--no-web` per saltarla; la Web UI si ferma con `down`/`delete`); `make dev-web` serve solo per avviarla da sola, poi `http://localhost:5174` (utenti `user1`/`user2`/`admin`, password `memobrain-dev-password`). Per provare il binario con la SPA incorporata: `make web-build build-cloud` e aprire `http://127.0.0.1:18081`.
