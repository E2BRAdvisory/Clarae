# ADR-0027 — Slides: presentazione di note

|                       |                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stato**             | accettata                                                                                                                                        |
| **Recepito in**       | `Specifications.md` v1.4 (2026-11-02): §2.2.1, §2.3.3, §4.1, §4.2, Appendice B (Appendice C.4)                                                   |
| **Data**              | 2026-10-28                                                                                                                                       |
| **Riferimenti spec**  | §2.2.1 (riga `slides`, P2), Appendice B (post-1.0); V-02/D-01, V-07/D-07; ADR-0004, ADR-0005, ADR-0026                                           |
| **Devia dallo spec?** | sì (§2.2.1 riga `slides`: da P2 a P1; Appendice B: Slides esce dal post-1.0) → richiede aggiornamento di `Specifications.md` da parte dell'owner |

## Contesto

Il mockup della shell (ADR-0026) include nella sidebar destra una tab _ShowSlide_ per configurare la presentazione del documento aperto: slide, effetti, note del presentatore. Lo spec classifica Slides come P2 post-1.0, con la sola indicazione «separatore `---`». Si decide di implementarla in M8, quindi lo spec va allineato.

Vincoli: finestra singola (V-07, niente schermo presentatore su finestra separata), nessun CSS personalizzato e HTML sanificato con DOMPurify (V-02), funzionamento offline, doppio parser con fixture condivise (`shared/conformance/`), file ordinari compatibili con Obsidian.

## Decisione

**Modello.** Una nota è una presentazione: le slide sono i blocchi separati da una riga `---` che segue una riga vuota (o è la prima del corpo) e sta fuori dal frontmatter, dai blocchi di codice (` ``` ` e `~~~`) e dai blocchi math (`$$`). La riga vuota prima è una scelta: `---` subito sotto un testo è un titolo setext, non un separatore (il comando «Inserisci separatore» la produce già così). Le note del presentatore sono le righe che seguono una riga `Note:` (anche con testo sulla stessa riga, maiuscole indifferenti, fuori da codice e math) fino alla fine della slide. Una slide senza contenuto è scartata. Il contenuto resta Markdown/OFM ordinario: una nota senza `---` è una presentazione a una slide e si legge normalmente.

**Configurazione.** Nel frontmatter, come proprietà piatte (scelta rispetto a un oggetto `slide:` annidato: l'API delle proprietà modifica valori semplici e il pannello Proprietà le mostra già): `slide-transition` (`none|fade|slide|zoom`, default `slide`), `slide-theme` (`auto|light|dark`, default `auto`), `slide-progress` (booleano, default `true`), `slide-numbers` (booleano, default `false`), `slide-notes` (booleano, default `true`: mostra le note nella vista presentatore). Valori non validi tornano al default; chiavi sconosciute sono ignorate. Nessun nuovo file in `.memobrain/`: la configurazione viaggia con la nota e si sincronizza come `.md`.

**Parser.** Estrazione delle slide in `packages/markdown` (TS) con equivalente Go in `apps/desktop/internal/parser` (oggi senza consumatori a runtime: serve a tenere i due parser allineati, come per le altre fixture), verificati con le stesse fixture in `shared/conformance/slides/` (CI bloccante). Ogni slide riporta la riga (1-based, frontmatter incluso) della sua prima riga non vuota, il contenuto e le note. Rendering con la pipeline reading (remark/rehype) già usata dall'anteprima; HTML sanificato con DOMPurify, nessun `style` inline.

**Presentazione.** Modalità a tutto schermo nella stessa finestra (overlay con `requestFullscreen` sul contenitore): navigazione da tastiera (frecce, spazio, Home/End), Esc per uscire, vista presentatore alternabile con slide corrente, successiva, note e timer. Comandi `slides:start` e `slides:start-here` nel registro. Nessuna richiesta di rete (verificata dalla CI come per Excalidraw).

**UI.** Tab _ShowSlide_ nella sidebar destra: opzioni sopra, miniature navigabili sotto; le modifiche scrivono il frontmatter attraverso lo stesso percorso delle Proprietà.

## Alternative considerate

- **reveal.js come dipendenza** — scartata: peso, CSS e temi propri in conflitto con V-02; la pipeline reading esistente basta per un sottoinsieme.
- **Slide in file `.slides` dedicati** — scartata: rompe la compatibilità con i vault Obsidian e il merge a 3 vie dei `.md`.
- **Finestra separata per il presentatore** — scartata: V-07.

## Conseguenze

- Slides entra in 1.0+ come P1: da riportare nella matrice §2.2.1 e nell'Appendice B, e da coprire in `docs/qa/` (checklist di parità).
- Il vincolo «Separatore `---`» dello spec è confermato; le note del presentatore e le chiavi `slide-*` sono estensioni di MemoBrain, non compatibili con i plugin Obsidian di slide (che le ignorano senza danno).
- Un nuovo punto di contatto tra i due parser: ogni modifica alla sintassi richiede aggiornare le fixture in entrambi i linguaggi.
