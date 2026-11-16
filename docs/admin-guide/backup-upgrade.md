# Backup, ripristino e upgrade

Le procedure operative dettagliate (PITR, prove di ripristino, RPO/RTO misurati) sono in `docs/runbook/backup-restore.md` (provate con un ripristino reale: `scripts/chaos/restore-drill.sh`). Qui i principi e i comandi essenziali.

## Cosa salvare

| Dato                                                                | Dove                            | Come                                                                              |
| ------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| Metadati (vault, file, revisioni, changelog, utenti, gruppi, audit) | PostgreSQL                      | `pg_dump` periodico **e** archiviazione WAL per il point-in-time recovery (PITR). |
| Blob dei file                                                       | bucket `S3_BUCKET_BLOBS`        | Versioning del bucket o replica verso un secondo bucket/regione.                  |
| Archivi di export                                                   | bucket `S3_BUCKET_EXPORTS`      | **Non** da salvare: sono temporanei e si rigenerano.                              |
| Realm Keycloak                                                      | database di Keycloak            | Backup del suo database + export del realm (`kc.sh export`).                      |
| Segreti e configurazione                                            | Secret Kubernetes / values Helm | Nel vostro gestore di segreti, mai nel repository.                                |

Database e storage vanno ripristinati **a istanti coerenti**: i blob sono immutabili e content-addressed, quindi un bucket _più recente_ del database è sicuro (blob orfani, che il GC rimuove dopo `blobs.gc_grace_hours`), mentre un bucket _più vecchio_ del database lascia revisioni che puntano a blob mancanti. Regola: ripristinare il database al punto desiderato e **non** far tornare indietro il bucket dei blob.

I **vault privati** sono cifrati dal client: un backup del server contiene solo dati cifrati e non sostituisce il backup della passphrase/recovery key dell'utente.

## Ripristino

1. Fermare le repliche (`kubectl scale deploy/clarae-api deploy/clarae-worker --replicas=0`).
2. Ripristinare il database (dump o PITR) e verificare che il bucket dei blob contenga almeno gli oggetti fino a quel momento.
3. Riavviare: le migrazioni mancanti si applicano da sole; la riconciliazione notturna corregge contatori di utilizzo e riferimenti blob.
4. I client che avevano sincronizzato modifiche successive al punto di ripristino se ne accorgono (cursore oltre il `last_seq` ripristinato, o numero di sequenza riusato da un altro cambiamento) e ripartono dal manifesto ripubblicando ciò che il server ha perso: le revisioni più recenti tornano sul server come nuove revisioni e i file che il server non conosce più vengono ricaricati, invece di essere sovrascritti o cestinati (ADR-0046, nessuna perdita silenziosa). Prima di ogni sovrascrittura il client salva la versione locale in _File recovery_. Un file cancellato dopo il punto di ripristino può ricomparire. Serve il desktop della versione successiva alla 1.3.1 (e il workbench web dello stesso cloud): le versioni precedenti spostano nel cestino locale `.trash/` i file che il server ha perso. Procedura completa nel [runbook](../runbook/backup-restore.md).

## Aggiornare senza perdere il database

Un aggiornamento che riparte da un database vuoto non dà errori: il servizio crea lo schema da capo e si avvia **senza utenti, vault e registro di audit**. Succede quando cambia il posto in cui vive il database. Per evitarlo:

1. **Stesso namespace, stessa release, stesso volume.** Con Helm: lo stesso `-n <namespace>`, lo stesso nome della release (`helm -n <namespace> list`) e lo stesso `PersistentVolumeClaim` di PostgreSQL (`kubectl -n <namespace> get pvc`: deve esserci quello che c'era, per esempio `postgres-data`). Un namespace o una release con un altro nome ripartono con un volume nuovo. Con Compose: lo stesso `COMPOSE_PROJECT_NAME`, insieme a `DB_EXPECT_INITIALIZED=true` in `.env` (non ha default proprio per questo: un altro nome crea volumi vuoti, vedi [migrazione](migrazione-clarae.md)).
2. **`pg_dump` prima di ogni aggiornamento**, anche se la migrazione sembra innocua. Esempio con PostgreSQL nello stesso namespace (adattare nomi e utente):

   ```sh
   kubectl -n <namespace> exec deploy/postgres -- pg_dump -U <utente> -Fc <database> > clarae-$(date +%F).dump
   ```

   Se Keycloak usa lo stesso PostgreSQL (database `keycloak`), salvare anche quello: il realm, gli utenti e le sessioni sono lì. Controllare che il file non sia vuoto (`pg_restore -l clarae-….dump | head`) e tenerlo fuori dal cluster.

3. **Lasciare attiva la guardia `DB_EXPECT_INITIALIZED`.** Il chart Helm la imposta da solo a ogni `helm upgrade` (`.Release.IsUpgrade`): con un database vuoto i ruoli `api` e `all` non creano lo schema ed escono con un errore che chiede di controllare `DATABASE_URL` (namespace, release, volume) o di ripristinare un dump. Per forzarla in `values` metterla in `config` (`DB_EXPECT_INITIALIZED: 'true'`); per una **nuova installazione voluta** su un database vuoto passata da un upgrade (per esempio il nuovo tentativo di una prima installazione fallita) metterla a `'false'`. Con Compose si imposta in `.env` (`DB_EXPECT_INITIALIZED=true`, riga commentata in `deploy/compose/.env.example`), dopo il primo avvio. Vedi [configurazione](configurazione.md#database).
4. **Dopo l'aggiornamento, leggere la riga `database state`** nel log del primo pod `api` (`kubectl -n <namespace> logs deploy/clarae-api | grep 'database state'`). Riporta `schema_version`, `schema_expected`, `audit_rows` e `audit_first_at`. Con un database che era in uso, `audit_rows` non è zero e `audit_first_at` precede l'aggiornamento: la riga più vecchia del registro non avanza mai.

**Se il registro di audit sembra sparito**, in sola lettura sul database del servizio (`psql "$DATABASE_URL"`):

```sql
SELECT version_id, tstamp FROM goose_db_version ORDER BY id;  -- quando è stato creato lo schema
SELECT min(at), count(*) FROM audit_log;                      -- la riga più vecchia e quante sono
SELECT min(created_at) FROM users;                            -- il primo utente
```

Se la data dello schema, quella della prima riga di audit e quella del primo utente coincidono con il giorno dell'aggiornamento, il database è stato **ricreato**: nessuna migrazione e nessun job cancella `audit_log` (la sola `UPDATE` è l'anonimizzazione di un utente, che toglie indirizzo di rete e nome utente dai dettagli e conserva le righe). Il vecchio database, se esiste ancora, è in un altro volume: `kubectl get pvc -A` mostra se c'è il `postgres-data` di un altro namespace (con una classe di storage `retain` il volume sopravvive alla cancellazione del namespace). Recuperarlo con `pg_dump` dal vecchio volume e **ripristinare con un piano** (la procedura è nel [runbook](../runbook/backup-restore.md)): non si fa in automatico.

## Upgrade

- Il servizio applica le **migrazioni SQL** (goose) all'avvio delle repliche API (`--role=api`/`all`), una alla volta grazie a un advisory lock PostgreSQL; il worker non migra e attende che lo schema raggiunga la versione del proprio binario prima di eseguire i job. Sono pensate per essere compatibili con la versione precedente (aggiunte, non rimozioni) così che un rolling update con repliche miste funzioni; le eccezioni sono segnalate nelle note di rilascio (`docs/release/README.md`).
- **Prima di aggiornare:** backup del database (`pg_dump`, vedi [Aggiornare senza perdere il database](#aggiornare-senza-perdere-il-database)); stesso namespace, release e volume; leggere le note di rilascio; verificare le nuove variabili in [configurazione](configurazione.md).
- **Versione con la migrazione `0016_device_hostname` (M21, dopo la 1.7.1):** aggiunge `devices.hostname` e un indice unico, e **revoca i dispositivi desktop duplicati** (stesso utente, piattaforma e nome del computer) lasciando attivo il più recente; nessuna riga si cancella. Un client che ricorda un dispositivo revocato propone «Registra di nuovo questo dispositivo». La migrazione è additiva: tornare all'immagine precedente non richiede il ripristino, ma i dispositivi revocati restano tali.
- **Dalla 1.x alla 1.5 (Clarae notanda):** seguire [la guida di migrazione](migrazione-clarae.md) (righe da aggiungere al `.env` di Compose, `nameOverride` di Helm, redirect Keycloak, metriche). Nessuna migrazione del database, e il rollback alla 1.4.0 non richiede il ripristino del backup. I client desktop non si aggiornano da soli: aggiornare ogni dispositivo dei vault collegati prima di portare il cloud alla 1.7, perché da quella versione `features.config_dir_v2` è acceso per default (sezione «Client desktop e cartella di configurazione dei vault» della guida).
- **Alla 1.7 (da 1.5 o 1.6):** ordine in [Aggiornare alla 1.7](migrazione-clarae.md#aggiornare-alla-17): prima i dispositivi, poi i riferimenti all'immagine (`ghcr.io/<owner>/clarae-cloud`: la 1.7 non pubblica più l'immagine con il nome della 1.x), poi il cloud. **Mai un pod 1.4 o precedente insieme a un pod 1.7 sullo stesso database**: da una 1.4 o precedente si passa per la 1.5 o la 1.6. Nessuna migrazione del database; il ritorno alla 1.4.0 è possibile solo se nessun pod 1.7 è in esecuzione.
- **Procedura Helm:** `helm upgrade clarae deploy/helm/clarae -f my-values.yaml --set image.tag=<nuova>`; osservare `readyz`, la dashboard e i log del primo pod.
- **Compatibilità client:** il protocollo di sync è versionato; i client più vecchi continuano a funzionare finché il server accetta la loro versione. Le versioni minime supportate saranno riportate nelle note di rilascio.
- **Formati v2 dei vault privati (dalla 1.3.0).** Il cloud distribuisce `features.envelope_v2` e `features.path_v2` accesi per default (ADR-0034, ADR-0042): i client scrivono gli envelope della chiave e i token dei path in formato v2, e riscrivono in background i token `enc1` rimasti. I desktop fino alla **1.2.4** non sanno aprire un envelope v2 né leggere un path `enc2`: non sbloccano più un vault con envelope v2, e saltano i file con un path `enc2`. Se ripartono dall'albero del server, per esempio dopo un nuovo collegamento, spostano anche nel cestino del sistema le loro copie locali di quei file. Sul cloud non si perde nulla: chiave, contenuto e storico restano gli stessi, e dopo l'aggiornamento del desktop tutto torna leggibile. Ordine consigliato:
  1. aggiornare tutti i desktop alla nuova versione (il workbench web è servito dal cloud ed è sempre aggiornato);
  2. aggiornare il cloud.

  Se dei dispositivi devono restare indietro, impostare prima `"features": {"envelope_v2": false, "path_v2": false}` nel profilo globale e toglierlo quando sono aggiornati. Spegnere i flag ferma solo i nuovi upgrade e la migrazione: un vault o un tipo di envelope che un client ha già visto in v2 resta v2 su quel client.

- **Rollback:** tornare all'immagine precedente è sicuro solo se la migrazione era retrocompatibile; altrimenti ripristinare il backup del database. Per questo il backup precede sempre l'upgrade.
