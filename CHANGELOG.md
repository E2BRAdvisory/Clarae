# Changelog

Le note di rilascio di ogni versione sono la sezione `## [X.Y.Z]` di questo file: il workflow di release le allega alla release (`scripts/release/notes.sh`).

Nelle sezioni fino alla 1.1.0 i comandi sono citati come `make <target>`: da prima della 1.2.0 il task runner è [Task](https://taskfile.dev) (ADR-0032) e gli stessi target si eseguono con `task <target>`, per esempio `task e2e`, `task e2e-desktop-prod`, `task test-integration`, `task test-wasm`, `task stack-up`.

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
