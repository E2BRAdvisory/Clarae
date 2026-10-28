# Changelog

Le note di rilascio di ogni versione sono la sezione `## [X.Y.Z]` di questo file: il workflow di release le allega alla release (`scripts/release/notes.sh`).

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
