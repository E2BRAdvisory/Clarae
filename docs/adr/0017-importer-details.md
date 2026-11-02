# ADR-0017 — Importer: mappature per sorgente e limiti

|                       |                                                                           |
| --------------------- | ------------------------------------------------------------------------- |
| **Stato**             | accettata                                                                 |
| **Recepito in**       | `Specifications.md` v1.4 (2026-11-02): §2.2.1, §2.5, §4.2 (Appendice C.4) |
| **Data**              | 2026-10-24                                                                |
| **Riferimenti spec**  | matrice §2.2.1 (Importer, P1); D-06; roadmap M6-WP4                       |
| **Devia dallo spec?** | no                                                                        |

## Contesto

L'importer porta in un vault note di altre app. I file sorgente sono non fidati. Apple Notes è rinviato a P2. Le fixture in `internal/importer/testdata` sono scritte a mano dalla conoscenza dei formati, non sono export reali.

## Decisione

**Architettura.** `internal/importer`: interfaccia `Importer{ID, Detect, Preview, Run}` + registry. Preview esegue lo stesso codice di Run su un sink "dry-run", quindi conteggi e avvisi coincidono con l'import. Le scritture passano da un `Sink` sul livello `vault.FS` (percorsi `pathrules`, scrittura atomica, contenimento symlink); i nomi sono prenotati prima della scrittura e non sovrascrivono mai (suffisso ` (1)`). Destinazione predefinita `Imports/<sorgente>-<data>/`; al termine viene scritta la nota `Import report.md` nella stessa cartella. Binding `ImporterAPI` (eventi `importer:progress`/`importer:done`, un solo import per vault, rifiutato sui mount viewer). L'indicizzazione è affidata al watcher.

**Link.** I link Markdown relativi (anche con percent-encoding, spazi, `#ancora`) sono riscritti in `[[wikilink]]`/embed se l'opzione `useWikilinks` è attiva (nome breve se univoco tra i file importati, altrimenti percorso), altrimenti restano link Markdown con percorso corretto. Codice inline e blocchi di codice non vengono toccati. Link a file non importati restano invariati e sono contati nel report. `useWikilinks` e cartella allegati sono opzioni del wizard (non esistono ancora come impostazioni di vault).

**Allegati.** Le sorgenti "cartella" (Markdown, Notion) mantengono la struttura relativa; gli allegati generati (ENEX, Keep, Bear) vanno in `<destinazione>/attachments`. Se la cartella allegati è impostata, tutti gli allegati vanno lì.

**Per sorgente.**

- _Markdown/HTML_: `.md` copiati, `.html` convertiti, altri file come allegati; cartelle nascoste ignorate.
- _ENEX_: `created`/`updated`/`tags`/`source`/`author` nel frontmatter; ENML→Markdown (`en-todo`→task, `en-media` per hash MD5, `en-crypt` sostituito da un callout con avviso); risorse base64 con estensione da MIME.
- _Notion_: via suffisso id a 32 hex da nomi di file e cartelle, `_all.csv` ignorato se esiste il CSV base, cartella-radice unica rimossa; ogni CSV genera una nota indice (tabella con link) e le proprietà finiscono nel frontmatter della pagina della riga (o in una nuova nota se la pagina manca). Archivi annidati non sono aperti (avviso).
- _Roam_: blocchi→elenchi annidati (tab), `{{[[TODO]]}}`/`DONE`→task, `((uid))`→testo semplice (avviso; irrisolti rimossi), `^^x^^`→`==x==`, `#[[x]]`→`[[x]]`, titoli giornalieri→`YYYY-MM-DD` (tag `daily-note`), `/` nei titoli→`-` con alias nei link. Altri `{{componenti}}` restano testo.
- _Bear_: `.bearbk`, `.textbundle/.textpack` (cartella o zip), Markdown esportato; tag in frontmatter, `#multi word#`→`#multi-word`, date da `info.json`. Il formato `[image:…]` (backup vecchi) non è risolto (avviso).
- _Google Keep_: JSON di Takeout; liste→task, label→`tags`, `pinned`/`archived`/`trashed`/`color` come proprietà, archiviate e cestinate escluse salvo opzione. Le pagine HTML di Takeout sono lette quando una nota non ha il JSON accanto (esportazioni vecchie o parziali): stesso risultato, con il contenuto convertito da HTML e la data della pagina come `updated` (ora locale della macchina che importa; manca `created`). Una nota presente in entrambi i formati è letta dal JSON.
- _CSV_: delimitatore rilevato (`, ; tab |`), colonna titolo e corpo scelte dall'utente, le altre in frontmatter con inferenza di tipo (numero, booleano, data); `tags`/`aliases` come liste.

**Sicurezza.** Nomi di voci zip validati (no assoluti, `..`, `\`, NUL, unità) e mai usati come percorso di destinazione; tetto a numero di voci (200.000), byte dichiarati (8 GiB) e per file (1 GiB), più un lettore che applica i tetti ai byte realmente letti (header falsi); symlink ignorati. XML con `encoding/xml` (nessuna entità esterna/DTD; le entità personalizzate danno errore) su lettore a dimensione limitata. HTML → Markdown puro: `script`, `style`, `iframe`, `object`, form, handler e stili sono scartati (e segnalati), link `javascript:`/`data:` ridotti al testo.

## Alternative considerate

- **Un'implementazione per Preview e una per Run** — scartata: i conteggi divergerebbero.
- **Mantenere HTML grezzo nelle note** — scartata: V-02 vieta HTML/CSS attivo.

## Conseguenze

Limiti noti: dati reali non verificati; Apple Notes (P2); Notion senza i valori delle relazioni risolti; la conversione HTML non riproduce layout complessi. I wikilink brevi sono univoci solo tra i file importati, non rispetto al resto del vault.
