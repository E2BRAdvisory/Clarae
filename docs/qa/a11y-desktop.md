# Accessibilità client desktop: copertura automatica e checklist manuale

Obiettivo: WCAG 2.1 AA per la **chrome dell'app** (barre, pannelli, dialog, menu). Non si afferma conformità: sono riportate le misure e i limiti.

## Copertura automatica

Suite Playwright sul mock dei binding Wails (`make e2e`, oppure `yarn workspace @memobrain/desktop-frontend e2e a11y keyboard`):

- `apps/desktop/frontend/e2e/a11y.spec.ts`: scansioni axe (`wcag2a, wcag2aa, wcag21a, wcag21aa`, blocca su `serious`/`critical`), in tema chiaro e scuro e con `prefers-reduced-motion: reduce`, di: schermata di benvenuto, shell con nota aperta e schede della barra laterale (File, Cerca, Tag, Struttura), palette comandi, selettore rapido, impostazioni, impostazioni scorciatoie, procedura di collegamento al cloud, condivisione e inviti, importer, vista grafo, nuova base, recupero file. `AXE_REPORT=<file>` salva tutte le violazioni (anche minori) in JSON lines.
- `apps/desktop/frontend/e2e/keyboard.spec.ts`: schede della barra laterale (roving tabindex, frecce, `Home`), albero dei file (una sola sosta, frecce/`Home`/`End`, espandi/chiudi, `Invio`, `F2`, menu con tasto Menu, ritorno del focus), schede dei documenti (frecce, `Canc`), palette come combobox.
- Unit: `src/i18n/lang.test.ts` (`<html lang>` segue la lingua).

**Contenuto di CodeMirror:** `.cm-content` e il canvas Excalidraw sono **esclusi** dalla scansione (il loro modello DOM non è sotto il nostro controllo); l'editor espone `role=textbox`, `aria-multiline` (forniti da CodeMirror) e l'etichetta tradotta "Editor della nota". Il comportamento reale con gli screen reader è nella checklist manuale.

### Esito misurato

| Regola axe (impatto)                    | Prima                                                                     | Dopo | Correzione                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------- |
| `nested-interactive` (serious)          | 18 occorrenze (schede dei documenti, tab della base e del grafo)          | 0    | La scheda è ora `button role=tab` con il pulsante di chiusura **fuori** dal ruolo `tab`; il tablist contiene solo schede. |
| `aria-input-field-name` (serious)       | 2                                                                         | 0    | Palette e selettore: `combobox` + `listbox` etichettato, `aria-activedescendant`, `aria-controls`.                        |
| `scrollable-region-focusable` (serious) | 2                                                                         | 0    | Il listbox scorrevole è focalizzabile (`tabindex=-1`) senza entrare nell'ordine di tabulazione.                           |
| `color-contrast` (serious)              | 4 (testo secondario nei risultati, filtri della base, link in tema scuro) | 0    | Nuovi token `--text-muted`/`--text-faint` (≥4,5:1 su tutte le superfici, chiaro e scuro) e `--accent-text` per i link.    |
| `aria-required-children` (critical)     | introdotta e risolta durante la correzione                                | 0    | Tablist in un contenitore dedicato; spazio e pulsanti accessori fuori dal tablist.                                        |

Totale dopo le correzioni: **0 violazioni** (di qualunque impatto) in 20 scansioni (10 scenari × 2 temi).

## Interventi di accessibilità dell'app (non solo test)

- **Albero dei file:** `role=tree`/`treeitem` con `aria-level`, `aria-expanded`, `aria-selected`; roving tabindex; frecce, `Home`/`End`, `→`/`←`, `Invio`/`Spazio`, `F2` (rinomina), `Canc` (cestino), tasto Menu / `Maiusc+F10` (menu contestuale).
- **Schede** (barra laterale e documenti): roving tabindex e frecce; `Canc` chiude la scheda del documento.
- **Menu contestuale:** il focus entra nel menu all'apertura, frecce/`Home`/`End`, `Esc`/`Tab` chiudono e il focus torna all'origine.
- **Palette e selettore rapido:** pattern combobox/listbox.
- **Stato di sincronizzazione:** regione `role=status` (`aria-live=polite`) nella barra di stato.
- **Focus visibile** ovunque (`:focus-visible`), **colori forzati** (`forced-colors: active`: focus, scheda attiva e voce selezionata con i colori di sistema) e **movimento ridotto** (`prefers-reduced-motion`).
- `<html lang>` segue la lingua scelta; stringhe prima fisse in inglese (titolo "Error", etichetta dell'editor) spostate in i18n.

## Limiti noti / da fare

- Grafo e lavagna sono superfici grafiche senza equivalente testuale completo (il grafo ha stato `aria-live`, ma non una navigazione per nodi). Da progettare dopo la 1.0. Per i **disegni** il comando «Descrivi il disegno come testo» elenca contenuto, cornici, testi e link in un dialogo navigabile; la canvas di Excalidraw resta esclusa dalla scansione axe, ma barra, esportazione, pannello Strumenti, dialoghi LaTeX e Mermaid, descrizione e presentazione sono scansionati (`e2e/a11y.spec.ts`).
- Dialog dell'app (`ui/dialogs.tsx`): il comportamento di focus è coperto dai test unitari esistenti; la verifica con screen reader è manuale.
- Il pulsante "✕" di chiusura delle schede è nascosto agli screen reader (`aria-hidden`, `tabindex=-1`) per rispettare il pattern tab: la chiusura da tastiera è `Canc` e dal menu della scheda.
- Nessuna verifica con VoiceOver/NVDA/Orca reali è stata fatta in questo ciclo; i webview reali (WKWebView, WebView2, WebKitGTK) differiscono da Chromium.

## Checklist manuale (non spuntata) — per ogni OS

Ambienti: **macOS** con VoiceOver su WKWebView; **Windows** con NVDA (e Narrator) su WebView2; **Linux** con Orca su WebKitGTK. Annotare versione OS/screen reader e data.

Generale (tutti gli OS)

- [ ] L'app si avvia e annuncia titolo della finestra e regione principale; la lingua di sintesi corrisponde alla lingua dell'interfaccia.
- [ ] Schermata di benvenuto: pulsante "Apri cartella come vault" e vault recenti annunciati e attivabili.
- [ ] Barra laterale: le schede (File/Cerca/Tag…) sono annunciate come "scheda, selezionata, n di m"; le frecce cambiano scheda.
- [ ] Albero dei file: annuncia nome, livello, "espanso/compresso" e posizione; `→`/`←` espande/chiude; `Invio` apre la nota; `F2` apre la richiesta di nome; menu da tasto Menu/`Maiusc+F10` navigabile.
- [ ] Schede dei documenti: annunciate con il nome della nota; frecce e `Canc` funzionano; la nota attiva è chiara.
- [ ] Editor: il campo è annunciato come "Editor della nota, modifica, più righe"; si legge riga per riga; i caratteri digitati e le righe sono annunciati; le scorciatoie di formattazione non confliggono con quelle del screen reader.
- [ ] Live Preview: elenchi, titoli, link, callout e tabelle sono comprensibili; il passaggio alla modalità sorgente e lettura è annunciato.
- [ ] Palette comandi e selettore rapido: all'apertura il campo è annunciato come "casella combinata"; spostando la selezione con le frecce si legge la voce; `Invio` esegue; `Esc` chiude e il focus torna all'editor.
- [ ] Dialog (conferme, richieste di nome, errori): titolo annunciato, focus dentro, `Esc` chiude, il focus torna all'origine.
- [ ] Barra di stato: i cambi di sincronizzazione (sincronizzato → in corso → offline/errore) sono annunciati senza rubare il focus; il badge del permesso (lettore/editor) è letto.
- [ ] Impostazioni: ogni controllo ha etichetta; le impostazioni bloccate dall'amministratore annunciano il motivo.
- [ ] Procedure guidate (collega al cloud, importer): passi annunciati ("Passo n di m"), errori e avanzamento annunciati; passphrase, forza della passphrase e chiave di recupero comprensibili; il campo passphrase non rivela il contenuto.
- [ ] Condivisione e inviti: elenco destinatari e livelli leggibili; accettare/rifiutare un invito è possibile da tastiera.
- [ ] Recupero file / cronologia: elenco delle versioni e diff leggibili; "Ripristina" è chiaramente un'azione.
- [ ] Vista grafo e lavagna: l'utente è informato che non hanno equivalente testuale completo e trova un'alternativa (backlink, struttura, note incorporate).
- [ ] Contrasto elevato / colori forzati: testi, focus, scheda attiva e selezione sono visibili (Windows: tema "Contrasto elevato").
- [ ] "Riduci movimento" del sistema: nessuna animazione residua.
- [ ] Zoom dell'interfaccia (Impostazioni → Aspetto) al massimo: nessun contenuto tagliato nelle finestre principali.

Specifico per OS

- [ ] **macOS/VoiceOver:** il rotore elenca intestazioni, link e controlli moduli; Safari/WKWebView non intercetta `Mod+,` e le scorciatoie dell'app.
- [ ] **Windows/NVDA:** modalità focus/modalità navigazione si alternano correttamente nell'editor e nelle liste; Narrator: stessa verifica sui dialog.
- [ ] **Linux/Orca:** il webview espone l'albero di accessibilità (AT-SPI abilitato); controllare albero dei file, dialog e palette.
