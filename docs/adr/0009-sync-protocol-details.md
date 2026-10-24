# ADR-0009 — Dettagli implementativi del protocollo di sync (M2)

|                       |                                                                                   |
| --------------------- | --------------------------------------------------------------------------------- |
| **Stato**             | proposta (da recepire nello spec a cura dell'owner)                               |
| **Data**              | 2026-10-24                                                                        |
| **Riferimenti spec**  | §3.2.2 (schema DB), §3.5 (API), §3.6 (protocollo di sync), §3.8 (E2EE), D-02/D-03 |
| **Devia dallo spec?** | sì, in modo additivo (campi, colonne e codice di errore aggiuntivi)               |

## Contesto

L'implementazione di M2 ha richiesto alcune scelte non coperte dallo spec o puntualmente diverse. Sono elencate qui per essere recepite o contestate.

## Decisioni

1. **`op_id` su `file_revisions`** (unico per vault): garantisce l'idempotenza dei commit ripetuti dopo un timeout (già previsto dalla roadmap, M2-WP2).
2. **`path_key` in `CommitOp`** per i vault privati: il server non vede i path; la collisione si verifica su `hmac1:<hex>` mentre il path opaco `enc1:<b64url>` è solo archiviato.
3. **Codice `NAME_IN_USE` (409)** quando l'utente crea un vault con un nome già usato tra i propri vault attivi (indice univoco parziale).
4. **Tabella `vault_blobs`** (capability per vault, `ON DELETE CASCADE`): un blob content-addressed globale è leggibile solo da chi ne ha la capability nel vault; la dedup verifica anche che l'oggetto esista nello store.
5. **Commit a transazione unica per batch (fast path)**, con fallback a una transazione per op in caso di race (violazione unique, deadlock, flush quota). Contatori di quota e `ref_count` accumulati per batch e applicati una sola volta in ordine di hash. Un'alternativa con SAVEPOINT per op è stata scartata per le prestazioni (>64 sotto-transazioni).
6. **tus fuori da OpenAPI**: gestito da un handler dedicato (`/vaults/{vid}/uploads`); i chunk sono oggetti separati nello store e vengono assemblati in finalizzazione con verifica SHA-256 (compatibile con S3 senza multipart server-side).
7. **SSE `/events`** usa `?known=<vault:seq,...>` invece di `Last-Event-ID` (gli eventi sono per più vault); il hub raggruppa (coalescing) gli eventi per vault.
8. **`sync.db` per vault** senza colonna `vault_id` (un DB per vault locale); colonna `base_rev` distinta da `server_rev` per l'antenato del merge 3-way.
9. **Serializzazione per vault**: scritture concorrenti sullo stesso vault sono serializzate dal lock del vault (p95 ≈ 1,15 s con 8 scrittori sullo stesso vault; informativo, il criterio di uscita riguarda scrittori su vault distinti).

## Conseguenze

- Migrazione `0003_vaults.sql` (la `0002` è già occupata dal seed delle impostazioni di M0, quindi il numero previsto dalla roadmap per M2 slitta di uno).
- `api/openapi.yaml` v1.0.0-m2 contiene `path_key`, `NAME_IN_USE` e la risposta `Conflict`.
- Limite noto: ricerca su 50k note oltre il budget (tracciato da M1, non risolto da M2).
