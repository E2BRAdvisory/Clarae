# Presentazioni

Ci sono due modi di presentare. Ogni nota Markdown può diventare una presentazione, senza un formato a parte: la nota resta un normale file `.md` leggibile anche da Obsidian (le prime tre sezioni). Per slide curate nell'aspetto esistono poi i file `.marp`, presentazioni Marp con editor, scheda Slideshow, presentazione a tutto schermo ed export in HTML, PDF e PowerPoint (sezione [Presentazioni Marp](#presentazioni-marp-marp)).

## Dividere in slide

Una slide finisce dove c'è una riga con tre trattini (`---`) **preceduta da una riga vuota**. Il comando _Inserisci separatore_ (o l'icona nelle azioni rapide) la scrive per voi.

```markdown
# Titolo

Introduzione.

---

# Secondo punto

- uno
- due

Note: ricordare l'esempio dei grafi

---

# Chiusura
```

- Una riga di trattini subito sotto un testo, senza riga vuota, è un titolo di secondo livello e **non** divide la slide.
- I separatori dentro un blocco di codice o di formule (`$$ … $$`) e nel frontmatter non contano.
- Le righe vuote iniziali e finali di una slide e le slide vuote sono ignorate. Una nota senza separatori è una presentazione di una sola slide.
- Le **note del presentatore** sono le righe dopo una riga che comincia con `Note:` (maiuscole indifferenti), fino alla fine della slide. Non compaiono sulla slide.
- Immagini, formule, diagrammi Mermaid, callout e incorporamenti si vedono come nella vista lettura; non si scarica nulla da internet.

## Avviare la presentazione

- Scheda **Slide** nella barra laterale destra: _Avvia la presentazione_, _Dalla slide corrente_ (usa la posizione del cursore) o un clic su una miniatura per partire da quella slide.
- Palette comandi: _Avvia la presentazione_ e _Avvia la presentazione dalla slide corrente_.

La presentazione occupa l'intera finestra (e lo schermo intero, dove il sistema lo consente).

| Azione                                | Tasti                                     |
| ------------------------------------- | ----------------------------------------- |
| Slide successiva                      | `→`, `↓`, `Pag↓`, `Spazio`, `Invio`, clic |
| Slide precedente                      | `←`, `↑`, `Pag↑`, `Indietro`              |
| Prima / ultima slide                  | `Home` / `Fine`                           |
| Vista presentatore (attiva/disattiva) | `P`                                       |
| Termina                               | `Esc`                                     |

La **vista presentatore** mostra la slide corrente, la successiva, le note e il tempo trascorso. Tutto avviene nella stessa finestra: non c'è uno schermo separato per il pubblico.

## Opzioni

Nella scheda _Slide_, e salvate nel frontmatter della nota (quindi viaggiano con il file e si sincronizzano come ogni altra proprietà):

| Opzione                       | Proprietà          | Valori                                        |
| ----------------------------- | ------------------ | --------------------------------------------- |
| Transizione                   | `slide-transition` | `none`, `fade`, `slide` (predefinita), `zoom` |
| Tema                          | `slide-theme`      | `auto` (come l'applicazione), `light`, `dark` |
| Barra di avanzamento          | `slide-progress`   | `true` (predefinito) / `false`                |
| Numero di slide               | `slide-numbers`    | `true` / `false` (predefinito)                |
| Note nella vista presentatore | `slide-notes`      | `true` (predefinito) / `false`                |

Un valore non valido viene ignorato e vale il predefinito. Con il movimento ridotto attivo nel sistema le transizioni sono disattivate. Su un vault condiviso in sola lettura le opzioni non si possono modificare, ma si può presentare.

## Presentazioni Marp (`.marp`)

Una presentazione Marp è un file `.marp` nel vault: testo Markdown con il frontmatter `marp: true`, in cui le slide sono divise da `---`. Il comando _Nuova presentazione_ (palette comandi) ne crea una con due slide. Per la sync è Markdown: unione a 3 vie, ricerca e link. Si usano i temi integrati di Marp (Predefinito, Gaia, Uncover), senza CSS proprio, e nessuna risorsa arriva dalla rete. L'amministratore può spegnere la funzione dal Config Profile (`features.presentations`).

### L'editor

Il `.marp` si apre in un editor del solo sorgente, a tutta larghezza: non c'è vista divisa né i pulsanti Live, Sorgente e Lettura. L'anteprima delle slide sta nella scheda Slideshow della barra destra.

### La scheda Slideshow

Con un `.marp` attivo, la scheda _Slide_ della barra destra (_Slideshow_) mostra «Slideshow · n di m slide incluse» e una card per slide. La slide sotto il cursore dell'editor è evidenziata.

Barra degli strumenti:

- _Avvia la presentazione_, dalla prima slide inclusa;
- _Stampa / salva come PDF_;
- _Informazioni sulla presentazione_: slide, incluse nella presentazione, tema, parole, slide con note;
- _Impostazioni di presentazione_: _Ricomincia alla fine_, _Numeri di pagina sulle slide_, _Mostra le note del relatore_, _Tema_ (_Predefinito_, _Gaia_, _Uncover_);
- il menu _Altre azioni_: _Includi tutte le diapositive_ ed _Escludi tutte le diapositive_.

Ogni card ha il titolo («1. Titolo»: il primo titolo della slide, altrimenti la prima riga di testo), la miniatura e i pulsanti:

- _Vai a questa slide nell'editor_ (la matita);
- _Sposta su_ e _Sposta giù_: scambiano i blocchi di testo tra i separatori `---`;
- _Includi nella presentazione_ / _Escludi dalla presentazione_ (l'occhio);
- _Avvia da questa diapositiva_.

Un clic su una card la seleziona, porta il cursore dell'editor sulla slide e apre la casella delle _Note del relatore_ (Markdown), che si salvano da sole poco dopo la digitazione.

Tutte queste azioni modificano il testo del file e si annullano con l'undo dell'editor; su un vault in sola lettura sono disattivate. Con le slide divise dai titoli (direttiva `headingDivider`) non ci sono separatori e quindi _Sposta su_ e _Sposta giù_ restano disattivati.

### Che cosa viene scritto nel file

- **Slide escluse:** il commento `<!-- memobrain: hidden -->` dentro la slide. Un'esclusione vale solo in MemoBrain Notes: un client più vecchio o un altro strumento Marp mostra la slide e può leggere il commento come nota.
- **Note del relatore:** commenti HTML nella slide, come vuole Marp (`<!-- testo della nota -->`). Un commento che contiene direttive di Marp (per esempio `theme: gaia`) è configurazione, non una nota; se si scrive una nota che sembra una direttiva, MemoBrain Notes vi inserisce un carattere invisibile perché Marp non la legga come tale. Un commento dentro un blocco di codice (recintato o rientrato) o tra apici inversi non è una nota e non viene toccato.
- **Impostazioni:** il tema e i numeri di pagina sono le direttive `theme` e `paginate` del frontmatter; _Ricomincia alla fine_ e _Mostra le note del relatore_ sono le chiavi `memobrain-loop` (`true` per ripetere) e `memobrain-notes` (`false` per nasconderle; altrimenti sono visibili). Marp e i client precedenti le ignorano.

### Presentare

_Avvia la presentazione_ (barra della scheda, card, oppure il comando _Presenta le slide_) apre la presentazione a tutto schermo, dove il sistema lo consente. Mostra le slide incluse del testo come è nell'editor, anche non salvato. I numeri di pagina seguono Marp: le slide escluse non lasciano buchi nella numerazione.

| Azione               | Tasti                               |
| -------------------- | ----------------------------------- |
| Slide successiva     | `→`, `↓`, `Pag↓`, `Spazio`, `Invio` |
| Slide precedente     | `←`, `↑`, `Pag↑`, `Indietro`        |
| Prima / ultima slide | `Home` / `Fine`                     |
| Termina              | `Esc`, o il pulsante di chiusura    |

La barra in basso ha i pulsanti precedente e successiva, l'elenco delle slide, «n / totale» e, se attive, le note del relatore. Con _Ricomincia alla fine_ dopo l'ultima slide si riparte dalla prima. Uscire dallo schermo intero chiude la presentazione. Non ci sono la vista presentatore (`P`) né il clic per avanzare, che sono delle note Markdown.

### Esportare

I pulsanti di esportazione stanno nel ribbon, a sinistra, e cambiano con il file attivo: con una presentazione sono HTML, PDF e PPTX (gli stessi comandi sono nella palette: _Esporta la presentazione in HTML_, _…in PDF_, _…in PowerPoint (PPTX)_). Le slide escluse restano fuori da tutti e tre.

- **HTML:** un file autonomo, con le slide e il tema.
- **PDF:** apre la finestra di stampa del sistema, dove scegliere «Salva come PDF».
- **PPTX:** un file PowerPoint con testo modificabile (titoli, elenchi, tabelle, codice, immagini, sfondi), note del relatore e numeri di pagina, che si apre in PowerPoint e Keynote. Nel browser viene scaricato. Limiti: il tema è approssimato (colori e font di Predefinito, Gaia e Uncover, classi `invert` e `lead`), quindi l'aspetto è vicino ma non identico all'HTML; le immagini che non si riescono a convertire (per esempio certi SVG) sono saltate e l'app le elenca al termine.
