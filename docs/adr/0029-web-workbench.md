# ADR-0029 — Workbench del vault nella Web UI (M9)

|                       |                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | proposta                                                                                                                                                             |
| **Data**              | 2026-10-29                                                                                                                                                           |
| **Riferimenti spec**  | §0.1 punto 3, A-03, §2.8, §3.4.1, §3.8.1, §4.4, tabella rischi (Web UI anello debole dell'E2EE); D-02, D-04, D-06; V-02; ADR-0020, ADR-0025, ADR-0030                |
| **Devia dallo spec?** | sì (A-03, §0.1, §2.8, §4.4, tabella rischi) → richiede aggiornamento di `Specifications.md` da parte dell'owner; testo proposto in "Proposta di modifica dello spec" |

## Contesto

Lo spec limita la Web UI del cloud a console amministrativa e area utente (quota, dispositivi, condivisioni, download ZIP): A-03 dice esplicitamente che "la Web UI del cloud non è un editor". L'owner chiede che dalla Web UI si possa gestire il vault **con le stesse funzioni e le stesse interfacce del client desktop** (`apps/desktop/frontend`), funzionanti e con lo stesso comportamento.

Vincoli che restano validi:

- il server non interpreta il contenuto e non fa merge (§3.4.1): ordina, versiona e conserva blob;
- vault privati E2EE: path e contenuto opachi al server (D-02);
- perimetro per-vault, nessuna funzione cross-vault (D-06);
- architettura chiusa, niente CSS o `<style>` dell'utente (V-02);
- Excalidraw offline, senza richieste di rete.

Stato del codice che rende la richiesta praticabile:

- il frontend desktop accede al backend solo tramite i binding Wails (`src/app/api.ts` → `wailsjs/go/app/*`, che chiamano `window.go.app[Svc][Method]`), più gli eventi `window.runtime.EventsOn*`;
- il mock e2e (`src/test/wails-mock`) installa proprio `window.go`/`window.runtime` e fa già girare l'intera UI in un browser.

## Decisione

1. **Il browser è un dispositivo come gli altri.**
   - Il workbench web registra un dispositivo (`POST /me/devices`, `platform: "web"`, uno per profilo del browser, id in IndexedDB), revocabile da Dispositivi.
   - Apre un vault cloud con lo stesso flusso di "Collega vault esistente": copia locale in OPFS, pull, indice locale, commit con `base_rev`, merge sul client.
   - Il protocollo di sync e le API restano invariati: nessuna API di contenuto nuova, il server resta cieco al contenuto.
2. **Stessa logica, stessa UI.**
   - La logica è il core Go del desktop compilato in WASM ed eseguito in un Web Worker (ADR-0030).
   - La UI è quella del desktop, estratta in `packages/workbench` (`@memobrain/workbench`) e condivisa dalle due app.
   - Un bridge in `web/src/workbench/` installa `window.go`/`window.runtime` sopra un RPC verso il worker: i binding generati non cambiano.
3. **Route.**
   - `/vaults/:id/open`, raggiungibile dal pulsante "Apri" in "I miei vault" e sui mount.
   - Il chunk del workbench è caricato in modo lazy; la console resta entro il suo budget (ADR-0020) e il workbench ha un budget separato.
4. **Online-first con cache.**
   - Copia del vault e database (`index.db`, `sync.db`) in OPFS.
   - Le modifiche fatte durante brevi disconnessioni restano in coda (outbox del sync engine).
   - Nessun service worker né installazione PWA: serve una sessione OIDC valida.
5. **Una scheda per vault.** Un Web Lock per vault (gli handle sincroni OPFS sono esclusivi). Una seconda scheda mostra "vault aperto in un'altra scheda", come l'istanza singola del desktop.
6. **Vault privati modificabili.**
   - Sblocco con passphrase o recovery key (`VaultCryptoAPI.Unlock`, stessa UI del desktop).
   - La VMK resta solo in memoria nel worker.
   - Blocco per inattività (default 15 min, configurabile nel Config Profile).
   - Al blocco, al logout e con "Dimentica questo browser" la copia OPFS in chiaro del vault privato viene **cancellata**: sul web il dato decifrato non sopravvive alla sessione.
7. **Eccezioni di parità** (non applicabili al web, elencate in `docs/web-workbench-parity.md`):

   | Funzione desktop                                                  | Sul web                                                |
   | ----------------------------------------------------------------- | ------------------------------------------------------ |
   | Updater                                                           | Non serve: la Web UI è servita dal cloud               |
   | Vault su cartella locale (`PickFolder`, "Apri un'altra cartella") | Solo vault cloud                                       |
   | Controllo della cifratura del disco                               | Non applicabile                                        |
   | Deep link `memobrain://`                                          | Route URL                                              |
   | Finestra nativa e schermo intero                                  | Fullscreen API                                         |
   | Dialoghi nativi di salvataggio e stampa                           | `showSaveFilePicker` o download Blob, `window.print()` |
   | Selezione di file per l'importer                                  | `<input type=file>` / `showDirectoryPicker`            |

   Ogni altra funzione (editor nelle tre modalità, ricerca, link e rename, grafo, canvas, Excalidraw, Bases, template, daily e unique note, composer, segnalibri, workspace, slide, export, importer, history locale e cloud, conflitti, condivisione, impostazioni, hotkey, palette) deve essere presente, con un test in `web` che la copre.

8. **Sicurezza della pagina.**
   - CSP dedicata alla route del workbench, derivata da quella di produzione del desktop (`apps/desktop/internal/app/csp_prod.go`): `script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`, `connect-src 'self' <issuer>`, `frame-ancestors 'none'`.
   - Gli stili dinamici di CodeMirror ed Excalidraw sono ammessi solo su quella route (nonce dove la libreria lo supporta, altrimenti `'unsafe-inline'` limitato agli stili).
   - Gli asset hanno SRI; la sanificazione con DOMPurify è invariata (V-02).
   - La console continua a usare la CSP attuale.
9. **Feature flag.** `web_workbench` nel Config Profile (feature, acceso di default) (default `true`) permette all'amministratore di disattivare il workbench per gruppo.

## Proposta di modifica dello spec

- **A-03:** "La Web UI del cloud comprende console amministrativa, area utente e un workbench del vault con le stesse funzioni del client desktop, salvo le eccezioni di ADR-0029 (updater, vault su cartella locale, integrazioni native del sistema operativo). Il workbench web è un dispositivo di sync come gli altri: online-first, con cache locale nel browser."
- **§0.1 punto 3:** aggiungere "workbench del vault (modifica nel browser)".
- **§2.8.2:** nuova schermata "Apri vault" con il rimando a ADR-0029.
- **§4.4:** aggiungere `src/workbench/` (bridge e worker) e il pacchetto `packages/workbench`.
- **§3.8.1 e tabella rischi:** "JavaScript servito dal server" vale ora anche per la scrittura dei vault privati. Mitigazioni: CSP, SRI, blocco per inattività, cancellazione della cache in chiaro, possibilità di disattivare il workbench con il feature flag; il client desktop firmato resta il percorso ad alta fiducia.

## Esito dell'implementazione (M9-WP5, 2026-10-29)

Scostamenti dalla decisione scritta sopra, emersi realizzandola:

- **Pagina a sé.** Il workbench non è una route lazy della SPA ma il documento `workbench.html`, servito per `/vaults/:id/open`: il CSS di un chunk dinamico finisce nel bundle dell'ingresso (esbuild non lo separa) e lo stile globale della UI desktop avrebbe cambiato la console. "Apri" è un link con caricamento completo; anche il ritorno al login passa da un caricamento completo.
- **Un workbench per browser** (Web Lock `memobrain-workbench`), non per vault, perché gli handle sincroni di OPFS e il pool di SQLite sono esclusivi per l'origine.
- **Cancellazione della copia in chiaro** (punto 6): implementata per il blocco e per l'inattività (15 minuti, fissi) in `launch.ts` (`lockAndForget`: `VaultCryptoAPI.Lock`, `CloseVault`, rimozione della cartella OPFS e dei database del vault); il logout e «Dimentica questo browser» sono fatti in WP7 (`forgetThisBrowser`: rimuove la cartella OPFS `fs` e il pool SQLite; si ferma se un workbench è aperto in un'altra scheda, perché ne tiene bloccati i file).
- **CSP** (punto 8): la politica dedicata è in `web-embed.WorkbenchCSP`; `worker-src 'self' blob:` e `connect-src 'self' blob:` più l'issuer bastano (verificato in un browser vero: nessuna violazione). `blob:` in `connect-src` serve ai download e alle risorse del vault; in `worker-src` serve solo al worker del core (vedi SRI). La console non ammette `blob:`.
- **SRI** (punto 8, rivisto 2026-11-01). Cosa è verificato e cosa no:
  - **Console:** è costruita senza code splitting, quindi è un solo file JS più un CSS, entrambi con `integrity` nel tag. Tutto il codice della console è coperto (non ha parti lazy, il budget non cambia).
  - **Worker del core** (Go WASM, sync, VMK): `new Worker()` non accetta `integrity`. La pagina scarica lo script con `fetch(url, { integrity })`, usando lo SHA-384 calcolato dalla build e incluso nel bundle del workbench (a sua volta caricato con SRI), e avvia il worker da un URL `blob:` dei byte verificati (`VerifiedWorker` in `bridge.ts`). Uno script alterato non parte e la pagina mostra l'errore (test in `e2e-security/workbench-csp.spec.ts`). Il bundle del worker deve restare autosufficiente, senza import (la build lo controlla), e risolvere gli URL su `location.origin`.
  - **WASM** (core e sqlite): `fetchChecked` nel worker usa sempre l'`integrity` registrata dalla build. Un hash mancante è un errore, non un controllo saltato; solo le build E2E (`MEMOBRAIN_E2E`, costante eliminata in produzione) lo ammettono. La catena pagina → worker → WASM è quindi verificata per intero.
  - **Chunk, worker ed Excalidraw** (chiusura delle lacune, W8 lotto C2, 2026-11-01). Il code splitting resta (tutto nel file iniziale porterebbe il workbench da circa 2,5 MB a circa 12,8 MB, oltre il budget di ADR-0020), e i chunk sono fissati da un **import map** inline in `workbench.html` con il campo `integrity` per ogni chunk JS della build, statico o lazy (Chromium 127+, Firefox 138+; gli altri browser ignorano il campo). È l'unico script inline della pagina: `web-embed` calcola all'avvio lo SHA-256 dell'import map dal `workbench.html` incorporato e lo aggiunge a `script-src` della `WorkbenchCSP` (`ImportMapHashes`); `'unsafe-inline'` resta vietato. Lo script classico `/excalidraw-assets/excalidraw.js` è aggiunto da un tag con `integrity`; il worker del layout del grafo (ora con nome hashato) e quello di pdf.js partono, come il core, da un URL `blob:` dei byte scaricati con `fetch` + `integrity` (`web/src/workbench/sri.ts`). Il collegamento è fatto dalla build web (plugin `verified-loaders` in `web/scripts/esbuild.mjs`), senza toccare il comportamento del desktop: per il layout la build sostituisce la chiamata `new Worker('/assets/layout.worker.js')` di `graph/layoutHost.ts` e fallisce se non la trova. Test: `TestEveryEmbeddedScriptIsPinned` (ogni script della build è raggiungibile da una catena di SRI che parte dalle pagine) e gli e2e di `e2e-security` con chunk, worker di pdf.js ed `excalidraw.js` alterati. Nessuno script della build resta senza verifica nei browser che supportano l'`integrity` dell'import map.
  - **Limite di fondo:** SRI protegge da file alterati tra il server e il browser (cache, CDN, proxy) o sostituiti nello storage degli asset. Non protegge da un server d'origine compromesso, che serve anche l'HTML con gli hash: per i vault privati il percorso ad alta fiducia resta il client desktop firmato.
- **Feature flag** (punto 9): si chiama `web_workbench` (le feature del Config Profile sono booleani piatti) ed è implementato in WP6, acceso di default.

## Alternative considerate

- **Web UI di sola consultazione**: scartata, non soddisfa la parità richiesta.
- **Port della logica in TypeScript**: scartato in ADR-0030 (due implementazioni da tenere allineate).
- **Calcolo lato server (indice e ricerca nel cloud)**: scartato. Viola §3.4.1, non funziona sui vault privati E2EE e sposta il carico sul server.
- **Workbench solo per i vault condivisi**: scartato dall'owner, che vuole anche i privati.
- **PWA offline completa**: rinviata. Richiede token offline, aggiornamento controllato degli asset e una politica di conservazione dei dati in chiaro che oggi non c'è.

## Conseguenze

- La Web UI diventa un client di sync completo. Gli e2e e i test di sync devono coprire anche il browser (web ↔ desktop, conflitti `.md` fusi, copie di conflitto per `.canvas`/`.excalidraw`).
- Lo spostamento del frontend in `packages/workbench` tocca molti file, ma è meccanico. Il desktop deve restare verde a ogni passo (`make e2e`, build Wails).
- Il bundle del workbench è grande (WASM, Excalidraw, mermaid, pdfjs). È accettato con caricamento lazy e budget separato.
- Il modello di fiducia della Web UI si allarga alla scrittura dei vault privati. Il limite è documentato e mitigato; l'audit crittografico esterno (M7-WP2) deve includerlo.
- Da rivalutare dopo il primo rilascio: PWA offline, apertura di più vault in schede diverse, condivisione della cache tra schede.
