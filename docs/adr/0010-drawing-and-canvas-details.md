# ADR-0010 — Dettagli implementativi di disegni e canvas (M3)

|                       |                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| **Stato**             | accettata                                                                                           |
| **Recepito in**       | `Specifications.md` v1.4 (2026-11-02): §2.2.1, §2.4, §2.7.1, §2.7.2, §2.7.3, §3.4.6 (Appendice C.4) |
| **Data**              | 2026-10-24                                                                                          |
| **Riferimenti spec**  | §2.2.1 (matrice funzioni), V-02/D-01, D-04, piano M3-WP1…WP4                                        |
| **Devia dallo spec?** | sì, in modo puntuale (editor testo dei canvas, export, anteprime)                                   |

**Aggiornamento 2026-11-02.** La versione `@excalidraw/excalidraw@0.18.1` è superata da ADR-0028 (alias `npm:@zsviczian/excalidraw@0.18.145`), e la rinomina riscrive ora anche i link dentro i disegni (ADR-0024, decisione 6); le regole offline restano quelle di questo ADR.

## Contesto

M3 porta in MemoBrain Notes i disegni Excalidraw (`.excalidraw`, JSON) e i canvas (`.canvas`, JSON Canvas 1.0), entrambi sincronizzati con la strategia per id già presente in `shared/go/merge`. Alcune scelte non erano fissate dal piano.

## Decisioni

1. **Excalidraw 0.18.1, caricato in lazy.** `@excalidraw/excalidraw` è un chunk separato (`React.lazy` + `import()`), mai caricato all'avvio. Gli asset (font, 13 MB) sono serviti dall'app stessa (`/excalidraw-assets/`: middleware in `vite dev`, copia in `dist/` in `vite build`) e `window.EXCALIDRAW_ASSET_PATH` li indica prima del caricamento: nessuna richiesta di rete. Il gate è un test Playwright che fallisce a qualsiasi richiesta fuori dall'origine dell'app.
2. **Tipi di `@excalidraw/utils`.** Il pacchetto non pubblica i tipi di `@excalidraw/utils/export`; `tsconfig.app.json` li mappa su `dist/types/utils/*` dentro `@excalidraw/excalidraw`, altrimenti `exportToSvg`/`exportToBlob` risultano non tipizzati.
3. **Autosave 2 s dei disegni, 1 s dei canvas**, con lo stesso hook dei documenti (`useNoteDocument`, hash atteso e banner di conflitto). `onChange` di Excalidraw scatta anche per selezione e scroll: si salva solo se cambia la firma (id e versione degli elementi, numero di file).
4. **Esportazione nel vault, non su disco.** Il webview Wails non garantisce il download via `<a download>` né l'API File System Access. PNG (1×–3×, con o senza sfondo) e SVG vengono salvati accanto al disegno con `SaveAttachment`; "copia" usa `exportToClipboard`. Si può aggiungere un binding con finestra di salvataggio nativa in seguito.
5. **Anteprime SVG come `<img>` con URL blob.** L'SVG generato da `exportToSvg` è messo in cache per hash del contenuto (`.memobrain/cache/drawings/<hash>.svg`, mai sincronizzato) tramite `DrawingAPI`. Un'immagine non esegue script né carica risorse e mantiene font e stili incorporati, cosa che la sanificazione DOMPurify dell'SVG inline eliminerebbe. `SavePreview` valida hash (64 esadecimali, niente path), dimensione (4 MB) e contenuto (`<svg`, niente `<script`).
6. **Libreria Excalidraw nel vault** (`.memobrain/excalidraw-library.json`, aggiunto all'elenco dei file di configurazione ammessi): segue la sync dei file di impostazioni.
7. **Indicizzazione.** `internal/drawing` e `internal/canvas` validano i file ed estraggono testo (FTS) e link (`[[…]]` sugli elementi/nel testo; i nodi file del canvas sono embed). Un file non valido resta elencato e cercabile per nome, con un avviso nel log. I link dei disegni e dei canvas alimentano backlink e grafo; il pannello Backlink li etichetta "Disegno: X" / "Lavagna: X" senza numero di riga. La **rinomina con aggiornamento link riscrive solo le note `.md`**: i link dentro disegni e canvas non vengono riscritti (limite noto).
8. **Canvas: editor testuale semplice.** Il piano prevede un mini editor CM6 per i nodi di testo; l'implementazione usa una `<textarea>` in modifica e il Markdown renderizzato (stessa pipeline sanificata del reading view, con math ed embed) a riposo. È un compromesso di dimensione/rischio: CM6 richiederebbe il contesto Live Preview per ogni nodo. Sostituibile senza toccare il formato.
9. **Canvas: embed statico da dati.** `![[mappa.canvas]]` si renderizza come SVG disegnato dai soli dati (`canvasSvg`, senza misure DOM), mostrato in `<img>`; doppio clic apre l'editor.
10. **Merge.** Nessuna modifica a `shared/go/merge`: le strategie `excalidraw-by-id` e `canvas-by-id` erano già attive in `sync/resolve.go`; M3-WP4 aggiunge i test e2e a due dispositivi (parti diverse convergono, versione più alta vince, un elemento cancellato resta cancellato, stesso nodo su entrambi i lati → copia di conflitto, nessuna perdita).

## Conseguenze

- Nuova dipendenza `@excalidraw/excalidraw@0.18.1` (MIT).
- Nuovo binding `DrawingAPI` (`ReadPreview`, `SavePreview`), nuovi pacchetti Go `internal/drawing` e `internal/canvas`, nuove directory frontend `drawing/` e `canvas/`.
- Checklist manuale sul webview reale: `docs/qa/m3-drawings-canvas.md`.
