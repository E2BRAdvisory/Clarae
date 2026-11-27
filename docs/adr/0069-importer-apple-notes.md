# ADR-0069 — Importer di Apple Notes

|                       |                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | proposta                                                                                                                                                                                                |
| **Data**              | 2026-11-27                                                                                                                                                                                              |
| **Riferimenti spec**  | §2.2.1 (riga «Importer», «Apple Notes solo macOS (P2)»); §2.5 (modulo `importer`); V-02; ADR-0017                                                                                                       |
| **Devia dallo spec?** | no: realizza una voce P2 già prevista; se si sceglie l'opzione B va aggiunta a §2.5 e App. B l'autorizzazione «Automazione» di macOS                                                                    |
| **Superfici**         | desktop (solo macOS per la lettura diretta); workbench web: eccezione di parità per la lettura diretta, mentre l'import di un'esportazione in Markdown vale ovunque con l'importer «cartella» esistente |

## Contesto

È l'unica lacuna di M6 ancora aperta (verifica del 2026-11-27 nella roadmap): l'importer copre Markdown/HTML, Evernote ENEX, Notion, Roam, Bear, Google Keep (JSON e HTML di Takeout) e CSV (`apps/desktop/internal/importer`), ma non Apple Notes, che lo spec e ADR-0017 rinviano a P2, solo macOS.

Apple Notes non ha un formato di esportazione completo e documentato. Le strade possibili, con ciò che è noto e ciò che va verificato:

1. **Esportazione dall'app Notes.** Storicamente solo PDF, una nota alla volta. Le versioni recenti di macOS e iOS (dal ciclo 26) aggiungono l'esportazione in Markdown: **da verificare** se vale per una nota sola o per una cartella, e che cosa conserva (allegati, tabelle, liste di controllo, link tra note).
2. **Lettura tramite AppleScript o JXA** (`osascript`, app Notes): elenca account, cartelle e note, con il corpo in HTML e le date di creazione e modifica. Chiede all'utente l'autorizzazione «Automazione» per controllare Notes. Le note bloccate da password non si leggono; gli allegati sono accessibili solo in parte (**da verificare** quali tipi e come). È lento su molte migliaia di note (**da misurare**).
3. **Lettura del database** `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`: il contenuto delle note è un protobuf compresso con gzip, **non documentato** e cambiato tra versioni di macOS; serve l'accesso completo al disco (o il consenso «dati di altre app»), e gli allegati stanno in cartelle `Media` per account.
4. **Copia dei dati da privacy.apple.com** (note di iCloud): formato e completezza **da verificare**; vale solo per le note su iCloud, non per quelle «Sul mio Mac».

## Decisione

Proposta in due passi, il primo senza codice nuovo di lettura:

1. **Passo 1: esportazione in Markdown con l'importer «cartella».** Dove Notes esporta in Markdown, l'utente esporta e importa la cartella con l'importer Markdown esistente (`folder.go`), che già gestisce link, allegati relativi e `Imports/<sorgente>-<data>/` con `Import report.md`. Si aggiunge solo:
   - una voce «Apple Notes (esportazione Markdown)» nel selettore della sorgente, che usa lo stesso importer con l'ID `applenotes-md` per il nome della cartella di destinazione e il report;
   - la guida utente (come esportare, cosa si perde);
   - fixture scritte a mano da un'esportazione reale, quando lo spike la conferma.
     Vale su desktop e workbench web, come gli altri importer a cartella.
2. **Passo 2 (facoltativo, dopo lo spike): lettura diretta via JXA, solo desktop macOS.** Un importer `applenotes` che esegue uno script JXA fisso e incorporato tramite `osascript` (nessuno script fornito dall'utente, V-02), legge account, cartelle e note in HTML, converte con `htmlmd.go` (lo stesso percorso di Keep e ENEX, HTML mai conservato come markup), mappa le cartelle in sottocartelle e le date nelle proprietà `created` e `updated`, salta le note bloccate elencandole nel report, ed estrae gli allegati dove lo script li espone. Capability `appleNotes` dichiarata dal core solo su macOS; eccezione di parità sul web. L'autorizzazione «Automazione» la chiede macOS alla prima esecuzione; un rifiuto diventa un errore spiegato, non un crash.

Lo **spike** (time-boxed, un giorno) decide se il passo 2 serve: esportazione Markdown di Notes (una nota o una cartella, fedeltà), resa di JXA su un account reale di qualche migliaio di note (tempo, allegati, note bloccate, account iCloud e «Sul mio Mac»), messaggi di macOS per l'autorizzazione.

## Alternative considerate

- **Parsing di `NoteStore.sqlite`** (opzione 3) — scartata: formato non documentato che cambia tra versioni (manutenzione continua e rischio di import silenziosamente incompleti), accesso completo al disco da chiedere all'utente per un'app di note, e un parser di dati non fidati in più.
- **Solo PDF** — scartata: il PDF non si riconverte in Markdown in modo affidabile.
- **Copia dei dati di privacy.apple.com** — non scelta come via principale: solo iCloud, formato da verificare, procedura lunga per l'utente; può diventare una sorgente in seguito se lo spike la trova utile.
- **Nessun importer, solo una guida** — possibile se lo spike mostra che l'esportazione Markdown di Notes è completa e per cartelle; resta comunque utile la voce nel selettore per il report e la destinazione.

## Conseguenze

- Il passo 1 costa poco e copre anche il web; dipende però dalla versione di macOS dell'utente (le versioni senza esportazione Markdown restano senza via, salvo il passo 2).
- Il passo 2 aggiunge una dipendenza dal sistema (`osascript`, autorizzazione Automazione) e un'eccezione di parità; non richiede né l'accesso completo al disco né parser di formati non documentati.
- Le note bloccate da password non si importano in nessuna delle due vie: il report le elenca.
- Da aggiornare quando l'ADR è accettato: `Specifications.md` §2.2.1 (riga «Importer»), ADR-0017 («Limiti noti»), il registro di parità (`shared/parity/features.yaml`, voce dell'importer), la guida utente.
