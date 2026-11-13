# Runbook: backup e restore (PostgreSQL + bucket S3)

Ambito: Cloud Service Clarae notanda (modular monolith) con PostgreSQL e uno store S3-compatibile per i blob. Requisito di riferimento: Appendice A, "Affidabilità dati: RPO ≤ 5 min (PITR PG, versioning bucket)". Il procedimento qui descritto è provato da `scripts/chaos/restore-drill.sh` su container usa e getta (esito in fondo).

## 1. Che cosa si protegge

| Dato                                                                          | Dove                     | Proprietà                                                                              | Come si protegge                                                               |
| ----------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Stato (utenti, vault, file, revisioni, changelog `seq`, share, quote, config) | PostgreSQL               | Fonte di verità; `seq` per vault monotono                                              | Base backup + archiviazione WAL continua (PITR); dump logico come seconda rete |
| Contenuto dei file                                                            | Bucket S3 `clarae-blobs` | Blob **content-addressed** (SHA-256) e immutabili; una chiave non cambia mai contenuto | Versioning del bucket + lifecycle sulle versioni non correnti                  |
| Export ZIP                                                                    | Bucket `clarae-exports`  | Temporanei (scadono)                                                                   | Nessun backup necessario                                                       |
| Identità                                                                      | Keycloak (DB proprio)    | Fuori dal perimetro di questo runbook                                                  | Backup del DB di Keycloak e export del realm, stessa disciplina                |

I vault privati sono E2EE: backup e restore contengono solo testo cifrato. Nessuna chiave è nel backup: la perdita di passphrase e recovery key resta non recuperabile (D-02).

## 2. Obiettivi (RPO / RTO)

- **RPO ≤ 5 minuti** (Appendice A). Si ottiene con WAL archiviati di continuo e `archive_timeout` ≤ 60 s (l'ultimo segmento parziale viene spedito entro 60 s); i blob non hanno finestra di perdita propria perché l'upload precede il commit del riferimento in DB e il bucket è durevole. Il valore da monitorare è l'età dell'ultimo WAL archiviato (alert se > 3 min).
- **RTO**: la specifica non ne fissa uno. Obiettivo proposto: **≤ 1 ora** per un database da 100 GB con base backup nello stesso datacenter; è dominato dalla copia del base backup e dal replay dei WAL, non dall'applicazione. Il drill misura solo il costo fisso (vedi §7): va ripetuto con un dataset realistico prima del rilascio 1.0.

## 3. Configurazione del backup

### 3.1 PostgreSQL (self-managed)

Parametri sul server (verificati dal drill):

```
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /wal-archive/%f && cp %p /wal-archive/%f'   # in produzione: pgBackRest / WAL-G verso S3 o NFS, mai sullo stesso disco del DB
archive_timeout = 60
```

- **Base backup**: `pg_basebackup -D <dir> -Ft -z -X stream -c fast` (giornaliero; ritenzione ≥ finestra PITR desiderata + 1 base backup). Sono equivalenti `pgBackRest backup` o `wal-g backup-push`, preferibili in produzione (incrementali, verifica, ritenzione).
- **Dump logico** (rete di sicurezza, non PITR): `pg_dump -Fc -f clarae.dump clarae`, settimanale. Serve per migrare/ispezionare, non per rispettare l'RPO.
- **Verifica**: ogni base backup va ripristinato da un job periodico (è ciò che fa il drill); un backup mai ripristinato non è un backup.

### 3.2 PostgreSQL gestito

Usare il PITR del servizio (RDS/Aurora, Cloud SQL, Azure Flexible Server, CloudNativePG con barman): abilitare la ritenzione dei backup ≥ 7 giorni e il PITR continuo; il ripristino crea una nuova istanza al timestamp scelto, poi si ripunta `DATABASE_URL` (stessi passi di §5 dal punto 3).

### 3.3 Bucket S3

- **Versioning attivo** su `clarae-blobs` (`PutBucketVersioning` = Enabled). Una cancellazione crea un _delete marker_, una sovrascrittura una nuova versione: entrambe reversibili.
- **Lifecycle**: scadenza delle sole versioni non correnti dopo N giorni, con **N ≥ finestra PITR** (consigliato 30), così un DB ripristinato a T trova ancora i blob che il GC ha tolto dopo T. Non impostare mai scadenza sulla versione corrente.
- Facoltativi: replica cross-region, Object Lock in modalità governance.
- **Supporto per backend**: il drill sonda lo store (`drilltool s3 probe`: due put, una delete, elenco delle versioni). **RustFS (`rustfs/rustfs:latest`, lo store di sviluppo) supporta versioning, delete marker, ripristino di versione e regole lifecycle** (esito del 2026-10-27); lo script ripiega su MinIO solo se la sonda fallisce. Per la produzione usare uno store che offra le stesse funzioni (AWS S3, MinIO, Ceph RGW) e rieseguire la sonda sul backend scelto.

## 4. Perché l'ordine conta (DB prima, poi i blob)

I blob sono immutabili e il DB li referenzia per hash. Ripristinando il DB a T:

1. il DB referenzia solo blob esistenti a T, quindi ciò che manca nel bucket può essere solo qualcosa **cancellato dopo T** (GC, errore operatore);
2. i blob creati dopo T restano nel bucket senza riga in DB: orfani innocui (nessuno li referenzia, occupano solo spazio; non vengono rimossi dal GC perché è guidato dalla tabella `blobs`);
3. il bucket non va mai riportato indietro nel tempo insieme al DB: è inutile e rischioso.

Perciò: si ripristina **prima il DB**, poi si **verifica la coerenza DB↔bucket** e si recuperano dalle versioni eventuali oggetti mancanti.

## 5. Procedura di restore (PITR)

Precondizione: stabilire il timestamp target **T** (UTC, es. l'ultimo istante prima dell'incidente) dal log di audit o dai log applicativi.

1. **Fermare il traffico e i job**: `kubectl scale deploy/<rel>-clarae-api deploy/<rel>-clarae-worker --replicas=0` (il worker esegue GC blob e manutenzione: non deve girare con DB e bucket in stati diversi).
2. **Ripristinare PostgreSQL a T**
   - Preparare un data directory vuoto, estrarre `base.tar.gz` e `pg_wal.tar.gz` del base backup scelto (anteriore a T) in `PGDATA` e `PGDATA/pg_wal`;
   - creare `recovery.signal`; in `postgresql.auto.conf`: `restore_command = 'cp /wal-archive/%f %p'`, `recovery_target_time = '<T>'`, `recovery_target_action = 'promote'`;
   - impostare proprietario `postgres` e modo `0700`, avviare. Il server riproduce i WAL fino a T e si promuove (nuova timeline). Il log riporta `recovery stopping before commit of transaction …, time <T>`.
   - Attenzione: il restore fallisce con "recovery ended before configured recovery target" se non esistono WAL **successivi** a T: forzare `SELECT pg_switch_wal()` prima dell'incidente non è possibile a posteriori, quindi usare un T anteriore all'ultimo WAL archiviato.
3. **Verificare il DB**: `SELECT pg_is_in_recovery()` deve dare `f`; conteggi di `vaults`, `files`, `file_revisions`; `max(last_seq)` per vault coerente con `max(seq)` di `file_revisions`.
4. **Verificare i blob** (coerenza DB↔bucket): per ogni riga di `blobs` con `ref_count > 0`, l'oggetto `blobs/<hh>/<hash>` esiste con la dimensione attesa. Lo fa `services/cloud/test/drilltool verify-blobs`; in alternativa `psql -Atc "select storage_key,size from blobs where ref_count>0"` confrontato con `aws s3api head-object`. Per ogni oggetto mancante o con dimensione diversa:
   - cancellato: rimuovere il _delete marker_ (`aws s3api delete-object --version-id <id-del-marker>`);
   - sovrascritto: rimuovere la versione corrente errata (la precedente torna corrente) o copiare la versione buona sopra la corrente;
   - nessuna versione disponibile: il blob è perso; i file che lo referenziano vanno cercati nei client (che mantengono la copia locale) e ricaricati.
5. **Riavviare** API e worker (`--replicas` originali). Il job di **manutenzione** (parte 30 s dopo l'avvio del worker, poi ogni 24 h) esegue `ReconcileUsage` e `ReconcileBlobRefs`: ricalcola contatori di quota e `ref_count` dal contenuto reale del DB e corregge la deriva; controllare nei log `usage drift corrected` / `blob ref count corrected` (attesi dopo un PITR) e l'assenza di `job failed`.
6. **Client** ([ADR-0046](../adr/0046-bootstrap-server-indietro.md)): i dispositivi che avevano già sincronizzato oltre T hanno un cursore **maggiore** dell'`last_seq` del server, oppure, se un altro dispositivo ha già ricaricato qualcosa, un cursore il cui `seq` è stato riusato da un cambiamento diverso (il client invia con il cursore anche l'id del cambiamento, `since_id`). In entrambi i casi il server risponde `410 CURSOR_EXPIRED` con `last_seq` e il client esegue il bootstrap da `/tree` in modalità _reconcile-upload_: le revisioni più recenti di quelle del server vengono ripubblicate come nuove revisioni, i file che il server non elenca più vengono ricaricati (non cestinati) e ciò che il server ha di più nuovo si applica come sempre; prima di ogni sovrascrittura il client salva la versione locale in _File recovery_. Il primo dispositivo che si collega ripubblica, gli altri ritrovano lo stesso contenuto o passano dal merge. Conseguenza voluta (D-04): un file cancellato dopo T può ricomparire. Informare gli utenti di controllare i file ricomparsi e, in caso di dubbi, _File recovery_. I desktop fino alla 1.3.1 non inviano `since_id` e reagiscono al bootstrap come prima (i file che il server ha perso finiscono nel cestino locale `.trash/`, mai cancellati definitivamente): aggiornarli prima di un ripristino, se possibile.
7. **Verifiche finali** (checklist): `/readyz` verde; login e `GET /me`; per un vault campione: `tree`, download di un blob con controllo SHA-256, `changes?since=0` con `seq` contigui; conteggio file e quota in Web UI; audit log: registrare l'evento di restore con T e operatore.

## 6. Ripristino puntuale di un oggetto del bucket (senza toccare il DB)

Caso: un blob è stato cancellato o sovrascritto, il DB è sano.

1. Individuare la chiave: `blobs/<primi 2 caratteri dell'hash>/<hash>`.
2. `aws s3api list-object-versions --bucket clarae-blobs --prefix <chiave>`: cercare delete marker (`IsLatest: true`) o la versione precedente.
3. Ripristinare come al punto 4 di §5 e rieseguire `verify-blobs`.
4. Nota: il server **non** verifica l'hash in lettura; è il client a farlo (`fetch` scarta il contenuto che non corrisponde al digest). Un oggetto corrotto in silenzio si manifesta come errore di sincronizzazione del client, non come errore del server.

## 7. Prova eseguita (restore drill)

`scripts/chaos/restore-drill.sh` (container `clarae-chaos-drill-*`, rimossi a fine esecuzione; report in `.dev/chaos/drill-*/report.md`):

1. PostgreSQL 17 con archiviazione WAL + store S3 (RustFS, con ripiego su MinIO se manca il versioning), cloud reale come processo;
2. dati creati via API (lotto a: 30 file, alcuni da ~300 KB), base backup + dump logico, versioning e lifecycle sul bucket;
3. lotto b (20 file), punto T, poi "incidente": b cancellato via API e lotto c creato dopo T;
4. guasti sul bucket: oggetto cancellato e oggetto sovrascritto, rilevati da `verify-blobs` e riparati dalle versioni;
5. **distruzione del database** (container + volume), **PITR a T**, riavvio del cloud, job di manutenzione;
6. verifica: file a+b presenti e c assente, ogni blob scaricato con digest corretto, changelog `1..N` contiguo, coerenza DB↔bucket, cursore avanti rifiutato con `CURSOR_EXPIRED`, nuove scritture accettate; ripristino del dump logico in un DB di prova con conteggi uguali.

I risultati dell'ultima esecuzione e i limiti sono riportati in `docs/adr/0022-resilience-details.md`.

Limiti noti del drill: dataset minuscolo (l'RTO reale va misurato con dati veri); PostgreSQL single-node; nessun test di Keycloak; WAL archiviati su volume locale (non su storage remoto); il job di GC dei blob non è stato fatto scattare tra T e il restore (coperto solo dal ragionamento di §4 e dal ripristino da versioni di §5.4).
