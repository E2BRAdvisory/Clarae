# ADR-0039 — sync.db: candidati al merge persistenti e quarantena dei path illeggibili

|                       |                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| **Stato**             | proposta                                                                                          |
| **Data**              | 2026-11-01                                                                                        |
| **Riferimenti spec**  | §3.4 (protocollo di sync), §3.4.3 (stato locale `sync.db`); D-02 (vault privati), D-04; ADR-0009  |
| **Devia dallo spec?** | sì: §3.4.3 va esteso con le tabelle `pending_remote` e `quarantine` e con le regole di questo ADR |

## Contesto

L'analisi del 2026-11-01 ha trovato due perdite silenziose nel motore di sync del desktop (`apps/desktop/internal/sync`). Lo stesso codice gira nel workbench web, compilato in WASM.

1. **Candidati al merge solo in memoria.** Una modifica remota a un file con modifiche locali veniva parcheggiata in una mappa in memoria, mentre il cursore del changelog veniva salvato subito. Se il merge falliva (errore di rete, app chiusa, file modificato di nuovo durante il merge), il candidato spariva e il cursore era già oltre. Il push successivo andava in conflitto all'infinito, e il file finiva in `StateConflict` senza nessun record nella vista dei conflitti.
2. **Path non decifrabili.** In un vault privato un errore di decifratura del path, anche solo perché il vault era stato bloccato a metà ciclo, faceva saltare la modifica con il cursore che avanzava. Durante il bootstrap faceva anche finire nel cestino il file locale corrispondente, come se il server l'avesse cancellato.

## Decisione

- **Tabella `pending_remote(file_id PK, rev, change JSON, created_at)`** (migrazione `0002_pending_remote.sql`):
  - i candidati vengono scritti nella **stessa transazione** del cursore della pagina;
  - si cancellano solo dopo un merge riuscito, oppure quando sono superati;
  - se il file cambia durante il merge, il candidato resta per il ciclo successivo;
  - un file con un candidato pendente non viene pushato;
  - un commit rifiutato con una revisione corrente più nuova genera un candidato sintetico, così il ciclo successivo fa il merge invece di ritentare alla cieca.
- **Vault bloccato:** un errore di tipo "bloccato" interrompe il pull **prima** che il cursore avanzi (fase `locked`). Il blocco manuale aspetta la fine del ciclo in corso.
- **Tabella `quarantine`:** un path che non si decifra per un motivo diverso dal blocco viene messo in quarantena (tabella, `LastError` della riga, log). Il file locale non si tocca. Nel bootstrap ogni voce dell'albero conta come "nota" prima della decifratura, quindi non viene mai interpretata come una cancellazione del server.
- **Transazioni:** `sync.db` ha ora `DB.WithTx`. Una pagina di pull, l'adozione nel bootstrap, il merge (copia, conflitto, originale) e il rename dalla UI sono atomici.
- **Ordine del merge:** la copia di conflitto si scrive **prima** di sovrascrivere l'originale. I nomi delle copie si troncano su confini di carattere UTF-8, entro i limiti di `pathrules`.

## Alternative considerate

- **Avanzare il cursore solo dopo il merge:** con le pagine di pull da 500 modifiche, un singolo file in errore avrebbe bloccato tutta la sincronizzazione. Scartata.
- **Saltare i path illeggibili, ma senza cestinare:** la perdita resterebbe silenziosa e il file non sarebbe più allineato. Scartata.

## Conseguenze

- **Stato locale:** `sync.db` ha due tabelle in più. Unlink e la rimozione di un mount le svuotano.
- **Candidati irrisolvibili:** un candidato che non si può risolvere (per esempio un blob sparito) tiene il file fuori dal push e segnala un errore a ogni ciclo, finché una modifica più recente del server non lo sostituisce. Prima il file finiva in conflitto in silenzio.
- **Blocco manuale più lento:** può attendere un ciclo lungo, per esempio un download grande.
- **Da fare:** la quarantena per ora non si vede nella UI, solo nel log e nello stato della riga. Va mostrata nel pannello sync, in una wave successiva.
- **Da fare:** il blocco automatico per inattività non si coordina ancora con il motore. Non può più causare perdite, perché l'errore di blocco ferma il pull prima del cursore, ma va allineato nella wave sulla sicurezza dell'host web (W3).
