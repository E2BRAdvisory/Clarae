# ADR-0035 — Barra di stato compatta e opzionale

|                       |                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | proposta                                                                                                                        |
| **Data**              | 2026-10-30                                                                                                                      |
| **Riferimenti spec**  | §2.2.1 (riga «Word count», `statusbar`, P0: «Parole, caratteri, selezione»), §4.2 (frontend); V-02/D-01; ADR-0026, ADR-0004     |
| **Devia dallo spec?** | no rispetto alla v1.1 (che prevede `statusbar`); precisa ADR-0026 → la riga `statusbar` di §2.2.1 va scritta come in questo ADR |

## Contesto

ADR-0026 (M8) ha eliminato la status bar e ha distribuito il contenuto:

- riga/colonna, parole, caratteri e selezione nel pannello _Statistiche_ della sidebar destra;
- indicizzazione, permessi, aggiornamenti, sync e inviti nel footer della sidebar destra, e nell'header a sidebar chiusa.

Il requisito «Word count» (P0) è soddisfatto dal pannello.

L'analisi dei gap del 2026-10-30 ha però notato un limite: i conteggi dell'editor si vedono solo con la sidebar destra aperta e sulla tab _Statistiche_. Chi scrive con un obiettivo di lunghezza, o lavora con la sidebar chiusa per avere spazio (modalità più comune su schermi piccoli e in presentazione), non ha più un'indicazione a colpo d'occhio. In Obsidian, a cui lo spec si ispira, la status bar mostra i conteggi in basso a destra.

Gli indicatori di stato (sync, permessi, aggiornamenti, inviti) non hanno questo problema: ADR-0026 li porta nell'header quando la sidebar è chiusa.

## Decisione

**Barra opzionale, spenta per default.** Il default della shell resta quello di ADR-0026 e del mockup.

- **Accensione:**
  - impostazione _Aspetto › Barra di stato_ (`statusBar` in `.memobrain/appearance.json`, booleano, default `false`);
  - comando `app:toggle-status-bar`, nella palette, senza hotkey di default;
  - chiave del Config Profile `appearance.statusBar`, che l'amministratore può impostare come default o bloccare, come le altre chiavi di `appearance`. Va aggiunta alle due copie dello schema.
- **Posizione:** una riga sottile (circa 22 px) sotto l'area editor, sopra lo slot della chat. Non attraversa le sidebar, quindi non tocca ribbon e footer. Una sola per finestra, riferita al pane attivo.
- **Contenuto**, solo informazioni dell'editor attivo, nell'ordine:
  1. **parole e caratteri** della nota; con una selezione attiva, **parole e caratteri selezionati** al loro posto, come nella riga «Word count» dello spec;
  2. **riga:colonna** del cursore;
  3. **modalità** (Sorgente / Live Preview / Lettura), cliccabile per ciclare, come il comando esistente.
  - Su un disegno, un canvas o una base mostra solo il tipo di file. Senza tab attiva è vuota.
- **Niente duplicati:** sync, permessi, aggiornamenti e inviti non entrano nella barra. Restano nel footer e nell'header (ADR-0026), così c'è una sola fonte per ogni indicatore.
- **Dati:** gli stessi del pannello _Statistiche_ (lo store delle statistiche dell'editor, aggiornato con debounce). Nessun binding nuovo, nessun Go.
- **Accessibilità:** `role="status"` senza `aria-live`, perché annunciare i conteggi a ogni tasto sarebbe rumore per lo screen reader. Il comando «Leggi statistiche della nota» resta il modo accessibile di ascoltarli. Contrasto conforme a `docs/qa/a11y-desktop.md`.
- **Workbench web:** identico (stesso `packages/workbench`).

## Alternative considerate

- **Ripristinare la status bar di prima di M8, sempre visibile** — scartata: è la barra affollata che ADR-0026 ha eliminato, e duplicherebbe gli indicatori già nel footer e nell'header.
- **Conteggi nell'header della nota (sotto il titolo)** — scartata: occupa spazio di contenuto e si confonde con le proprietà.
- **Badge sul pulsante della sidebar destra** — scartata: mostra un solo numero e non la selezione.
- **Nessuna modifica (solo pannello)** — possibile, ed è lo stato attuale. Questo ADR la supera solo per chi accende la barra: chi non la usa non vede differenze.

## Conseguenze

- La riga `statusbar` di §2.2.1 dello spec diventa: «Word count — parole, caratteri, selezione nel pannello _Statistiche_; barra di stato compatta opzionale (spenta per default) con conteggi, posizione e modalità; P0». In §4.2, `statusbar/` sta accanto a `sidebar/`.
- Implementazione stimata piccola (un componente in `packages/workbench/src/shell/`, un'impostazione, un comando, due chiavi i18n, la chiave nello schema). Test:
  - unit (contenuto con e senza selezione, tipi di file);
  - e2e su mock (accensione dalla palette e persistenza);
  - axe sulla shell con la barra accesa.
- Il layout di M8 (`docs/qa/m8-shell-ui.md`) va verificato anche con la barra accesa: altezza dell'area editor, slot della chat, presentazione Slides (dove la barra si nasconde).
- Se la sperimentazione mostra che quasi tutti la accendono, valutare il default `true` con un ADR successivo.
