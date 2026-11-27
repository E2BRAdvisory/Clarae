# Changelog

Le note di rilascio di ogni versione sono la sezione `## [X.Y.Z]` di questo file: il workflow di release le allega alla release (`scripts/release/notes.sh`).

Nelle sezioni fino alla 1.1.0 i comandi sono citati come `make <target>`: da prima della 1.2.0 il task runner è [Task](https://taskfile.dev) (ADR-0032) e gli stessi target si eseguono con `task <target>`, per esempio `task e2e`, `task e2e-desktop-prod`, `task test-integration`, `task test-wasm`, `task stack-up`.

## [Unreleased]

## [2.0.1] - 2026-11-27

Sola documentazione sul codice della 2.0.0: lo spec passa dalla 1.12 alla 1.14 e le prove manuali dell'owner del 2026-11-27 sono registrate. Nessun cambiamento del prodotto, del protocollo, delle API né del database: client e cloud 2.0.1 lavorano con client e cloud 2.0.0 e 1.8.x.

### Documentazione

- `Specifications.md` alla **1.14**: registra le prove manuali del 2026-11-27 (Marp a tutto schermo nella WKWebView, cancello A-W8 per intero, runbook m21, m22 e 1.7) e dichiara Flatpak, Snap e macOS Intel fuori dalle prove e dal supporto ufficiale (§2.2.1, §2.3.2, App. A, C.2, C.4).
- `Specifications.md` alla **1.13**: completa il recepimento di [ADR-0070](docs/adr/0070-2-0-senza-rimozione-compatibilita-1x.md) con intestazione, riga del registro delle revisioni e riga in Appendice C.4 (il corpo era già aggiornato nella 2.0.0).
- Prove manuali dell'owner del 2026-11-27 registrate in roadmap, ADR e runbook QA, tutte con esito positivo dichiarato, senza esito per riga: presentazione Marp a tutto schermo nella WKWebView reale (M30; ADR-0048), cancello A-W8 dell'editor Live per intero (IME, controllo ortografico e lettori di schermo sulle tre WebView, incolla da app esterne, note reali grandi, matrice e CSP sulla shell reale; ADR-0049) e runbook [`m21-correttivi.md`](docs/qa/m21-correttivi.md), [`m22-nomi-file-e-applicazioni.md`](docs/qa/m22-nomi-file-e-applicazioni.md) e [`verifica-manuale-1.7.md`](docs/qa/verifica-manuale-1.7.md). Flatpak e Snap: prova non necessaria, non sono pacchetti distribuiti né supportati (i pacchetti sono `.deb` e AppImage). macOS Intel esce dalle matrici di prova: non provato e non supportato ufficialmente, il `.dmg` universal contiene comunque la parte x86_64 (nessuna modifica a build, script o workflow). Avvertenze «non provato» aggiornate in guida utente (applicazioni), guida dell'amministratore (profili, quote e audit) e README.
- [ADR-0005](docs/adr/0005-webview-csp.md): nota sulla CSP dell'editor Live (ProseMirror e il codice Live impostano gli stili solo dal CSSOM; `style-src 'unsafe-inline'` resta per CodeMirror, KaTeX ed Excalidraw). [ADR-0027](docs/adr/0027-slides-note.md): i file `.marp` sono una funzione distinta dalle slide delle note.

### Contratti

- `api/openapi.yaml`: `info.version` a 2.0.1 (stub rigenerati); nessuna operazione nuova né cambiata.

### Verificato

Sull'albero della 2.0.1, tutti i passi di `task ci` verdi: `lint`, `vet-windows`, `vet-linux`, typecheck, `govulncheck`, `wailsjs`, `test-go`, conformance, `test-wasm`, `test-core`, `web-budget`, `task parity` e `check-gen`. Il primo giro di `test-ts` si è fermato su un solo test di tempi (`editor/live/fidelity/perf.test.ts`, nota di circa 150 kB: 17,4 s contro 15 s, con la macchina sotto carico per `vet-linux` in Docker); rilanciato da solo è passato in 8,9 s, e `test-ts` ripetuto per intero è verde (workbench: 2778 test passati, 46 saltati). Il codice è quello della 2.0.0.

## [2.0.0] - 2026-11-27

**La 2.0.0 è sola numerazione** ([ADR-0070](docs/adr/0070-2-0-senza-rimozione-compatibilita-1x.md)): il prodotto è quello della 1.8.8, più la documentazione. **Non toglie la compatibilità con la 1.x**, contrariamente a quanto ADR-0052 annunciava: schema `memobrain://`, cartella `.memobrain/`, voci del portachiavi, variabili `MEMOBRAIN_*`, realm `memobrain`, ruolo `memobrain-admin`, servizio gRPC `memobrain.v1` e `nameOverride: memobrain` restano fino a una release major successiva. Nessuna migrazione del database, nessun cambiamento del protocollo né delle API: client e cloud 2.0.0 lavorano con client e cloud 1.8.x.

Decisioni dell'owner del 2026-11-27: [ADR-0067](docs/adr/0067-sito-documentazione-github-pages.md) e [ADR-0068](docs/adr/0068-template-in-clarae-templates.md) accettati e recepiti in `Specifications.md` 1.11; [ADR-0069](docs/adr/0069-importer-apple-notes.md) respinta; [ADR-0023](docs/adr/0023-distribution-and-updates-details.md), [0045](docs/adr/0045-parita-per-costruzione.md), [0046](docs/adr/0046-bootstrap-server-indietro.md), [0047](docs/adr/0047-apertura-file-per-tipo-e-presentazioni-marp.md), [0048](docs/adr/0048-presentazioni-marp-slideshow-ribbon-pptx.md), [0049](docs/adr/0049-editor-live-milkdown.md) e [0050](docs/adr/0050-ai-inattiva-e-collab-spento.md) accettati e recepiti in `Specifications.md` 1.12. Nessun cambiamento del prodotto, del protocollo né dei contratti: l'accettazione non cambia lo stato del codice.

### Compatibilità

- **Apple Notes non è previsto:** l'importer non si implementa (ADR-0069, respinta). Gli importer disponibili restano Markdown/HTML, Evernote ENEX, Notion, Roam, Bear, Google Keep e CSV.
- **Compatibilità con la 1.x mantenuta** (ADR-0070): commenti del codice, configurazioni (Compose, Helm, installer, proto), `scripts/rebrand/allowlist.tsv` e guide dell'amministratore dicono ora «in una release major successiva alla 2.0» invece di «nella 2.0»; la tabella delle rimozioni di [migrazione a Clarae notanda](docs/admin-guide/migrazione-clarae.md) è aggiornata.

### Contratti

- `api/openapi.yaml`: `info.version` a 2.0.0 (stub rigenerati); nessuna operazione nuova né cambiata.

### Documentazione

- `Specifications.md` alla **1.12**: recepisce ADR-0023, ADR-0045, ADR-0046, ADR-0047, ADR-0048, ADR-0049 e ADR-0050 (§0.3, §1.2, §1.7, §2.2.1, §2.3, §2.5, §2.6.6, §2.8.3, §3.4.2, §3.4.4, §3.4.5, §3.4.6, §3.5.2, §3.5.3, §4.2, §4.5, App. B, C.1, C.2, C.4), ciascuno con lo stato reale. **ADR-0023 (manifest firmato, installer firmati, aggiornamento automatico) non è attivo**: non è mai stato eseguito su una release, l'updater è compilato fuori dalle build di rilascio dalla 1.2.2 e gli installer non sono firmati; mancano certificati, chiave del manifest e canale. **ADR-0050**: l'assistente AI e la collaborazione in tempo reale sono nel codice ma spenti e non disponibili; il co-editing resta escluso. **ADR-0049**: Live su Milkdown è implementato e rilasciato (1.4.0), ma le prove manuali su WebView reali (IME, correzione ortografica, lettori di schermo, incolla da app esterne, note grandi) restano da fare. ADR-0045 e ADR-0046 (1.3.2), ADR-0047 (1.3.3) e ADR-0048 (1.3.4) erano già rilasciati. Stato, indice degli ADR, roadmap (M7, M12, M13, M14, M16) allineati.
- `Specifications.md` alla 1.11: recepisce ADR-0067 (sito della documentazione e workflow `docs.yml`, eccezione ad ADR-0036: §4.1, §4.5) e ADR-0068 (template in `.clarae/templates/`: §2.2.1, §2.6.6, §3.4.5, §3.4.6, §3.4.7), con le voci di Appendice C.
- Le prove manuali dell'owner del 2026-11-27 sono registrate con esito positivo (dichiarato, senza esito per riga): matrice di Wails v3 su Windows e Linux (B-W8), vista integrata delle applicazioni (driver WebView2 e WebKitGTK), terminale integrato (ConPTY e Job Object compresi) e presenza in tempo reale con più utenti. Cambiano le avvertenze «non provato» in spec, ADR, roadmap, runbook QA e guide (applicazioni, profili di configurazione).

### Verificato

Sull'albero della 2.0.0: `task ci` per intero, verde (`lint` con eslint, prettier, `lint-go` e `lint-brand`; `vet-windows`, `vet-linux`, typecheck, `govulncheck`, `wailsjs`, `test-go`, `test-ts`, conformance, `test-wasm`, `test-core`, `web-budget`, `task parity`, `check-gen`). Il codice è quello della 1.8.8 (`task test-integration`, `task test-desktop-e2e`, `task e2e-desktop` e lo spec `sync-unsent` della matrice erano verdi su quell'albero) più commenti e documenti. `Specifications.md`: corrette le frasi «fino alla 2.0» del corpo; intestazione 1.13, registro e riga ADR-0070 di C.4 non ancora scritti.

## [1.8.8] - 2026-11-27

Milestone M26 ([roadmap](docs/roadmap.md) §13-novodecies), sessioni M26-S4…S6, [ADR-0066](docs/adr/0066-vcs-esclusi-e-file-non-inviati.md) (accettata): **Impostazioni › Sincronizzazione mostra i file che questo dispositivo non invia al cloud, con il motivo**. Il core e i binding sono già nella 1.8.3. Nessuna migrazione del database, nessun cambiamento del protocollo né del cloud.

### Client desktop

- **Blocco «File non inviati»**: i file raggruppati per motivo (troppo grandi, cifratura non riuscita, spostamento che svuoterebbe una cartella condivisa, rifiutati dal server, in errore con nuovi tentativi, troppe modifiche concorrenti, in attesa di unire una modifica del server, nome non valido, collegamenti simbolici), con il codice dell'errore. «Riprova» rimette in coda un file che l'app ha smesso di ritentare, «Riprova tutti» li rimette in coda tutti. Le cartelle dei sistemi di versione e il cestino compaiono, solo come informazione, sotto «Cartelle escluse».
- **Nuova azione** `sync:retry-unsent`.
- **Corretto**: un file rifiutato con `BLOB_MISSING` o `PATH_COLLISION` per cinque volte smetteva di partire senza lasciare un errore, quindi non compariva tra i file non inviati e «Riprova» non lo rimetteva in coda. Ora, finché restano tentativi, è elencato «in errore, si riprova» con il codice; esauriti i tentativi è messo da parte come «Rifiutati dal server» e «Riprova» lo rimanda.

### Client workbench (browser)

- Lo stesso blocco nel workbench web, sul core WebAssembly: la voce `sync.unsent` del registro di parità è `yes` anche sul web, provata dallo spec della matrice `sync-unsent.spec.ts` (una nota rifiutata dal mock REST, messa da parte dal core, elencata e rimandata con «Riprova»).

### Documentazione

- [Sincronizzazione e cloud](docs/user-guide/sync-cloud.md): sezione «File non inviati» (motivi, «Riprova», che cosa non è elencato, cartelle `.git` e simili mai sincronizzate; i file già nel cloud restano e contano nella quota).
- [Risoluzione dei problemi](docs/user-guide/risoluzione-problemi.md): voce «Un file non arriva sugli altri dispositivi».

### Contratti

- `api/openapi.yaml`: `info.version` a 1.8.8 (stub rigenerati); nessuna operazione nuova. Nessun binding nuovo: `SyncAPI.Unsent` e `SyncAPI.RetryUnsent` sono della 1.8.3.

### Verificato

Sull'albero della 1.8.8 (prima del commit di rilascio, che cambia solo versioni e note): tutti i passi di `task ci` (`lint` con eslint, prettier, `lint-go` e `lint-brand`; `vet-windows`, `vet-linux`, typecheck, `govulncheck`, `wailsjs`, `test-go`, `test-ts`, conformance, `test-wasm`, `test-core`, `web-budget`, `task parity` con 99 funzioni e 214 comandi, `check-gen`); `task test-integration`; `task test-desktop-e2e`, rilanciato dopo la correzione del push; `task e2e-desktop` (282 test); lo spec `sync-unsent.spec.ts` della matrice sul mock Wails e sul core WebAssembly; una revisione avversariale, esito Fail, con tutti i rilievi corretti. `task lint-ts` lanciato com'è si ferma sulla formattazione di una cartella `skills/` non tracciata, estranea a questa versione: prettier è verde su tutti i file del repository. **Non eseguiti:** l'intera matrice e2e e Playwright su WebKit, e una prova manuale nell'app desktop.

## [1.8.7] - 2026-11-24

Milestone M31 ([roadmap](docs/roadmap.md) §13-quatervicies), sessioni M31-S1…S5, [ADR-0068](docs/adr/0068-template-in-clarae-templates.md) (proposta): **i template stanno nella cartella `.clarae/templates` del vault e valgono per note, disegni e presentazioni**. Nessuna migrazione del database, nessun cambiamento del protocollo né del cloud.

### Client desktop e workbench

- **Posizione fissa dei template**: `.clarae/templates` del vault, con il tipo dall'estensione (`.md`, `.excalidraw`, `.marp`). L'impostazione «Cartella dei template» non c'è più. I template non compaiono più in ricerca, grafo e selettore rapido.
- **Template di default** in Impostazioni › Note giornaliere e template: per ogni nuova nota, ogni nuovo disegno e ogni nuova presentazione, con l'elenco dei template del vault (Apri, Elimina, Nuovo template).
- **Nuovi comandi**: «Nuovo disegno da template», «Nuova presentazione da template», «Nuovo template», «Salva come template», «Modifica template», «Importa template dalla cartella…».
- **«Applica template»** prende il posto di «Inserisci template» (stesso comando, le scorciatoie restano): in una nota inserisce al cursore, in un disegno aggiunge gli elementi al centro della vista, in una presentazione aggiunge le slide dopo quella corrente.
- **Template esistenti**: all'apertura di un vault con template nella vecchia cartella l'app chiede una volta se spostarli; i riferimenti nelle impostazioni vengono aggiornati e quelli vecchi continuano a funzionare. Lo spostamento non avviene sui vault in sola lettura, sulle cartelle condivise con voi e quando la cartella dei template è condivisa con altri.
- **Sincronizzazione**: un template modificato su due dispositivi viene fuso come la nota o il disegno che è, senza copia di conflitto. I dispositivi non ancora aggiornati non elencano i template spostati e, su una modifica concorrente, producono una copia di conflitto.
- **Cartelle condivise con voi**: non vi si creano template propri; per un gruppo resta la libreria di template, che ora offre anche disegni e presentazioni.

### Contratti

- `api/openapi.yaml`: `info.version` a 1.8.7 (stub rigenerati); nessuna operazione nuova.
- Binding del core (desktop e WebAssembly): `TemplatesAPI.List` senza la cartella, `TemplateInfo` con `kind` e `rel`; nuovi `Create`, `MigrationPlan`, `Migrate`, `DeclineMigration`.

### Verificato

Sull'albero della 1.8.7: test Go con `-race` di `shared/go` e di `apps/desktop/internal`; i tre test di sync dei template contro il cloud reale (`-tags integration`: merge per contenuto, spostamento con lo stesso id di file, cartella di configurazione di un mount); `task lint-go`; typecheck; vitest completo del workbench (2772 test); `task parity` (99 funzioni, 214 comandi); `e2e/templates.spec.ts`, `marp.spec.ts` e `drawing.spec.ts` su Chromium; una revisione avversariale di sync, merge e migrazione, con i rilievi corretti. **Non eseguiti:** `task ci` completo (`vet-windows`, `vet-linux`, `govulncheck`, conformance, `test-wasm`, `test-core`, `web-budget`, `check-gen`), l'intera `task e2e`, Playwright su WebKit e sul core WebAssembly, `test-integration`, e una prova manuale nell'app desktop. `task lint-ts` passa eslint ma si ferma sulla formattazione di una cartella `skills/` non tracciata, estranea a questa versione.

## [1.8.6] - 2026-11-24

Milestone M30 ([roadmap](docs/roadmap.md) §13-tervicies), sessioni M30-S1…S4: **la presentazione di un `.marp` e le miniature della scheda Slideshow riempiono davvero il loro spazio anche nell'app desktop su macOS**. La 1.8.5 aveva tolto l'effetto dello zoom dell'interfaccia, ma nella WKWebView reale la slide restava alla sua dimensione naturale (1280×720) nell'angolo in alto a sinistra. Nessuna migrazione del database, nessun cambiamento dei formati né del protocollo.

### Client desktop e workbench

- **Presentazione Marp a tutto schermo in WebKit**: WebKit non scala l'HTML di un `<foreignObject>` con il `viewBox` del suo `<svg>` (bug 23113), e il polyfill di Marp, applicato solo quando le misure del layout mostravano il difetto, nella WKWebView dell'app non scattava. Ora la slide si dispone alla sua dimensione naturale (il `viewBox`, 1280×720 di norma) e `div.marpit` viene scalato e centrato con una trasformazione CSS (`fitSlide` in `marp/document.ts`), che vale in ogni motore senza polyfill e segue il ridimensionamento dello schermo. `e2e/marp-show-layout.spec.ts` prova anche 1920×1080 e controlla che l'adattamento venga dalla trasformazione e non dal polyfill.
- **Miniature della scheda Slideshow senza polyfill**: anche le miniature allargavano l'`<svg>` della slide alla card e si affidavano al polyfill di Marp. Ora la slide sta alla sua dimensione naturale in un riquadro dello shadow root che prende le proporzioni dal `viewBox` (anche le presentazioni 4:3) ed è scalata con la stessa trasformazione della presentazione (`fitSlide`, condivisa). Il polyfill non serve più: tolti `marp/polyfill.ts`, il suo test e la dipendenza diretta da `@marp-team/marpit-svg-polyfill`.

### Contratti

- `api/openapi.yaml`: `info.version` a 1.8.6 (stub rigenerati); nessuna operazione nuova.

### Verificato

- Prima pubblicazione della 1.8.6 (M30-S1…S2): `task ci` verde (551 s): lint (Go, TS, nome del prodotto), `vet-windows`, `vet-linux`, typecheck, `govulncheck`, test Go con `-race` (122 pacchetti), vitest, conformance, `test-wasm`, `test-core`, budget, parità (99 funzioni) e `check-gen`.
- Con M30-S3 (miniature): `task ci` **non è stato completato**. Verdi lint, `vet-windows`, `vet-linux`, typecheck, `govulncheck`, test Go, vitest (2753 test del workbench) e la conformance Go e del parser TS; il gate dell'editor live (`src/test/conformance.test.ts`, Milkdown) è andato due volte in timeout nel `beforeAll` (600 s) con il Mac a batteria e sotto carico (2% di CPU per il processo), e non usa codice Marp. `test-wasm` non eseguito; `test-core`, `web-budget`, `parity` e `check-gen` verdi eseguiti a parte.
- `e2e/marp-show-layout.spec.ts` (con il nuovo test delle miniature) e `e2e/marp.spec.ts` sul mock, su Chromium e WebKit (`E2E_WEBKIT=1`): 20 test verdi; vitest di `marp/` e `sidebar/` (153 test).
- **Non eseguiti** il `task e2e` completo, `task test-integration` e la prova manuale nell'app desktop: WebKit headless di Playwright non riproduceva il difetto della WKWebView, quindi presentazione e miniature vanno confermate a mano nell'app.

## [1.8.5] - 2026-11-23

Milestone M29 ([roadmap](docs/roadmap.md) §13-duovicies), sessioni M29-S1…S2: **le presentazioni si mostrano sempre al 100%**, qualunque sia lo zoom dell'interfaccia. Con la 1.8.5 esce anche la riduzione del sito della documentazione alle guide e ai documenti di sicurezza, committata dopo la 1.8.4. Nessuna migrazione del database, nessun cambiamento dei formati né del protocollo.

### Client desktop e workbench

- **Le presentazioni si mostrano al 100%**: la presentazione di un `.marp`, lo slideshow di una nota, la presentazione di un disegno e il canvas a tutto schermo ignorano lo zoom dell'interfaccia (Aspetto → Zoom) finché sono aperti, e all'uscita lo zoom torna com'era. Con uno zoom diverso dal 100% la slide Marp non risultava più a tutto schermo e in WebKit (WKWebView su macOS) il polyfill di Marp la scalava in modo sbagliato. L'attributo `data-presenting` sulla radice, messo da `util/fullscreen.ts`, attiva in `style.css` `zoom: 1 !important`; `e2e/marp-show-layout.spec.ts` lo verifica con zoom 150% e 80% su Chromium e WebKit.

### Documentazione

- **Il sito della documentazione pubblica solo `docs/user-guide`, `docs/admin-guide` e `docs/security`** ([ADR-0067](docs/adr/0067-sito-documentazione-github-pages.md), emendato), con una home dedicata (`docs/site-home.md`); `docs/index.md` resta l'indice del repository. Le altre voci di `docs/` sono escluse dal build (`srcExclude`), i link verso di esse puntano al file su GitHub, la barra laterale e la navigazione non hanno più ADR, roadmap e architettura, e il workflow `docs.yml` parte solo quando cambiano le pagine pubblicate, la configurazione del sito o `docs/index.md`.

### Contratti

- `api/openapi.yaml`: `info.version` a 1.8.5 (stub rigenerati); nessuna operazione nuova.

### Verificato

- `task ci` verde sull'albero della 1.8.5 (550 s): lint (Go, TS, nome del prodotto), `vet-windows`, `vet-linux`, typecheck, `govulncheck`, test Go con `-race` (122 pacchetti), vitest, conformance, `test-wasm`, `test-core`, budget, parità (99 funzioni) e `check-gen`.
- `e2e/marp-show-layout.spec.ts` sul mock, su Chromium e WebKit (`E2E_WEBKIT=1`): 8 test verdi; senza la regola CSS le quattro varianti con zoom 150% e 80% falliscono.
- **Non eseguiti** il `task e2e` completo, `task test-integration` e la prova manuale nell'app desktop (WKWebView reale): la modifica è una regola CSS e due righe di `util/fullscreen.ts`.

## [1.8.4] - 2026-11-23

Milestone M27 ([roadmap](docs/roadmap.md) §13-vicies), sessioni M27-S1…S5: **la documentazione diventa un sito** generato da `docs/` e pubblicato su GitHub Pages ([ADR-0067](docs/adr/0067-sito-documentazione-github-pages.md), in stato di proposta). Milestone M28 (§13-unvicies), sessioni M28-S1…S5: **il repository non nomina più l'editor di note a cui il prodotto si ispirava**, nemmeno in `Specifications.md` e nei documenti storici. Nel prodotto cambiano solo i testi della conversione dei disegni `.excalidraw.md` e il riconoscimento di uno schema di link; nessuna migrazione del database, nessun cambiamento dei formati.

### Client desktop e workbench

- I testi del comando e della finestra di conversione dei disegni `.excalidraw.md` sono neutri («Converti un disegno .excalidraw.md»).
- Nei disegni, un link con lo schema dell'editor di terze parti non è più riconosciuto come URL durante la rinomina dei file collegati.

### Documentazione

- **`docs/index.md`**: introduzione al progetto e indice di tutti i documenti, raggruppati per pubblico (utenti, amministratori, sviluppatori) e per area (ADR, sicurezza, QA, prestazioni, rilascio).
- **Sito statico con VitePress** (`docs/.vitepress/config.mjs`): `task docs-build` genera `docs_html/` con base `/Clarae/` (`DOCS_BASE` la cambia), ricerca locale e interfaccia in italiano, barra laterale che segue `docs/index.md` e tutti gli ADR. I `README.md` diventano l'indice della loro cartella; i link a file fuori dal sito (`Specifications.md`, sorgenti, `api/`) puntano al file su GitHub. `task docs-dev` e `task docs-preview` per l'anteprima.
- **Pubblicazione sul branch `gh-pages`**: `task docs-publish` (`DOCS_DRY_RUN=1` per non pushare) e il workflow `.github/workflows/docs.yml`, che costruisce e pubblica a ogni push su `main` che tocca `docs/`. Il workflow non esegue controlli: `task ci` resta il cancello (ADR-0036).
- ADR-0067, sezione M27 della roadmap, sezione «Sito della documentazione» in `docs/dev-setup.md`, README e processo di rilascio aggiornati. Le righe da aggiornare in `Specifications.md` (§6, Appendice C) sono nelle «Conseguenze» dell'ADR, a cura dell'owner.
- `Specifications.md` (modifica autorizzata dall'owner), guide, ADR, roadmap e note dei rilasci passati descrivono la compatibilità con formule neutre. Rinominati `docs/adr/0028-excalidraw-fork.md` e `docs/qa/parita-funzionale-m1.md`.

### Contratti

- `api/openapi.yaml`: `info.version` a 1.8.4 (stub rigenerati); nessuna operazione nuova.

### Verificato

- `task ci` verde sull'albero della 1.8.4 (745 s): lint (Go, TS, nome del prodotto), `vet-windows`, `vet-linux`, typecheck, `govulncheck`, test Go con `-race` (122 pacchetti), vitest, conformance, `test-wasm`, `test-core`, budget, parità (99 funzioni) e `check-gen`.
- `task docs-build` senza link interrotti (340 link interni del sito controllati); `scripts/docs-publish.sh` provato contro un remote locale: prima pubblicazione, sito invariato (nessun commit), sito modificato, dry run.
- Con M28: `task ci` di nuovo verde (571 s) e i 19 test Playwright dei disegni toccati (`drawing-wp6`, `drawing-extra-tools`, `drawing-embed`) sul mock.
- **Non eseguiti** il `task e2e` completo e `task test-integration`: le sole modifiche al prodotto sono due testi e la regex degli schemi URL dei disegni, coperta da `TestInURLStringSchemes`.

### Non provato e lavoro successivo

- Il workflow `docs.yml` non è ancora stato eseguito su GitHub; serve abilitare Pages (_Settings_ → _Pages_ → _Deploy from a branch_ → `gh-pages`, `/ (root)`).
- M26-S4 e M26-S5 (interfaccia «File non inviati», guide, revisione) restano da fare.

## [1.8.3] - 2026-11-21

Milestone M26 ([roadmap](docs/roadmap.md) §13-novodecies), sessioni M26-S1…S3: **le cartelle dei sistemi di versione non si sincronizzano più**, e il core sa elencare **i file che non invia, con il motivo** ([ADR-0066](docs/adr/0066-vcs-esclusi-e-file-non-inviati.md), accettato dall'owner il 2026-11-21, non ancora recepito in `Specifications.md`). Il blocco «File non inviati» in Impostazioni › Sincronizzazione arriva con M26-S4: in questa versione l'elenco esiste nel core e nei binding, non nell'interfaccia. Nessuna migrazione del database.

### Compatibilità

- **`.git`, `.hg`, `.svn`, `.bzr` e `.jj` sono esclusi dalla sincronizzazione**: cartelle o file con questi nomi, a qualunque profondità, senza distinzione di maiuscole. Restano sincronizzati `.gitignore`, `.gitattributes`, `.gitmodules`, `.github/` e `.hgignore`. Le cartelle escono anche dall'indice, dalla ricerca e dagli ZIP; su disco restano intatte per git e per il terminale.
- **I file VCS già nel cloud restano dove sono.** Un dispositivo 1.8.3 li dimentica nel proprio `sync.db` senza inviare cancellazioni, quindi un dispositivo ancora su 1.8.2 o precedente non perde la propria `.git`. Le copie restano nella quota del proprietario finché qualcuno non le toglie.
- **Il cloud 1.8.3 rifiuta con `PATH_INVALID`** i nuovi commit su quei percorsi nei vault condivisi, anche come destinazione di una rinomina di cartella (`move_prefix`, che prima non controllava le esclusioni). Un client 1.8.2 che prova a inviarli mette da parte il file, senza bloccare la sincronizzazione. Nei vault privati il cloud non vede i percorsi: i client 1.8.2 continuano a scambiarsi la `.git` tra loro, quelli 1.8.3 la ignorano.
- **Un file che diventa escluso non è più una cancellazione**, per qualunque regola presente o futura. Fa eccezione un file sincronizzato che l'utente rinomina in un nome escluso (per esempio `nota.md` → `nota.tmp`): lascia il suo percorso nel cloud, che si cancella come prima.

### Client desktop e workbench

- **Elenco dei file non inviati nel core** (`Engine.Unsent`, binding `SyncAPI.Unsent`): file messi da parte (`too-large`, `rejected` con il codice del server, `encrypt-failed`, `share-root-move`), in conflitto per troppe modifiche concorrenti, in attesa di un merge, nomi che le regole dei percorsi rifiutano (es. `:` nel nome), link simbolici, e come voci informative una per cartella le cartelle VCS e il cestino. File di sistema, temporanei e locali di `.clarae/` non si elencano.
- **`SyncAPI.RetryUnsent`** rimette in coda i file messi da parte (tutti, o quelli indicati) e sincronizza subito; i conflitti restano alla loro vista. **`Status.unsent`** (evento `sync:status`) conta le voci che richiedono un intervento.
- Il motivo di un file messo da parte è ora salvato come `<CODE>: <dettaglio>`, con codici locali `ENCRYPT_FAILED` e `TOO_MANY_CONFLICTS`. Le righe scritte dalle versioni precedenti sono riconosciute.
- `vault.FS.WalkReport` riporta ciò che la visita salta, senza una seconda visita del disco.

### Contratti

- `api/openapi.yaml`: `info.version` a 1.8.3 (stub rigenerati); nessuna operazione nuova. Binding `SyncAPI.Unsent` e `SyncAPI.RetryUnsent`, campo `unsent` di `sync.Status`; voce `sync.unsent` nel registro di parità (`partial` fino all'interfaccia di M26-S4).

### Documentazione

- ADR-0066 e la sezione M26 della roadmap. Le righe da aggiornare in `Specifications.md` (§3.4.2, §3.4.3, §3.4.4 A, C.4) sono nelle «Conseguenze» dell'ADR, a cura dell'owner.

### Verificato

- `task ci` verde sull'albero della 1.8.3: lint (Go, TS, nome del prodotto), `vet-windows`, `vet-linux`, typecheck, `govulncheck`, test Go con `-race` (122 pacchetti), vitest, conformance, `test-wasm`, `test-core`, budget, parità (99 funzioni) e `check-gen`.
- Test d'integrazione del cloud mirati (`TestSharedVaultRefusesVCSPaths`, `TestSharedVaultRefusesWindowsReservedNames`) verdi su container veri. **Non eseguiti** in questa versione `task e2e` e il `task test-integration` completo: nessuna modifica all'interfaccia, ma restano da rilanciare con M26-S4.

### Non provato e lavoro successivo

- **Nessun e2e a due dispositivi contro il cloud reale** per la dimenticanza delle righe escluse. Un cloud 1.8.3 rifiuta i percorsi `.git` nei vault condivisi, quindi lo stato «già sincronizzato» non si prepara: lo copre il test del motore con il remote finto, verificato anche togliendo la correzione (il test fallisce).
- Da fare in M26-S4 e M26-S5: interfaccia «File non inviati» con «Riprova», guide utente, revisione avversariale.

## [1.8.2] - 2026-11-21

Milestone M25 ([roadmap](docs/roadmap.md) §13-octodecies), rilasciata nella 1.8.2: **presenza in tempo reale sui vault condivisi** ([ADR-0065](docs/adr/0065-presenza-in-tempo-reale.md), accettato dall'owner il 2026-11-20 e recepito in `Specifications.md` v1.9). Gli avatar degli **altri** utenti che hanno aperto lo stesso file compaiono nella barra dell'Esplora file, e sopra il documento i loro cursori con il nome. **Non è co-editing:** il merge resta sul client e [ADR-0050](docs/adr/0050-ai-inattiva-e-collab-spento.md) resta in vigore. Questa sezione non è ancora una release: versione, `info.version` dell'OpenAPI e tag si fanno al rilascio. Nessuna migrazione del database.

### Compatibilità

- **Nuovo endpoint WebSocket `GET /api/v1/presence`** nel cloud. Un proxy o un Ingress davanti al cloud deve lasciar passare l'upgrade WebSocket e non chiudere le connessioni inattive prima di circa un'ora. **Il chart Helm crea un Ingress in più**, `<release>-presence` (path esatto `/api/v1/presence`), con i timeout di `ingress.presence.timeoutSeconds` (3600) e annotazioni extra in `ingress.presence.annotations`; il `Caddyfile` di Compose non richiede modifiche. Chi non usa il chart o Caddy deve configurare il proprio proxy ([guida](docs/admin-guide/presenza.md)).
- **`features.presence` è acceso di default**: aggiornando, gli utenti dei vault condivisi vedono avatar e cursori degli altri senza fare nulla. Si spegne dal Config Profile (anche a caldo); nuova chiave dello schema, non bloccabile.
- **Privacy:** gli altri utenti del file vedono nome visualizzato e posizione del puntatore finché il file è aperto. Niente viene salvato né finisce nell'audit o nei log ([conservazione dei dati](docs/security/data-retention.md)). I vault privati non hanno presenza.
- **Limite per replica:** al più 32 connessioni per utente **per replica**, non globali.
- **I client 1.8.1 e precedenti** non aprono la connessione e non cambiano comportamento; il cloud nuovo li serve come prima.

### Client desktop e workbench

- **Avatar al posto del pulsante «Nuova applicazione»** nella barra dell'Esplora file: fino a quattro, poi `+N` (in `AvatarGroup` `max` conta gli avatar mostrati). `app:new` resta in ribbon, menu contestuali, palette e stato vuoto (emenda [ADR-0060](docs/adr/0060-web-viewer-acceso-di-default.md)).
- **Cursori live** per note (Source e Live Preview), disegni e canvas; per lettura, basi, PDF, immagini e applicazioni solo avatar. Nelle note segue il **puntatore del mouse**, non il caret; in Live la colonna è approssimata dentro un blocco. Nei disegni e nei canvas la posizione è di scena e tiene conto di zoom e scroll di chi guarda.
- **Colore deterministico per utente**, uguale per avatar, puntatore ed etichetta: otto token `--presence-1…8` con contrasto AA. Con la riduzione del movimento il puntatore non scivola.
- Si vedono solo gli altri utenti (non sé stessi né un altro dispositivo dello stesso account), solo file già sincronizzati, solo dove si ha almeno il permesso di lettore.
- Funziona uguale sul desktop e nel workbench web (stesso core Go, WebAssembly nel browser). Capability `presence`.

### Cloud

- Modulo `internal/presence`: stanze in memoria per `(vault, file)`, identità timbrata dal server, autorizzazione per file al `join` e ricontrollo su revoca, sospensione, cambio di profilo e ogni 60 s; heartbeat di 30 s, limiti (16 stanze, 40 movimenti/s con trattenuta dell'ultimo, frame da 1 KiB, 8 KiB per `auth`), controllo dell'origine per il browser, chiusura ordinata allo spegnimento.
- **Più repliche** sul canale PostgreSQL `presence` (`LISTEN/NOTIFY`, nessun Redis): movimenti solo se la stanza ha membri altrove (circa 15/s), heartbeat di 20 s e scadenza dei membri remoti a 70 s.
- Ricontrollo delle stanze di un vault a ogni commit, al più ogni 5 s per sessione: uno spostamento fuori dallo scope di una share espelle in circa 5 s. Il `join` non salta mai l'autorizzazione; i battiti tra repliche non si perdono (coda fino a 100000, `NOTIFY` a blocchi di 500); i `Refresh` del core sono serializzati.
- **Nessuna metrica Prometheus della presenza nella 1.8.2** (deciso dall’owner).

### Contratti

- `api/openapi.yaml`: `info.version` a 1.8.2 (stub rigenerati) e rotta esterna `GET /presence` (WebSocket, il primo frame `auth` porta il token), con frame, codici d'errore e limiti. `api/config-profile.schema.json`: `features.presence` (booleano, default `true`).
- Binding `PresenceAPI` (`Watch`, `Unwatch`, `Move`), eventi `presence:members`, `presence:move`, `presence:cleared`, capability `presence`; voce `presence` nel registro di parità.

### Build

- Nuova dipendenza `github.com/coder/websocket` (cloud e desktop, anche per `GOOS=js`) e `golang.org/x/time` nel cloud. Il relay `web/scripts/e2ePresence.mjs` per gli e2e del workbench è attivo solo con `CLARAE_E2E=1`.

### Documentazione

- ADR-0065 accettato e allineato al contratto effettivo; [`Specifications.md` v1.9](docs/spec-v1.9-proposta.md) applicato (2026-11-20).
- Nuove pagine: [Presenza](docs/user-guide/presenza.md) (guida utente), [Presenza in tempo reale](docs/admin-guide/presenza.md) (guida dell'amministratore) e il runbook [`docs/qa/m25-presenza.md`](docs/qa/m25-presenza.md) (P1…P22). Aggiornati data-retention, `desktop-web-sync.md`, `architecture.md` e la roadmap.

### Verificato

- `task ci` verde sull'albero di M25 (598 s): lint, `vet-windows`, `vet-linux`, typecheck, `govulncheck`, test Go con `-race` (122 pacchetti), vitest, conformance, `test-wasm`, `test-core`, budget, parità (98 funzioni) e `check-gen`. Un primo tentativo si era fermato al lint (un file della guida admin non formattato) e un `task e2e` era stato interrotto per il carico della macchina; rilanciati a macchina scarica.
- `task e2e` verde (desktop 272, bundle di produzione 48, console web 103), `task e2e-matrix -- presence.spec webapp.spec` verde (44 passati) sul mock e sul core WASM, `task test-integration` verde (115 s, compresi i test della presenza tra due repliche sullo stesso PostgreSQL).
- Dopo il passaggio alla versione 1.8.2 rieseguiti `check-gen`, parità e i controlli dei file toccati.

### Non provato e lavoro successivo

- **Nessuna prova con più utenti reali** (desktop e web insieme), su un Ingress vero, con più repliche, né su Safari (corrispondenza di `'self'` con `wss:`): i test sono automatici (hub, due «repliche» sullo stesso PostgreSQL, server finto, mock dei binding). Il manuale è in `docs/qa/m25-presenza.md`, a carico dell'owner.
- Il carico di `NOTIFY` con molti utenti nella stessa stanza e i limiti (40 movimenti/s, ~15 Hz) vanno misurati. L'avatar con immagine non c'è (solo iniziali e colore).
- Revisione: **Pass con riserve**, quattro rilievi bassi corretti.

## [1.8.1] - 2026-11-20

Milestone M24 ([roadmap](docs/roadmap.md) §13-septendecies), richiesta dell'owner del 2026-11-20 dopo la 1.8.0: **il terminale ha carattere e dimensione del carattere configurabili**, con default `MesloLGS NF` e 13 px. Nessuna migrazione del cloud, nessuna modifica delle API né dello schema del Config Profile.

### Client desktop e workbench

- **«Carattere del terminale» in _Impostazioni → Aspetto_.** Il default è **`MesloLGS NF`** (un Nerd Font, con le icone dei prompt di shell come Powerlevel10k). **Il carattere non è incluso nell'app**: va installato sul computer; se manca, il terminale usa un carattere a spaziatura fissa del sistema (`ui-monospace`, `Menlo`, `Consolas`, `DejaVu Sans Mono`, nell'ordine) e le icone possono apparire come quadratini.
- **«Dimensione del carattere del terminale»**, nello stesso posto: da **8 a 32** pixel, predefinita **13** (un valore non valido o fuori intervallo torna a 13, un decimale si arrotonda).
- Si scrive **un solo nome di famiglia**: virgolette, virgole e gli altri caratteri non ammessi sono tolti e il nome si ferma a 64 caratteri; il campo vuoto torna al default.
- **Effetto immediato:** i terminali aperti cambiano carattere o dimensione senza riavviare le shell e, caricato il font, la shell riceve il nuovo numero di colonne e righe.
- **Dove sta:** nelle impostazioni del vault (`.clarae/appearance.json`), come il carattere dell'interfaccia, non nel Config Profile (nessun flag per gli amministratori). Nei vault sincronizzati segue l'utente sui suoi dispositivi. La finestra separata usa le impostazioni del vault della scheda in primo piano (13 px e il carattere predefinito per una scheda senza vault). Nel workbench web i due campi **non compaiono** (il browser non ha il terminale); i valori scelti sul desktop restano in `appearance.json`.

### Contratti

- `api/openapi.yaml`: solo `info.version` a 1.8.1 (stub rigenerati); nessun binding, evento o capability nuovi: le due impostazioni stanno in `appearance.json` del vault (`terminalFont`, `terminalFontSize`).

### Verificato

- `task ci` verde sull'albero di M24 (1306 s): lint, `vet-windows`, `vet-linux`, typecheck, `govulncheck`, test Go con `-race` (120 pacchetti), vitest (2675 test), conformance, `test-wasm`, `test-core`, budget, parità e `check-gen`. Due esecuzioni precedenti si erano fermate a `test-ts` per il carico della macchina (budget di tempo di `perf.test.ts`, attese di `marpNotesTabSwitch`, `taskSerialization` e della porta A di conformance, file non toccati da M24): rilanciati isolati passano sempre.
- `task e2e` verde: desktop 264 passati, bundle di produzione 48, console web 103. Dopo il passaggio alla versione 1.8.1 rieseguiti `check-gen`, parità e i controlli dei file toccati.
- **Non eseguiti:** `task test-integration` e `task test-desktop-e2e` (nessuna modifica del cloud né della sync).

### Documentazione

- La guida del terminale ([`docs/user-guide/terminale.md`](docs/user-guide/terminale.md), sezione «Il carattere del terminale») e quella delle impostazioni, il runbook [`docs/qa/m23-terminale.md`](docs/qa/m23-terminale.md) (sezione 8, T20…T27) e la roadmap (M24).

### Non provato e lavoro successivo

- **Il rendering con il font vero non è provato su una finestra reale** (con `MesloLGS NF` installato e non installato, su macOS, Windows e Linux): la misura delle celle e il ridimensionamento della shell dopo il cambio sono coperti solo dai test automatici. Le prove sono a carico dell'owner (T20…T27).

## [1.8.0] - 2026-11-20

L'owner **accetta il 2026-11-20 gli ADR 0051, 0062, 0063 e 0064** e `Specifications.md` passa alla **v1.8**: il client desktop su Wails v3.1.0 (ADR-0051, già rilasciato dalla 1.4.0: lo spec lo recepisce, opzione A della proposta; la matrice manuale B-W8 su Windows e Linux resta da eseguire), la vista integrata delle applicazioni su Windows e Linux (ADR-0062) e i nomi dei file senza estensione (ADR-0063), già rilasciati nella 1.7.3 (milestone M22, [roadmap](docs/roadmap.md) §13-quindecies), e il terminale integrato con la finestra separata (ADR-0064, milestone M23, [roadmap](docs/roadmap.md) §13-sedecies). **La 1.8.0 porta il terminale integrato** (pulsante nella ribbon, più tab, pannello ancorabile, finestra separata senza riavviare le shell; non nei vault in sola lettura; non nel workbench web), ma **nulla del terminale è provato su una finestra reale**, e il driver di Windows (ConPTY, Job Object) è provato solo in compilazione. Nessuna migrazione del cloud e nessuna modifica delle API del cloud: il cloud 1.8.0 è la 1.7.3 con la versione aggiornata.

### Compatibilità

- **Terminale integrato (solo client desktop).** Nuovo pulsante nel ribbon, sopra _Impostazioni_, che apre un pannello con una shell per scheda. Nessun cambio per chi non lo usa: una shell parte solo da un gesto dell'utente.
- **Un amministratore non può spegnerlo.** Non esiste un flag del Config Profile (decisione dell'owner, ADR-0064): lo schema e le chiavi del profilo non cambiano. Su un computer gestito va limitato con i mezzi del sistema operativo.
- **Il terminale esegue qualunque comando dell'utente e non è un confine di sicurezza.** Una shell può modificare file fuori dalle regole dell'app (altri vault, `.clarae/`, mount in sola lettura aperti come cartella). Per un vault in sola lettura (lettore di un mount, condivisione revocata) il pulsante e `+` sono disabilitati, il core rifiuta l'apertura (`terminal-read-only`) e le sessioni già aperte in un vault che lo diventa si chiudono con un avviso. **Limite noto:** un mount già chiuso che diventa di sola lettura non chiude le sessioni aperte in lui.
- **Il workbench web non ha il terminale** (eccezione di parità: il browser non può avviare processi).
- **Scorciatoie.** ``Ctrl+` `` mostra o nasconde il terminale e ``Ctrl+Maiusc+` `` apre una scheda nuova, su tutti i sistemi, **anche macOS** (``Cmd+` `` resta al sistema). Il tasto si riconosce dal carattere e poi dalla posizione fisica; su macOS con una tastiera ISO valgono sia il tasto in alto a sinistra sia `<>`. **Conflitto noto:** con il layout italiano su Windows e Linux il tasto a sinistra del `1` scrive `\`: fuori dal terminale, con una nota aperta, `Ctrl+\` esegue _Dividi a destra_ invece del terminale (dentro il terminale `Ctrl+\` resta alla shell); _Impostazioni → Scorciatoie_ non lo segnala. Nella finestra separata valgono le scorciatoie del vault della scheda in primo piano. Copia e incolla nel terminale: `Cmd+C`/`Cmd+V` su macOS, `Ctrl+Maiusc+C`/`Ctrl+Maiusc+V` altrove.

### Client desktop e workbench

- **Pannello.** In basso (predefinito), a sinistra o a destra, ridimensionabile; posizione e dimensione sono preferenze del dispositivo (`localStorage`, `clarae.terminal.dock`), non nel vault. Schede con `+` e `×`, selettore di posizione e, all'estrema destra, **Sgancia terminale** / **Aggancia a Clarae**.
- **Finestra separata.** Una seconda finestra del sistema (`/terminal.html`), l'unica oltre alla principale: le shell **non ripartono** allo sgancio e al riaggancio (lo schermo si ridisegna da uno snapshot). Chiuderla con il pulsante del sistema termina tutte le shell; chiudere la finestra principale chiude anche quella; **Aggancia** la chiude e tiene le shell. In quella finestra una scheda nuova usa il vault della scheda in primo piano.
- **Shell e cartella.** Unix: `$SHELL -l` (ripiego `/bin/zsh`, `/bin/bash`, `/bin/sh`); Windows: `pwsh.exe`, poi `powershell.exe`, poi `%ComSpec%` (ConPTY, Job Object). `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Clarae`. Cartella di partenza: la radice del vault corrente (la home senza vault).
- **Fine di una sessione.** `exit` con codice 0 chiude la scheda; con un codice diverso da 0 la scheda resta con il codice. Nessun processo orfano alla chiusura di una scheda, della finestra separata o dell'app (Unix: `SIGHUP` al gruppo e `SIGKILL` dopo 1 s; Windows: Job Object con `KILL_ON_JOB_CLOSE`); l'uscita dell'app avviene entro 3 secondi. Al massimo 16 sessioni.
- **Vault privato bloccato.** Le schede di quel vault sono coperte e non ricevono tasti, anche con la sincronizzazione in pausa (conta lo stato del vault, non la fase della sync); i processi restano vivi.
- **Collegamenti.** Gli indirizzi nell'output e i collegamenti OSC 8 si aprono nel browser di sistema, solo se web, e-mail o telefono.
- **Finestra separata:** il titolo segue la lingua dell'app. Una shell che esce prima che la scheda compaia dà una scheda già segnata come terminata (o nessuna scheda, se l'uscita è pulita).

### Contratti

- `api/openapi.yaml`: solo `info.version` a 1.8.0 (stub rigenerati); lo schema del Config Profile non cambia. Binding nuovo `TerminalAPI` (`Open`, `CanOpen`, `Write`, `Resize`, `Close`, `List`, `Snapshot`, `State`, `Undock`, `Dock`), eventi `terminal:output`, `terminal:exit` (con il campo `reason`) e `terminal:layout`, capability `terminal` (desktop su macOS, Windows e Linux; web falsa), metodi `Host.OpenTerminalWindow` e `Host.CloseTerminalWindow` (e `app.TerminalWindowHost`), codici d'errore `terminal-unavailable`, `terminal-read-only`, `terminal-not-found`, `terminal-limit`, `terminal-busy`, `terminal-too-large`, `terminal-failed`. Voce `terminal` del registro di parità (`exception` sul workbench); `task gen` rigenerato.

### Build e sviluppo

- **Dipendenze nuove, tutte con licenza MIT:** `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0 e `@xterm/addon-web-links` 0.12.0 (caricate in modo lazy: il budget iniziale non cambia) e `github.com/creack/pty` v1.1.24. Le attribuzioni sono nel `README.md` e in _Impostazioni → Informazioni → Licenze_ (xterm.js sempre, creack/pty solo sul desktop). Le versioni `@xterm/*` sono esatte in `packages/workbench/package.json`, e `yarn.lock` e `go.sum` le fissano.
- La build del frontend desktop produce due pagine, `index.html` e `terminal.html`, e fallisce se una manca.

### Documentazione

- ADR **0051**, **0062**, **0063** e **0064** in stato _accettata_ (2026-11-20) e **«Recepito in: `Specifications.md` v1.8»**; indice degli ADR, note di emendamento di ADR-0047, ADR-0051, ADR-0056 e ADR-0060, roadmap (M22 e M23), guida admin, `docs/architecture.md` e runbook di QA allineati. Note di emendamento (testo storico invariato) in ADR-0001, 0005, 0023, 0025, 0029, 0030 e 0031, che dicevano Wails v2, `wails.json`, `wails build` o `-tags webkit2_41` come stato attuale.
- **`Specifications.md` v1.8** (20 novembre 2026), applicata dalla proposta [`docs/spec-v1.8-proposta.md`](docs/spec-v1.8-proposta.md), che resta come storia: ADR-0051 (V-07, D-07, A-03, §1.3, §2.3.2, §2.5, §4.2, §4.5, C.2), ADR-0062 (§2.2.1, §2.6.6, §3.7, §4.2, C.2), ADR-0063 (§2.2.1) e ADR-0064 (V-02, A-03, §2.2.1, §2.5, §2.8.3, §3.7, §4.2, App. B, C.2), con il registro delle revisioni e le righe di C.4. Priorità del terminale: P2. **Deriva nota, non corretta:** `Specifications.md:1903` cita ancora il tag `webkit2_41` (di Wails v2), mentre la build Linux usa `gtk3`.
- **ADR-0051 accettato** (opzione A): lo spec non dice più Wails v2 se non come storia. Accettarlo non esegue la matrice B-W8 su Windows e Linux: il rischio resta, dichiarato.
- **Guide e runbook del terminale:** nuova pagina [`docs/user-guide/terminale.md`](docs/user-guide/terminale.md) (con le avvertenze di sicurezza) e voce nell'indice della guida; nota in `docs/admin-guide/profili-quote-audit.md` (il terminale non si spegne dal profilo); `docs/desktop-web-sync.md`, `docs/architecture.md` e `docs/dev-setup.md`; il runbook [`docs/qa/m23-terminale.md`](docs/qa/m23-terminale.md).
- **Licenze del terminale controllate** (2026-11-20): `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `@xterm/addon-web-links` 0.12.0 e `creack/pty` v1.1.24 sono MIT (campo `license` dei pacchetti e `LICENSE`).
- **Ancora da fare:** le prove manuali su macOS, Windows e Linux.

### Verificato

- `task ci` verde sull'albero di M23 (559 s): lint, `vet-windows`, `vet-linux`, typecheck, `govulncheck`, test Go con `-race` (120 pacchetti, compreso `internal/terminal`), vitest (2650 test), conformance, `test-wasm`, `test-core`, parità e `check-gen`; `task e2e` verde (413 passati: desktop 262, bundle di produzione 48, console web 103). Dopo il passaggio alla versione 1.8.0 rieseguiti `check-gen`, parità e i controlli dei file toccati.
- Una revisione avversariale del diff del terminale (esito Fail: due rilievi medi confermati, link OSC 8 e copertura dei vault bloccati, più un rilievo medio plausibile e quattro bassi), tutti corretti.
- **Non eseguiti su questo albero:** `task test-integration` e `task test-desktop-e2e` (nessuna modifica del cloud né della sync, a parte l'hook `ReadOnly` dei mount, coperto dai test di `internal/sync`).

### Non provato e lavoro successivo

- **Il terminale non è mai stato eseguito su una finestra reale**, né su ConPTY e Job Object (Windows: solo `task vet-windows`). Le prove sono a carico dell'owner: [`docs/qa/m23-terminale.md`](docs/qa/m23-terminale.md) (shell e cartella, cambio vault, schede, posizioni, sgancio con `top` che continua, riaggancio, chiusure senza orfani, sola lettura, vault privato bloccato, scorciatoie su layout americano e italiano).
- **Da fare (owner):** le prove manuali di M23 e B-W8.

## [1.7.3] - 2026-11-20

Milestone M22 ([roadmap](docs/roadmap.md) §13-quindecies, ADR-0062 e ADR-0063, entrambi in stato _proposta_: non sono accettati e non sono recepiti in `Specifications.md`, che non è toccato). **Le applicazioni si aprono dentro Clarae notanda anche su Windows e su Linux**, accese di default, con ripiego automatico a «Apri nel browser»; **l'esploratore, le schede e le intestazioni mostrano i nomi dei file senza estensione** per tutto ciò che si apre in una scheda, e **la rinomina non fa più perdere il tipo di un file**. **Nulla di ciò che riguarda Windows e Linux è provato su una finestra reale** (vedi _Non provato e lavoro successivo_). Nessuna migrazione del cloud e nessuna modifica delle API: il cloud 1.7.3 è la 1.7.2 con la versione e la descrizione di `features.web_viewer` aggiornate.

Gli ADR 0057, 0058, 0059, 0060 e 0061 della 1.7.2 e l'ADR-0052 (rebrand) sono **accettati** dall'owner il 2026-11-16 (milestone M21, [roadmap](docs/roadmap.md) §13-quaterdecies) e `Specifications.md` è alla **v1.7**, che li recepisce con la nomenclatura _Clarae notanda_ in tutto lo spec.

### Compatibilità

- **Le applicazioni cambiano su Windows e su Linux.** Con `features.web_viewer` acceso (il default dalla 1.7.2) la pagina di un'applicazione si apre **nella scheda**, come su macOS, invece che nel browser di sistema. Su macOS non cambia nulla. **Chi non la vuole:** `{"features": {"web_viewer": false}}` nel profilo (per tutti), oppure, su un singolo computer Windows o Linux, la variabile d'ambiente **`CLARAE_WEBVIEW=off`** prima di avviare l'app (vale solo `off`, maiuscole e spazi ai lati non contano; macOS non la legge).
- **`CLARAE_WEBVIEW2_EXPERIMENTAL` non esiste più** (era l'interruttore di sviluppo della 1.7.1, per accendere il driver di Windows): non è più letta e non ha effetto. Il suo posto lo prende `CLARAE_WEBVIEW=off`, che **spegne** invece di accendere.
- **Requisiti per la vista nella scheda.** Windows: _WebView2 Runtime_ dalla versione **1.0.2210.55**. Linux: `webkit2gtk-4.1` dalla versione **2.40**, con il pacchetto ufficiale (costruito per GTK 3; una build per GTK 4, senza cgo o con `purego` non ha il driver) e **bubblewrap (`bwrap`) installato e funzionante**: la sandbox di WebKit è obbligatoria, e dove non si può avere (`bwrap` assente, namespace utente spenti, un container senza privilegi, la variabile `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS` impostata) la vista non parte e vale il ripiego. **Se il requisito manca** la scheda mostra «Apri nel browser», senza errori; se la prima apertura trova il sistema incapace, per il resto della sessione le applicazioni mostrano direttamente il riquadro e la funzione risulta spenta.
- **Dati di sessione su Windows e Linux:** una cartella per vault in `<cartella dati>/webapps/<identificatore>` (su Linux con `data/` e `cache/`, cookie in `cookies.sqlite`), persistente, fuori dal vault, non sincronizzata. _Elimina i dati delle applicazioni_ la cancella.
- **Nomi senza estensione.** L'esploratore, le schede e le intestazioni nascondono l'estensione di note, presentazioni, disegni, lavagne, basi, applicazioni, immagini, PDF, audio e video; per i file che l'app non apre da sé (`.docx`, `.zip`, `LICENSE`, `.gitignore`) il nome resta intero. **La rinomina non cambia più l'estensione** di un file supportato: il campo mostra il nome senza estensione e l'estensione originale viene rimessa; per cambiarla serve il file system. Il testo che i link inseriscono non cambia (`[[Review.marp]]`).

### Client desktop e workbench

- **Applicazioni su Windows (WebView2) e su Linux (WebKitGTK).** Stessa scheda con barra, conferma dell'origine, sessioni per vault e regole di sicurezza di macOS (solo `http` e `https`, nessun ponte verso l'app, download rifiutati, permessi negati, certificati non aggirabili). Differenze dichiarate: **Windows**, user agent di Edge, selettore di file non negabile, per il blocco automatico dei vault privati contano solo i tasti e il fuoco, NTLM e Kerberos li gestisce il runtime; **Linux**, user agent di WebKitGTK (con `Safari/605.1.15`), selettore di file annullato, **frame di una navigazione in parte sconosciuto** (WebKitGTK non lo dice: per tutto ciò che non è `about:`, `blob:` o `data:` valgono le regole del frame principale, le più severe; un iframe verso un indirizzo locale da una pagina pubblica è rifiutato, e un redirect verso un indirizzo locale dopo una navigazione verso un host pubblico è rifiutato).
- **Ripiego automatico.** Un errore che dice «questa piattaforma non può mostrare viste» (runtime assente o troppo vecchio, WebKitGTK sotto 2.40, finestra con una struttura inattesa) diventa `webview-unavailable` e non più `webview-failed`: la scheda mostra «Apri nel browser» invece di un errore. Se nessuna vista era mai stata creata nella sessione, il driver è dato per non disponibile fino alla chiusura dell'app (la capability `embeddedBrowser` risulta falsa e non si ritenta a ogni scheda). Un errore passeggero di una pagina resta un errore di quella scheda: per esempio, su Linux, aprire un'applicazione dello stesso vault mentre se ne cancellano i dati di sessione dà un errore ritentabile («Riprova»), non il ripiego. **Rischio residuo su Linux:** se il processo web di WebKit non parte dopo che il controllo della sandbox è riuscito, WebKit fa abortire l'app (nessun ripiego). Flatpak e Snap non sono provati.
- **Nomi dei file.** Le intestazioni di note, disegni e lavagne, i titoli di recupero e cronologia, la conferma del cestino, i collegamenti inversi e i selettori (compreso quello delle immagini dei disegni) mostrano **cartella e nome senza estensione**. L'elenco dell'esploratore si ordina per il nome mostrato (una nota `Piano` e una lavagna `Piano` restano vicine). Il pannello dei collegamenti non toglie più l'estensione ai file non supportati. Nei selettori che mescolano tipi (aggiunta di note e media a una lavagna, immagini, disegni e note incorporati in un disegno) due voci che senza estensione avrebbero la stessa etichetta (`Piano.pdf` e `Piano.png`, senza badare alle maiuscole) mostrano il **percorso completo con l'estensione**.
- **Rinomina (`F2`, menu della riga, comando _Rinomina nota_).** Il campo parte dal solo nome; l'estensione uguale a quella del file non si raddoppia (`Diagramma.excalidraw` resta tale); un'altra estensione digitata resta parte del nome (`Foo.txt` su una nota diventa `Foo.txt.md`); gli spazi ai lati si tolgono; un nome vuoto o uguale non fa nulla; cartelle e file non supportati si rinominano come prima.

### Contratti

- `api/openapi.yaml`: solo `info.version` a 1.7.3 (stub rigenerati). Schema del Config Profile: la descrizione di `features.web_viewer` nomina Windows e Linux (`task gen`); chiavi e default non cambiano. Binding del core: nessun metodo né evento nuovo; cambia solo il codice di errore di `WebViewAPI.Open` quando la piattaforma non può mostrare viste (`webview-unavailable` al posto di `webview-failed`).
- Capability `embeddedBrowser`: il campo `DesktopOS` ora elenca `darwin`, `windows` e `linux`; il testo della capability e `capabilities.gen.ts` sono rigenerati (`task gen`).
- Variabile d'ambiente nuova `CLARAE_WEBVIEW` (client desktop, Windows e Linux): `off` spegne la vista integrata. Tolta `CLARAE_WEBVIEW2_EXPERIMENTAL`. Registro di parità: la voce `webapp.embedded` dice «macOS, Windows e Linux» e porta le prove nuove; `docs/web-workbench-parity.md` rigenerato.

### Build e sviluppo

- **`task vet-linux`** (in `task ci`, dopo `vet-windows`): in un container Docker (`scripts/linux-vet`, con `libgtk-3-dev` e `libwebkit2gtk-4.1-dev`) esegue `go vet -tags gtk3`, compila i test di `internal/shell`, `internal/app` e `internal/webview` e il file C del driver con `-Wall -Wextra`, e controlla con `go list` che il pacchetto si elenchi in sei combinazioni di tag e di cgo (il file C porta lo stesso vincolo di build del driver: una build senza GTK 3 non deve rompersi). Serve Docker; `LINUX_ARCH=arm64` lo rende molto più veloce su un Mac Apple silicon.
- **`task test-nativeview-linux`** (a mano, non in `task ci`): i 14 test live del driver Linux contro una finestra vera di Wails su GTK3, sotto Xvfb, in Docker, **con la sandbox di WebKit accesa**: il container parte con `--init --cap-add SYS_ADMIN --cap-add NET_ADMIN --security-opt seccomp=unconfined --security-opt systempaths=unconfined` (o `--privileged`), perché bubblewrap deve creare i namespace; un container amd64 su un Mac arm64 non può (l'emulatore non ha seccomp): lì serve `LINUX_ARCH=arm64`. Opzioni `RUN=<regexp>`, `NO_MENU=1` e `CLARAE_NATIVEVIEW_CFLAGS=-DCLARAE_NATIVEVIEW_TRACE`. Verdi su arm64 con la sandbox accesa (riportato dagli sviluppatori); il vecchio esito su amd64 era senza sandbox e non vale più.
- **Prove nuove:** `manager_test.go` (`TestAPlatformThatCannotShowViewsIsUnavailableForTheSession`, `TestAPlatformFailureAfterAViewWasMadeDoesNotEndTheSession`, `TestAnOrdinaryCreateFailureKeepsTheManagerAvailable`), `bindings_webview_test.go` (`TestAPlatformThatCannotShowViewsFallsBackToTheSystemBrowser`), i tre test dei frame di `manager_test.go` (`TestUnknownFrameFollowsTheRulesOfTheTopFrameWithoutMovingIt`, `TestRedirectOfUnknownFrameDoesNotReturnToThePrivateNetwork`, `TestTopFrameStillMovesThePage`), `switch_test.go`, `datafolders_test.go`, `driver_linux_live_test.go` (anche `TestLiveAStoreThatIsBeingDeletedRefusesNewViews`) e `driver_windows_test.go`; `media.test.ts` (`splitName`, `displayName`, `displayPath`), `rename.test.ts` (`renameTarget`, `promptRename`) e i test aggiornati di esploratore, schede, segnalibri, embed e anteprime; e2e `keyboard.spec.ts` («F2 shows a file without its extension and the rename keeps it») e gli spec aggiornati di disegni, presentazioni, flussi e apertura per tipo.

### Verificato

- `task ci` verde sull'albero di M22 (835 s): lint (compreso `lint-brand`), `vet-windows` e il nuovo `vet-linux` in Docker, typecheck, `govulncheck`, test Go con `-race`, vitest (2554 test), conformance, `test-wasm`, `test-core`, budget (console 701 kB su 720), parità e `check-gen`. Dopo il passaggio alla versione 1.7.3 rieseguiti `check-gen`, parità e i controlli dei file toccati.
- I test live del driver Linux (`task test-nativeview-linux`) verdi su arm64 sotto Xvfb con la sandbox di WebKit accesa; le spec Playwright toccate da M22 verdi sul mock dei binding e nella matrice sul core WASM; una revisione avversariale del diff, i cui cinque rilievi sono corretti.
- **Non eseguiti su questo albero:** `task test-integration`, `task test-desktop-e2e` e l'intera suite `task e2e` dopo le ultime correzioni (nessuna modifica del cloud né della sync).

### Non provato e lavoro successivo

- **I driver di Windows e di Linux non sono mai stati eseguiti su una finestra reale.** Per Linux esiste la prova sotto Xvfb (X11); mancano Wayland, una scheda grafica reale, mouse e tastiera veri, **Flatpak e Snap** e l'amd64 con la sandbox. Per Windows non esiste nessuna prova a runtime. Un difetto che non fa fallire la creazione della vista (posizione, fuoco, sfarfallio) non è coperto dal ripiego. Le prove sono a carico dell'owner: [`docs/qa/m18-webview-matrice.md`](docs/qa/m18-webview-matrice.md) (sezioni 2 e 3) e [`docs/qa/m22-nomi-file-e-applicazioni.md`](docs/qa/m22-nomi-file-e-applicazioni.md).
- **Da decidere (owner):** accettare ADR-0062 e ADR-0063 e aggiornare `Specifications.md` (le righe sono elencate negli ADR); rivedere il default di `CLARAE_WEBVIEW` su macOS (oggi non letta) dopo la matrice.

### Documentazione

- ADR **0062** (vista integrata su Windows e Linux) e **0063** (nomi dei file senza estensione) in stato _proposta_, con le note di emendamento in ADR-0056, ADR-0060 e ADR-0047; roadmap §13-quindecies; guide utente e admin (Applicazioni, installazione, primo vault), `docs/desktop-web-sync.md`, `docs/dev-setup.md`, matrice `docs/qa/m18-webview-matrice.md` (sezioni 2 e 3 riscritte) e runbook `docs/qa/m22-nomi-file-e-applicazioni.md`.
- ADR **0057** (dispositivo per nome del computer), **0058** (uscita completa da Keycloak), **0059** (pulizia della cartella di configurazione legacy e ZIP coerente), **0060** (`features.web_viewer` acceso di default) e **0061** (budget iniziale della console a 720 kB) in stato _accettata_; ADR-0056 e ADR-0020 portano le note dei loro emendamenti (ADR-0060 e ADR-0061), ADR-0052 quella di ADR-0059. L'indice degli ADR è allineato.
- **`Specifications.md` v1.7**: recepisce ADR-0052 (nome del prodotto e identificatori in tutto lo spec; restano le etichette crittografiche congelate `memobrain/v1/*` e `memobrain/v2/*` e i riferimenti alla 1.x) e gli ADR 0057–0061 (§1.3, §1.6, §1.7, §2.2.1, §2.6.1, §2.6.6 con la riga di `features.config_dir_v2`, §2.8.2, §3.2.2, §3.3.1, §3.4.6, §3.5.1, §3.5.2, §3.8.2, §4.4, C.2, C.4). Il recepimento segue [`docs/spec-v1.7-proposta.md`](docs/spec-v1.7-proposta.md), che resta come storia; gli ADR 0052 e 0057–0061 portano la riga «Recepito in».
- Guida admin, runbook e roadmap non dicono più «in proposta» per questi ADR.

## [1.7.2] - 2026-11-16

Dodici **correttivi** su console web, desktop, cloud e workbench (milestone M21, [roadmap](docs/roadmap.md) §13-quaterdecies, ADR-0057, ADR-0058, ADR-0059 e ADR-0060): **il testo dei disegni si scrive e gli oggetti si spostano di nuovo**; le **presentazioni a tutto schermo** non finiscono più in un angolo su macOS; **«Esci» esce davvero** (console e desktop) e il desktop **non aggiunge più un dispositivo a ogni accesso**; la cartella di configurazione della 1.x (`.memobrain/`) si **ripulisce** e lo ZIP ha solo `.clarae/`; le **applicazioni** sono **accese di default** e si creano dall'esploratore dei file; il cloud ha una **guardia contro un aggiornamento che riparte da un database vuoto**. **Questa versione ha una migrazione del cloud** (`0016_device_hostname`, che revoca i dispositivi desktop duplicati) **e un default che cambia** (`features.web_viewer`): leggere _Compatibilità_ prima di aggiornare. Gli ADR 0057, 0058, 0059, 0060 e 0061 sono in stato _proposta_ e **non sono ancora recepiti in `Specifications.md`**, che non è toccato: li accetta e li recepisce l'owner. **Nulla è provato su un Keycloak vero né sulla finestra reale del desktop** (vedi _Non provato e lavoro successivo_).

### Compatibilità

- **Come si aggiorna dalla 1.7.1:** prima il backup del database (`pg_dump`), poi il cloud nello stesso namespace, con la stessa release e lo stesso volume; i client desktop non si aggiornano da soli, si installano a mano (un client 1.7.1 contro il cloud nuovo continua a funzionare, vedi sotto). **Il cloud ha una migrazione** (`0016`), applicata da sola al primo avvio di un pod `api`.
- **Aggiornamento del cloud: prima il backup.** Il Cloud Service applica da solo la migrazione `0016_device_hostname` al primo avvio di un pod `api`. Fare un `pg_dump` **prima** di aggiornare, e aggiornare nello **stesso namespace, con la stessa release Helm e lo stesso volume di PostgreSQL** (con Compose, lo stesso `COMPOSE_PROJECT_NAME`): un database nuovo al posto del vecchio parte senza dati e **senza registro di audit**. Procedura e interrogazioni di controllo in [docs/admin-guide/backup-upgrade.md](docs/admin-guide/backup-upgrade.md).
- **Migrazione `0016`: i dispositivi desktop si deduplicano.** Aggiunge `devices.hostname` (nome del computer, minuscolo e senza spazi ai lati, per `windows`, `macos` e `linux`; `NULL` per `web`) e un indice unico su `(utente, piattaforma, hostname)`. Dove un utente ha più righe con lo stesso nome e la stessa piattaforma, **resta attiva quella con l'attività più recente** (un dispositivo attivo vale sempre più di uno revocato) e **le altre si revocano**: **nessuna riga si cancella**, le revisioni dei file continuano a puntare al loro autore. Un client che ricorda uno dei dispositivi revocati si ferma e propone «Registra di nuovo questo dispositivo», che riattiva la riga rimasta. Il rollback della migrazione toglie colonna e indice, ma non riattiva i dispositivi revocati.
- **`DB_EXPECT_INITIALIZED`: la guardia dell'aggiornamento.** Con `DB_EXPECT_INITIALIZED=true` i ruoli `api` e `all` rifiutano di creare lo schema su un database vuoto (nessuna migrazione applicata) e terminano con un errore che dice che cosa controllare. **Il chart Helm la imposta da solo a ogni `helm upgrade`** (non alla prima installazione); si può forzare in `config` o spegnere con `'false'` per far partire una nuova installazione su un database vuoto attraverso un upgrade (per esempio il nuovo tentativo di una prima installazione fallita). **Con Compose** la variabile ora viene inoltrata: si imposta in `.env` (`DB_EXPECT_INITIALIZED=true`, commentata in `.env.example`, da attivare dopo il primo avvio) e va **sempre insieme a `COMPOSE_PROJECT_NAME`**, che non ha default perché un nome diverso crea volumi nuovi e vuoti. **I valori di k3d** (`deploy/helm/clarae/values-k3d.yaml`) la tengono a `'false'`: è un cluster usa e getta. Default `false`: **chi non fa nulla non ha cambiamenti**.
- **Riga di log `database state`.** Dopo le migrazioni il servizio scrive la versione dello schema, il numero di righe del registro di audit e la data della prima. La riga più vecchia non avanza mai: dopo un aggiornamento, una data uguale al giorno dell'aggiornamento significa database ricreato.
- **`features.web_viewer` è acceso di default** (decisione dell'owner, ADR-0060). Il cloud lo distribuisce `true` ai profili senza un valore esplicito, e un client che non ha ancora letto un profilo usa lo stesso default: le applicazioni compaiono al primo avvio dopo l'aggiornamento. **Per non averle:** `{"features": {"web_viewer": false}}` nel profilo globale o in quello di un gruppo; un profilo che ha già `false` lo conserva. La vista incorporata resta solo su macOS; altrove la scheda apre la pagina nel browser. La matrice manuale delle applicazioni **non è eseguita**: chi amministra può spegnere il flag finché non lo è.
- **Cartella di configurazione della 1.x: serve un cloud ≥ 1.7 per la parte sincronizzata.** Un cloud 1.5 o 1.6 (E2BR esegue la 1.5.1) distribuisce `features.config_dir_v2` spento: il client riporta le impostazioni in `.memobrain/` e **non** può ripulirle. La pulizia locale (sotto) parte comunque, ma solo per ciò che `.clarae/` ha già. **Aggiornare il cloud ad almeno la 1.7**, dopo aver aggiornato ogni dispositivo dei vault collegati ([docs/admin-guide/migrazione-clarae.md](docs/admin-guide/migrazione-clarae.md)).
- **Un client precedente contro un cloud con la migrazione `0016`** continua a funzionare: non revoca il dispositivo all'uscita, ma il login successivo riattiva la riga dello stesso nome invece di aggiungerne una. **Un client nuovo contro un cloud precedente** revoca il dispositivo all'uscita ma, a ogni accesso, registra ancora una riga nuova.
- **Due computer dello stesso utente con lo stesso nome e la stessa piattaforma diventano un solo dispositivo** (ADR-0057): condividono identificativo e ultimo accesso, e una revoca vale per entrambi. Si distinguono rinominando un computer. Per provare due istanze sullo stesso computer: `CLARAE_DEVICE_NAME`.
- **Una revoca dalla console si annulla al login successivo di quel computer** (la registrazione riattiva la riga). Per escludere un utente restano la sospensione dell'account e la revoca delle sessioni.
- **Keycloak: un realm già importato non cambia da solo.** Il file del realm ammette già la pagina `/signed-out` (carattere jolly sull'origine), ma `--import-realm` salta un realm esistente: su un'installazione che ha importato il realm prima, controllare dalla console di Keycloak che `post.logout.redirect.uris` del client `clarae-web` ammetta `<origine>/signed-out` (guida: [docs/admin-guide/keycloak.md](docs/admin-guide/keycloak.md)). Se non la ammette, Keycloak mostra «Invalid redirect uri» all'uscita.
- **Primo avvio dopo l'aggiornamento: pulizia di `.memobrain/`.** All'apertura di ogni vault, **una volta per versione dell'app**, l'app toglie dalla cartella della 1.x ciò che `.clarae/` ha già (indice, stato di sync, area di lavoro, cache, snapshot identici, file di sistema come `.DS_Store`) e la rimuove se resta vuota. Mai: il `sync.db` in uso, una voce che esiste solo lì, i link simbolici. **Impostazioni diverse in un vault non collegato vanno nel cestino del vault** (`.trash/`), non si cancellano; in un vault collegato le gestisce la sync (sotto).
- **Un dispositivo 1.4 o precedente rimasto su un vault** dopo la pulizia ricrea nella cartella vecchia le impostazioni che non trova: due copie con id diversi, da riconciliare a mano. La sequenza non cambia: prima ogni dispositivo, poi il cloud.

### Client desktop e workbench

- **Disegni: il testo si scrive e gli oggetti si spostano.** Il motore di disegno (Excalidraw, ADR-0028) richiede un «host» che Clarae notanda non registrava: aprire l'editor di un testo falliva a metà, il testo spariva, non c'era un campo in cui scrivere e, con un testo «in modifica», **nessun oggetto si poteva trascinare né ridimensionare**. Ora l'host è registrato una volta, al caricamento del motore, con i comportamenti predefiniti di Excalidraw (nessun suggeritore di link `[[`, nessun Mermaid condiviso; la voce _LaTeX_ dei suoi menu apre la finestra di Clarae notanda). Il gestore del fuoco dei modali non toglie più il fuoco al campo di testo mentre è aperto un pannello del motore. Un test fallisce se un aggiornamento del motore cambia il protocollo dell'host.
- **Presentazione a tutto schermo e miniature su macOS.** Nella finestra del sistema (WKWebView) la slide restava alla sua dimensione naturale nell'angolo, con il resto nero (bug WebKit 23113). L'app applica ora il polyfill di Marp **solo dove rileva il difetto** (un WebKit che lo ha corretto non lo riceve) alla presentazione e alle miniature, e la slide è centrata, con barre sul lato lungo, su ogni motore. Nuova spec `marp-show-layout.spec.ts`; per provarla su WebKit: `E2E_WEBKIT=1` (progetto opzionale, vedi _Build e sviluppo_).
- **Applicazioni nell'esploratore dei file.** Un pulsante **Nuova applicazione** nella barra dell'esploratore (nella cartella della riga selezionata, o in cima al vault) e la voce nei menu contestuali di una riga e dello spazio vuoto. L'esploratore e le schede mostrano il nome **senza `.webapp`**. Compaiono solo con il flag acceso e su un vault in cui si può scrivere.
- **«Esci» chiude davvero la sessione.** Il desktop, in quest'ordine: ferma la sincronizzazione, **revoca il proprio dispositivo** sul cloud, chiude la sessione su Keycloak (senza aprire il browser) e revoca il token, poi cancella la sessione locale; ogni passo di rete è a miglior sforzo, con un tetto di 8 s, e un errore non tiene l'utente connesso. **Il login successivo a un'uscita esplicita chiede le credenziali** (`prompt=login`), anche se Keycloak ricorda ancora l'utente. Il file `auth-logged-out`, nella cartella dati dell'app, ricorda l'uscita e si cancella a login completato.
- **Dispositivo desktop identificato dal nome del computer.** Dopo «Esci» e un nuovo accesso l'elenco dei dispositivi mostra la **stessa riga**, non una nuova. Il nome si può forzare con la variabile d'ambiente `CLARAE_DEVICE_NAME` (due istanze sullo stesso computer, prove); `scripts/run-desktop-with-cloud.sh --two-devices` la imposta da solo.
- **La percentuale per vault è rispetto alla quota dell'utente** (il pannello dell'uso dello spazio del desktop e della console, lo stesso componente): prima la percentuale era rispetto alla somma dei vault, quindi un solo vault mostrava sempre 100%. Con spazio **illimitato** mostra «—», e un suggerimento sulla cella dice il limite («Rispetto al tuo limite di N GB») o che non c'è.
- **Cartella di configurazione della 1.x: pulizia e sync.** Oltre alla pulizia locale (_Compatibilità_), su un vault collegato e con `features.config_dir_v2` acceso (cloud ≥ 1.7) il motore di sync **cancella la riga legacy** quando `.clarae/<nome>` esiste già e le due righe sono pulite: toglie il file dal disco (nel cestino del vault se il contenuto differiva) e invia una cancellazione normale, quindi la revisione **resta nello storico del cloud**.
- **Console: l'uscita si completa anche se la revoca fallisce.** La revoca dei token e la chiusura della sessione su Keycloak sono a miglior sforzo: se falliscono (rete, token scaduto), la console toglie comunque la sessione locale e arriva a `/signed-out`.
- **Desktop: l'uscita non riavvia la sincronizzazione.** Se la sessione era già scollegata con un token scaduto, rinnovarlo per revocare il dispositivo non la ricollega più e non fa ripartire la sync che l'uscita aveva fermato.
- **Console e workbench web: una pagina «Sei uscito».** Dopo «Esci» la console torna a `/signed-out`, una pagina pubblica con il pulsante «Accedi», che **non rifà il login da sola**. Il login successivo chiede la password (`prompt=login`, marcatore `clarae.auth.forceLogin` nello spazio locale del browser). Un'uscita revoca anche i token.

### Cloud

- **Dispositivi (ADR-0057).** `POST /me/devices` per `windows`, `macos` e `linux` è un upsert su `(utente, piattaforma, hostname)`: la stessa registrazione restituisce lo stesso `id`, riattivato se era revocato, e aggiorna nome e versione dell'app. La risposta resta `201` in ogni caso. Per `web` ogni registrazione crea un dispositivo. La `Idempotency-Key` continua a valere prima dell'upsert.
- **Download ZIP: una sola cartella di configurazione.** Lo ZIP di un vault condiviso scrive i file di `.memobrain/` sotto `.clarae/`; se esiste già lo stesso nome in `.clarae/`, **vince `.clarae/`** e quello legacy non entra. Per un vault privato lo ZIP si costruisce nel browser con la stessa regola, **qualunque sia l'ordine** dei file; il file escluso compare nel rapporto come `duplicate_path` e non si scarica. **Se la copia in `.clarae/` non si può esportare** (blob mancante, decifrazione fallita), non nasconde più la gemella sana della cartella legacy: questa esce sotto `.clarae/` e la copia guasta resta nel rapporto. Le esclusioni di prima (`index.db`, `sync.db`, …) restano.
- **Registro di audit protetto da un aggiornamento sbagliato (Onda F).** Guardia `DB_EXPECT_INITIALIZED`, riga di log `database state` e prove nuove (_Compatibilità_). Un test (`TestNoMigrationEmptiesTheAuditLog`) fallisce se una migrazione, nelle sezioni `Up`, cancella o svuota `audit_log`; un'integrazione porta un database con righe di audit dalla 0015 alla 0016 e le ritrova. Nessuna migrazione o job cancellava il registro: la causa probabile dei dati persi su E2BR è un database ricreato durante un aggiornamento Helm in un altro namespace.
- **Avvio più rapido.** La riga `database state` si scrive in background: non ritarda l'ascolto del servizio.
- **Realm di Keycloak:** nessuna modifica ai file; i test del realm verificano che `/signed-out` sia ammesso, in produzione (`${WEB_UI_ORIGIN}/signed-out`) e in sviluppo (`localhost:5174` e `localhost:18081`).
- **k3d e sviluppo:** `deploy/k3d/deps.yaml` tiene PostgreSQL su un volume (`postgres-data`, 2 Gi) invece che su `emptyDir`: fermare e riavviare lo stack non azzera più il database, e il secondo `up` (un upgrade Helm) non trova uno schema vuoto.

### Console web

- **«Scarica ZIP» uguale per ogni vault.** La riga di un vault privato mostra lo stesso testo («Scarica ZIP») degli altri; la nota che il file è decifrato nel browser resta nell'etichetta per i lettori di schermo.
- **La finestra «Scarica …» va a capo.** Il testo non esce più dal bordo (la causa era `white-space: nowrap` ereditato dalla cella della tabella). Vale per ogni finestra montata in una cella.
- **Amministrazione a tutta larghezza.** Le pagine `/admin/*` usano tutta la larghezza, con il menu a sinistra; le altre pagine restano a 1000 px. Sotto i 700 px non cambia nulla.

### Contratti

- `api/openapi.yaml`: nessuna operazione né campo nuovi. Cambiano le descrizioni di `POST /me/devices` e di `Device.name` (per le piattaforme desktop `name` è il nome del computer e identifica il dispositivo; `201` anche alla riattivazione).
- `api/config-profile.schema.json`: `features.web_viewer` ha default `true` (era `false`); la descrizione dice «On by default since 1.7.2». Rigenerati `shared/go/features` e `packages/api-client`.
- Configurazione del cloud: variabile nuova `DB_EXPECT_INITIALIZED` (booleano, default `false`), documentata in `docs/admin-guide/configurazione.md`. Chart Helm: stessa chiave in `config`, impostata a `"true"` a ogni upgrade se non è già in `values`.
- Database: migrazione `0016_device_hostname` (colonna `devices.hostname` e indice unico parziale `devices_hostname_uq`).
- Binding del core: nessun metodo né evento nuovo.

### Build e sviluppo

- **`E2E_WEBKIT=1`** aggiunge un progetto WebKit a `apps/desktop/frontend/playwright.config.ts`, che esegue solo `marp-show-layout.spec.ts` (il motore della finestra di macOS, che Chromium non riproduce). Prima volta: `npx playwright install webkit`. Non fa parte di `task ci`.
- **Dipendenza:** `@marp-team/marpit-svg-polyfill` (`^2.1.0`) in `@clarae/workbench`.
- **Prove nuove:** `cleanup_test.go` (`vaultdir`), `config_shadowed_test.go` (`vault`), `manager_pause_test.go` e `configmigrate_test.go` (`sync`), `logout_test.go` (`auth`); `device_hostname_test.go` e `export_test.go` (integrazione del cloud), `audit_migrations_test.go` e `migrate_test.go` (`db`), `realm_test.go`; `excalidrawHost.test.ts`, `polyfill.test.ts`, `FileExplorer.webapp.test.tsx`, `configdir.test.ts`, `oidc.test.ts`; e2e `marp-show-layout.spec.ts`, `webapp.spec.ts`, `drawing-tools.spec.ts`, `web/e2e/app.spec.ts`, `admin.spec.ts`, `vaults.spec.ts`, `devices.spec.ts`.
- **Allowlist del rebrand:** una riga `legacy` nuova per `packages/vaultcrypto-web/src/configdir.ts` (nome della cartella della 1.x, rimozione alla 2.0).

### Verificato

- `task ci` verde sull'albero della 1.7.2 (506 s): lint, typecheck, test Go con `-race`, vitest, conformance, `test-wasm`, parità, `check-gen` e budget (console 701 kB su 720, ADR-0061).
- `task test-integration` (cloud con testcontainers, 116 s) e `task test-desktop-e2e` (sync a due dispositivi contro il cloud reale, 233 s), entrambi verdi.
- Le spec Playwright toccate (web, desktop sul mock, bundle di produzione, matrice sul core WASM, WebKit con `E2E_WEBKIT=1` per la presentazione) verdi; una revisione avversariale del diff, i cui cinque rilievi sono corretti.

### Documentazione

- ADR **0057** (dispositivo per nome del computer e revoca all'uscita), **0058** (uscita completa da Keycloak), **0059** (pulizia della cartella di configurazione legacy e ZIP coerente) **0060** (`web_viewer` acceso di default) e **0061** (budget iniziale della console da 700 a 720 kB), tutti in _proposta_; ADR-0056 ha una nota che rimanda a ADR-0060.
- Guida utente (applicazioni, esportare un vault, sincronizzazione e dispositivi, risoluzione dei problemi), guida per chi amministra (aggiornamento con backup e guardia, Keycloak e `/signed-out`, tabella dei flag, `DB_EXPECT_INITIALIZED`), `docs/dev-setup.md` e `docs/desktop-web-sync.md` (`CLARAE_DEVICE_NAME`, `E2E_WEBKIT`), roadmap §13-quaterdecies (M21) e indice degli ADR. Runbook delle prove manuali: [docs/qa/m21-correttivi.md](docs/qa/m21-correttivi.md).

### Non provato e lavoro successivo

- **Il logout contro un Keycloak vero.** Il logout in background del desktop (`end_session_endpoint` con il token di rinnovo) e `prompt=login` sono provati con un server OIDC finto; che Keycloak 26 chiuda davvero la sessione e che il login successivo chieda la password si verifica a mano ([docs/qa/m21-correttivi.md](docs/qa/m21-correttivi.md)). La **causa** del rientro senza password su E2BR non è accertata: può essere il realm importato prima (URI di post-logout) o un broker; le correzioni valgono in entrambi i casi.
- **Nulla di visivo è provato sulla finestra reale del desktop:** la presentazione a tutto schermo su WKWebView (il progetto WebKit di Playwright è un'approssimazione), il testo e il trascinamento dei disegni, il pulsante «Nuova applicazione», il testo della finestra «Scarica» e l'amministrazione a tutta larghezza sono provati da vitest, test Go ed e2e in Chromium.
- **Ripulitura di `.memobrain/` su E2BR:** con un cloud 1.5 o 1.6 la parte sincronizzata non si corregge. L'aggiornamento di E2BR va fatto con la procedura della guida (backup, stesso namespace e stesso volume).
- **Diagnosi dell'audit su E2BR:** è un compito dell'owner (interrogazioni in sola lettura nella guida), non è stata eseguita. Se il vecchio database esiste ancora, il ripristino da `pg_dump` si pianifica con l'owner.
- **ADR 0057…0061 da accettare e da recepire in `Specifications.md`** (§1.3, §1.7, §2.6.6, §2.8.2, §3.2.2, §3.3.1, §3.5.1, §3.5.2): li accetta l'owner.

## [1.7.1] - 2026-11-15

Il grafo 3D guadagna un **livello di dettaglio intermedio** (solidi istanziati, uno per forma, da 1.001 a 2.000 nodi); il **selettore rapido** trova anche le applicazioni, le lavagne, le basi e i disegni; una **pulizia in background** cancella i dati di sessione delle applicazioni dei vault che non esistono più; un **driver per Windows** entra nel codice, compilato ma spento (milestone M20, [roadmap](docs/roadmap.md) §13-terdecies, ADR-0055 e ADR-0056). **`Specifications.md` passa alla v1.6** e gli ADR 0053, 0054, 0055 e 0056 sono **accettati** e recepiti. **Nessuna migrazione: il protocollo di sync, le operazioni delle API e il database del cloud non cambiano, e `api/openapi.yaml` cambia solo nel numero di versione.** **`features.web_viewer` resta spento di default** (decisione dell'owner): la matrice manuale non è eseguita. **Nulla di nuovo è stato provato sulla finestra reale del desktop e il driver Windows non è mai stato eseguito su Windows** (vedi _Non provato e lavoro successivo_).

### Compatibilità

- **Come si aggiorna dalla 1.7.0:** i client desktop non si aggiornano da soli, si installano a mano; il Cloud Service non cambia. Nessun comando da eseguire, nessuna migrazione locale né del cloud.
- **Primo avvio: pulizia dei dati di sessione.** Dopo l'aggiornamento l'app cancella, in background, gli archivi di sessione delle applicazioni dei vault che non esistono più (regola sotto, in _Client desktop e workbench_). Un vault solo chiuso, su un disco non montato o aperto negli ultimi 30 giorni non perde nulla.
- **Grafo 3D: tre livelli al posto di due.** Un vault con 1.001 o 2.000 nodi mostrati vede solidi invece di sprite; nessuna impostazione nuova e nessuna chiave nuova in `.clarae/graph.json`. I tetti non cambiano (5.000 nodi; trascinamento fino a 2.000).
- **Applicazioni: nessun cambio di comportamento visibile fuori da macOS.** `features.web_viewer` resta `false`. Il driver per Windows è spento: la capability `embeddedBrowser` resta solo macOS, quindi su Windows l'applicazione si apre ancora nel browser di sistema. Il driver si accende solo con la variabile d'ambiente di sviluppo `CLARAE_WEBVIEW2_EXPERIMENTAL=1` (vale il solo valore `1`) e anche così l'interfaccia non lo usa.
- **Selettore rapido e completamento dei wikilink: i file in `.trash/` e nelle cartelle nascoste non compaiono più** (un segmento del percorso che inizia con `.`), come nell'esploratore dei file. Nella 1.7.0 le note nel cestino comparivano nei suggerimenti dei wikilink, del selettore di note dei disegni e del selettore rapido. Per il resto i suggerimenti dei link `[[` e i selettori di nota sono invariati (solo note).

### Client desktop e workbench

- **Grafo 3D: un livello di dettaglio in più (ADR-0055, punto 7).** I nodi si disegnano in tre modi, secondo quanti sono: **sprite con l'icona del tipo fino a 1.000**, **solidi istanziati da 1.001 a 2.000**, **punti oltre**. I solidi hanno una forma per tipo: sfera per note e presentazioni, cubo per i disegni, ottaedro per le lavagne, cilindro per le basi, cono per gli allegati, toro per i tag, icosaedro per le note non ancora create. La legenda mostra la forma al posto dell'icona. I nodi si trascinano con sprite e solidi (fino a 2.000), non con i punti. Misure, su una macchina condivisa con carico variabile e in una o due serie (ordini di grandezza): con Metal e un grafo misto il livello istanziato fa 8 draw call a qualunque dimensione e 0,1 ms di CPU per frame, contro 0,9 ms degli sprite a 1.000 nodi e 1,8 ms a 2.000 (60 fps in tutti i casi, limitati dal vsync); con un rasterizzatore software a 2.000 nodi 11,3 / 27,3 fps contro 9,3 / 18,0 degli sprite (durante il layout / in orbita). Oltre 2.000 nodi non guadagna sui punti e su software perde (7,7 contro 24,7 fps a 5.000 nodi), per questo si ferma a 2.000. Il file del 3D (`Graph3D-*.js`) cresce di 10,6 KiB e `layout.worker.js` di 0,9 kB; i budget del bundle non cambiano. Metodo e tabelle in [docs/qa/graph-3d-benchmark.md](docs/qa/graph-3d-benchmark.md).
- **Selettore rapido (`Mod+O`).** Trova per nome, oltre alle note, le **applicazioni** (`.webapp`), le **lavagne**, le **basi** e i **disegni**, con l'icona del tipo e il tipo letto dai lettori di schermo; li apre nella loro vista. Un file di un altro tipo con lo stesso nome di una nota che non esiste non nasconde più la voce «Crea nota» (e nemmeno un titolo): la tolgono solo una nota, una presentazione `.marp` o un alias omonimi (crearla riassegnerebbe i link esistenti); lavagne, basi, disegni, applicazioni e titoli no. I file in `.trash/` e nelle cartelle nascoste non compaiono né qui né nei suggerimenti dei wikilink. Prima il selettore cercava solo le note.
- **Applicazioni: pulizia dei dati di sessione.** Dopo l'avvio, in background, l'app cancella i dati di sessione (e la riga che li identifica) delle applicazioni di un vault solo se quel vault non è aperto, non è una condivisione ricevuta e non è tra i vault recenti, oppure vi è ma è «sicuramente sparito»: aperto l'ultima volta più di 30 giorni prima, non su un volume rimovibile, con la cartella che non esiste mentre quella che la contiene c'è, si legge e **non è vuota** (una madre vuota è la firma di un punto di mount scelto dall'utente e non montato: rclone, sshfs, macFUSE, Cryptomator; il vault si tiene). Subito prima di cancellare si ricontrolla che il vault non sia stato aperto nel frattempo. Mai per un vault solo chiuso o su un disco non montato. Limite noto: il dato di un vault cancellato che era l'unica cosa nella sua cartella resta (qualche megabyte). La deviazione dal piano resta e ora è accettata: i dati stanno nel contenitore di WebKit e non in una cartella dell'app.
- **Driver per Windows, compilato e spento.** `internal/shell/nativeview` contiene un driver WebView2 per Windows, su una copia ridotta e corretta del binding WebView2 interno di Wails v3.1.0 (`webview2/`, con `LICENSE` e `NOTICE`), compilata per amd64 e arm64 con CGO spento. **Mai eseguito su Windows.** Spento: si accende solo con `CLARAE_WEBVIEW2_EXPERIMENTAL=1` e anche così la capability `embeddedBrowser` resta solo macOS, quindi l'interfaccia apre comunque le applicazioni nel browser di sistema. Serve a provarlo su una macchina Windows. Differenze dichiarate rispetto a macOS: user agent di Edge; il selettore di file non si può negare; per il blocco automatico di un vault privato contano solo tasti e fuoco, non mouse e rotella; l'autenticazione integrata di Windows è gestita dal runtime; dati in `<cartella dati>\webapps\<store>`; runtime WebView2 almeno 1.0.2210.55, altrimenti la pagina si apre nel browser. Per accenderlo davvero, a prova eseguita: `windows` in `DesktopOS`, `task gen`, registro di parità e guide.

- **Il fuoco resta nella palette e nei dialoghi aperti.** Un componente che si prende il fuoco da solo — la casella di ricerca della libreria di forme di Excalidraw, montata mentre un disegno finisce di caricarsi — lo toglieva alla palette dei comandi appena aperta con `Mod+P`, e la digitazione finiva nel disegno. Il gestore unico del fuoco dei modali (`packages/ui/src/focus.ts`, ADR-0043) ora lo riporta nel modale aperto, tranne quando è l'utente ad agire sul modale (per esempio «Vai alla riga», che rimette il fuoco nell'editor). Vale per la palette, il selettore rapido e ogni dialogo, anche nella console. Il difetto c'era già nella 1.7.0: lo ha mostrato la matrice e2e (la spec della libreria dei disegni falliva 3 volte su 9 sulla base `v1.7.0`); ora c'è un e2e che lo prova (`keyboard.spec.ts`).

### Build e sviluppo

- **La prova CSP del 3D si è spostata.** `web/e2e-security/graph3d-csp.spec.ts` non esiste più: il test del grafo 3D sta in `web/e2e-security/workbench-csp.spec.ts` (stesso server e stessa CSP di produzione) e prova anche il livello istanziato. La voce `graph.3d` del registro di parità rimanda al nuovo file. Nella sezione 1.7.0 di questo file il nome vecchio resta, perché è la storia.
- **Grafo 3D: la presa di un nodo e i controlli della camera.** Se il grafo cambia mentre si tiene un nodo (sprite o solido), la presa si chiude e i controlli della camera restano attivi; prima restavano spenti. E2e dedicato.
- **`task ci` compila il codice Windows.** Nuovo passo `vet-windows`: `go vet`, compilazione dei test senza eseguirli e `golangci-lint` per `GOOS=windows`, amd64 e arm64, con CGO spento (10-35 s). Il test `webview2/com_test.go` è limitato a 64 bit; 386 non è un target.
- **Revisione del codice della 1.7.1:** due rilievi medi (la pulizia che poteva cancellare i dati di un vault su un punto di mount non montato; i controlli della camera spenti dopo un aggiornamento del grafo) e quattro bassi (l'indicizzazione di un test della pulizia, il ricontrollo prima di cancellare, i file nascosti nel selettore, «Crea nota» con una presentazione omonima, più `task ci` che non compilava il codice Windows), tutti corretti con un test ciascuno. Il driver Windows è risultato davvero spento.
- **Test del 3D stabilizzati.** `apps/desktop/frontend/e2e/graph-3d.spec.ts`: timeout esplicito, 17 commutazioni invece di 20, attese più larghe sullo stato della scena e attesa della quiete della scena (con la macchina molto carica falliva per attese legate a un frame del rendering software).
- **Benchmark del 3D:** `CLARAE_GRAPH3D_KINDS=mixed` (grafo di nove tipi di documento), `CLARAE_GRAPH3D_LOD=sprite|instanced|points` per forzare il livello (solo nelle build E2E), colonne per la CPU di render e per i triangoli.
- **Prove nuove:** `lod.test.ts` e `QuickSwitcher.test.tsx` (vitest), e2e `quick-switcher.spec.ts`, test Go di `internal/links` (`SuggestFiles`) e `internal/app` (`bindings_suggest_test.go`, `webviews_sweep_test.go`), `manager_test.go` di `internal/webview`, `winpure_test.go` e `driver_windows_test.go` (il secondo compilato, non eseguito, su Windows).
- **Runbook delle prove manuali:** [docs/qa/verifica-manuale-1.7.md](docs/qa/verifica-manuale-1.7.md) dice come preparare l'ambiente (anche con il cloud e il profilo con `features.web_viewer`), come generare i vault per il 3D, in che ordine eseguire le checklist e dove registrare gli esiti. **Le soglie che propone** (≥ 30 fps in orbita a 5.000 nodi sulla finestra reale, nessun avviso WebGL dopo dieci aperture e chiusure, matrice macOS 14 o successivo senza difetti P0 e P1 per proporre `features.web_viewer` acceso) **sono proposte, non ancora fissate dall'owner.**

### Contratti

- `api/openapi.yaml`: nessuna operazione cambiata (cambia solo il numero di versione). `api/config-profile.schema.json` non cambia.
- Binding del core (desktop e core WASM): `LinksAPI.Suggest` con `kind = "all"` può restituire suggerimenti di tipo `webapp`, `canvas`, `base` e `drawing` oltre a quelli di prima; con `kind = "notes"` e gli altri valori non cambia nulla. Nessun metodo né evento nuovo.

### Documentazione

- **`Specifications.md` v1.6** recepisce **ADR-0053, ADR-0054, ADR-0055 e ADR-0056**, accettati dall'owner (Appendice C.4 e registro delle revisioni). Il recepimento non tocca gli ADR 0045–0052: lo spec dice ancora Wails v2 e _MemoBrain Notes_ (`.memobrain/`).
- ADR-0055 (punto 7: tre livelli, con la misura) e ADR-0056 (selettore rapido, pulizia dei dati di sessione, driver Windows spento, `features.web_viewer` spento di default); matrice manuale [docs/qa/m18-webview-matrice.md](docs/qa/m18-webview-matrice.md) (caso M4 aggiornato, M42 nuovo, sottosezione «Driver sperimentale (interruttore)» con i casi WE1…WE25, nessuno eseguito); `docs/qa/graph-3d-benchmark.md` con la sezione del livello intermedio; guide utente (selettore rapido, applicazioni, vista grafo) e guida per chi amministra (pulizia dei dati di sessione, Windows); roadmap §13-terdecies (M20) e aggiornamenti in §13-undecies; indice degli ADR.

### Non provato e lavoro successivo

- **Nulla delle novità è provato sulla finestra reale del desktop** (WKWebView su macOS, WebView2, WebKitGTK): il livello a solidi del grafo (forme, legenda, trascinamento), il selettore rapido e la pulizia dei dati di sessione sono provati da vitest, test Go e e2e in Chromium con i binding simulati e sul core WebAssembly. Le misure del 3D sono su un solo computer e un grafo sintetico, su una macchina condivisa con carico variabile.
- **Il driver Windows non è mai stato eseguito su Windows.** La sua matrice (casi WE) non è eseguita.
- **`features.web_viewer` resta spento di default:** la matrice manuale [docs/qa/m18-webview-matrice.md](docs/qa/m18-webview-matrice.md) non è eseguita. Le prove manuali (runbook sopra) le esegue l'owner.
- **Suite complete su `v1.7.0`** (eseguite il 2026-11-15 in un worktree, su una macchina molto carica): `e2e:security` 11 su 11; `task test-integration` verde; `e2e-desktop-prod` 44 su 44; `e2e-web` 97 su 97; `e2e-desktop` 235 passati e 1 fallito (il test dei contesti WebGL del grafo 3D, oltre il timeout di 30 s); matrice e2e 442 passati e 4 falliti al primo giro, tutti in `graph-3d.spec.ts` (attese legate a un frame del rendering software sotto carico), poi verdi rilanciati. Per questo `graph-3d.spec.ts` è stabilizzato nella 1.7.1 (sopra).

- **Verificato sull'albero della 1.7.1 (2026-11-15):** `task ci` completo verde (budget: console `initial 698 kB (limit 700)`, workbench `initial 1998 kB (limit 2500), total 17358 kB (limit 23000)`; durata 520 s; `vet-windows` su amd64 e arm64; `task parity` 96 funzioni, 203 comandi, 155 binding). Suite complete: `e2e-desktop` 244 passati; `e2e-desktop-prod` 44; `e2e-web` 97; `e2e:security` 11; `task test-integration` verde; matrice e2e (desktop-mock e web-core) 462 passati e 1 fallito sull'ultimo giro, «Present toggles…» di `drawing.spec.ts` su web-core (la barra di Excalidraw non visibile entro 5 s), poi 60 su 60 rilanciando la spec cinque volte; nel giro precedente, con la correzione del fuoco, 463 passati e nessun fallimento.

## [1.7.0] - 2026-11-15

Il grafo del vault in 3D, con i disegni, le lavagne e le basi tra i nodi; le **applicazioni**, pagine web registrate nel vault che si aprono in una scheda (in un browser incorporato su macOS, dietro un flag spento di default); e le **tre rimozioni di compatibilità con la 1.x** che la 1.5.0 fissava alla 1.6 e che il proprietario ha spostato alla 1.7 (milestone M18 tracce D ed E e M19, [roadmap](docs/roadmap.md) §13-undecies e §13-duodecies, ADR-0055, ADR-0056 e ADR-0052). **Chi amministra un cloud: leggere _Compatibilità_ prima di aggiornare** (ordine dei passi, immagine, repliche, Config Profile). ADR-0055 e ADR-0056 sono in stato proposta: ADR-0055 è un'aggiunta a ADR-0013 e a `Specifications.md` (§2.2.1, Appendice A, §3.4.6); ADR-0056 anticipa il Web viewer da P2 (§2.2.1, Appendice B, C.2) e non tocca «una sola finestra» né la CSP; lo spec non è toccato e lo aggiorna il proprietario, a partire dall'elenco in fondo a ciascun ADR. **Il protocollo di sync, le operazioni delle API e il database del cloud non cambiano** (nessuna migrazione): cambia solo la descrizione del flag `features.web_viewer` nello schema del Config Profile. **Le applicazioni sono spente di default (`features.web_viewer`) finché la matrice di prove manuali non è eseguita** ([docs/qa/m18-webview-matrice.md](docs/qa/m18-webview-matrice.md)). **Non provato sull'applicazione desktop reale** (WKWebView, WebView2, WebKitGTK): le prove del grafo 3D sono in Chromium e sul core WebAssembly, e il frontend delle applicazioni non è mai stato visto su una finestra reale (vedi _Non provato e lavoro successivo_).

### Compatibilità

- **Come si aggiorna dalla 1.5 o dalla 1.6, in quest'ordine** (dettagli in [docs/admin-guide/migrazione-clarae.md](docs/admin-guide/migrazione-clarae.md), «Aggiornare alla 1.7»): **(1)** aggiornare ogni dispositivo dei vault collegati; **(2)** correggere i riferimenti all'immagine; **(3)** non far mai girare un pod 1.4 o precedente con un pod 1.7; **(4)** aggiornare il cloud. I client desktop non si aggiornano da soli: si installano a mano. Il Cloud Service non ha migrazioni del database in questa versione.
- **Advisory lock (R1).** Il cloud prende un solo lock con il nome `clarae.<tipo>:<id>` per la pubblicazione di un blob, i controlli di quota degli upload e le richieste di export; nelle linee 1.5 e 1.6 prendeva prima il nome della 1.x e poi quello nuovo. **Un pod 1.4 o precedente non deve mai girare insieme a un pod 1.7 o successivo sullo stesso database**: prende solo il nome vecchio, quindi i due non si escluderebbero più (due upload dello stesso blob, o due controlli di quota dello stesso utente, potrebbero correre insieme). Da una 1.4 o precedente si passa per la 1.5 o la 1.6 e solo dopo alla 1.7; la 1.5 e la 1.6 convivono sia con la 1.4 sia con la 1.7. **Il ritorno alla 1.4.0 resta possibile solo se nessun pod 1.7 è in esecuzione.**
- **Immagine (R2).** La release pubblica solo `ghcr.io/<owner>/clarae-cloud`: **non esiste un tag `memobrain-cloud:1.7.x`**. I tag 1.5 e 1.6 con il vecchio nome restano nel registry. Chi ha in Compose `MEMOBRAIN_IMAGE` o `CLARAE_IMAGE` che punta a `ghcr.io/<owner>/memobrain-cloud`, o in Helm `image.repository: ghcr.io/<owner>/memobrain-cloud`, deve cambiarlo in `clarae-cloud` (o togliere l'override: i default di Compose e del chart sono già `clarae-cloud`) **prima** di portare la versione a 1.7, altrimenti il pull fallisce. Restano fino alla 2.0 le variabili `MEMOBRAIN_*` del Compose, `nameOverride: memobrain` del chart e il resto della tabella delle rimozioni.
- **`features.config_dir_v2` è acceso per default (R3).** Il motore di sync sposta le impostazioni sincronizzate dei vault collegati (editor, scorciatoie, aspetto, template, …) dalla cartella della 1.x a `.clarae/`, come un normale spostamento di file (stessi id e stessa cronologia). Spento, il client legge entrambe le cartelle e non sposta nulla; spegnerlo ferma solo lo spostamento, quello già fatto resta. Un vault non collegato e un mount in sola lettura non spostano nulla.
  - **Per chi amministra:** aggiornare prima ogni dispositivo dei vault collegati, poi il cloud. Per non spostare: `"features": {"config_dir_v2": false}` nel profilo globale (o di gruppo); toglierlo quando tutti i dispositivi sono aggiornati.
  - **Il cloud decide il valore.** Il cloud calcola il profilo effettivo dai suoi default: un cloud 1.7 distribuisce `true`, uno 1.5 o 1.6 `false`, quindi **un client 1.7 contro un cloud più vecchio non sposta nulla.**
  - **Lo spostamento parte solo dopo che il client ha letto un profilo del server**, fresco o in cache. Prima (non collegato, primo avvio offline, nessuna cache) la configurazione è vuota e un default acceso avrebbe spostato le impostazioni prima che un'organizzazione che l'aveva spento apposta avesse voce.
  - **Un dispositivo 1.4 rimasto sul vault dopo lo spostamento** non vede le impostazioni nella cartella nuova, scrive le sue nella vecchia e ricrea quelle che non trova: due copie con id diversi, da riconciliare a mano. Il motore non sposta un file se nella cartella nuova c'è già quel nome, quindi non si perdono dati.
  - **Limite noto, non corretto:** se nella stessa sessione si passa a un altro server la cui cache è fresca, il valore del server precedente vale fino al refresh successivo.
- **Grafo 3D: nessuna migrazione.** Le chiavi nuove di `.clarae/graph.json` (`showDocuments`, `curvedLinks`, `showLegend`, `maxNodes3d`) hanno un valore predefinito: un vault senza di esse si apre come prima, con i disegni, le lavagne e le basi tra i nodi.
- **La scelta 2D/3D è per dispositivo**: sta nello spazio locale del browser o della WebView (chiave `clarae.graph.mode`), non nel vault e non si sincronizza. Su un dispositivo nuovo il grafo si apre in 2D.
- **Il tetto di 5.000 nodi vale solo per il 3D.** Il 2D mantiene il tetto di prima, con l'obiettivo di 10.000 nodi a 30 fps di M6; il 3D non lo eredita (misure in [docs/qa/graph-3d-benchmark.md](docs/qa/graph-3d-benchmark.md)).
- **La CSP non cambia** e il budget del bundle nemmeno: il codice 3D sta in un file a parte (791 kB sul desktop, 792 kB sul web) che si scarica solo alla prima apertura del 3D.
- **Applicazioni: flag spento di default, nessuna migrazione.** `features.web_viewer` resta `false` (prima era «riservato», senza effetti): chi non lo accende non vede nulla di nuovo. Si accende da un profilo, quindi **serve un cloud**: un vault solo locale non ha un profilo. Il client lo legge con il profilo e, se un profilo nuovo lo spegne, chiude le pagine aperte.
- **Dove c'è il browser incorporato: solo macOS.** Il client desktop per Windows e per Linux non ha un driver: l'applicazione si apre nel browser di sistema (anche con il flag acceso). Nel workbench web si apre una nuova scheda del browser. Su macOS 13 le sessioni dei siti durano quanto l'app (da macOS 14 sono persistenti); l'app non lo segnala.
- **Il file `.webapp` è un file ordinario** (`{"version":1,"url":"https://…"}`) e si sincronizza come ogni altro (per il merge è di tipo `other`: due dispositivi che lo cambiano insieme, ultima scrittura se è lo stesso utente, copia di conflitto se sono utenti diversi). Un client 1.6 o precedente lo vede come un file che non sa mostrare.
- **I dati di sessione dei siti restano sul dispositivo**, per vault, **fuori dal vault e dalla sincronizzazione** (nel contenitore di WebKit; l'identificatore dell'archivio sta in `app.db`). Non stanno in una cartella dell'app, perché `WKWebView` non permette di sceglierla. Spegnere il flag **non** li cancella; _Elimina i dati delle applicazioni_ sì.

### Cloud

- Il Cloud Service prende un solo advisory lock per blob, quota e export (vedi _Compatibilità_); nessun'altra modifica al codice, alle operazioni delle API e al database. Il workflow di release pubblica un'immagine sola e l'allowlist del rebrand perde le quattro righe `legacy` dei lock e dell'immagine («dropped in 1.7»).

### Client desktop e workbench

- **Impostazioni sincronizzate nella cartella nuova.** Su un vault collegato, con un profilo del server già letto e `features.config_dir_v2` acceso (il default dalla 1.7), le impostazioni si spostano da sole in `.clarae/` a fine ciclo di sincronizzazione (vedi _Compatibilità_).
- **Grafo in 3D.** Nella barra del grafo, un pulsante passa tra 2D e 3D nella stessa vista: filtri, gruppi, timelapse e grafo locale valgono per entrambe. Si apre anche dal ribbon (icona a cubo) e dalla palette: _Apri vista grafo in 3D_ (`graph:open-3d`) e _Grafo: passa tra 2D e 3D_ (`graph:toggle-3d`), senza scorciatoia di default. Funziona uguale sul desktop e nel workbench web.
- **Come si usa.** Un click su un nodo lo seleziona e porta la camera su di lui; un click sul nodo già selezionato, il doppio click o Invio lo aprono, Ctrl/Cmd+click lo apre in una nuova scheda. Dalla tastiera: frecce per ruotare, `+` e `-` per lo zoom, `0` per adattare, `[` e `]` per passare da un nodo all'altro (dal più connesso), Esc per togliere la selezione. Passando sopra un nodo, lui e i suoi vicini restano accesi e gli altri si attenuano. I link tra due note che si rimandano l'una all'altra sono disegnati come due archi (opzione _Link reciproci curvi_).
- **Icone per tipo di documento.** Ogni nodo ha l'icona del suo tipo (le stesse dell'esploratore dei file) sul colore del suo gruppo o del suo tipo, e una legenda con il conteggio per tipo (si spegne dalle impostazioni del grafo). Le etichette sono al massimo 40 alla volta: il nodo corrente, i suoi vicini e i più connessi vicini alla camera.
- **Fino a 2.000 nodi** ogni nodo si può trascinare e resta **fisso** dove lo si lascia, anche quando il grafo si aggiorna; _Sblocca i nodi fissati_ li libera. **Oltre 2.000** i nodi sono punti e non si trascinano.
- **Fino a 5.000 nodi.** Se il vault ne ha di più, il 3D mostra i più connessi e la riga di stato lo dice («Mostrati N nodi su M»). Il limite si abbassa da _Nodi mostrati (massimo)_, da 500 a 5.000. Con più nodi usate il 2D.
- **Senza WebGL2 il grafo resta in 2D**, con un avviso: succede se il dispositivo non lo offre, se il contesto grafico va perso, se ci sono già quattro grafi 3D aperti o se la vista non parte. Scegliere di nuovo il 3D riprova. A riposo la scena smette di disegnare; con «riduci movimento» attivo del sistema la camera salta invece di muoversi.
- **Disegni, lavagne e basi nel grafo, anche in 2D.** Prima il grafo mostrava solo note e allegati. Ora i disegni (`.excalidraw`), le lavagne (`.canvas`) e le basi (`.base`) compaiono come nodi: disegni e lavagne con i link che contengono, una base solo come destinazione. I tag restano solo delle note, quindi un filtro per tag li nasconde. Si spengono con _Disegni, lavagne e basi_ nei filtri. Il grafo locale si può centrare anche su un disegno, una lavagna o una presentazione.
- **Applicazioni (ADR-0056).** Una pagina web registrata nel vault come file `.webapp` si apre in una scheda. _Nuova applicazione_ (`app:new`, nel ribbon e nel pannello vuoto, nascosta con il flag spento, disabilitata su un vault in sola lettura) chiede indirizzo (senza schema riceve `https://`) e nome e scrive il file; _Apri applicazione…_ (`app:open`) elenca quelle del vault; _Cambia l'indirizzo dell'applicazione_ (`app:edit-url`) riscrive il file; _Apri l'applicazione nel browser_ (`app:open-in-browser`). **Il selettore rapido non trova i `.webapp`** (cerca solo le note); un `.webapp` incorporato in una nota non carica nulla.
- **Applicazioni: la prima volta si chiede.** Alla prima apertura di un indirizzo su un dispositivo, per vault, compare «Aprire … qui?»: anche per chi ha appena creato l'applicazione, perché il file può arrivare dalla sync o da un altro utente di un vault condiviso. Si può aprire «qui» o nel browser; _Elimina i dati delle applicazioni_ (`app:clear-data`) azzera le conferme.
- **Applicazioni su macOS: il browser dentro la scheda.** La pagina gira in una vista nativa (`WKWebView`, user agent simile a Safari) aggiunta come figlia della stessa finestra: non c'è una finestra in più. La barra ha indietro, avanti, ricarica (`Mod+[`, `Mod+]`, `Mod+R`), l'indirizzo **come solo testo** (per cambiarlo si riscrive il file), «Cambia indirizzo» e «Apri nel browser»; sotto, gli avvisi della pagina e riquadri per errore di caricamento, certificato rifiutato (nessun modo di proseguire), pagina in crash, vista chiusa e limite di viste. La pagina sta sempre sopra l'interfaccia, quindi si nasconde da sola mentre si trascina una scheda, uno splitter o un file e sotto palette, menu e dialoghi. Cambiare scheda la nasconde e la conserva; chiudere la scheda la chiude; due pannelli sulla stessa applicazione sono due pagine; le schede ripristinate non caricano nulla finché non sono mostrate. Le scorciatoie dell'app (non quelle dell'editor) funzionano anche con il fuoco nella pagina. Una pagina nascosta ha i timer rallentati dal motore web: è accettato, le schede in secondo piano non si tengono vive.
- **Applicazioni: che cosa non può fare una pagina.** Nessun ponte verso l'app (né binding, né eventi, né l'origine dell'app); solo `http` e `https`, controllati in Go a ogni navigazione, reindirizzamenti compresi; nessun download, nessun permesso (camera, microfono, posizione, notifiche), nessuna finestra nuova nell'app (un indirizzo va al browser di sistema solo dopo un gesto recente nella pagina, mai da una scheda nascosta, al massimo uno al secondo); certificati non validi non aggirabili. **L'autenticazione HTTP di base non è supportata** (le richieste di credenziali sono annullate) e **i login con popup e `window.opener` non funzionano**. Una pagina raggiunta da un sito pubblico non può portare la vista su `localhost` o sulla rete locale (che l'utente può comunque registrare di sua scelta), ma il controllo non riguarda ciò che una pagina incorpora in un frame o richiede con `fetch`, e il DNS rebinding non è coperto.
- **Applicazioni dove non c'è il browser incorporato** (Windows, Linux, workbench web): la scheda è un riquadro con «Apri nel browser»; creare, aprire, cambiare indirizzo e la conferma sono quelle del desktop. Lavorare dentro un'applicazione conta come attività per il blocco automatico dei vault privati; chiudere il vault, bloccare un vault privato, togliere una condivisione ricevuta e uscire chiudono le pagine; al massimo 32 pagine per vault e 64 in tutto.
- **Correzioni della revisione di sicurezza del core delle applicazioni**, otto rilievi, ciascuno con un test: la regola della rete privata restava accesa per tutta la vita di una vista aperta su un host privato (ora dipende dalla pagina corrente e dagli host scelti dall'utente); una vista aperta mentre il vault si chiudeva restava orfana; le scorciatoie riservate erano consumate solo dalla vista a fuoco; le richieste di credenziali non erano annullate; gli acceleratori con Maiusc; il flag non era ricontrollato dopo l'apertura; l'identificatore dell'archivio dati era derivato dal percorso del vault; il browser di sistema si apriva senza un gesto dell'utente.
- **Correzioni della revisione del 3D**, ciascuna con una prova e2e: nel livello a punti un solo click apriva il nodo (ora lo seleziona); nel livello a sprite un nodo nascosto dal timelapse si poteva cliccare e trascinare (ora no); la selezione restava riferita al grafo precedente dopo un aggiornamento; la texture dell'anello di selezione non veniva rilasciata al cambio di tema; dopo un download fallito del chunk 3D, riscegliere il 3D lo riscarica.

### Build e sviluppo

- **Il codice 3D non costruisce codice a runtime.** Due dipendenze della libreria lo facevano con `new Function`, vietato dalla CSP: sono sostituite da uno stub (anche `three/webgpu`, per non portare nel bundle un secondo renderer). Un controllo nella build (`noRuntimeCode` in `packages/workbench/build/esbuild.mjs`) la fa **fallire** se un file che contiene three.js ha `eval(` o `new Function(`, anche dopo un aggiornamento.
- **Dipendenze nuove, pinnate:** `3d-force-graph` 1.80.2, `three` 0.187.0, `d3-force-3d` 3.0.6, `@types/three` 0.187.0.
- **`task test-nativeview`** (a mano, su un Mac, con lo schermo acceso): prova il driver macOS delle applicazioni contro una finestra reale (apre una finestra, usa la rete per due controlli, non fa parte di `task ci`). `scripts/run-desktop-with-cloud.sh` e `task dev-cloud` servono per accendere il flag in sviluppo (un profilo del cloud).
- **Benchmark opzionale:** `CLARAE_GRAPH3D_BENCH=<nodi> CLARAE_GRAPH3D_GL=metal|swiftshader yarn workspace @clarae/desktop-frontend exec playwright test e2e/graph-3d-bench.spec.ts` (si salta senza la variabile).
- **Prove nuove:** vitest (`geometry3d`, `layoutEngine3d`, `GraphView.3d`, più `graph` e `incremental`); `TestBuildDocuments` in `apps/desktop/internal/graph`; e2e `graph-3d.spec.ts` sul mock dei binding e sul core WASM; scansione di accessibilità della vista 3D in `a11y.spec.ts`; `web/e2e-security/graph3d-csp.spec.ts` sulla CSP di produzione. La voce `graph.3d` del registro di parità è «sì» su desktop e workbench.
- **Prove nuove delle applicazioni:** test Go di `internal/webview`, di `internal/app` (`bindings_webview_test.go`) e di `internal/shell`, con `-race`; la prova del driver `driver_darwin_live_test.go` (14 prove); vitest in `packages/workbench/src/webapp/` (115 test); e2e `apps/desktop/frontend/e2e/webapp.spec.ts` (17 casi) sul mock dei binding e, per ciò che non richiede la vista incorporata, sul core WASM; scansione di accessibilità in `a11y.spec.ts`. Le voci `webapp` e `webapp.embedded` del registro di parità (quest'ultima `exception` sul workbench web).
- **Prove delle rimozioni:** `locks_test.go` (una sola chiave, mai il nome vecchio); `services/cloud/test/integration/advisory_lock_test.go` sostituisce il test che simulava un pod 1.4 (esclusione sullo stesso hash, nessun blocco su hash diversi, 40 transazioni concorrenti che terminano, chiave col nome corrente); `TestConfigDirV2FromProfile` per lo spostamento che parte solo dopo un profilo del server.
- **Il workflow di release non è stato eseguito** con la modifica (serve un tag pubblicato): è stato riletto e analizzato come YAML; `actionlint` non è installato.

### Contratti

- `api/openapi.yaml`: nessuna operazione cambiata. **`api/config-profile.schema.json`:** il default di `features.config_dir_v2` passa da `false` a `true` (descrizione aggiornata); i file generati (`shared/go/features`, `@clarae/api-client/features`) sono rigenerati.
- **Applicazioni:** nuovo servizio `WebViewAPI` (13 metodi: `Status`, `Open`, `SetBounds`, `SetVisible`, `Navigate`, `Back`, `Forward`, `Reload`, `Focus`, `Close`, `CloseVault`, `ReserveKeys`, `ClearData`; sul core WASM ogni metodo risponde `webview-unavailable`), dieci eventi `webview:*` (`state`, `blocked`, `new-window`, `download`, `permission`, `key`, `load-error`, `crashed`, `focus`, `closed`), codici d'errore `webview-*`, capability `embeddedBrowser` (vera solo sul desktop su macOS con il driver). **`api/config-profile.schema.json`:** cambia la descrizione di `features.web_viewer` (il default resta `false`); `api/openapi.yaml` non cambia.
- **Binding del core** (desktop e core WASM): `GraphAPI.Build` accetta l'opzione `showDocuments`; i nodi del grafo possono essere di tipo `drawing`, `canvas` e `base`. Nel layout worker, nuovi messaggi `fix` e `release` e il parametro `dims` (3 per il 3D).

### Documentazione

- ADR-0056 (applicazioni in una vista nativa) e la matrice manuale [docs/qa/m18-webview-matrice.md](docs/qa/m18-webview-matrice.md) (nessun caso ancora eseguito), guida utente «Applicazioni» e nota di sicurezza per chi amministra in profili, quote e audit, scorciatoie e accessibilità, `docs/desktop-web-sync.md` e `docs/dev-setup.md`. ADR-0055 (grafo 3D), in stato proposta; `docs/qa/graph-3d-benchmark.md` (metodo, misure e limiti) e `docs/qa/graph-3d-spike-d0/` (misure grezze dello spike D0); roadmap §13-undecies (stato delle tracce D ed E) e nuovo §13-duodecies (M19); guida utente della vista grafo e dell'accessibilità; [guida di migrazione](docs/admin-guide/migrazione-clarae.md) con la sezione «Aggiornare alla 1.7», profili e backup-upgrade della guida admin, `docs/desktop-web-sync.md`; nota di aggiornamento in ADR-0052; `docs/web-workbench-parity.md` rigenerato.

### Non provato e lavoro successivo

- **Verificato per questa versione:** `task ci` completo verde sull'albero del grafo 3D (2026-11-15; budget stampati: console `initial 697 kB (limit 700)`, workbench `initial 1950 kB (limit 2500), total 17298 kB (limit 23000)`). Per le rimozioni: `task gen` e `task check-gen`, test Go di sync, app, vault e features, test del cloud dei pacchetti toccati, il sottoinsieme dei test d'integrazione su lock, blob, tus, quota ed export con Docker, `task test-wasm`, vitest di workbench e web, `golangci-lint` senza rilievi. **Non eseguita** l'intera `task test-integration`.
- **Grafo 3D non provato** sulla WebView reale del desktop (WKWebView, WebView2, WebKitGTK), su GPU integrate, su Windows e Linux e su vault reali (solo un grafo sintetico, su un MacBook Apple M4): serve una verifica manuale con `task run-desktop`.
- **Applicazioni (traccia E di M18), verificato:** test Go di `internal/webview`, `internal/app`, `internal/shell` e `internal/sync` con `-race`; `go vet` per `GOOS=js`, `GOOS=windows CGO_ENABLED=0` e `GOOS=linux`; `task lint-go` con 0 rilievi; `task test-wasm`; `task gen` e `task check-gen`; **la prova del driver su un Mac reale** (`task test-nativeview`, macOS 27.2.1, arm64): 14 prove su 14, tra cui un sito che vieta l'incorniciamento caricato (`https://github.com`), bounds entro il punto a più dimensioni della finestra, schemi vietati rifiutati, nuove finestre non aperte, download rifiutati, certificato autofirmato rifiutato, richieste di credenziali annullate, scorciatoie riservate, 100 cicli di apertura e chiusura, dati separati per vault e `ClearData`; vitest del workbench (2.475 test, 115 nella cartella `webapp`), `task lint-ts`, `task parity` (96 funzioni, 203 comandi, 155 binding), e2e `webapp.spec.ts` e a11y. Quattro prove di mutazione sul frontend (indirizzo non http accettato, testo della pagina reso come markup, vista sotto un dialogo, conferma dell'origine saltata) fanno fallire i test. **Dopo una revisione del frontend** sono stati corretti altri rilievi, ciascuno con un test: una vista che finiva di aprirsi dopo che la scheda era stata lasciata restava disegnata sopra l'altra scheda; la pagina poteva prendere la tastiera da un altro pannello; un trascinamento non concluso poteva lasciare le viste nascoste; dopo il blocco del vault l'applicazione non si riapriva senza chiudere la scheda; gli eventi della vista arrivati prima della risposta di `Open` andavano persi; `F2` e i comandi dell'editor non sono più riservati sopra una pagina. **`task ci` completo è verde con le applicazioni dentro** (2026-11-15; budget stampati: console `initial 697 kB (limit 700)`, workbench `initial 1996 kB (limit 2500), total 17344 kB (limit 23000)`; `task parity`: 96 funzioni, 203 comandi, 155 binding).
- **Applicazioni non provate:** **nulla del frontend è verificato sulla finestra reale del desktop**: il posizionamento della vista sopra l'HTML, i bounds con lo zoom dell'app diverso da 100% (WebKit può rispondere diversamente da Chromium), lo sfarfallio nel nascondere e mostrare, il fuoco da tastiera, la sonda che rileva ciò che sta sopra la pagina (`elementsFromPoint`) su `WKWebView` (un overlay molto piccolo e senza sfondo può passare tra i punti), il trascinamento di una scheda sopra la vista. Nella prova del driver: tastiera e mouse reali (il processo di prova non è l'app attiva: gli eventi sono costruiti), camera e microfono (in quella configurazione `navigator.mediaDevices` non esiste), NTLM e certificato client, macOS precedente alla 14, il limite di viste. **Windows e Linux a runtime.** Per questo il flag `features.web_viewer` resta spento di default finché la matrice manuale non è eseguita.

## [1.6.0] - 2026-11-15

Una shell più morbida, lo stato vuoto con i comandi di creazione e un editor dei disegni più sicuro e più veloce (milestone M18, [roadmap](docs/roadmap.md) §13-undecies, ADR-0053 e ADR-0054). **La milestone è eseguita in parte:** il grafo 3D e le applicazioni in una tab (webview nativa) non ci sono ancora; di entrambi sono finiti i soli spike di fattibilità, con esito sotto, e il lavoro resta da fare. Gli ADR 0053 e 0054 sono in stato proposta: ADR-0054 devia da `Specifications.md` (§3.4.5 e §3.4.6: la libreria di forme si fonde per id) e ADR-0053 aggiunge un punto a §2.7.2; lo spec non è toccato e lo aggiorna il proprietario, a partire dall'elenco in fondo a ogni ADR. **Il protocollo di sync, le operazioni delle API e il database del cloud non cambiano.** Le rimozioni della compatibilità con la 1.x che la 1.5.0 fissava alla 1.6 **passano alla 1.7** (vedi _Compatibilità_).

### Compatibilità

- **Le rimozioni previste per la 1.6 passano alla 1.7** (decisione del proprietario, 2026-11-15): gli advisory lock con il nome `memobrain.*`, l'immagine pubblicata anche come `memobrain-cloud` e il default acceso di `features.config_dir_v2`. Nella 1.6.0 non cambia nulla di tutto ciò: il cloud prende ancora prima il lock vecchio e poi quello nuovo, la release pubblica ancora l'immagine con i due nomi, e `features.config_dir_v2` resta **spento** per default. Chi ha letto nelle note della 1.5.0 o nella guida di migrazione «prima della 1.6» legga «prima della 1.7». Il resto (variabili `MEMOBRAIN_*`, voci del portachiavi, schema `memobrain://`, realm, gRPC `memobrain.v1`, …) resta alla 2.0. L'elenco vive in `scripts/rebrand/allowlist.tsv` e nella tabella di [docs/admin-guide/migrazione-clarae.md](docs/admin-guide/migrazione-clarae.md).
- **Migrazioni locali al primo avvio** (nessuna del cloud, nessun comando da eseguire): `sync.db` guadagna la colonna `head_author`, e `index.db` rianalizza **una volta** tutti i disegni del vault (per indicizzare il testo come lo ha scritto l'utente e il TeX delle formule): con molti disegni grandi il primo avvio dopo l'aggiornamento impiega di più. Tornare alla 1.5 sullo stesso dispositivo dopo aver aperto un vault con la 1.6 non è stato provato.
- **Vault condivisi: la fusione nell'editor è prudente finché le righe non hanno un autore.** D-04 garantisce il merge tra utenti diversi solo per le note. Per un disegno aperto, con modifiche non salvate e una versione nuova su disco, l'editor fonde le due versioni solo se quella su disco è dello stesso utente; lo sa dall'autore dell'ultima revisione, che `sync.db` registra da questa versione. **I file già sincronizzati prima della 1.6 non hanno autore** e contano come «di un altro autore»: su un vault condiviso, la prima volta compare il banner di conflitto invece della fusione, finché un pull o un commit non riscrive la riga. Sui vault non collegati e su quelli privati (un solo autore) il limite non c'è.
- **Libreria di forme: la fusione per forma la fa il client.** Un dispositivo ancora alla 1.5 sullo stesso vault continua a fonderla per chiave, quindi con un client 1.5 una forma aggiunta può ancora andare persa. I file non cambiano formato (`.clarae/excalidraw-library.json`, o `.memobrain/` nei vault della 1.x).
- **Come si aggiorna:** i client desktop non si aggiornano da soli (come per la 1.5): si installa a mano. Il Cloud Service non cambia in questa versione (nessuna modifica al codice, alle operazioni delle API né al database).

### Client desktop e workbench

- **Shell più morbida.** Le schede hanno gli angoli superiori arrotondati, con un raccordo concavo verso il contenuto, e il corpo del pannello ha gli angoli superiori arrotondati; l'indicatore della scheda attiva passa in alto. Nuova scala dei raggi nel workbench (`--radius-xs` … `--radius-pill`). La console non cambia.
- **Stato vuoto con i comandi.** Un pannello senza schede offre _Nuova nota_, _Nuova lavagna_, _Nuovo disegno_, _Nuova presentazione_ e il selettore rapido, ciascuno con la scorciatoia in uso. Le voci di una funzione spenta dal profilo non compaiono; su un vault in sola lettura sono disabilitate. Con più pannelli vuoti il file si apre in quello su cui si è cliccato.
- **Disegni: navigazione (ADR-0053).** Accanto al controllo dello zoom di Excalidraw, in basso a sinistra: _Zoom sulla selezione_ (inquadra gli elementi selezionati, o tutto il disegno se non c'è selezione; funziona anche in sola visualizzazione e senza il flag `drawing_actions`, e rispetta la barra inferiore) e _Mini-mappa_ (miniatura dell'intero disegno con la porzione visibile; clic e trascinamento spostano la vista, le frecce la scorrono, Home inquadra tutto). La mini-mappa è spenta finché non la si accende, resta così **su questo dispositivo** (non si sincronizza), e non compare in modalità Zen, in presentazione né mentre è aperto il menu degli stili. Comandi della palette: `drawing:zoom-to-fit-selected` e `drawing:toggle-minimap`, senza scorciatoia di default.
- **Disegni: le modifiche non si perdono e non si bloccano (ADR-0054).** Se mentre un disegno è aperto cambia il file (la sincronizzazione, l'altro pannello dello stesso disegno) e ci sono modifiche non salvate, le due versioni vengono **fuse** con lo stesso codice della sincronizzazione, e il disegno continua senza interruzioni; la fusione aspetta fino a 20 s la fine di un gesto in corso. Quando la fusione non è ammessa o non riesce (un altro utente su un vault condiviso, conflitti veri) compare il banner, ora con una terza scelta, _Tieni entrambe_, che salva la propria versione in una copia accanto al file e mostra il file com'è. Binding nuovo: `VaultAPI.MergeEdit`.
- **Disegni: tema, anteprime e libreria.** In tema scuro un disegno incorporato in una nota mostra la versione scura, e cambia da solo al cambio di tema, anche quando con il tema «Sistema» è il sistema operativo a cambiarlo (prima il tema «Sistema» non seguiva il sistema a caldo); stampa ed esportazione della nota restano chiare. Un embed con l'anteprima in cache non rilegge più il disegno, e più embed dello stesso disegno condividono la lettura. La **libreria di forme** è una sola per vault, condivisa dai pannelli aperti (una forma aggiunta compare subito negli altri) e, nella sincronizzazione, si fonde forma per forma: se due dispositivi ne aggiungono di diverse restano entrambe.
- **Disegni: ricerca ed esportazione.** La ricerca trova il testo come lo ha scritto l'utente (prima non trovava una parola andata a capo dentro una forma) e il TeX delle formule. L'**esportazione automatica** parte 15 secondi dopo l'ultimo salvataggio, quando il lavoro si ferma, e subito alla chiusura del disegno, del vault o dell'app, non a ogni salvataggio.
- **Disegni: limiti di dimensione.** Sopra 8 MB un disegno non viene più indicizzato (il testo non si trova e i link non compaiono nei backlink: la soglia era già così, ora l'editor la segnala), sopra 10 MB si avvisa che salvataggio e sincronizzazione rallentano; entrambe le soglie si misurano in byte del file salvato.

### Correzioni

- **Un `.excalidraw` reso invalido da fuori non viene più sovrascritto.** Se il file cambia sul disco in modo che non sia più un disegno, l'editor non lo adotta e il salvataggio successivo non lo scrive: compare un avviso con la sola scelta _Sovrascrivi_ (o si ripara il file fuori dall'app). Prima la scena in memoria lo riscriveva al salvataggio seguente.
- **Annulla.** Una modifica esterna (sincronizzazione, fusione) non entra più nella cronologia di annullamento, e un'azione sulla scena è un solo passo.
- **Ricarica esterna.** Applica anche sfondo e griglia del file e aggiorna l'elenco della scheda Slideshow, senza riscrivere il file.
- **Due pannelli sullo stesso disegno.** Il comando agisce sul pannello a fuoco (prima agiva sempre su quello aperto per ultimo), la scheda Slideshow mostra i frame del pannello a fuoco e non resta vuota quando l'altro pannello passa a un altro file, e drop e dialoghi vanno all'editor da cui partono.
- **Cache delle anteprime.** `.clarae/cache/drawings/` non veniva mai ripulita e cresceva a ogni salvataggio: all'apertura del vault si tolgono le anteprime di versioni che non esistono più (solo quelle più vecchie di 10 minuti).
- **Salvataggio più leggero.** La scena non si serializza più a ogni modifica ma solo quando si salva (selezione e scroll non ne causano più), e l'editor non si ridisegna a ogni cambio di stato del salvataggio.

### Build e sviluppo

- **Allowlist del rebrand.** Nuove righe `legacy` per `apps/desktop/internal/drawing/drawing.go` e `drawing_test.go` (la chiave `customData.memobrain` della 1.x, letta per il TeX), e nei motivi delle quattro righe che dicevano «dropped in 1.6» ora c'è «dropped in 1.7». `task lint-brand` resta verde.
- **Prove nuove:** test Go di `MergeEdit`, dell'autore in `sync.db`, della potatura della cache e della libreria (`shared/go/merge`, `TestShapeLibraryMergesByID` nel sync a due dispositivi); 13 fixture `library-*` in `shared/conformance/merge/`; test vitest dei moduli puri dei disegni; sei spec e2e (`drawing-navigation`, `-lifecycle`, `-merge`, `-split`, `-theme`, `-library`), eseguiti sul mock dei binding e, per i nuovi, sul core WASM. La voce `drawing.navigation` del registro di parità copre i due comandi nuovi.
- **Instabilità nota di un test:** `packages/workbench/src/workspace/marpNotesTabSwitch.test.tsx` fallisce a volte quando gira insieme agli altri (anche sul codice della 1.5.1) e passa da solo.
- **Cache di Vitest.** `i18n/consistency.test.ts` elenca i sorgenti con `import.meta.glob` quando il file di test viene trasformato: se dopo aver aggiunto o tolto file sorgente il test segnala chiavi mancanti o inutilizzate senza motivo, si svuota `node_modules/.vitest-cache` (la cache dei moduli di Vitest, fuori dal repository) e lo si rilancia.

### Contratti

- `api/openapi.yaml`: versione 1.6.0, nessuna operazione cambiata. `api/config-profile.schema.json` non cambia.
- **Binding del core** (desktop e core WASM; client generati in `web/src/workbench/core.gen.ts`): nuovo `VaultAPI.MergeEdit`; `DrawingAPI.Preview(vaultID, path, variant)` prende il posto di `DrawingAPI.ReadPreview` (rimosso) e restituisce hash del file e SVG in cache; `DrawingAPI.SavePreview` ha il parametro `variant` (`""` chiaro, `"dark"` scuro; il file in cache è `<hash>.svg` o `<hash>.dark.svg`). Nuova strategia di merge `library-by-id` (`merge.LibraryByID`, `merge.DecideByPath`, `pathrules.IsShapeLibrary`).

### Documentazione

- ADR-0053 (navigazione dei disegni) e ADR-0054 (editor dei disegni: merge, undo, ricarica, libreria, ricerca; emenda ADR-0010), in stato proposta; roadmap §13-undecies; guida utente dei disegni (navigazione, fusione, libreria, tema, ricerca, esportazione, limiti); guida di migrazione e ADR-0052 con le rimozioni spostate alla 1.7; checklist manuali dei disegni e della shell.

### Lavoro successivo (non in questa release)

- **Grafo 3D** (`3d-force-graph`): spike eseguito, esito **sì con tre condizioni** (link in un unico `LineSegments`, layout in un worker con forze alleggerite, tetto iniziale di 5.000 nodi); un chunk di 793 kB caricato solo quando serve, nessun `eval` e CSP di produzione rispettata. Non misurati: hardware più lento e la WebView reale di Wails. Non incluso.
- **Applicazioni in una tab (webview nativa):** spike eseguito, esito: macOS sì (provato), Windows sì a condizione di una copia ridotta del binding WebView2 interno di Wails (compilata, mai eseguita), Linux **no per ora** (compilato in un container, mai eseguito). Non incluso.

## [1.5.1] - 2026-11-13

**È la prima versione pubblicata di Clarae notanda.** La 1.5.0 è stata etichettata ma non pubblicata: la build dell'immagine del cloud e la pubblicazione del chart Helm si sono fermate, quindi non esistono né l'immagine né il chart né la release 1.5.0. La 1.5.1 contiene tutto ciò che descrive la sezione 1.5.0 qui sotto, **comprese le note di compatibilità per chi arriva dalla 1.x**, da leggere prima di aggiornare ([CHANGELOG, sezione 1.5.0](https://github.com/E2BRAdvisory/MemoBrain/blob/v1.5.1/CHANGELOG.md#150---2026-11-13); per gli amministratori [la guida di migrazione](https://github.com/E2BRAdvisory/MemoBrain/blob/v1.5.1/docs/admin-guide/migrazione-clarae.md)). Dove quella sezione e le guide dicono «1.5.0» per l'immagine, il chart e gli installer, la versione da usare è la 1.5.1.

### Correzioni

- **Immagine del cloud:** la build si fermava sul budget del bundle della console web, a 704 kB contro un limite di 700 (ADR-0020). La pagina dei Config Profile importava l'intero schema JSON per leggerne i nomi delle sezioni; ora li prende dall'elenco generato dallo stesso schema (`CONFIG_SECTIONS` in `@clarae/api-client/features`) e la console torna a 697 kB. Il comportamento della pagina non cambia.
- **Chart Helm:** la pubblicazione su GHCR falliva con «failed to perform "Tag" on destination: not found». Helm 4 carica il manifest per digest e lo rilegge per applicare il tag, e GHCR può rispondere 404 a un manifest appena accettato, soprattutto per un pacchetto che non esisteva ancora (`charts/clarae`). Il workflow di release ritenta il push fino a cinque volte; ciò che è già caricato non viene rimandato.

### Build e sviluppo

- **`task ci` costruisce la Web UI per la produzione** (nuovo task `web-budget`, in `.dev/web-budget`): i budget del bundle erano controllati solo dalla build dell'immagine, cioè dal workflow di release.

### Contratti

- `api/openapi.yaml`: versione 1.5.1, nessuna operazione cambiata.

## [1.5.0] - 2026-11-13

Il prodotto cambia nome: da MemoBrain Notes a **Clarae notanda** (milestone M17, [roadmap](docs/roadmap.md) §13-decies, ADR-0052). Cambiano il nome, il payoff («Your knowledge, carefully preserved in its clarity.»), il marchio e la palette (Deep Navy `#102B3A`, Teal `#159992`, Mint `#72C9BD`, Mist `#E9F0EF`, White `#FFFFFF`) di app desktop, workbench web e console. **Le funzionalità, il protocollo di sync e le operazioni delle API non cambiano.** I dati esistenti passano da soli ai nomi nuovi e nessun vault, sessione o chiave di un vault privato va perso; un client 1.4.0 e un cloud già installato continuano a funzionare. Le etichette crittografiche dei vault E2EE restano quelle di prima: i vault privati esistenti si aprono come sempre. L'ADR-0052 è in stato proposta e devia da `Specifications.md` (nome del prodotto, cartella di configurazione, schema URL, realm e client OIDC, gRPC, chiave Excalidraw), che il proprietario deve aggiornare a partire dall'elenco nell'ADR. **Alcune prove su macchine reali non sono state fatte** (installer Windows sopra una 1.x, dialogo «chiudi la vecchia app», dati del WebView su macOS e Linux, prove manuali con client 1.4.0 veri): sono elencate in fondo a _Compatibilità_.

### Compatibilità

- **Nessun client 1.x ha l'aggiornamento automatico: la 1.5.0 si installa a mano**, su ogni sistema operativo. I nomi degli artefatti diventano `clarae-<versione>-<sistema>-<architettura>.<estensione>` (prima `memobrain-…`); nel `.dmg` c'è `Clarae notanda.app`, nell'installer Windows `Clarae notanda.exe`, il pacchetto Linux si chiama `clarae`.
  - **macOS:** trascinare `Clarae notanda.app` in _Applicazioni_. È un'app diversa (nuovo identificatore `dev.clarae.desktop`): **`MemoBrain Notes.app` resta dov'è e va spostata nel Cestino a mano**. Se la trova in `/Applications`, la nuova lo scrive nel log.
  - **Windows:** l'installer rimuove da solo l'installazione della 1.x (eseguibile, `uninstall.exe`, i due collegamenti e la voce tra le app installate; la cartella solo se resta vuota). Non esegue il disinstallatore vecchio, perché cancellerebbe il profilo del WebView2, che la nuova app riprende. Se la vecchia app è aperta l'installer chiede di chiuderla e di riprovare; un'installazione silenziosa si ferma con codice di uscita 5.
  - **Linux:** il `.deb` sostituisce il pacchetto `memobrain` (`Replaces` e `Conflicts`). **Un AppImage della 1.x non viene rimosso: il vecchio file va cancellato a mano.**
- **Primo avvio: cartella dati, sessione e chiavi.** La nuova app sposta la cartella dati `MemoBrain Notes` (in `~/Library/Application Support`, `%AppData%` o `~/.config`) in `Clarae notanda`, con una rinomina sola, e riscrive i percorsi dei vault recenti. La sessione, le chiavi dei vault privati e la chiave del provider AI si leggono dalle voci del portachiavi della 1.x: la prima lettura le copia sotto il nome nuovo, una scrittura toglie la copia vecchia e un'uscita o un blocco del vault cancella anche quella. Non si deve accedere di nuovo né reinserire passphrase. Se la **vecchia app è aperta** (lo si riconosce dal suo database), la nuova mostra un dialogo che chiede di chiuderla e **non parte**; lo stesso se il sistema rifiuta la rinomina (su Windows, per una cartella in uso). Con `--data-dir` o `CLARAE_DATA_DIR` la cartella indicata si usa com'è e non si sposta nulla. Se `Clarae notanda` ha già un suo `app.db`, vince e la cartella vecchia resta com'è, annotata nel log. I file di log `memobrain*` sono rinominati, così la rotazione prosegue. Su Windows il profilo del WebView2 passa in `<cartella dati>\webview`.
- **Cartella di configurazione dei vault: `.memobrain/` diventa `.clarae/`, in due fasi (ADR-0052).** La regola dei percorsi esclusi dal sync vale per entrambi i nomi, anche per i file temporanei `.memobrain-tmp-*`.
  - **Fase 1 (1.5.0):** quando un vault si apre, la parte locale (`index.db`, `sync.db`, `cache/`, `snapshots/`, `workspace*.json`) si sposta in `.clarae/`, un elemento alla volta, ripetibile dopo un'interruzione, senza cancellare né sovrascrivere nulla (se c'è già un elemento nuovo vince, e il vecchio resta). Un vault **non collegato al cloud** sposta anche le impostazioni (`editor.json`, `hotkeys.json`, template, …). Un vault **collegato** le lascia in `.memobrain/`, perché un client 1.4.0 sullo stesso vault le legge e le scrive ancora lì: l'app le cerca in `.clarae/` e poi in `.memobrain/` e le scrive dove il file già si trova. Un vault non collegato che si collega al cloud rimette in `.memobrain/` le sue impostazioni sincronizzate (un file che c'è già resta).
  - **Fase 2 (flag `features.config_dir_v2`, spento nella 1.5.0):** acceso dall'amministratore con il Config Profile, il motore di sync sposta ogni impostazione sincronizzata nella cartella nuova come un normale spostamento di file (stesso id, stessa cronologia), a fine ciclo e solo per file senza modifiche locali. **Da accendere solo dopo aver aggiornato ogni dispositivo dei vault**: un client 1.4.0 non vedrebbe più le impostazioni e le ricreerebbe. Spegnerlo ferma gli spostamenti; quelli fatti restano.
  - **Una difesa in più:** pull e bootstrap non scrivono mai un percorso remoto che i client non sincronizzano (database, cache, layout del dispositivo, temporanei): un `sync.db` caricato da un client vecchio in un vault privato viene ignorato.
- **Schema `clarae://`; `memobrain://` ancora accettato.** Gli installer registrano entrambi gli schemi (anche `x-scheme-handler` su Linux), e i link `memobrain://` già scritti nelle note continuano ad aprirsi. Quando l'accesso al cloud usa lo schema personalizzato (se il collegamento locale non è possibile o è rifiutato), prova per primo `clarae://auth/callback`; se il realm lo rifiuta e accetta `memobrain://auth/callback`, usa quello: **un realm creato per la 1.x funziona senza interventi**, ma conviene aggiungere il redirect nuovo (vedi la guida di migrazione).
- **File `.excalidraw` e presentazioni Marp della 1.x.** Si leggono e basta: i nomi nuovi si scrivono solo quando un file viene modificato, senza riscritture in blocco. Un disegno salva al primo salvataggio le sue impostazioni sotto la chiave `clarae`; frame, formule e card di un disegno passano alla chiave nuova solo quando uno strumento li riscrive. Una presentazione scrive il marcatore `<!-- clarae: hidden -->` per le nuove esclusioni (i marcatori esistenti non vengono riscritti e «includi» toglie quello che c'è) e le chiavi `clarae-loop` e `clarae-notes`, togliendo le vecchie nella stessa modifica (un solo annulla). **Un client 1.4.0 non legge i nomi nuovi:** su un disegno toccato dalla 1.5.0 non vede più le formule modificabili né l'ordine delle diapositive, su una presentazione mostra le slide escluse e ignora «ricomincia alla fine» e le note del relatore. Nei merge concorrenti di un `.excalidraw` possono restare entrambe le chiavi: la 1.5.0 le legge tutte e due. Il merge non cambia e nessun dato si perde.
- **Workbench web: il profilo del browser della 1.4 si porta ai nomi nuovi.** Alla prima apertura del workbench, sotto lock e prima che il core parta, si spostano le cartelle OPFS dell'account (la chiave dell'account cambia), la registrazione del dispositivo (IndexedDB), i marker dei vault in `localStorage` e le preferenze (tema e lingua della console, strumenti recenti dei disegni: si legge la chiave nuova e poi la vecchia, si scrive la nuova e la vecchia resta). Lo spostamento riprende se si interrompe e non perde modifiche non caricate. **Una scheda del workbench 1.4 ancora aperta blocca l'avvio finché non viene chiusa**: la pagina nuova prende entrambi i Web Lock e usa entrambi i canali di comunicazione, così le due non lavorano mai insieme sugli stessi file. Resta con il nome della 1.x, invisibile all'utente, la cartella dati interna del core e le chiavi dei database nel pool SQLite del browser: il pool non può rinominare un database, e spostare la cartella avrebbe fatto partire il core dove non trova né il suo database né lo stato di sync dei mount, con le modifiche non caricate. Un profilo nuovo usa i nomi nuovi.
- **Variabili d'ambiente `MEMOBRAIN_*` ancora lette, con un avviso.** `CLARAE_<nome>` vince; il nome vecchio vale ancora se quello nuovo non è impostato, e il log dice di passare al nuovo. Vale per il desktop (`DATA_DIR`, `UPDATES`, `AUTH_REDIRECT`, `DEFAULT_SERVER_URL`), per il Cloud Service (`ALLOW_PLACEHOLDER_SECRETS`) e per Docker Compose (`HOST`, `SITE`, `IMAGE`, `VERSION`, `ALLOW_PLACEHOLDER_SECRETS`). Le variabili solo di prova, di misura e di build si sono rinominate senza alias.
- **Cloud Service: i nomi della 1.x restano finché l'issuer è il realm `memobrain`.** Un'installazione fatta per la 1.x **non cambia nome da sola e non perde dati**: con un issuer che finisce in `/realms/memobrain` valgono ancora audience `memobrain-api`, client `memobrain-*`, bucket `memobrain-blobs` e `memobrain-exports`, il prefisso delle metriche `memobrain_` e il realm; un altro issuer usa i nomi `clarae-*`. Un valore impostato a mano vince sempre; all'avvio il log mostra i nomi in uso (`names in use`). Il ruolo amministratore vale sia `clarae-admin` sia `memobrain-admin` (`OIDC_ADMIN_ROLES`, nuovo, con questo valore di default). Nessuna migrazione del database.
- **Il cloud rifiuta di partire sul bucket sbagliato.** Se il bucket di default manca ma esiste quello della 1.x, il servizio (e `s3-init` di Compose) si ferma e indica la variabile da impostare, invece di creare un bucket vuoto in cui ogni blob risulterebbe mancante.
- **gRPC:** il servizio nuovo è `clarae.v1.NotifyService`; **`memobrain.v1.NotifyService` resta servito dallo stesso codice**, con le stesse regole di autenticazione, sospensione e limite di flussi per utente, e l'Ingress di Helm instrada entrambi (`ingress.grpc.legacyPath`). Un client 1.4.0 mantiene il suo flusso; un client 1.5.0 contro un cloud 1.4.0 ricade sullo stream SSE già esistente.
- **Docker Compose: righe obbligatorie nel `.env`.** `COMPOSE_PROJECT_NAME`, `POSTGRES_USER`, `POSTGRES_DB` e `KC_REALM` non hanno più un default: un default col nome nuovo avvierebbe lo stack su volumi vuoti e con un secondo realm. Un'installazione fatta per la 1.x aggiunge `COMPOSE_PROJECT_NAME=memobrain-onprem`, `POSTGRES_USER=memobrain`, `POSTGRES_DB=memobrain` e `KC_REALM=memobrain`; Compose rifiuta di partire senza e dice quale riga manca.
- **Helm: `nameOverride`.** Il chart si chiama `clarae`. I selector di un Deployment sono immutabili: per aggiornare sul posto un'installazione della 1.x serve `nameOverride: memobrain` nei valori, **in modo permanente** (nomi e selector restano quelli di prima). `task helm-check` verifica questo rendering con `ci/values-legacy.yaml`.
- **Immagine pubblicata con due nomi:** `ghcr.io/<owner>/clarae-cloud` e, solo con la 1.5, anche `ghcr.io/<owner>/memobrain-cloud`, così Compose e valori Helm della 1.x tirano l'aggiornamento senza modifiche.
- **Advisory lock di PostgreSQL (blob, quota, export):** nomi `clarae.*`; ogni transazione prende **prima** il lock col nome vecchio e poi quello nuovo, sempre in questo ordine, così le repliche 1.4 e 1.5 che girano insieme durante un aggiornamento a rotazione si escludono senza deadlock.
- **`METRICS_NAMESPACE`:** il prefisso delle metriche è `clarae_` con un realm nuovo e `memobrain_` con il realm `memobrain`, oppure quello che indicate (lettere minuscole, cifre e `_`; un valore non valido fa fallire l'avvio). La dashboard e gli alert distribuiti con la 1.5 interrogano `clarae_*`: su un'installazione della 1.x restano vuoti finché non impostate `METRICS_NAMESPACE=clarae` e reimportate dashboard e regole, oppure sostituite il prefisso nelle regole.
- **Guida di migrazione:** [docs/admin-guide/migrazione-clarae.md](docs/admin-guide/migrazione-clarae.md) (Compose, Helm, Keycloak, metriche, variabili deprecate, rollback, verifica finale). Sui realm esistenti si consiglia di **aggiungere** al client desktop i redirect `clarae://auth/callback` e `clarae://auth/logout`, tenendo quelli `memobrain://`.
- **Tornare alla 1.4.0 sullo stesso dispositivo non è previsto:** la cartella dati e lo stato di sync (il collegamento al cloud è in `sync.db`) sono già in posizioni nuove, e la 1.4.0 non troverebbe lo stato di sync di un vault aperto dalla 1.5.0, quindi lo vedrebbe come non collegato; scrivere il token nuovo toglie anche la copia vecchia dal portachiavi. Un cloud sì: il rollback del cloud alla 1.4.0 non richiede di ripristinare il database.
- **Cosa viene rimosso, e quando.** **1.6** (previsto): gli advisory lock col nome vecchio e l'immagine con il nome `memobrain-cloud`, e il flag `features.config_dir_v2` diventa acceso. **2.0:** il resto della compatibilità con la 1.x: variabili `MEMOBRAIN_*`, voci del portachiavi, cartella dati e profilo WebView vecchi, schema `memobrain://` e i suoi redirect, i nomi di cartella e di file temporanei `.memobrain*`, la lettura dei nomi del browser, i default del realm `memobrain` (audience, client, bucket, metriche), il ruolo `memobrain-admin`, il servizio gRPC `memobrain.v1` e `legacyPath`. La lettura dei file `.excalidraw` e delle presentazioni Marp della 1.x non ha una release di rimozione, perché non c'è una conversione in blocco. L'elenco vive in `scripts/rebrand/allowlist.tsv`.
- **Limiti noti e prove ancora da fare:**
  - Il **dialogo «chiudi la vecchia app»** non è stato provato su una macchina reale; è provata la sonda che riconosce l'altra istanza (un secondo processo che tiene aperto il database).
  - L'**installer Windows sopra una 1.x** non è stato eseguito su Windows: ci sono asserzioni sullo script (chiave di disinstallazione, nessuna chiamata al disinstallatore vecchio, ordine dei passi) e, dove c'è `makensis`, la compilazione dell'installer.
  - **Su macOS e Linux il codice non sposta il profilo del WebView della 1.x** (lo fa solo su Windows): ciò che il WebView tiene per conto suo, per esempio l'elenco degli strumenti recenti di Excalidraw, può ripartire vuoto.
  - **Convivenza con client 1.4.0 veri:** i casi di interoperabilità (flag spento e acceso, ricreazione dal client vecchio, vault privato, mount della 1.x) sono provati da un test a due dispositivi che simula il client vecchio scrivendo sul disco, non con un'app 1.4.0.
  - **Portachiavi e dati della 1.x:** la presa in carico di cartella dati, sessione e chiavi è provata con un portachiavi finto e con cartelle costruite dai test, non con un'installazione 1.4.0 vera.

### Client desktop e workbench

- **Nuovo nome, marchio e palette.** Titolo, schermata di benvenuto, _Informazioni_, installer, pacchetti, icone, favicon e `site.webmanifest` hanno il nuovo nome, il marchio (tre forme, ridisegnato in vettoriale a partire da `assets/clarae.png`) e il payoff, che non si traduce (stesso testo in italiano e in inglese). La barra del titolo del desktop e l'intestazione della console sono Deep Navy in entrambi i temi.
- **Colore d'accento.** Il predefinito è il Teal del marchio (`#159992`). Un accento scelto dall'utente resta e continua a colorare link e pulsanti; il violetto che la 1.x salvava come predefinito vale come «nessuna scelta» e diventa il Teal. Il Teal da solo non regge il testo (3,5:1 su bianco): link e pulsanti pieni usano una tonalità più scura (`--accent`) e il Teal vero marca ciò che non è testo (`--accent-bright`). Callout, preset di canvas e grafo, palette di Excalidraw, temi di Mermaid e di Marp non cambiano.
- **Aspetto.** I colori hanno una sola fonte, i token `--brand-*` di `packages/ui/src/tokens.css`, da cui derivano quelli della console, del workbench e degli overlay; il nuovo `tokens.contrast.test.ts` impone un contrasto di almeno 4,5:1 tra testo e superficie nei due temi. Corretto anche `--bg-primary`, usato nel canvas e mai definito.
- **Schema URL, link e file.** Vedi _Compatibilità_. Il file della chiave di recupero scaricato da un vault privato si chiama `clarae-recovery-key.txt` e comincia con «Clarae notanda recovery key»: una chiave salvata con la 1.x resta valida.
- **Build e sviluppo.** Nuovo `task lint-brand` (primo passo di `task lint`): il vecchio nome può comparire solo dove `scripts/rebrand/allowlist.tsv` lo ammette, con classe, motivo e release di rimozione per ogni riga, e una riga che non copre più nulla fa fallire la guardia. Il task `rename-module` è rimosso (non gestiva `go.mod`, il pacchetto proto e lo script di rilascio). `task gen` (`gen-capabilities`) scrive anche `packages/workbench/src/platform/vaultPaths.gen.ts` (nomi delle cartelle del vault). `scripts/release/build-desktop.sh` ricava il pacchetto dell'updater con `go list` e verifica con un test (`TestLdflagsProbe`) che gli `-ldflags` lo raggiungano prima di costruire: un percorso sbagliato non lascia più un binario che si fida della chiave di sviluppo. Un test del cloud lega le regole `depguard` ai pacchetti che nominano.

### Cloud e deploy

- Compatibilità e passi per un aggiornamento da 1.x: vedi _Compatibilità_ e la [guida di migrazione](docs/admin-guide/migrazione-clarae.md). Un'installazione nuova usa i nomi nuovi (realm `clarae`, client `clarae-*`, bucket `clarae-blobs` e `clarae-exports`, ruolo `clarae-admin`) e non ha niente da migrare. I realm esportati dalla 1.5 (`deploy/keycloak*/realm-clarae.json`) hanno i redirect `clarae://` e `memobrain://`.
- Il contesto di firma del manifest di aggiornamento e il seme della chiave di sviluppo sono rinominati: nessuna release pubblicata ha un manifest né l'updater attivo, quindi nessun client in circolazione verifica una firma con il contesto vecchio.

### Contratti

- `api/openapi.yaml`: `info.version` 1.5.0, titolo e testi con il nuovo nome (`aud=clarae-api`, `x-required-role: clarae-admin`, estensione `x-clarae-external-routes`); **nessuna operazione cambia** (83 operazioni su 61 percorsi, come nella 1.4.0).
- `api/config-profile.schema.json` (e la sua copia incorporata nel core del client): nuova chiave `features.config_dir_v2`, booleana, default `false` (vedi _Compatibilità_); `$id` e titolo con il nuovo nome.
- Proto: il contratto delle notifiche è ora `clarae.v1` (`api/proto/clarae/v1/notify.proto`, codice in `shared/go/notifyv1`); `memobrain.v1` resta come proto legacy (`api/proto/memobrain/v1/notify.proto`, codice in `shared/go/notifyv1legacy`), con gli stessi messaggi, fino alla 2.0.

### Documentazione

- ADR-0052 (rebrand, in proposta, con l'elenco delle sostituzioni da riportare in `Specifications.md`), roadmap M17, guida di migrazione per gli amministratori, _Aggiornare dalla 1.x_ nella guida utente, `docs/web-ui.md` (dati del browser per account e migrazione del profilo), `docs/desktop-web-sync.md`, `docs/dev-setup.md`, `docs/architecture.md`, `CONTRIBUTING.md` (guardia del nome, regola sui percorsi di impostazioni e database), `assets/brand/README.md`, README e tabella delle chiavi del Config Profile nella guida admin.

## [1.4.0] - 2026-11-12

Il client desktop passa a Wails v3 (milestone M15, [roadmap](docs/roadmap.md) §13-octies, ADR-0051) e la modalità Live diventa l'editor WYSIWYG Milkdown (milestone M16, §13-nonies, ADR-0049, accettato il 2026-11-12 per decisione del proprietario). Gli ADR 0049, 0050 e 0051 non sono ancora recepiti in `Specifications.md`, che il proprietario deve aggiornare (V-07, A-03, D-07, §2.3, §2.6.6, §3.4.2, §4.2, §4.5); gli ADR 0050 e 0051 sono ancora in stato proposta. **Il nuovo Live non è stato provato a mano su WebView reali** (composizione con IME, correzione ortografica, lettori di schermo su WKWebView, WebView2 e WebKitGTK): il proprietario ha deciso di renderlo il predefinito senza attendere quelle prove, che restano da fare. L'assistente AI e la collaborazione in tempo reale **non sono ancora offerti**: sono nel codice dietro interruttori di build spenti. Il protocollo di sync, le API e le migrazioni del cloud non cambiano.

### Compatibilità

- **Go 1.27.4:** desktop, cloud e strumenti si compilano con Go 1.27.4 (prima 1.27.3) per GO-2026-6859, vulnerabilità di `net/http` segnalata da `govulncheck` (ADR-0006). Le immagini Docker del cloud usano `golang:1.27.4-alpine3.24`; chi compila dai sorgenti ha bisogno di Go 1.27.4, che con `GOTOOLCHAIN=auto` viene scaricato.
- **macOS 13 o successivo:** l'app desktop richiede macOS 13 (prima l'`Info.plist` dichiarava 10.13). Il linker di Go 1.27 compila per macOS 13: la 1.3.4 dichiarava 10.13 su Intel e 11.0 su Apple Silicon, ma non era stata provata sotto macOS 13. Su macOS 12 o precedente il Finder rifiuta l'app. **Chi usa macOS 12 o precedente non può installare la 1.4.0** (serve macOS 13, `LSMinimumSystemVersion` `13.0.0`) e resta sulla 1.3.4 finché non aggiorna il sistema.
- **Wails v3 sul desktop (ADR-0051):** funzioni, nomi degli artefatti, installer e dati restano quelli della 1.3.x. Su macOS e Linux l'elenco degli **strumenti recenti di Excalidraw** si azzera una volta, perché cambia l'origine della pagina (`wails://wails` diventa `wails://localhost`). L'app è provata su macOS; su Windows c'è solo il cross-build e su Linux la build non è ancora stata eseguita (matrice manuale in `docs/qa/m15-wails3-matrice.md`). Le build pubblicate non hanno l'aggiornamento automatico (canale non firmato): la nuova versione si installa a mano sopra la 1.3.4, su ogni sistema operativo. Questo percorso non è ancora provato su Windows e Linux. Non è previsto un ritorno a Wails v2: un problema grave si corregge con una nuova versione. Lo smoke del binario su macOS (avvio, seconda istanza con `memobrain://`, chiusura con SIGTERM) è verde.
- **Config Profile:** nuovi flag riservati `features.ai` e `features.collab` (default `false`). Non hanno effetto: l'assistente AI e la collaborazione in tempo reale sono implementati ma inattivi, e servono anche una build che li abiliti (e, per la collaborazione, un provider che oggi non esiste). Un profilo con `true` in una build rilasciata non cambia nulla (ADR-0050).
- **File delle note (ADR-0049):** il nuovo Live non riscrive le note: un `.md` aperto e salvato senza modifiche resta identico byte per byte (BOM, frontmatter, ritorni a capo), e modificare un blocco cambia solo le righe di quel blocco, quindi il merge a tre vie del sync non produce più conflitti per riscritture di forma. Un file con CRLF modificato in Live conserva il CRLF nei blocchi non toccati (prima, in Live, tornava tutto in LF). Un file che il Live non saprebbe restituire identico, o con ritorni a capo misti, si apre in Sorgente con un avviso, senza essere normalizzato.

### Client desktop e workbench

- **Live è il nuovo editor WYSIWYG (M16, ADR-0049):** la modalità Live (`Mod+Maiusc+E` passa a Sorgente) mostra il risultato mentre scrivete, con l'esperienza del playground di Milkdown: una maniglia accanto al blocco con «+» (aggiunge un blocco e apre il menu `/`) e una presa per trascinarlo, una barra sulla selezione (grassetto, corsivo, barrato, evidenziato, codice, formula, link, con le vostre scorciatoie), il tooltip dei link Markdown (copia, modifica, rimuovi), il segnaposto nel blocco vuoto, il menu slash con gruppi e icone e margini più larghi. Sorgente resta l'editor di testo di prima (CodeMirror) e Lettura non cambia. Il Live Preview di CodeMirror è stato rimosso: non c'è un'impostazione per tornarci.
- **Cosa cambia in Live rispetto al Live Preview di prima** (elenco completo in ADR-0049, §9): la sintassi non compare più sulla riga attiva (i wikilink e gli embed mostrano il sorgente quando il cursore è dentro); numeri di riga, cursori multipli, selezione rettangolare, evidenziazione delle selezioni uguali, parentesi abbinate, riga attiva e completamento dei nomi delle proprietà ci sono solo in Sorgente; la colonna nella barra di stato è approssimata dentro il blocco; _Cerca nella nota_ cerca il testo reso (non i simboli Markdown), con espressioni regolari e «sostituisci tutto», mentre il pannello di ricerca di CodeMirror è solo in Sorgente; Invio in un paragrafo ne crea uno nuovo e Maiusc+Invio va a capo, Tab in un paragrafo scrive una tabulazione e nelle liste affonda la voce; commenti `%%`, formule `$$` in linea, HTML, note a piè di pagina, link a riferimento, autolink e riferimenti a caratteri sono blocchi non modificabili in Live (si modificano in Sorgente); `[[` non chiuso si salva come `\[\[`; digitare `:smile:` scrive il carattere Unicode (si vede come immagine Twemoji locale, anche offline); l'undo non attraversa il cambio Live e Sorgente (la sessione Live si annulla in un solo passo da Sorgente); i code block sono nel carattere a spaziatura fissa e con meno margine interno; il backtick non si chiude da solo; il comando Tabella inserisce una tabella con le celle vuote.
- **Note grandi e primo avvio:** una nota con più di 250.000 caratteri, 3.000 blocchi, un blocco da più di 20.000 caratteri o più di 150 blocchi di codice si apre in Sorgente, con un avviso. Il primo Live aperto carica l'editor (circa 0,8 s a freddo); in una misura in Chromium headless l'apertura di una nota da 200 kB ha richiesto circa 2,5 s, circa 10 volte il Live precedente. Non è stata misurata su una WebView reale: potrebbe servire abbassare le soglie.
- **Limiti noti del nuovo Live:** la caccia agli errori di scrittura non è esaurita (restano aperti il redo dopo un incolla di blocchi in una cella di tabella, la riscrittura delle righe vicine in liste con rientro irregolare e un titolo con `[[^1]](url)`); i controlli di riga e colonna delle tabelle si usano solo col puntatore (da tastiera ci sono i comandi di cella); la maniglia dei blocchi è solo per il puntatore (il «+» ha un nome per i lettori di schermo; i tasti equivalenti sono `/` e Alt+↑/↓).
- **Licenze:** la grafica delle emoji è Twemoji (Copyright Twitter, Inc. e altri collaboratori, licenza CC-BY 4.0, usata senza modifiche): l'attribuzione è in _Impostazioni → Informazioni_ (riga _Licenze_), nel `README.md` e in `emoji/ATTRIBUTION.txt` accanto alle immagini, che ogni build incorpora.
- **Export HTML fino a 256 MiB** anche sul desktop su Wails v3, che per la richiesta ammette 64 MiB: i payload oltre 32 MiB viaggiano a blocchi su un percorso dedicato della stessa origine, senza cambiare la CSP. Provato su macOS (65, 200 e 250 MiB); Windows e Linux no.
- **Dialoghi di file e cartella** agganciati alla finestra dell'app. Su Windows, «Annulla» non deve mostrare errori: da verificare su una macchina vera.
- **Build e sviluppo:** `task build-desktop`, `task dev-desktop` e `task release-desktop` non usano più la CLI di Wails v2: la build è un `go build`, lo sviluppo usa il watcher di Wails v3 con il server esbuild su `127.0.0.1:5173`, e la CLI `wails3` serve solo su Windows (risorse dell'exe e bootstrapper WebView2) e nel watcher. Un controllo in `task lint` verifica che le versioni di Wails (Go, runtime npm, CLI) coincidano, e ogni binario di rilascio è controllato (tag `production` presente, `mcp`, `server` e `devtools` assenti).
- **Build di rilascio:** `task release-desktop`, `task web-build` e l'immagine Docker del cloud rifiutano le variabili `MEMOBRAIN_AI`, `MEMOBRAIN_COLLAB`, `MEMOBRAIN_E2E` e `MEMOBRAIN_DIST` se sono impostate nella shell di chi compila, e controllano che l'interfaccia costruita non contenga né il codice della collaborazione (`y-prosemirror`) né il finto binding delle prove, e che contenga il chunk dell'editor Live (`assets/MilkdownEditor-*.js`): un rilascio esce sempre con la build predefinita. La variabile `MEMOBRAIN_LIVE_ENGINE` e l'interruttore di build del motore Live non esistono più: ogni build ha Milkdown, e chi imposta ancora quella variabile non ottiene nulla (non è più rifiutata). `MEMOBRAIN_DIST` accetta ora anche percorsi assoluti (uno relativo parte dalla cartella del pacchetto dell'app; un valore che coincide con il pacchetto o con una sua cartella madre è rifiutato, perché la build svuota la cartella di destinazione).
- **Comandi nuovi:** _Cerca nella nota_ (`Mod+F`) e _Vai alla riga_ (`Mod+Alt+G`, con una finestra per il numero) sono comandi della palette e di _Scorciatoie_ (`editor:find` e `editor:goto-line`), assegnabili e disponibili anche in Sorgente.
- **Menu slash e barra:** `/table` (o `/tabella`) e il pulsante Tabella della barra dell'editor inseriscono la tabella intera (prima il primo `|` spariva); `/callout` e `/divider` a metà riga iniziano su una riga propria.
- **Tag:** `Mod+clic` su un `#tag` nell'editor in modalità Live apre la ricerca del tag (prima non faceva nulla); in Sorgente il clic non segue il tag.
- **File con CRLF:** le sezioni incorporate, le statistiche e le query della nota leggono ora tutti i titoli (anche con i `#` finali) e tutte le attività. L'indice desktop leggeva già bene il CRLF.
- **File con BOM iniziale:** il BOM non nasconde più il frontmatter né il titolo in prima riga, né nell'indice né in Reading; Reading non mostra il BOM e riconosce fence e frontmatter in prima riga. Di conseguenza il pannello Proprietà mostra le proprietà di questi file, e modificarle o rimuoverle non duplica più il blocco e conserva il BOM; rinominare una nota aggiorna anche i link scritti nelle proprietà di un file con BOM.

### Contratti

- `api/config-profile.schema.json` (e la sua copia incorporata nel core del client): chiavi `features.ai` e `features.collab`, booleane, default `false`. `api/openapi.yaml` non cambia.

### Documentazione

- ADR-0049 (editor Live su Milkdown, con l'elenco delle differenze trovate in Live), accettato il 2026-11-12; ADR-0050 (AI inattiva e collaborazione spenta) e ADR-0051 (Wails v3), in proposta; ADR-0004 (Live Preview) superato in parte da ADR-0049; roadmap M15 e M16 con lo stato reale delle onde e dei criteri di uscita, compresa la rimozione del vecchio Live (A-W9) e le prove manuali ancora da fare; matrice di QA manuale `docs/qa/m15-wails3-matrice.md` (anche l'installazione a mano sopra la 1.3.4, il percorso reale delle build senza aggiornamento automatico); `docs/release/README.md` (build e rilascio su Wails v3); tabella delle chiavi del Config Profile nella guida admin; guida utente (nuovi comandi, le modalità Live, Sorgente e Lettura, la ricerca nella nota e le impostazioni dell'editor); `shared/conformance/README.md` (chi consuma le fixture, `roundtrip/` e le fixture `bom-*` e `crlf-*`); pagina di parità.

## [1.3.4] - 2026-11-05

Le presentazioni Marp come i disegni (milestone M14, [roadmap](docs/roadmap.md) §13-septies). La decisione è in ADR-0048, accettato: supera in parte ADR-0047 e, come questo, devia da `Specifications.md` (§2.2.1, §3.4.5, §3.4.6), che il proprietario deve aggiornare. Nessuna modifica al cloud né al protocollo di sync.

### Compatibilità

- **Slide escluse:** si escludono con il commento `<!-- memobrain: hidden -->` nel file della presentazione. Un client fino alla 1.3.3 (e ogni altro strumento Marp) non lo riconosce: mostra la slide e può leggere il commento come nota del relatore. L'esclusione vale solo nei client che la conoscono.
- **Impostazioni nel frontmatter:** `memobrain-loop` e `memobrain-notes` sono chiavi sconosciute a Marp, che le ignora, come i client precedenti. Il tema e i numeri di pagina usano le direttive native `theme` e `paginate`.
- Il merge a 3 vie dei `.marp` non cambia (per la sync sono ancora Markdown).

### Client desktop e workbench

- **Presentazioni Marp (ADR-0048):** un `.marp` si apre in un editor del solo sorgente a tutta larghezza: la vista divisa con l'anteprima non c'è più, e non compaiono più i pulsanti Live, Sorgente e Lettura, che su un `.marp` non facevano nulla.
- **Scheda Slideshow:** per un `.marp` mostra una card per ogni slide, come per i disegni: titolo, miniatura, vai alla slide nell'editor, sposta su e giù, includi o escludi, avvia da questa slide, e le note del relatore, che si scrivono nella card e si salvano da sole come commento nel file. Nella barra: avvia la presentazione, stampa o salva in PDF, informazioni (slide, incluse, tema, parole, slide con note), impostazioni (ricomincia alla fine, numeri di pagina, note del relatore, tema Predefinito, Gaia o Uncover) e il menu per includere o escludere tutte le slide. Ogni modifica è annullabile con undo nell'editor e, in sola lettura, è disattivata. Con le slide divise dai titoli (`headingDivider`) il riordino non è disponibile.
- **Presentazione a tutto schermo:** mostra le slide incluse del testo come è nell'editor, anche non salvato, con gli stessi tasti e la stessa ripetizione dei disegni; la barra ha slide precedente e successiva, l'elenco delle slide e le note del relatore. I numeri di pagina seguono Marp anche quando alcune slide sono escluse.
- **Export nel ribbon, per tipo di file:** i pulsanti a sinistra cambiano con il file attivo. Una nota ha PDF, immagine e HTML; un disegno ha PNG, SVG e PDF; una presentazione ha HTML, PDF e PPTX. Per gli altri file non compare nulla. _Esporta in PDF_ delle note è ora attivo solo per le note `.md`.
- **Export PPTX:** nuovo, con testo modificabile in PowerPoint o Keynote, note del relatore e numeri di pagina. Il tema è approssimato (colori e font di Predefinito, Gaia e Uncover, classi `invert` e `lead`) e non identico all'HTML. Le immagini che non si riescono a convertire (per esempio certi SVG) sono saltate e l'app le elenca. Le slide escluse restano fuori dall'HTML, dal PDF e dal PPTX. Nel browser il file viene scaricato.
- **Disegni:** nuovi comandi per esportare in PNG, SVG e PDF (_Disegno: esporta come immagine PNG…_, _…SVG…_, _Disegno: esporta tutto il disegno in PDF_), disponibili anche dal ribbon. I comandi dei disegni agiscono sul disegno della scheda attiva, e un file del vault trascinato su un disegno lo aggiunge a quel disegno.

### Documentazione

- ADR-0048, roadmap M14, guida utente delle presentazioni (ora anche per i `.marp`), pagina di parità.

## [1.3.3] - 2026-11-03

L'apertura dei file per tipo e le presentazioni Marp (milestone M13, [roadmap](docs/roadmap.md) §13-sexies). La decisione è in ADR-0047, accettato; devia da `Specifications.md` (§2.2.1, §3.4.5, §3.4.6) e va recepita dal proprietario. Nessuna modifica al cloud né al protocollo di sync.

### Compatibilità

- **File `.marp`:** per la sync sono Markdown. Un client fino alla 1.3.2 li tratta come file generici: in caso di conflitto crea una copia di conflitto invece dell'unione a 3 vie, e nessuna modifica si perde. Per unire le presentazioni modificate su più dispositivi aggiornare tutti i client.

### Client desktop e workbench

- **Apertura dei file per tipo (ADR-0047):** note, lavagne, basi, disegni, presentazioni, immagini, PDF, audio e video si aprono in una scheda. Ogni altro file (`.zip`, `.docx`, `.pptx`, …) si apre con l'applicazione predefinita del sistema sul desktop. Nel browser compare la conferma «Apertura File» e il file si scarica. Un programma (`.exe`, `.sh`, `.command`, …) non viene mai aperto: si mostra nella cartella. L'explorer ha un'icona per tipo di file e le voci «Apri con l'app predefinita», «Mostra nella cartella» e «Download».
- **Presentazioni Marp (`.marp`, ADR-0047):** «Nuova presentazione» crea un file Marp. A sinistra c'è l'editor della sorgente, a destra l'anteprima delle slide aggiornata mentre si scrive, con la slide del cursore evidenziata. Si presenta a tutto schermo e si esporta in HTML o in PDF; l'export PPTX non è ancora disponibile. Si usano solo i temi integrati di Marp, senza CSS dell'autore, e nessuna risorsa arriva dalla rete. Per la sync un `.marp` è Markdown: unione a 3 vie, ricerca e link. Un client precedente lo tratta come file generico, quindi in caso di conflitto crea una copia di conflitto. Il flag `presentations` del Config Profile spegne la funzione.

### Contratti

- `info.version` del contratto OpenAPI passa a 1.3.3, come la versione del prodotto; nessuna operazione cambia. Il Config Profile ha la nuova chiave `features.presentations` (default `true`).

### Documentazione

- ADR-0047 (apertura dei file per tipo e presentazioni Marp), roadmap M13, tabella delle chiavi del Config Profile nella guida admin, capability `openWithSystemApp` in `desktop-web-sync.md`, pagina di parità.

## [1.3.2] - 2026-11-03

Le correzioni della revisione del 2026-11-02 (milestone M12, [roadmap](docs/roadmap.md) §13-quinquies). Le decisioni sono in ADR-0045 (parità per costruzione) e ADR-0046 (bootstrap dopo un ripristino del cloud), accettati.

### Compatibilità

- **Migrazioni 0010–0014** (indici, `purged_subjects`, chiavi di idempotenza e `export_jobs.source_seq`, `uploads.finalizing_until`, rimozione delle autoconcessioni dei creatori di condivisioni). Si applicano all'avvio come sempre. Durante le migrazioni il pod API risponde già: `healthz` 200 e `readyz` 503.
- **Cursore della sync con identità (ADR-0046):** `GET /vaults/{id}/changes` accetta `since_id` e restituisce `next_id`; `GET /vaults/{id}/tree` restituisce `as_of_id`. I client precedenti, che non inviano `since_id`, funzionano come prima. Per riconoscere i numeri di sequenza riusati dopo un ripristino servono il desktop e il workbench di questa versione.
- **Server senza TLS:** il desktop non accetta più un server o un issuer `http://` che non sia locale (`localhost`, `127.0.0.0/8`, `::1`). Il token e i contenuti dei vault condivisi viaggerebbero in chiaro. All'accesso compare l'errore `insecure-url`, e una sessione salvata con un indirizzo così non viene ripresa.
- **Liste paginate:** `GET /shares`, `GET /shared-with-me`, `GET /admin/groups`, `GET /admin/groups/{id}/members` e `GET /admin/config-profiles/{id}/versions` restituiscono `{items, next_cursor}` invece di un array. I desktop fino alla 1.3.1 non leggono più condivisioni, inviti e mount da un cloud aggiornato; nessun dato si perde. Aggiornare i desktop prima del cloud. La console e il workbench web sono già allineati. Lo storico di un profilo elenca solo i metadati; la configurazione di una versione si legge con `GET /admin/config-profiles/{id}/versions/{version}`.

### Client desktop e sync

- **Ripristino del cloud a un punto precedente (ADR-0046):** quando il server risponde che il cursore del dispositivo è più avanti del suo, la sync non riscrive più i file locali con le revisioni vecchie e non sposta nel cestino quelli che il server ha perso: li ripubblica. Prima di ogni sovrascrittura durante un bootstrap viene salvata una versione in _File recovery_. Un bootstrap interrotto riprende nella stessa modalità.
- **Vault con `#` o `?` nel percorso:** `index.db` e `sync.db` venivano aperti in un file troncato fuori dal vault, e due vault potevano condividere lo stesso stato di sync. Ora il percorso è codificato correttamente. Se resta un database al vecchio percorso, il log lo segnala e il file non viene toccato: l'indice si ricostruisce da solo, mentre un vault di questo tipo collegato al cloud va ricollegato.
- **File grandi su reti lente:** download e upload dei blob non hanno più il limite di tempo totale delle chiamate di controllo. Si interrompono solo se non arrivano byte per 60 secondi o se la risposta non inizia entro 2 minuti.
- **Prima sincronizzazione di vault grandi:** il push legge e cifra i file un batch alla volta invece di tenerli tutti in memoria.
- **Basi (`.base`) ricevute da altri:** limiti di profondità (128 livelli), di lunghezza delle espressioni (16 KiB) e del file (1 MiB); budget di memoria (1 MiB per valore, 256 MiB per esecuzione) e di calcolo (10 secondi) per ogni esecuzione. Un'espressione che li supera dà un errore nella cella invece di chiudere l'app. `title()` non spezza più le iniziali accentate.
- **Stati della sync:** un file cancellato e ripristinato tra due scansioni non perde le modifiche non inviate né uno spostamento in sospeso. Un file spostato qui e cancellato sul server viene ricreato invece di restare bloccato. La migrazione dei path cifrati fatta da un altro dispositivo non annulla una rinomina locale. Prima di cestinare un file cancellato sul server si controlla che non sia stato modificato nel frattempo.
- **Conflitti:** «Mantieni la mia» e l'unione sovrascrivono il file solo se contiene ancora il testo mostrato nel confronto. La versione sostituita finisce in _File recovery_.
- **Quarantena:** i file illeggibili vengono ritentati a ogni ciclo e ne escono quando arriva una revisione leggibile. Lo stato della sync ne riporta il numero.
- **Rinomina durante la sync:** rinominare una nota o una cartella non aspetta più la fine del ciclo di sincronizzazione in corso.
- **Condivisioni montate:** un errore su un singolo file non segna più la condivisione come revocata, e un cambio di account non revoca i mount dell'altro account. Un vault eliminato dalla console o da un altro dispositivo viene scollegato come se lo si eliminasse dall'app, e i file locali restano.
- **Errori di rete:** le risposte d'errore di un proxy (413, 429, 5xx) non bloccano più tutto il push e non mostrano HTML nella UI. Un 401 rinnova il token una volta. Se la sessione viene rifiutata di continuo, lo stream delle notifiche si ferma invece di riconnettersi ogni secondo. Le risposte hanno limiti di dimensione.
- **File grandi:** la history, il parser e l'indice non leggono più per intero i file enormi. Le note oltre 8 MiB vengono indicizzate solo per nome e percorso.
- **Modifiche esterne:** le modifiche trovate dalla riconciliazione arrivano all'interfaccia e alla history. Un overflow del watcher avvia una riconciliazione, e un'attività continua non rinvia più all'infinito gli aggiornamenti.
- **Cartelle che iniziano con `..`:** una cartella come `..Archivio` non viene più rifiutata come esterna al vault.
- **Import:** gli allegati vengono copiati senza caricarli in memoria e i nomi con segmenti `.` vengono normalizzati. L'import di `.excalidraw.md` ha limiti di memoria a ogni passo.
- **Tipi delle proprietà:** due modifiche contemporanee a `types.json` non si sovrascrivono più.
- **Core WebAssembly:** i timeout delle chiamate all'host del browser vengono rispettati.
- **Sincronizzazione più veloce:** download e upload dei blob avvengono fino a 4 alla volta, con le modifiche applicate sempre in ordine. In una prima sincronizzazione con un server a 20 ms il tempo scende di circa tre volte.
- **Workbench nel browser più leggero:** il core WebAssembly non include più l'accesso OIDC del desktop, il portachiavi, l'updater e il cestino di sistema (−9 % di dimensione). Impostazioni, recupero dei file, procedura di collegamento, conflitti, cronologia e lavagne si caricano al primo uso.
- **Excalidraw:** «Scomponi in un nuovo disegno» e «Aggiorna le schede delle note» erano attivi anche senza diritti di modifica.
- **Passphrase nuove:** la regola di robustezza (12 caratteri e stima zxcvbn) è applicata dal core del desktop e del browser, non solo dall'interfaccia; le passphrase esistenti continuano a funzionare.
- **Modifica remota e spostamento:** una modifica arrivata da un altro dispositivo non va più persa quando lo stesso file viene anche spostato prima che questo dispositivo la applichi.
- **Upload ripresi:** un upload tus interrotto a metà riprende dal punto in cui il server è arrivato, invece di fallire per una posizione non coincidente.
- **Log:** gli avvisi dei componenti che usano `slog` finiscono nel log dell'app.

### Workbench (desktop e web)

- **Annulla dopo un ricaricamento:** una nota ricaricata dal disco o dalla sync non si annulla più con Annulla, che prima poteva cancellare la modifica appena arrivata. Le lavagne azzerano la cronologia quando arriva una versione nuova.
- **Lavagne e incolla:** le azioni che finiscono dopo un dialogo non sovrascrivono più le modifiche remote. Gli allegati incollati finiscono nel punto giusto e un errore viene mostrato.
- **Viste che falliscono:** un errore in una vista, o un pezzo dell'app che non si scarica, mostra un messaggio con «Riprova» invece di una pagina bianca. Le altre viste restano utilizzabili.
- **Grafo:** si aggiorna senza rifare il layout da capo e senza perdere zoom e posizione. I salvataggi automatici che non cambiano i collegamenti non lo ricalcolano.
- **Basi e Live Preview:** le basi aggiornano i risultati con un piccolo ritardo e senza accodare esecuzioni. La Live Preview analizza solo la parte del documento cambiata, ed è molto più veloce sulle note lunghe.
- **Stato della sync:** un avviso quando il vault cloud è stato eliminato altrove; il numero di file illeggibili in quarantena; il confronto dei conflitti si ricarica se il file è cambiato. I codici d'errore sono tradotti, compreso `insecure-url`.
- **Impostazioni, segnalibri e libreria di Excalidraw:** le modifiche in attesa vengono scritte alla chiusura e al cambio di vault, non si perdono.
- **Avvio più leggero:** la vista grafo e la procedura di import si caricano al primo uso.
- **Passphrase errata:** l'errore ha un codice proprio ed è tradotto ovunque, anche nel blocco di sblocco del browser.
- **Note lunghe:** l'editor non copia più l'intero testo della nota a ogni tasto.

### Web UI

- **Export lunghi:** il token viene rinnovato durante l'export e non scade più dopo 5 minuti. Un errore di rete al rinnovo non chiude la sessione.
- **Export dei vault privati:** si salta solo un file che il server non ha più; per gli altri errori l'export si ferma senza salvare uno ZIP incompleto. La memoria usata è limitata.
- **Export dei vault condivisi:** l'archivio preparato dal server si salva su disco in streaming con _Salva ZIP…_, senza caricarlo tutto in memoria.
- **Copie nel browser per account:** le copie dei vault, i marcatori e il dispositivo sono separati per account. Un altro utente dello stesso browser non vede né cancella le copie altrui. Le copie delle versioni fino alla 1.3 vengono adottate solo se appartengono con certezza all'account, altrimenti si possono eliminare dalla pagina Account.
- **Eliminazione dell'account:** cancella anche le copie in chiaro nel browser e la registrazione del dispositivo.
- **Chiavi dei vault privati:** vengono azzerate in memoria e scadono dopo il tempo di blocco (`security.vault_lock_minutes`).
- **Console:** l'area di amministrazione segue il ruolo restituito da `/me`. Le cache di vault, condivisioni e flag sono uniche.
- **Profili di configurazione:** due amministratori che salvano insieme non si sovrascrivono più. Il secondo riceve un conflitto e può ricaricare la versione corrente (`expected_version`).
- **Avvio del workbench web:** l'avvio del core ha limiti di tempo e offre «Riprova». Un indirizzo malformato mostra «non trovato».
- **Condivisioni montate nel browser:** «Apri» passa dalla pagina del vault con le stesse protezioni dell'apertura dalla console. Al posto di «Mantieni una copia», che nel browser creava una cartella irraggiungibile, si offre «Scarica una copia».
- **Uscita e «Dimentica questo browser»:** prima di cancellare le copie si caricano le ultime modifiche dei vault condivisi. Una copia con modifiche non caricate non viene cancellata senza conferma.
- **Sblocco nel browser:** la nuova passphrase scelta dopo la chiave di recupero rispetta la stessa regola di robustezza del desktop.
- **Ricerca di utenti e gruppi** dal workbench: una sola richiesta, con la descrizione dei gruppi come nella console.
- **Liste lunghe:** condivisioni, inviti, gruppi, membri e storico dei profili si caricano a pagine con «Carica altri». La lista dei vault condivisi con l'utente è una sola tra console e workbench.
- **Pulsante account nel browser:** non offre più accesso e uscita, che nel browser appartengono alla console.
- **Copie di vault eliminati:** aprendo nel browser la copia di un vault eliminato mentre nessuna pagina era aperta, il workbench lo riconosce: la copia si apre per esportarla e si può rimuovere dal browser.

### Cloud

- **Pulizia dei blob:** l'oggetto in S3 viene cancellato solo dopo che la cancellazione della riga è confermata, e un upload deduplicato non può più essere raccolto subito dopo il collegamento. Un blob che non si riesce a cancellare viene saltato e contato nella metrica `memobrain_jobs_item_failures_total`, senza bloccare gli altri.
- **Upload tus:** l'eliminazione di un account o il purge di un vault cancellano anche i chunk in S3, e uno sweep periodico rimuove quelli rimasti senza riga. La finalizzazione concorrente dello stesso upload non chiede più di ricominciare, e gli upload iniziati prima dell'aggiornamento riprendono correttamente.
- **Tombstone e vault eliminati:** i file cancellati vengono rimossi davvero quando escono dalla retention (prima restavano per sempre). Il purge dei vault eliminati procede a pagine, in transazioni brevi e nell'ordine dei lock del commit, ricontrolla che il vault sia ancora eliminato e, se un vault fallisce, passa al successivo. Nuovi indici sulle colonne usate dai controlli delle chiavi esterne.
- **Autenticazione:** un token con un `kid` sconosciuto non provoca più una richiesta del JWKS a Keycloak per ogni chiamata; discovery e JWKS hanno un timeout di 10 secondi. Lo stream gRPC delle notifiche ha limiti per IP e per utente. Una sospensione arrivata durante il provisioning non viene più persa dalla cache.
- **Account eliminati:** dopo il purge, un nuovo login con la stessa identità Keycloak viene rifiutato anche se l'account Keycloak non è stato disabilitato. Il purge prova a disabilitarlo e registra l'esito nell'audit.
- **Condivisioni:** un manager non può concedersi grant sulle condivisioni che crea, e perde quelli che aveva quando perde la gestione. Una condivisione scaduta la modifica solo il proprietario. I cambi nei gruppi inviano gli eventi di condivisione ai membri interessati. Un nuovo invito dopo un rifiuto torna «in attesa», e rifiutare due volte non dà errore. Lo spostamento delle cartelle condivise usa lo stesso confronto dei path degli ambiti.
- **API:** `POST /vaults` e `POST /me/devices` rispettano `Idempotency-Key`.
- **Export:** un export in corso torna in coda quando il worker si ferma. Gli errori mostrati sono generici. Un archivio pronto di un vault non cambiato viene riusato. Gli stream ZIP diretti hanno un limite per utente (`exports.max_active_per_user`). L'eliminazione dell'account o del vault ferma gli export in corso.
- **Export GDPR:** `/me/export` include tutto il registro di audit dell'utente, non più solo le 10.000 voci più vecchie.
- **Log delle richieste:** registra l'IP del client risolto attraverso i proxy fidati.
- **Avvio e arresto:** l'API apre la porta prima delle migrazioni, così le probe non riavviano un pod in attesa del lock. All'arresto gli stream gRPC restano aperti per tutto il drain, come HTTP.
- **Quota degli upload:** il controllo della quota a ogni upload non rilegge più tutti i blob caricati nella finestra; durante una prima sincronizzazione grande passa da decine di migliaia di righe lette a qualche centinaio.

### Deploy

- **Realm Keycloak di produzione:** l'indirizzo di ritorno dopo il logout del client `memobrain-web` usa `${WEB_UI_ORIGIN}`. Prima era fisso su `localhost`, e il logout dalla Web UI non chiudeva la sessione SSO. Nelle installazioni con un realm configurato a mano va aggiunto `<origine della Web UI>/*` ai _Valid post logout redirect URIs_ (guida admin, Keycloak).
- **Helm:** `progressDeadlineSeconds` 900 per API e worker. I commenti su probe e tempi di arresto ora corrispondono al budget reale: `preStopSleepSeconds` + `SHUTDOWN_DRAIN` + `SHUTDOWN_TIMEOUT` deve stare sotto `terminationGracePeriodSeconds`.
- **Compose on-premise:** header HSTS quando il servizio è in https. Lo stack di sviluppo e `run-cloud-k3d.sh` pubblicano le porte solo su `127.0.0.1`.

### Documentazione

- **OpenAPI:** ogni operazione autenticata dichiara le risposte del middleware di autenticazione (403 `USER_SUSPENDED`, 409 per il conflitto d'identità); `Conflict` elenca tutti i codici.
- **Guide per chi sviluppa:** `CONTRIBUTING.md` segue il processo di parità di ADR-0045, con la tabella completa dei file generati; `docs/desktop-web-sync.md` ha le ricette passo per passo per una funzione nuova; README, architettura, Web UI, pagina di parità e `dev-setup` sono allineati al codice.
- **Ripristino del database:** il runbook e la guida admin descrivono il comportamento dei dispositivi dopo un ripristino point-in-time (ADR-0046).

### Sviluppo

- **Parità per costruzione (ADR-0045):** il registro delle funzioni distingue le prove per superficie (desktop, workbench, console, cloud). Uno stato «sì» sul workbench richiede una prova sul core WebAssembly. Un mock REST validato sull'OpenAPI fa girare i pannelli cloud sul core reale.
- **Eventi e binding tipizzati:** gli eventi Go → TypeScript si dichiarano una volta in Go e sono generati per il frontend (`task gen-events`). L'host web usa un client tipizzato generato dai binding. ESLint vieta nomi di eventi e binding scritti a mano.
- **Capability, azioni e tipi dal core:** le capability del browser sono dichiarate dal core Go e generate per il frontend. I pulsanti dei pannelli sono azioni dichiarative legate a una funzione del registro (`FeatureId` generato). I binding di gestione cloud restituiscono i tipi dell'OpenAPI. Le suite dei componenti cloud girano anche sul core WebAssembly reale (`task test-core`).

## [1.3.1] - 2026-11-02

Una barra di stato facoltativa sotto l'editor e l'allineamento della specifica al codice: `Specifications.md` 1.4 recepisce gli ADR già implementati (0009–0022, 0024, 0026–0028, 0031, 0033, 0034) e la 1.5 recepisce ADR-0035. Resta in stato di proposta solo ADR-0023 (manifest firmato e aggiornamento automatico). Nessuna modifica al cloud né al protocollo di sync.

### Client desktop e workbench

- **Barra di stato facoltativa** (ADR-0035, accettato e recepito in `Specifications.md` 1.5): una riga sottile sotto l'area dell'editor con parole e caratteri della nota (o della selezione), riga:colonna del cursore e modalità, che un clic fa ciclare. È **spenta per default**: si accende da _Impostazioni › Aspetto_, con il comando _Mostra/nascondi barra di stato_ (`app:toggle-status-bar`) o con la chiave `appearance.statusBar` del Config Profile, che l'amministratore può anche bloccare. Sync, permessi, aggiornamenti e inviti restano nel blocco di stato del vault. Su disegni, lavagne e basi mostra solo il tipo di file e si nasconde durante le presentazioni.
- Riga e colonna nella scheda _Statistiche_ sono giuste appena si apre una scheda o si passa a un altro pannello, senza aspettare il primo tasto.

### Contratti

- `info.version` del contratto OpenAPI passa a 1.3.1, come la versione del prodotto; nessuna operazione cambia.

### Documentazione

- `Specifications.md` 1.4 e 1.5 (registro delle revisioni e Appendice C.4): accettati e recepiti gli ADR 0009–0022, 0024, 0026–0028, 0031, 0033, 0034 e 0035; indice degli ADR, roadmap e nota sulla proposta v1.2 aggiornati.
- Guide utente (primo vault, impostazioni, accessibilità), tabella delle chiavi del Config Profile nella guida admin e checklist QA descrivono la barra di stato.

## [1.3.0] - 2026-11-02

Correzioni d'integrità dei dati nel cloud e nel client, una politica di cancellazione per le copie dei vault privati nel browser, prestazioni e osservabilità, la parità completa tra desktop, workbench web e console (registro delle funzioni, `@memobrain/cloud-features`, client Go generato), path cifrati ed envelope v2 attivi per default, e la revisione dei rilievi di sicurezza. Le decisioni sono negli ADR 0029, 0030, 0032 e 0036–0044, accettati e recepiti in `Specifications.md` 1.3; ADR-0034 resta in stato di proposta. Prima di aggiornare il cloud leggere la sezione «Compatibilità».

### Compatibilità

- **Desktop fino alla 1.2.4 e vault privati:** questa versione scrive per default gli envelope della chiave in formato v2 e i path cifrati in formato `enc2` (ADR-0034, ADR-0042), e il cloud distribuisce i due flag accesi. I desktop 1.2.4 e precedenti non leggono questi formati: non sbloccano un vault il cui envelope è passato al v2 e saltano i file con un path `enc2`. Aggiornare i desktop **prima** del cloud, oppure impostare `"features": {"envelope_v2": false, "path_v2": false}` nel profilo globale finché restano dispositivi vecchi (`docs/admin-guide/backup-upgrade.md`). Il workbench web è sempre aggiornato. Nessuna perdita di dati: chiave, contenuto e storico sul cloud non cambiano, e un desktop aggiornato legge tutto.

### Verifiche (ADR-0036)

- **Nessun servizio di CI:** `task ci` è il controllo ufficiale da eseguire prima di ogni merge e di ogni tag. Ora comprende anche typecheck di tutti i pacchetti TypeScript, test del core in WebAssembly, controllo di parità e controllo del codice generato (`task check-gen`), e funziona su un clone pulito e su Linux. Il test che confronta dispatcher e binding generati fallisce invece di essere saltato.

### Cloud

- **Retention dello storico** (ADR-0038): non si blocca più su una copia di conflitto (migrazione `0007_retention_fixes.sql`); quando cancella un'operazione strutturale fa avanzare `compaction_seq`, così un client rimasto indietro riceve `410 CURSOR_EXPIRED` e riparte dall'albero invece di applicare un changelog con dei buchi; scorre i candidati con una paginazione keyset.
- **Memoria:** il validatore delle richieste non legge più in memoria il corpo degli upload dei blob.
- **Job del worker:** gli advisory lock usano un pool dedicato (prima un pool piccolo poteva bloccare lo scheduler); la riconciliazione di quote e riferimenti ai blob corregge riga per riga sotto lock invece di scrivere uno snapshot vecchio.
- **Limite per IP dietro un proxy:** il chart Helm e il compose impostano un default per `TRUSTED_PROXIES` (reti private); prima tutti gli utenti dietro l'ingress condividevano un solo contatore.
- **Osservabilità del worker:** `/metrics`, `/healthz` e `/readyz` su un listener interno (`METRICS_LISTEN_ADDR`, default `127.0.0.1:18083`); il worker aspetta lo schema e le migrazioni sono serializzate da un advisory lock. `/readyz` tiene in cache i controlli per 2 s e dà il dettaglio solo ai chiamanti interni; l'etichetta del metodo HTTP nelle metriche ha un insieme chiuso di valori.
- **Web UI incorporata:** asset con ETag e compressione gzip; i file temporanei di upload ed export lasciati da un processo interrotto vengono rimossi all'avvio, e lo spool ha un `sizeLimit` nel chart.
- **API:** `GET /vaults?include_deleted=true` elenca anche i vault eliminati ancora ripristinabili. Lo stream SSE termina subito dopo la sospensione dell'account, come quello gRPC.
- **Contratto OpenAPI** (`info.version` ora segue la versione del prodotto, 1.3.0): risposte `429`, `413` e `default` documentate su tutte le operazioni, `x-required-role: memobrain-admin` sulle operazioni di amministrazione, schema `openIdConnect`, upload tus e stream SSE descritti nell'estensione `x-memobrain-external-routes`.

- **Quota sugli upload:** i byte caricati ma non ancora committati contano come in sospeso e un upload oltre quota viene rifiutato subito; il `PATCH` tus non tiene aperta una transazione durante lo streaming.
- **Commit più veloci e senza deadlock:** il lock del vault si prende per primo, gli statement per operazione scendono da 10 a 4 (creazione) e da 9 a 3 (modifica); un ritentativo concorrente viene riconosciuto dall'id dell'operazione.
- **Rinomina di cartelle condivise** (ADR-0040): il client invia un solo `move_prefix` e la condivisione segue la cartella; il server applica le regole sulla radice delle condivisioni anche al `move_prefix`.
- **Condivisioni:** la history vista da una condivisione non mostra path esterni né revisioni precedenti; gli inviti rifiutati risultano rifiutati; le liste non perdono condivisioni sugli errori; gli export hanno limiti per vault e per utente.
- **Account e ruoli** (ADR-0041): un token vecchio non annulla più una retrocessione; guardia sull'ultimo amministratore sotto lock; eliminazione dell'account con un solo percorso, i grant su vault altrui passano al proprietario; la directory trova un'email solo con l'indirizzo esatto.
- **Notifiche:** hub riscritto con risincronizzazione dopo una riconnessione al database, limite di stream per utente, recupero dai panic e chiusura ordinata in gRPC.
- **Dispositivo revocato:** il commit lo segnala con un motivo dedicato.

### Client desktop e workbench

- **Sync senza perdite** (ADR-0039): i candidati al merge sono salvati in `sync.db` nella stessa transazione del cursore (`pending_remote`); un vault bloccato a metà ciclo ferma il pull prima che il cursore avanzi; un path che non si decifra va in quarantena invece di essere saltato o di mandare nel cestino il file locale; la copia di conflitto si scrive prima di sovrascrivere l'originale, con nomi troncati su confini UTF-8.
- **Scritture concorrenti:** un lock per path in `vault.FS` impedisce che la sync e il salvataggio dall'editor si sovrascrivano a vicenda.
- **Editor:** «Sovrascrivi» in un conflitto con una modifica esterna funziona; le modifiche ancora in attesa di salvataggio vengono scritte prima di chiudere il vault, la finestra o un tab, prima di caricare un workspace e prima di tornare alla console.
- **Merge del frontmatter:** chiavi duplicate o righe ambigue producono un conflitto invece di essere scartate in un merge «pulito» (nuove fixture in `shared/conformance/merge`).
- **Prestazioni:** chiavi dei link nell'indice e risoluzione incrementale (niente più risoluzione di tutto il vault a ogni creazione o cancellazione), candidati alla rinomina dall'indice, il primo scan della sync non ricalcola più l'hash di tutto il vault, eventi `vault:file-changed` tipizzati (create, modify, delete) con aggiornamenti mirati dell'interfaccia, meno perdite di memoria negli embed.

- **Watcher su macOS con FSEvents** (ADR-0044): da circa 51.000 descrittori a 11 su un vault di 50.000 file; su Linux e Windows degrada in modo controllato al limite dei descrittori.
- **Dispositivo revocato:** il sync si ferma senza toccare i dati locali né l'outbox, un banner offre di registrare di nuovo il dispositivo e poi l'outbox viene caricato.
- **Rinomina:** aggiorna anche i nodi dei canvas e i link nelle proprietà; il rollback non sovrascrive contenuto cambiato nel frattempo.
- **Merge:** diff deterministico con un budget di lavoro fisso (al posto del timeout di 1 s), un cambio LF/CRLF di un solo lato non produce più un conflitto sull'intero file, Excalidraw usa la base come il canvas.
- La recovery key non si perde se il keychain fallisce dopo la creazione del vault; un errore temporaneo del keychain non cancella più la sessione; installer Windows avviato senza problemi di quoting; il codice OAuth non finisce nei log.

### Workbench web

- **Copie in chiaro dei vault privati:** il core è l'unico timer di inattività e rispetta il profilo; quando il vault si blocca, la copia nel browser viene cancellata se il cloud ha tutto, altrimenti resta con un avviso bloccante (sblocca, elimina comunque, torna alla console). All'avvio si rimuovono le copie lasciate da un tab chiuso, tranne quelle con modifiche non inviate; logout e «Dimentica questo browser» avvisano se una copia ha modifiche non inviate (D-04).
- **Affidabilità:** se il core si ferma la pagina lo dice invece di restare bloccata; le chiamate di avvio hanno un limite di tempo; il token si rinnova senza ricaricare la pagina e, se il rinnovo fallisce, le modifiche vengono scritte prima del login.

- **Capability estese:** sul web «Disconnetti» diventa «Rimuovi da questo browser» (svuota prima l'outbox), niente vault recenti o cestino di sistema; identità del dispositivo stabile per profilo del browser (IndexedDB).
- Link nei canvas e nelle slide intercettati, diagrammi Mermaid resi correttamente in chiaro e scuro, niente più crash con un `%` in un link, meno lavoro a ogni tasto; core WASM da 8,1 a 6,8 MB compressi.

### Parità e contratti (ADR-0037)

- **Registro delle funzioni** `shared/parity/features.yaml`, con un `scripts/parity.mjs` che legge i comandi a runtime e verifica funzioni, comandi, binding e operazioni REST (`task parity`); campo `Command.requires` per i comandi che dipendono da una capability.
- **Client Go generato** da `api/openapi.yaml` (`shared/go/apiclient`), usato dal trasporto della sync del core; contract test del client contro il server reale e test che allinea l'enum `ErrorCode` ai codici di `shared/go/syncproto`.
- **`@memobrain/cloud-features`:** la gestione dei vault cloud scritta una volta per console, desktop e workbench, dietro l'interfaccia `CloudPort`: ciclo di vita dei vault (creazione, rinomina, eliminazione logica, ripristino; i vault privati si creano nel workbench del browser con la crittografia Go), dispositivi (quello in uso protetto), utilizzo con il livello del server e il dettaglio per vault, condivisioni (creazione e modifica anche dalla console), inviti, «I miei gruppi».
- **Feature flag dallo schema:** nomi e default dei flag del Config Profile si generano da `api/config-profile.schema.json` (`task gen-features`) per Go e TypeScript; nella guida admin una tabella di tutte le chiavi, verificata da un test.
- **Matrice e2e:** gli spec della UI desktop girano anche sul workbench web reale (`task e2e-matrix`), con le esclusioni motivate dal registro; una suite mista mette un dispositivo desktop headless e il browser sullo stesso cloud (`task e2e-mixed`).

### Sicurezza e crittografia

- **Audit:** registra l'IP del client (attraverso i proxy fidati) e l'eliminazione, il ripristino e il cambio di chiave dei vault; tutte le celle del CSV sono protette dalla formula injection.
- **SRI completa nel workbench:** worker del core, chunk (import map con `integrity`), worker di layout e di pdf.js, `excalidraw.js`; la CSP aggiunge solo l'hash della import map.
- **Passphrase normalizzate NFC** prima di Argon2id; gli envelope creati da un input non NFC continuano ad aprirsi.
- **Envelope della VMK v2** legato a vault e tipo (ADR-0034) e **path cifrati v2** legati al file (ADR-0042): tutti i client leggono entrambi i formati, e `features.envelope_v2` e `features.path_v2` sono **accesi per default** (rilascio N+1 dei due ADR). Il client fa l'upgrade a v2 degli envelope allo sblocco e riscrive in background, a lotti e senza bloccare la sync, i token di path `enc1` rimasti. Quando l'albero di un vault non ne contiene più, accende un pin forte e da lì mette in quarantena ogni token `enc1` di quel vault. Vedi «Compatibilità».
- Chiavi azzerate al blocco, calibrazione di Argon2id con un tetto di 256 MiB, manifest di aggiornamento con scadenza firmata.

### Deploy e supply chain

- Immagini pinnate per versione e digest, action di `release.yml` per SHA, appimagetool e runtime per checksum (`deploy/PINS.md`).
- Compose: console di amministrazione e realm master di Keycloak chiusi per default (`KEYCLOAK_ADMIN_FROM`); il cloud, il compose e il chart Helm rifiutano i segreti segnaposto (`change-me`); il preStop `sleep` solo da Kubernetes 1.30.

### Documentazione

- Nuovi `CONTRIBUTING.md`, `docs/architecture.md` e `docs/desktop-web-sync.md`; README con struttura del repository e indice della documentazione; i documenti non promettono più una CI (ADR-0036).
- ADR in stato di proposta: 0036 (verifiche locali), 0037 (registro delle funzioni e cloud-features), 0038 (retention e changelog), 0039 (`sync.db`), 0040 (`move_prefix`), 0041 (ruoli, identità e account), 0042 (path cifrati legati al file), 0043 (convergenza della UI), 0044 (watcher FSEvents).

### Sviluppo

- Linux: `task dev-desktop` e `task build-desktop` usano il tag `webkit2_41` dove c'è solo `webkit2gtk-4.1`. La copia generata del runtime di Wails in `apps/desktop/frontend/wailsjs` non è più versionata (la UI usa `packages/workbench/wailsjs`).
- La CLI Wails si installa nella versione di `apps/desktop/go.mod` (v2.17, `task wails-cli`); `gen-wails`, `dev-desktop` e `build-desktop` rifiutano una CLI diversa.

## [1.2.4] - 2026-10-31

Solo la pipeline di rilascio: nessuna modifica all'app o al cloud.

### Rilascio

- Tutte le action di `release.yml` passano alla major che gira su Node.js 24: sparisce l'avviso di deprecazione di Node.js 20.

## [1.2.3] - 2026-10-31

Solo la pipeline di rilascio.

### Rilascio

- **macOS:** la build gira su `macos-15`, dopo il fermo programmato del runner `macos-14`.
- **Windows arm64:** l'installer non viene più prodotto. Restano macOS universale, Windows amd64 e Linux amd64.

## [1.2.2] - 2026-10-31

Un solo workflow, che costruisce e pubblica.

### Rilascio

- `release.yml`, su un tag, pubblica l'immagine multi-arch del cloud e il chart Helm su GHCR, costruisce gli installer desktop e crea la GitHub Release con `SHA256SUMS`. Non firma nulla: niente cosign, SBOM, attestazioni né manifest di aggiornamento, e l'updater resta compilato fuori dai binari.
- Rimossi `ci.yml` e `security.yml`: lint, test e scansioni si eseguono in locale con `task ci` (poi ADR-0036).

## [1.2.1] - 2026-10-31

Correzioni della pipeline di rilascio dopo il cambio del nome del prodotto.

### Rilascio

- Nome dei file degli installer e ricerca del bundle dell'app corretti dopo il cambio del nome del prodotto in `wails.json` (installer NSIS, `.dmg`, script di avvio).
- Allineamenti per la verifica: due test con errori di tipo, la specifica OpenAPI incorporata nel binario rigenerata, il controllo del codice generato esteso ai pacchetti sqlc di ogni modulo.

## [1.2.0] - 2026-10-30

Correzioni di affidabilità nel cloud e nella sync, ricerca più pertinente, footnote inline, template per le nuove note e import di Google Keep in HTML. Dentro, il cloud separa l'accesso ai dati per modulo.

### Cloud

- **Stream e download lunghi non si interrompono più:** il timeout di 60 s vale solo per le operazioni JSON; lo stream degli eventi, gli upload ripristinabili, i blob e gli export ZIP non hanno più un limite di tempo.
- **Limite di richieste per IP effettivo:** prima ogni connessione aveva un contatore nuovo. Dietro un reverse proxy va impostato `TRUSTED_PROXIES` (guida admin, «Rete e processo»). I probe di salute sono esenti.
- **Corpo delle richieste JSON** al massimo 8 MiB (`413 FILE_TOO_LARGE`).
- **Nessun blob perso dalla pulizia:** un commit che referenzia un blob mentre la pulizia lo sta cancellando non lascia più un riferimento a un oggetto inesistente.
- **Manutenzione notturna:** un passo che fallisce non blocca più gli altri (purge, riconciliazione delle quote, snapshot).
- **Accesso ai dati per modulo** (ADR-0033): ogni modulo ha le proprie query e non tocca le tabelle degli altri, salvo eccezioni dichiarate e verificate da un test.

### Client desktop e workbench web

- **Vault privati:** blocco automatico dopo un periodo di inattività, in Impostazioni › Sync › Cifratura, anche impostabile dall'amministratore (`security.vault_lock_minutes`). Default: mai, come prima.
- **Nessuna perdita locale nella sync:** prima che un merge sostituisca testo non ancora sincronizzato, una copia va nella cronologia locale (File recovery).
- **File troppo grandi:** sono esclusi dalla sync prima di essere letti e cifrati, e non bloccano più l'invio degli altri file.
- **Login:** se Keycloak rifiuta il redirect locale, l'app passa da sola a `memobrain://`; l'amministratore può imporre la modalità dal profilo (`auth.redirect_mode`).
- **Ricerca:** risultati ordinati per pertinenza (BM25, con peso maggiore per il titolo) e parole trovate evidenziate nell'anteprima, centrata sulla corrispondenza nelle righe lunghe.
- **Footnote inline** `^[…]` nella vista di lettura e nell'export HTML, numerate insieme alle `[^x]`.
- **Template per ogni nuova nota**, in Impostazioni › Note giornaliere e template.
- **Import di Google Keep anche dalle pagine HTML** di Takeout, quando manca il JSON.
- **Disegni:** i font di Excalidraw (compreso quello per il cinese, il giapponese e il coreano) arrivano sempre dall'app; prima il font CJK veniva cercato su un CDN esterno e non si caricava.

### Documentazione

- Proposta di aggiornamento delle specifiche alla v1.2 (`docs/spec-v1.2-proposta.md`).
- Nuovi ADR in stato di proposta: involucri della chiave dei vault legati al vault (ADR-0034) e barra di stato opzionale (ADR-0035).

### Limiti noti

- Valgono quelli della 1.1.0: installer non firmati, nessun aggiornamento automatico, nessun installer Linux arm64, pacchetti GHCR privati.
- **Limite di dimensione dei file:** il client usa quello del profilo di configurazione (default 100 MB). Se l'amministratore alza solo `files.max_size_bytes` del server, va alzato anche `sync.max_file_size_bytes` del profilo.
- **Footnote inline:** in Live Preview restano testo.
- **Keep HTML:** porta solo la data di modifica, non quella di creazione.

## [1.1.0] - 2026-10-30

Il vault si apre e si modifica anche dalla Web UI del cloud, e il rilascio dei tre installer desktop e dell'immagine del cloud è automatico.

### Workbench web (ADR-0029, ADR-0030)

- **Stessa interfaccia del client desktop nel browser**, alla rotta `/vaults/<id>/open` della console: editor, ricerca, link, grafo, canvas, disegni, Bases, cronologia, presentazioni. Il core Go del desktop gira compilato in WebAssembly in un Web Worker, con i file in OPFS e l'indice SQLite (FTS5) in sqlite-wasm: stesso codice, stesso comportamento, stesso merge sul client.
- Il browser è un dispositivo (`web`) come gli altri: sincronizza con le stesse API, anche per i vault privati cifrati.
- Il blocco per inattività e «Dimentica questo browser» (anche all'uscita) cancellano le copie in chiaro e i database del browser.
- Interruttore `web_workbench` nei profili di configurazione (acceso di default); CSP e SRI dedicati per la pagina del workbench.
- Il frontend del desktop è il pacchetto condiviso `@memobrain/workbench`.

### Rilascio

- Una sola pipeline per tag (`release.yml`): installer macOS (universale), Windows (amd64 e arm64) e Linux (amd64, `.deb` e AppImage), immagine multi-arch del cloud (amd64 e arm64, Web UI e workbench inclusi) su GHCR firmata con cosign, chart Helm come artefatto OCI firmato, una GitHub Release con i checksum.
- La CI (`ci.yml`) costruisce l'app desktop sui tre sistemi e l'immagine a ogni pull request e push su `main`.

### Limiti noti

- **Gli installer non sono firmati** (nessun certificato Apple Developer ID né Authenticode): Gatekeeper e SmartScreen avvisano al primo avvio. Verificare il download con `SHA256SUMS`. L'aggiornamento automatico è disattivato in queste build: l'aggiornamento è manuale.
- Nessun installer Linux arm64 (serve un runner arm64, vedi `docs/release/secrets.md`).
- I pacchetti GHCR (immagine e chart) sono privati finché non si rendono pubblici dalle impostazioni del pacchetto.
- Non verificati: vault privato nel browser, desktop nativo contro web sullo stesso cloud, copie di conflitto `.canvas` ed `.excalidraw` dal browser, Safari e Firefox, indicizzazione di vault molto grandi. Elenco in `docs/web-workbench-parity.md`.
- La CI non esegue più i test end-to-end, di integrazione e del core WASM: restano da lanciare a mano (`make e2e`, `make test-integration`, `make test-wasm`).

## [1.0.0] - 2026-10-28

Tutto ciò che c'è nella `1.0.0-rc.1` (sotto) più i disegni completi e il nuovo build del client desktop.

### Disegni (parità con i plugin Excalidraw ed Excalidraw Extras di terze parti, ADR-0024)

- **Embed e link**: parti di un disegno (`#frame=`, `#clippedframe=`, `#group=`, `#area=`), allineamento, apertura dei link degli elementi, anteprima al passaggio, link riscritti alla rinomina delle note, immagini, note (come schede) e altri disegni inseribili anche trascinando dal vault.
- **Esportazione**: PNG/SVG per tutto, selezione o cornice con scala, margine, tema e scena incorporata; salvataggio con nome, PDF, esportazione automatica per vault o per singolo disegno.
- **Extras**: formule LaTeX (MathJax) e diagrammi Mermaid, offline.
- **Azioni native** (al posto degli script utente, V-02/D-01): distribuzione, Auto Layout, colore e stile, schemi di colori, forme e Boolean Operations, frecce, testo, mappa mentale, calendari, vignette, linea organica; pannello Strumenti con ricerca, preferiti e recenti.
- **Presentazione** a diapositive (cornici) con note del relatore, puntatore laser e penne; **Descrivi il disegno come testo** per chi non vede la lavagna.
- **Import**: `.excalidraw.md` del plugin Excalidraw di terze parti e librerie `.excalidrawlib`.
- **Amministrazione**: sotto-flag `drawing_latex`, `drawing_mermaid`, `drawing_auto_export` e `drawing_actions` nei profili di configurazione.
- Accessibilità: l'interfaccia dei disegni (barra, esportazione, pannello Strumenti, presentazione) è nelle scansioni axe; il dialogo di esportazione ora ha il focus e si chiude con Esc.

### Client desktop

- Build e server di sviluppo con **esbuild** al posto di Vite (ADR-0025): niente source map nel binario, budget di dimensione del bundle verificato dal build, `katex` unico, e un controllo end-to-end sul bundle di produzione (`make e2e-desktop-prod`). In sviluppo la pagina si ricarica per intero (niente HMR).

### Limiti noti (in più rispetto alla rc.1)

- Azioni non implementate rispetto al plugin di terze parti: Icon Library, Image Occlusion, LayerManager, Crop Vintage Mask, Capture Note, Folder Note, "Fixed inner distance"; escluse Collaboration Frame (D-04), Scribble Helper e Hardware Eraser (penna), ExcaliAI e OCR (rete). Elenco completo in `docs/qa/parita-funzionale-m1.md`.
- I buchi delle Boolean Operations lasciano una sottile asola con il tratto; le schede-nota si aggiornano solo su richiesta.
- Lo stack Docker Compose importa ora un realm di produzione (`deploy/keycloak-prod/`, senza utenti di prova, con il secret di servizio e l'origine della Web UI presi dall'ambiente); il realm di sviluppo (`deploy/keycloak/`) resta solo per `make stack-up` e k3d. Con Helm il Keycloak è esterno e va configurato dall'amministratore.
- Non cablati (rinviati): applicare un template a ogni nuova nota (ADR-0015) e l'hook `pre-sync-overwrite`.

## [1.0.0-rc.1] - non rilasciata

Candidata al rilascio 1.0: tutte le funzioni P0 e P1 del piano sono implementate. Resta da eseguire la checklist di `docs/release/v1.0.0-checklist.md` (firma degli installer, test manuale su macOS, Windows e Linux, test con screen reader, audit esterni).

### Cosa c'è

- **Editor e vault**: note Markdown in file ordinari, apribili anche da altri editor (Live Preview, Sorgente, Lettura), link e backlink, properties, tag, ricerca full-text, disegni Excalidraw, canvas, Bases, vista grafo, template, note giornaliere e uniche, composer, segnalibri, workspace, anteprima di pagina, blocchi `query`, esportazione HTML e PDF, importer (Markdown/HTML, Evernote, Notion, Roam, Bear, Google Keep, CSV).
- **Sincronizzazione e cloud**: sync con merge sul client, vault cifrati end-to-end (privati) e vault condivisi, condivisione con utenti e gruppi, permessi, profili di configurazione distribuiti, quote, cronologia delle revisioni, recupero file locale.
- **Amministrazione**: console web (utenti allineati a Keycloak, gruppi, profili con cronologia, limiti, cruscotto storage, audit con CSV), esportazione ZIP (anche dei vault privati, decifrati nel browser), area account con esportazione dei propri dati e cancellazione (GDPR).
- **Distribuzione**: aggiornamenti firmati (ed25519) con rifiuto di downgrade e replay, installer per macOS, Windows e Linux, chart Helm con HPA, PDB e ingress gRPC, compose per installazioni on-premise.

### Prestazioni (misurate su un Mac M4, vedi `docs/perf/README.md`)

- Indicizzazione di un vault da 50.000 note in circa 73 s (obiettivo: 3 minuti).
- Ricerca a 50.000 note: 27–143 ms mediana; **una ricerca con espressione regolare sull'intero vault resta a 461 ms** (obiettivo 200 ms: non raggiunto).
- Albero file virtualizzato: 37 nodi DOM invece di 50.000 a 50.000 note.

### Sicurezza e affidabilità

- Vettori di test negativi per la cifratura, uguali in Go e TypeScript; CSP e SRI verificati da test; intestazioni di sicurezza su tutte le risposte dell'API; `/metrics` non raggiungibile tramite ingress.
- Scansione `govulncheck` senza vulnerabilità raggiungibili (toolchain Go 1.27.3) e `yarn npm audit` senza avvisi di gravità alta.
- Spegnimento ordinato con drain (`SHUTDOWN_DRAIN`), scritture atomiche a prova di crash, ripresa degli upload, convergenza dopo perdita di rete, ripristino point-in-time provato (`docs/runbook/backup-restore.md`).
- **Cambiamento di comportamento**: un cursore di sync più avanti del server (dopo un ripristino a un istante passato) risponde ora `410 CURSOR_EXPIRED` e il client riparte dal manifest, invece di saltare in silenzio i nuovi commit.

### Limiti noti

- Disponibilità misurata solo su un cluster di prova (100 % escludendo un crash di PostgreSQL con un solo pod; 99,83 % complessivo): non dimostra il 99,9 % mensile.
- Nessun audit crittografico né pen test eseguito: i pacchetti per i revisori sono in `docs/security/`.
- Accessibilità: scansioni axe pulite sulle schermate coperte, ma nessun test con screen reader reale; grafo e canvas non hanno alternativa testuale (i disegni sì: «Descrivi il disegno come testo»).
- Importer: Google Keep in HTML e Apple Notes non supportati; provato solo con file di esempio, non con export reali.
- Aggiornamento automatico: l'applicazione degli aggiornamenti è provata solo con processi simulati.
- Prodotto rinominato in "MemoBrain Notes" (identificatori `memobrain`), senza migrazioni: nessuna installazione precedente.
