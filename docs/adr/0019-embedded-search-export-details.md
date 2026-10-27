# ADR-0019 — Embedded search, export PDF/HTML e impostazioni residue (M6-WP6)

|                       |                                                                            |
| --------------------- | -------------------------------------------------------------------------- |
| **Stato**             | proposta                                                                   |
| **Data**              | 2026-10-24                                                                 |
| **Riferimenti spec**  | matrice §2.2.1 (Embedded search, Export P1), §2.6 impostazioni; D-01, D-06 |
| **Devia dallo spec?** | no                                                                         |

## Contesto

M6-WP6 chiude le righe P1 "Embedded search (code block `query`)", "Export PDF/HTML autonomo" e le impostazioni rimaste fuori da M1.

## Decisione

**Blocco `query`.** Il corpo usa la stessa sintassi del pannello di ricerca (§2.4). Righe opzionali riconosciute dalla sola chiave: `sort: relevance|name|modified`, `limit: N` (tetto rigido, max 500), `view: list|cards`, `context: on|off` (riga di contesto con evidenziazione), `self: include|exclude`. Le altre righe formano la query. Senza `limit` i risultati sono a pagine da 100 con "mostra altri". Usa il binding `SearchAPI.Query` esistente (nessun Go nuovo) tramite `QueryObserver` sul `queryClient` condiviso: la chiave inizia con `['search', vaultId]`, quindi si aggiorna con le stesse invalidazioni del pannello. Errori di query inline (`role=alert`). La nota ospitante è esclusa di default (impostazione `queryIncludeHost`, override `self:`); l'esclusione è lato client, quindi con `limit` si richiede un risultato in più. Live Preview: widget di blocco (sorgente visibile con il cursore dentro); Reading: `hydrate`.

**Export.** Un solo renderer (`export/render.ts`) parte dal reading view e rende il documento indipendente: immagini/disegni/canvas come data URI (tetto 8 MB per file, 48 MB totali; oltre, esclusi e segnalati), note incorporate in linea, math come MathML, Mermaid come SVG in tema chiaro, HTML ri-sanificato con DOMPurify. Scelta sui link: i wikilink diventano testo semplice, salvo i link a un'intestazione/blocco della stessa nota (ancore interne); link http(s)/mailto restano link. Audio, video, PDF e immagini remote sono omessi e segnalati. I blocchi `query` restano come codice.

- **HTML**: `ExportAPI.SaveHTML` (Go) mostra il dialogo nativo, scrive in modo atomico (tmp + rename) e rifiuta destinazioni dentro il vault (anche i vault in sola lettura sono esportabili, mai modificati). Il Go rifiuta script, handler, iframe e risorse remote come seconda barriera; il file ha CSP `default-src 'none'` e `prefers-color-scheme`.
- **PDF**: layer di stampa chiaro (`#memobrain-print`, sempre tema chiaro, UI nascosta in `@media print`) e `ExportAPI.Print` → `runtime.WindowPrint` (Wails 2.12: macOS `NSPrintOperation`, Windows/Linux `window.print()`); il PDF si ottiene con "Salva come PDF" del dialogo di sistema. Wails v2 non offre print-to-PDF senza dialogo.

**Impostazioni aggiunte** (`editor.json`, bloccabili dalla config): `newNoteLocation` (cartella indicata / accanto alla nota), `attachmentLocation` (cartella / accanto alla nota / sottocartella della nota), `confirmDelete`, `queryIncludeHost`. Già presenti: cartella nuove note/allegati, formato link, modalità cestino, vista predefinita. **Non fatte:** aggiornamento automatico dei link al rinomina on/off, file esclusi, "usa wikilink vs link Markdown" (non elencate nello spec; da valutare). Daily notes: WP3a.

## Limiti per piattaforma

Non verificabile in questo ambiente (nessuna GUI Wails): macOS forza orientamento orizzontale e margini 0 nel pannello di stampa (si cambia nel pannello; i margini sono nel padding del documento); Windows/Linux dipendono dal dialogo di WebView2/WebKitGTK. Da provare a mano (`docs/qa/m6-search-export.md`).

## Alternative considerate

- **PDF generato in Go/headless Chrome** — dipendenza pesante, contro l'architettura chiusa.
- **KaTeX HTML+CSS nell'export** — richiede font incorporati (centinaia di KB); MathML è nativo nei browser moderni.

## Conseguenze

Un solo percorso di rendering per stampa ed HTML. Il risultato PDF dipende dal dialogo di sistema. L'esclusione della nota ospitante è approssimata oltre il limite di pagina.
