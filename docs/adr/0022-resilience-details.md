# ADR-0022 — Resilienza: fault injection, chaos su Helm, backup/PITR (M7-WP2b)

|                       |                                                                                  |
| --------------------- | -------------------------------------------------------------------------------- |
| **Stato**             | proposta                                                                         |
| **Data**              | 2026-10-27                                                                       |
| **Riferimenti spec**  | Appendice A (Disponibilità, Affidabilità dati); §3.4.4 (pull/cursor); D-02, D-03 |
| **Devia dallo spec?** | no                                                                               |

## Contesto

Appendice A richiede RPO ≤ 5 min, scritture client atomiche, nessuna perdita silenziosa e cloud 99,9 % ("SLO + chaos test", "test di fault injection"). Ogni scenario sotto asserisce che il guasto sia stato davvero iniettato prima di valutare l'esito.

## Garanzie verificate

| Scenario                               | Iniezione                                                                                                                | Esito                                                                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kill del cloud a metà `commit` (40 op) | SIGKILL del processo reale mentre una op è bloccata in PG (trigger `pg_sleep`); `pg_terminate_backend`; abort del client | Nessuna revisione/file/contatore parziale; retry con gli stessi `op_id` → 40 accettate, `seq` contigui, secondo retry identico, nessun duplicato                                                                  |
| Upload blob / tus interrotto           | Proxy TCP che taglia la connessione dopo N byte                                                                          | Nulla pubblicato; HEAD riporta l'ultimo offset completo; ripresa e digest verificato; chunk corrotto → 400 e sessione scartata                                                                                    |
| `WriteAtomic`                          | Processo figlio con `os.Exit` dopo tmp-write, fsync, prima del rename, dopo il rename (crea e sovrascrive)               | Il target è sempre il vecchio o il nuovo contenuto, mai parziale                                                                                                                                                  |
| Pull con rete persa                    | Transport che taglia `changes` alla 2ª pagina o tronca un download (con errore e in silenzio)                            | Cursore = fine dell'ultima pagina applicata (o invariato), nessun file a metà, converge senza conflitti; il digest intercetta il troncamento silenzioso                                                           |
| Restart di PostgreSQL ×3               | `docker stop/start` sotto il cloud in esecuzione                                                                         | `/readyz` 503 con check `database`, `/healthz` resta 200, richieste → 500 problem+json con `code` (mai 401), pronto di nuovo in ~0,3 s, zero richieste fallite dopo la readiness, goroutine e connessioni stabili |
| SIGTERM                                | Commit in volo + SIGTERM                                                                                                 | `/readyz` 503 subito, servizio attivo durante il drain, la richiesta in volo termina 200, il processo esce da solo                                                                                                |

## Bug trovati e corretti

1. **Shutdown senza drain**: la readiness non cambiava prima dello stop e le connessioni SSE bloccavano `Shutdown` fino al timeout. Ora `httpserver.Serve`: readiness → 503, drain `SHUTDOWN_DRAIN` (default 5 s), chiusura degli stream, poi `Shutdown`. Misura su k3d con 3 repliche: rolling restart con drain 0 s = 9 timeout su 130 richieste (93,1 %), con 5 s = 0 falliti.
2. **File di staging mai esclusi**: `.memobrain-tmp-*` non era in `pathrules.IsExcluded`, quindi un crash durante `WriteAtomic` lasciava un file che `Walk` (sync, indicizzatore) vedeva e sincronizzava. Ora escluso; `FS.CleanStaleTemp` lo rimuove (> 1 min) al primo sync dell'engine.
3. **`changes` con cursore oltre `last_seq`** rispondeva una pagina vuota: dopo un PITR il client avrebbe saltato in silenzio i nuovi commit che riusano quei `seq`. Ora 410 `CURSOR_EXPIRED` (il client fa bootstrap; i file persi dal server vanno nel `.trash/` locale, non cancellati).
4. `authtest.New` aveva una data race (letta da un processo esterno prima dell'assegnazione di `Server`).

## Chaos sul chart Helm (k3d `memobrain-chaos-*`, 3 repliche API, sonda 10 Hz `GET /me` autenticato con token Keycloak reale, finestra ~170 s)

Kill SIGKILL ×3, delete graceful ×2, rolling restart, crash di PostgreSQL (SIGKILL al checkpointer): **`/me` 100 % (0/1562) escludendo il crash di PG; 99,885 % complessivo** (2 × 500 in ~0,2 s di crash recovery). Senza drain (0 s): 99,36 % escludendo PG. Il 99,9 % è dunque raggiunto _in finestra_ con ≥ 2 repliche e drain; su 1500 campioni la risoluzione è 0,07 %: **non dimostra 99,9 % mensile**.

**Lacune del chart** (da M7-WP3, non toccato): nessun PodDisruptionBudget; nessun anti-affinity/topologySpread; `SHUTDOWN_DRAIN` non impostato né `terminationGracePeriodSeconds` esplicito (deve essere > drain + `SHUTDOWN_TIMEOUT`); readiness con `periodSeconds 10`, `timeout 1s`; strategia di default 25 %/25 % (meglio `maxUnavailable: 0`); `values-k3d` usa 1 replica (downtime a ogni rollout); PostgreSQL singolo pod (ogni suo guasto è downtime: serve HA o servizio gestito). Gli errori in outage sono 500 `INTERNAL`, non 503 con `Retry-After`: un codice `UNAVAILABLE` richiede modifica di OpenAPI (non fatta). Il desktop tratta i 5xx come errore, non come offline.

## Backup/PITR

`docs/runbook/backup-restore.md` provato da `scripts/chaos/restore-drill.sh` (container usa e getta): WAL archiving + `pg_basebackup`, distruzione del DB, **PITR a T eseguito** (a+b presenti, c assente), changelog `1..N` contiguo, blob scaricati con digest, coerenza DB↔bucket, oggetto cancellato/sovrascritto riparato dalle versioni, dump logico ripristinato; RTO del drill 33 s (dataset minuscolo). **RustFS supporta versioning e lifecycle**.

## Limiti

Nessun test di Keycloak, di PG HA né di GC dei blob tra T e restore; WAL su volume locale; RTO reale da misurare con dati veri.
