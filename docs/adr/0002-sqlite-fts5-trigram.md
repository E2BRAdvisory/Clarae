# ADR-0002 — SQLite pure-Go con FTS5 `trigram` per l'indice locale (SPIKE-02)

|                       |                                                                          |
| --------------------- | ------------------------------------------------------------------------ |
| **Stato**             | accettata                                                                |
| **Data**              | 2026-10-23                                                               |
| **Riferimenti spec**  | §2.4 (ricerca), §2.5 `store`, Appendice A (ricerca < 200 ms su 50k note) |
| **Devia dallo spec?** | no                                                                       |

## Contesto

La ricerca deve offrire il matching per sottostringa di Obsidian (≥ 3 caratteri) senza CGO, per compilare il client su tre OS senza toolchain C.

## Decisione

`modernc.org/sqlite` v1.61 (driver `database/sql` "sqlite") con `CREATE VIRTUAL TABLE fts_content USING fts5(path UNINDEXED, title, body, tokenize = 'trigram case_sensitive 0')`. Verificato dal test `TestFTS5Trigram` (`apps/desktop/internal/store`): sottostringhe interne, case-insensitive, testo Unicode. Migrazioni con goose su `database/sql`; `journal_mode=WAL`, `busy_timeout=5000`, una sola connessione aperta per database (SQLite serializza le scritture).

Query sotto i 3 caratteri: nessun risultato dal FTS; in M1-WP4 scansione lineare sui candidati, come da spec.

## Alternative considerate

- **`mattn/go-sqlite3` (CGO)** — scartata: cross-compilazione e firma più onerose.
- **Bleve / indice custom in Go** — scartata: più codice da mantenere, meno strumenti di ispezione.

## Conseguenze

Il benchmark su 50.000 note sintetiche (obiettivo < 200 ms) resta da eseguire in M1-WP4; se il trigram risultasse troppo lento o grande, il fallback è `unicode61` con prefix-matching e post-filtro.
