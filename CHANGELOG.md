# Changelog

Le note di rilascio di ogni versione sono la sezione `## [X.Y.Z]` di questo file: il workflow di release le allega alla release (`scripts/release/notes.sh`).

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

### Disegni (parità con i plugin Obsidian Excalidraw ed Excalidraw Extras, ADR-0024)

- **Embed e link**: parti di un disegno (`#frame=`, `#clippedframe=`, `#group=`, `#area=`), allineamento, apertura dei link degli elementi, anteprima al passaggio, link riscritti alla rinomina delle note, immagini, note (come schede) e altri disegni inseribili anche trascinando dal vault.
- **Esportazione**: PNG/SVG per tutto, selezione o cornice con scala, margine, tema e scena incorporata; salvataggio con nome, PDF, esportazione automatica per vault o per singolo disegno.
- **Extras**: formule LaTeX (MathJax) e diagrammi Mermaid, offline.
- **Azioni native** (al posto degli script utente, V-02/D-01): distribuzione, Auto Layout, colore e stile, schemi di colori, forme e Boolean Operations, frecce, testo, mappa mentale, calendari, vignette, linea organica; pannello Strumenti con ricerca, preferiti e recenti.
- **Presentazione** a diapositive (cornici) con note del relatore, puntatore laser e penne; **Descrivi il disegno come testo** per chi non vede la lavagna.
- **Import**: `.excalidraw.md` di Obsidian e librerie `.excalidrawlib`.
- **Amministrazione**: sotto-flag `drawing_latex`, `drawing_mermaid`, `drawing_auto_export` e `drawing_actions` nei profili di configurazione.
- Accessibilità: l'interfaccia dei disegni (barra, esportazione, pannello Strumenti, presentazione) è nelle scansioni axe; il dialogo di esportazione ora ha il focus e si chiude con Esc.

### Client desktop

- Build e server di sviluppo con **esbuild** al posto di Vite (ADR-0025): niente source map nel binario, budget di dimensione del bundle verificato dal build, `katex` unico, e un controllo end-to-end sul bundle di produzione (`make e2e-desktop-prod`). In sviluppo la pagina si ricarica per intero (niente HMR).

### Limiti noti (in più rispetto alla rc.1)

- Azioni non implementate rispetto al plugin Obsidian: Icon Library, Image Occlusion, LayerManager, Crop Vintage Mask, Capture Note, Folder Note, "Fixed inner distance"; escluse Collaboration Frame (D-04), Scribble Helper e Hardware Eraser (penna), ExcaliAI e OCR (rete). Elenco completo in `docs/qa/obsidian-parity.md`.
- I buchi delle Boolean Operations lasciano una sottile asola con il tratto; le schede-nota si aggiornano solo su richiesta.
- Lo stack Docker Compose importa ora un realm di produzione (`deploy/keycloak-prod/`, senza utenti di prova, con il secret di servizio e l'origine della Web UI presi dall'ambiente); il realm di sviluppo (`deploy/keycloak/`) resta solo per `make stack-up` e k3d. Con Helm il Keycloak è esterno e va configurato dall'amministratore.
- Non cablati (rinviati): applicare un template a ogni nuova nota (ADR-0015) e l'hook `pre-sync-overwrite`.

## [1.0.0-rc.1] - non rilasciata

Candidata al rilascio 1.0: tutte le funzioni P0 e P1 del piano sono implementate. Resta da eseguire la checklist di `docs/release/v1.0.0-checklist.md` (firma degli installer, test manuale su macOS, Windows e Linux, test con screen reader, audit esterni).

### Cosa c'è

- **Editor e vault**: note Markdown compatibili con Obsidian (Live Preview, Sorgente, Lettura), link e backlink, properties, tag, ricerca full-text, disegni Excalidraw, canvas, Bases, vista grafo, template, note giornaliere e uniche, composer, segnalibri, workspace, anteprima di pagina, blocchi `query`, esportazione HTML e PDF, importer (Markdown/HTML, Evernote, Notion, Roam, Bear, Google Keep, CSV).
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
