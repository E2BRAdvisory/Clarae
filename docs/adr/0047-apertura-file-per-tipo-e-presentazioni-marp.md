# ADR-0047 — Apertura dei file per tipo e presentazioni Marp (`.marp`)

|                       |                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stato**             | accettata                                                                                                                                                                                                                                                                                              |
| **Data**              | 2026-11-03                                                                                                                                                                                                                                                                                             |
| **Riferimenti spec**  | §2.2.1 (matrice funzioni), §2.3 (editor e rendering), §3.4.5 (strategia per tipo di file), §3.4.6 (scope di sync); V-02/D-01, D-04, V-07; ADR-0020, ADR-0027, ADR-0029, ADR-0030, ADR-0045                                                                                                             |
| **Devia dallo spec?** | sì (§3.4.5: `.marp` entra nella riga «Markdown»; §3.4.6: `.marp` nel contenuto sincronizzato; §2.2.1: nuove righe «Apertura file per tipo» e «Presentazioni Marp»; supera in parte ADR-0027, alternativa «file di slide dedicati») → richiede aggiornamento di `Specifications.md` da parte dell'owner |
| **Superfici**         | desktop (binding, host Wails, comandi) · workbench web (core WASM, download, comandi) · cloud: nessuna modifica (il server non interpreta il contenuto né il tipo) · console: nessuna                                                                                                                  |

## Contesto

Il file explorer mostra già ogni file del vault: l'unico filtro è sulle dot-cartelle (`.memobrain`, `.trash`, `.git`), che restano nascoste perché stato interno. Ma un file di tipo sconosciuto (`.zip`, `.docx`, `.pptx`, …) apre una tab con il solo segnaposto «embed-other»: non c'è modo di aprirlo con l'applicazione del sistema operativo, né di scaricarlo dal workbench web.

In parallelo si vogliono presentazioni [Marp](https://marp.app/) (Markdown con direttive, temi e rendering a slide 16:9), create e modificate nell'app con editor e anteprima affiancati ed esportabili. ADR-0027 ha già introdotto le slide di una nota `.md` (pipeline reading, chiavi `slide-*`) e aveva scartato i file di slide dedicati per compatibilità Obsidian e merge a 3 vie. Marp è però un formato diverso (direttive, temi, `paginate`, sfondi `![bg]`) che la pipeline reading non riproduce; tenerlo in un'estensione propria evita che le note `.md` cambino aspetto a seconda del frontmatter e separa nettamente le due funzioni.

Vincoli: nessun CSS personalizzato e HTML sanificato (V-02/D-01), funzionamento offline, CSP con `frame-src 'none'` e senza `unsafe-eval` (desktop e web), finestra singola (V-07), parità desktop/web per costruzione (ADR-0045), budget dei bundle (ADR-0020).

## Decisione

### 1. Apertura dei file per tipo

Un unico gestore (`openFile` in `packages/workbench/src/app/openFile.ts`) decide in base all'estensione, ed è agganciato a `openNote` dello store, così ogni punto d'ingresso (explorer, quick switcher, ricerca, link) lo attraversa:

| Tipo                                                                    | Desktop                                      | Workbench web                                                                                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Note `.md`, `.canvas`, `.base`, `.excalidraw`, `.marp`                  | Vista interna                                | Vista interna                                                                                                                       |
| Immagini (`png jpg jpeg gif svg webp bmp avif`), `pdf`, audio e video   | Viewer interno esistente                     | Viewer interno esistente                                                                                                            |
| Qualsiasi altro tipo, anche senza estensione                            | Applicazione predefinita del SO; nessuna tab | Dialog «Apertura File» — «Il file `<nome>` non può essere visualizzato direttamente. Desideri scaricarlo?» — `Annulla` / `Download` |
| Eseguibili (`exe bat cmd com msi ps1 sh command app scr jar vbs lnk …`) | Mai aperti: avviso e «Mostra nella cartella» | Come gli altri tipi (download)                                                                                                      |

- Nuova capability `openWithSystemApp` (desktop sì, browser no) e due metodi `Host` che essa governa: `OpenPath` e `RevealPath`, implementati sul desktop con i comandi del SO (`open`/`open -R`, `xdg-open`, `rundll32 url.dll,FileProtocolHandler`/`explorer /select,`).
- Nuovi binding `VaultAPI.OpenWithSystemApp`, `VaultAPI.RevealInFolder` (path risolto con `FS.Resolve`, traversal rifiutato, eseguibili rifiutati anche lato Go) e `VaultAPI.DownloadFile` (`Host.SaveFile` + copia in streaming + `Host.Delivered`: nel browser è il download, sul desktop «Salva una copia…»; nessun limite di `ReadBinary`).
- Le tab di tipo sconosciuto già salvate in `workspace.json` mostrano il segnaposto con il pulsante «Apri con l'app predefinita» o «Scarica».

### 2. Il file `.marp`

- Estensione `.marp`, contenuto Markdown di Marp (frontmatter con `marp: true`). Il core Go lo classifica come markdown: `syncproto.KindOf(".marp") = KindMarkdown`. Ne seguono merge a 3 vie (anche tra utenti diversi, D-04), indice FTS, link e backlink, senza nuovi tipi nel protocollo.
- Il server non cambia: il tipo è calcolato dal client. Un client di versione precedente classifica `.marp` come `other` e, in caso di conflitto, produce una _conflict copy_: nessuna perdita di dati.
- Nessun nuovo parser condiviso: l'indice usa il parser markdown esistente; il rendering a slide è solo nel frontend.

### 3. Rendering Marp entro V-02

- Libreria `@marp-team/marp-core` a versione esatta, in un chunk lazy (come Canvas ed Excalidraw).
- Solo i temi integrati (`default`, `gaia`, `uncover`): niente temi esterni né `@theme` personalizzati.
- Disattivati tutti i canali di CSS dell'autore: `html: false`, `inlineStyle: false`, chiave `style:` del frontmatter e commenti `<!-- style: … -->` rimossi prima del rendering. Le direttive del formato (`theme`, `paginate`, `header`, `footer`, `class`, `backgroundColor`, `color`, `backgroundImage`, `![bg]`) sono ammesse: generano stili da Marp, non CSS scritto dall'utente.
- Uscita sanificata: DOMPurify dedicato (ammette `svg`/`foreignObject`/`section` e l'attributo `style` generato, scartando `url()` che non siano `data:` o `blob:`); CSS del tema privato di `@import` e `url()` remoti, sul modello di `sanitizeSvg` per Mermaid.
- Isolamento in Shadow DOM (un iframe è escluso da `frame-src 'none'`): il CSS del tema non tocca l'interfaccia.
- Offline: emoji come caratteri nativi (niente twemoji da CDN), matematica MathJax in SVG, font dei temi che usavano Google Fonts sostituiti dai font di sistema. Un test e2e verifica zero richieste di rete, come per Excalidraw.

### 4. Vista, creazione e presentazione

- Vista divisa: editor CodeMirror in modalità Source a sinistra, anteprima delle slide a destra aggiornata in tempo reale (debounce ~150 ms) e allineata alla slide del cursore.
- Comando `marp:new` (template con `marp: true`, `theme: default`, `paginate: true` e due slide), presente anche nel menu dell'explorer e nella ribbon. Presentazione a tutto schermo nella stessa finestra, come ADR-0027.
- Funzione governata dal feature flag `presentations` del Config Profile.

### 5. Export

- **HTML**: documento autonomo senza script (slide SVG impilate e responsive, immagini inline `data:`), che passa `checkStandaloneHTML`.
- **PDF**: stampa del documento con `@page { size: 1280px 720px; margin: 0 }` e una slide per pagina; si salva in PDF dal dialog di stampa, come l'export delle note.
- **PPTX**: rinviato. Marp CLI lo produce con un Chromium headless, assente sia nella webview Wails sia nel browser; il comando `marp:export-pptx` è nel registro ma disabilitato, con l'indicazione «Non ancora disponibile».

## Alternative considerate

- **`.md` con `marp: true` nel frontmatter** (convenzione di Marp, compatibile con Obsidian) — scartata per scelta di prodotto: una nota cambierebbe vista e aspetto a seconda di una chiave, e si sovrapporrebbe alle slide di ADR-0027. Resta un'estensione possibile in futuro.
- **`.marp` come file opaco (`other`)** — scartata: niente merge a 3 vie (solo copie di conflitto), niente ricerca né link.
- **Anteprima in iframe con `srcdoc`** — scartata: `frame-src 'none'` nella CSP di desktop e web.
- **PPTX rasterizzato in JS (pptxgenjs, una immagine per slide)** — rinviata: dipendenze pesanti e testo non modificabile; da rivalutare se richiesto.
- **Mostrare anche le dot-cartelle nell'explorer** — scartata: espone `.memobrain/` (stato interno, in parte non sincronizzato) e `.git`.
- **Aprire gli eseguibili come gli altri file** — scartata: un click su un file arrivato con la sync di un vault condiviso eseguirebbe codice di altri.

## Conseguenze

- Spec da aggiornare (owner): §3.4.5 riga «Markdown `.md`» → «Markdown `.md`, `.marp`»; §3.4.6 contenuto sincronizzato con `.marp`; §2.2.1 nuove righe; nota in ADR-0027 che i file `.marp` sono una funzione distinta dalle slide delle note.
- Vault Obsidian: i `.marp` appaiono in Obsidian solo con l'opzione «Detect all file extensions» e senza anteprima; gli altri strumenti Marp (VS Code, CLI) li leggono rinominandoli `.md`.
- La parità è registrata in `shared/parity/features.yaml` con le voci `files.open-by-type` e `presentations.marp`.
- Nuova dipendenza da tenere aggiornata e dentro i budget dei bundle; i temi di Marp sono la sola eccezione, limitata e sanificata, al divieto di CSS di terzi.
- Debito accettato: export PPTX assente; da rivedere quando sarà disponibile un renderer senza Chromium o su richiesta esplicita.
