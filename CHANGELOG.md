# Changelog

Le note di rilascio di ogni versione sono la sezione `## [X.Y.Z]` di questo file: il workflow di release le allega alla release (`scripts/release/notes.sh`).

Nelle sezioni fino alla 1.1.0 i comandi sono citati come `make <target>`: da prima della 1.2.0 il task runner è [Task](https://taskfile.dev) (ADR-0032) e gli stessi target si eseguono con `task <target>`, per esempio `task e2e`, `task e2e-desktop-prod`, `task test-integration`, `task test-wasm`, `task stack-up`.

## [Unreleased]

Il client desktop passa a Wails v3 (milestone M15, [roadmap](docs/roadmap.md) §13-octies, ADR-0051) e la modalità Live diventa l'editor WYSIWYG Milkdown (milestone M16, §13-nonies, ADR-0049, accettato il 2026-11-12 per decisione del proprietario). Gli ADR 0049, 0050 e 0051 non sono ancora recepiti in `Specifications.md`, che il proprietario deve aggiornare (V-07, A-03, D-07, §2.3, §2.6.6, §3.4.2, §4.2, §4.5); gli ADR 0050 e 0051 sono ancora in stato proposta. **Il nuovo Live non è stato provato a mano su WebView reali** (composizione con IME, correzione ortografica, lettori di schermo su WKWebView, WebView2 e WebKitGTK): il proprietario ha deciso di renderlo il predefinito senza attendere quelle prove, che restano da fare. L'assistente AI e la collaborazione in tempo reale **non sono ancora offerti**: sono nel codice dietro interruttori di build spenti. Il protocollo di sync, le API e le migrazioni del cloud non cambiano.

### Compatibilità

- **Go 1.27.4:** desktop, cloud e strumenti si compilano con Go 1.27.4 (prima 1.27.3) per GO-2026-6859, vulnerabilità di `net/http` segnalata da `govulncheck` (ADR-0006). Le immagini Docker del cloud usano `golang:1.27.4-alpine3.24`; chi compila dai sorgenti ha bisogno di Go 1.27.4, che con `GOTOOLCHAIN=auto` viene scaricato.
- **macOS 13 o successivo:** l'app desktop richiede macOS 13 (prima l'`Info.plist` dichiarava 10.13). Il linker di Go 1.27 compila per macOS 13: la 1.3.4 dichiarava 10.13 su Intel e 11.0 su Apple Silicon, ma non era stata provata sotto macOS 13. Su macOS 12 o precedente il Finder rifiuta l'app. **Chi usa macOS 12 o precedente non può installare la 1.3.5** (serve macOS 13, `LSMinimumSystemVersion` `13.0.0`) e resta sulla 1.3.4 finché non aggiorna il sistema.
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
