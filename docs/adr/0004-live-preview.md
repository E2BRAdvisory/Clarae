# ADR-0004 — Architettura Live Preview (SPIKE-04)

|                       |                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------- |
| **Stato**             | accettata                                                                               |
| **Data**              | 2026-10-24                                                                              |
| **Riferimenti spec**  | §2.2.1 (Editor), §2.7                                                                   |
| **Devia dallo spec?** | in parte: HTML grezzo ridotto a un sottoinsieme sanificato; PDF via pdf.js (vedi sotto) |

## Contesto

Live Preview è la modalità predefinita: il testo resta Markdown, ma la sintassi si nasconde ovunque il cursore non sia e compaiono widget (embed, math, mermaid, callout). Deve restare fluida su note da 1 MB e condividere con l'indexer le stesse regole di riconoscimento (link, tag, task, block id), altrimenti editor e indice divergono.

## Decisione

1. **Un solo documento CodeMirror 6.** Live Preview, Source e Reading non sono tre editor: Source e Live sono la stessa `EditorView` con un `Compartment` (`modeC`) che cambia le estensioni; selezione e scroll sopravvivono al cambio. Reading è un componente separato (`reading/ReadingView`) alimentato dal testo corrente.
2. **Decorazioni, non trasformazioni.** `editor/livePreview.ts` costruisce un `DecorationSet` puro (`buildInline(state, ranges)`) sull'albero `@lezer/markdown` (strutture a blocchi) più uno scanner di righe OFM (wikilink, embed, tag, highlight, commenti, block id) che usa le stesse regole del parser Go. La funzione è testabile senza DOM; il `ViewPlugin` la invoca solo sui range visibili e ricostruisce quando cambiano documento, selezione o viewport.
3. **Sintassi sulla riga del cursore.** Ogni decorazione "nascondi" ha un'esenzione quando la selezione tocca il suo intervallo: il token riappare e si può editare.
4. **Widget a blocchi in uno `StateField`** (`editor/blockWidgets.ts`): frontmatter (nascosto, la vista è il pannello Properties), math `$$`, mermaid, callout ripiegabili. Un blocco mostra il sorgente quando la selezione è al suo interno. Le decorazioni a blocchi non possono venire da un `ViewPlugin`, da qui lo `StateField`.
5. **Ponte verso l'applicazione:** l'editor non importa mai le API. `editor/context.ts` definisce `LivePreviewContext` (risoluzione link con cache, rendering embed/immagini/math/mermaid, apertura link) fornita tramite `Facet`. `NoteView` la implementa; quando una risoluzione asincrona termina emette l'effetto `linkStatusChanged` e le decorazioni si ricalcolano (link risolti vs fantasma).
6. **Tasti:** le scorciatoie dell'app passano da `Prec.highest(keymap.of([{ any }]))` → `commandForEvent`, così hanno la precedenza sulla keymap predefinita di CodeMirror (che altrimenti legherebbe `Mod-i` a "selectParentSyntax" e `Mod-Enter` a "insertBlankLine"). Lo stesso registro comandi serve palette, menu e hotkey personalizzati.
7. **Reading view:** `unified` (`remark-parse`, `remark-gfm`, `remark-math`) con plugin OFM proprio → `rehype-raw` → DOMPurify, poi _idratazione_ post-sanificazione (KaTeX, Mermaid, embed). DOMPurify vieta gli stili inline (D-01), quindi KaTeX/Mermaid sono inseriti dopo la sanificazione, da codice nostro, a partire da testo già escapato.

## Deviazioni dallo spec

- **HTML grezzo nelle note:** è renderizzato solo il sottoinsieme che DOMPurify lascia passare (niente `<script>`, `<style>`, attributi `style`, handler). Coerente con D-01 e con la CSP di ADR-0005.
- **PDF:** incorporati con pdf.js caricato lazy (non `<embed>`), perché `<embed>` non è affidabile nei webview e non rispetta `#page=` ovunque.
- **Vault switcher:** il roadmap lo elenca tra i comandi; è coperto da "Chiudi vault", che riporta alla schermata iniziale con i vault recenti.

## Alternative considerate

- **Editor ProseMirror/WYSIWYG:** il documento non sarebbe più il file Markdown; round-trip lossy, diff e merge (M2) più difficili.
- **Due viste sovrapposte (editor nascosto + preview):** cursore e selezione sincronizzati a mano, scroll fragile.
- **Widget per ogni inline:** costoso su note grandi; si usano `Decoration.mark/replace` e widget solo dove serve contenuto nuovo (checkbox, bullet, embed, math, mermaid).

## Conseguenze

- Ogni nuova sintassi OFM va aggiunta in tre punti con lo stesso comportamento: parser Go, estrattore TS (`@memobrain/markdown`) e scanner di Live Preview, coperti dalle fixture di `shared/conformance/markdown`.
- Le prestazioni dipendono dal limitare il lavoro ai range visibili; `livePreview.test.ts` fissa il comportamento, la prova di digitazione su 1 MB è manuale (`docs/qa/obsidian-parity.md`).
