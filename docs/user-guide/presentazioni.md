# Presentazioni

Ogni nota Markdown può diventare una presentazione: non serve un formato a parte, e la nota resta un normale file `.md` leggibile anche da Obsidian.

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
