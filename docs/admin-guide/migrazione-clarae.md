# Migrazione a Clarae notanda (da MemoBrain Notes 1.x)

Dalla 1.5 il prodotto si chiama **Clarae notanda** e gli identificatori passano da `memobrain` a `clarae` (ADR-0052). Un cloud già in esercizio **non cambia nome da solo e non perde dati**: il Cloud Service accetta i nomi della 1.x finché non li sostituite voi, e i client desktop 1.4.0 continuano a funzionare contro un cloud 1.5. Questa pagina elenca che cosa cambia, che cosa aggiungere alla configurazione esistente e come verificare l'aggiornamento. Vale per un aggiornamento da 1.x; un'installazione nuova usa i nomi nuovi e non ha niente da migrare.

Il codice 1.5 **non** richiede migrazioni del database (nessuna migrazione nuova rispetto alla 1.4.0), non ricrea il realm Keycloak, i bucket o i volumi, e non tocca i vault.

## Aggiornare alla 1.7

La 1.7.0 toglie tre compatibilità con la 1.x che la 1.5 teneva in piedi e che la 1.6 non aveva ancora tolto (ADR-0052; la decisione di spostarle dalla 1.6 alla 1.7 è del 2026-11-15). Se arrivate dalla 1.5 o dalla 1.6, l'ordine è questo:

1. **Aggiornate ogni dispositivo dei vault collegati alla 1.5 o successiva.** Dalla 1.7 `features.config_dir_v2` è acceso per default: il client sposta le impostazioni sincronizzate nella cartella `.clarae/`, e un dispositivo 1.4 o precedente non le vede più (vedi [Client desktop e cartella di configurazione dei vault](#client-desktop-e-cartella-di-configurazione-dei-vault)). Se non potete aggiornarli tutti prima, impostate `"features": {"config_dir_v2": false}` nel profilo globale o in quello di un gruppo, e toglietelo quando l'ultimo dispositivo è aggiornato. Un client 1.7 contro un cloud 1.5 o 1.6 non sposta nulla (quel cloud distribuisce `false`): aggiornare i dispositivi prima del cloud è sempre sicuro.
2. **Controllate i riferimenti all'immagine.** La release 1.7 pubblica solo `ghcr.io/<owner>/clarae-cloud`: non esiste `memobrain-cloud:1.7.x` e il pull fallirebbe. Se nel `.env` di Compose `MEMOBRAIN_IMAGE` o `CLARAE_IMAGE` puntano a `ghcr.io/<owner>/memobrain-cloud`, o se nei valori di Helm `image.repository` è `ghcr.io/<owner>/memobrain-cloud`, cambiateli in `clarae-cloud` oppure togliete l'override: i default di Compose e del chart sono già `clarae-cloud`. Fatelo **prima** di portare la versione a 1.7. I tag 1.5 e 1.6 con il vecchio nome restano nel registry.
3. **Non fate mai girare un pod 1.4 (o precedente) insieme a un pod 1.7 (o successivo) sullo stesso database.** Dalla 1.7 gli advisory lock di blob, quota degli upload ed export hanno solo il nome `clarae.*`; un pod 1.4 prende solo `memobrain.*`, quindi i due non si escluderebbero più (due upload dello stesso blob o due controlli di quota dello stesso utente potrebbero correre insieme). Da una 1.4 o precedente si passa per la 1.5 o la 1.6 e solo dopo alla 1.7. Le versioni 1.5 e 1.6 convivono sia con la 1.4 sia con la 1.7, quindi l'aggiornamento a rotazione 1.6 → 1.7 è sicuro.
4. **Aggiornate il cloud alla 1.7** (Compose: `CLARAE_VERSION`; Helm: `--version`). Nessuna migrazione del database in questa versione.

Il resto della compatibilità (variabili `MEMOBRAIN_*` del Compose, `nameOverride: memobrain`, realm, schema `memobrain://`, servizio gRPC `memobrain.v1`, …) resta fino a una release major successiva alla 2.0 (ADR-0070), come nella [tabella delle rimozioni](#variabili-deprecate-e-rimozioni).

## Che cosa cambia e che cosa resta

| Voce                                              | 1.x                                                                           | 1.5                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binario e immagine                                | `memobrain-cloud` (`ghcr.io/<owner>/memobrain-cloud`)                         | `clarae-cloud`; la 1.5 e la 1.6 pubblicano l'immagine **anche** con il vecchio nome; **dalla 1.7 solo `clarae-cloud`** (i tag 1.5 e 1.6 con il vecchio nome restano nel registry)                                                                                                            |
| Chart Helm                                        | `memobrain` (`oci://ghcr.io/<owner>/charts/memobrain`)                        | `clarae` (`oci://ghcr.io/<owner>/charts/clarae`); per non cambiare nomi e selector degli oggetti: `nameOverride: memobrain`                                                                                                                                                                  |
| Realm Keycloak                                    | `memobrain`                                                                   | un realm esistente **non cambia** e resta `memobrain`; un'installazione nuova importa `clarae`                                                                                                                                                                                               |
| Client OIDC                                       | `memobrain-desktop`, `memobrain-web`, `memobrain-admin-svc`                   | invariati nel realm esistente (valgono da soli se il realm è `memobrain`); `clarae-*` nei realm nuovi                                                                                                                                                                                        |
| Audience del token                                | `memobrain-api`                                                               | invariata con il realm `memobrain`; `clarae-api` nei realm nuovi                                                                                                                                                                                                                             |
| Ruoli del realm                                   | `memobrain-admin`, `memobrain-user`                                           | `clarae-admin`, `clarae-user` nei realm nuovi; il servizio riconosce come amministratore **entrambi** i nomi (`OIDC_ADMIN_ROLES`)                                                                                                                                                            |
| Bucket S3                                         | `memobrain-blobs`, `memobrain-exports`                                        | invariati con il realm `memobrain`; `clarae-blobs`, `clarae-exports` altrimenti                                                                                                                                                                                                              |
| Compose: progetto, utente e database              | `memobrain-onprem`, `memobrain`, `memobrain`                                  | invariati, ma ora **vanno dichiarati nel `.env`** (`COMPOSE_PROJECT_NAME`, `POSTGRES_USER`, `POSTGRES_DB`, `KC_REALM`)                                                                                                                                                                       |
| Variabili d'ambiente                              | `MEMOBRAIN_HOST`, `_SITE`, `_IMAGE`, `_VERSION`, `_ALLOW_PLACEHOLDER_SECRETS` | `CLARAE_*` equivalenti; il nome `MEMOBRAIN_*` vale ancora se il nuovo non è impostato, con un warning (solo `ALLOW_PLACEHOLDER_SECRETS` lo registra nel log del servizio)                                                                                                                    |
| Servizio gRPC delle notifiche                     | `memobrain.v1.NotifyService`                                                  | `clarae.v1.NotifyService`; il servizio `memobrain.v1` resta attivo, servito dallo stesso codice, per i client 1.4.0                                                                                                                                                                          |
| Prefisso delle metriche Prometheus                | `memobrain_*`                                                                 | `clarae_*`; con il realm `memobrain` il servizio **continua a esporre `memobrain_*`** finché non impostate `METRICS_NAMESPACE`                                                                                                                                                               |
| Schema URL del client desktop                     | `memobrain://auth/callback`                                                   | `clarae://auth/callback`; il realm esistente va aggiornato (vedi [Keycloak](#keycloak))                                                                                                                                                                                                      |
| Advisory lock di PostgreSQL (blob, quota, export) | nomi `memobrain.*`                                                            | nomi `clarae.*`; nella 1.5 e nella 1.6 ogni transazione prende **prima** il lock con il nome vecchio e poi quello nuovo, così repliche 1.4 e 1.5 si escludono durante un aggiornamento a rotazione; **dalla 1.7 solo `clarae.*`** (una replica 1.4 o precedente non deve girare con una 1.7) |

**Invariato:** schema e dati del database, vault e blob, URL pubblici e path REST (`/api/v1`), URL dell'issuer e utenti Keycloak, sessioni e token già emessi, formato e chiavi dei vault privati (E2EE, le etichette crittografiche non cambiano), password e segreti.

## Docker Compose

1. **Salvate il `.env`** e fate un backup (vedi [backup e upgrade](backup-upgrade.md)).
2. Aggiungete al `.env` le **quattro** righe che identificano l'installazione. Non hanno più un default e `docker compose` rifiuta di partire senza (con un messaggio che dice quale manca): un default col nome nuovo avvierebbe lo stack su volumi vuoti e un secondo realm.

   ```sh
   COMPOSE_PROJECT_NAME=memobrain-onprem
   POSTGRES_USER=memobrain
   POSTGRES_DB=memobrain
   KC_REALM=memobrain
   ```

   Se nel `.env` della 1.x avevate già un `COMPOSE_PROJECT_NAME` diverso, tenete quello: il nome del progetto prefissa i volumi (`<progetto>_pgdata`, `<progetto>_s3data`) e un altro nome ne creerebbe di vuoti (`docker volume ls` mostra quelli esistenti). Utente e database di PostgreSQL sono fissati alla creazione del volume.

3. **Immagine e versione.** Con `MEMOBRAIN_IMAGE` e `MEMOBRAIN_VERSION` nel `.env` basta cambiare `MEMOBRAIN_VERSION` a `1.5.1` (la 1.5.0 non è stata pubblicata): la 1.5 e la 1.6 sono pubblicate anche come `memobrain-cloud`, la 1.7 **no**. Passate ai nomi nuovi prima della 1.7: `CLARAE_IMAGE=ghcr.io/<owner>/clarae-cloud` e `CLARAE_VERSION=1.5.1` (`CLARAE_*` vince su `MEMOBRAIN_*`), oppure togliete `CLARAE_IMAGE` e `MEMOBRAIN_IMAGE` e usate il default `ghcr.io/e2br/clarae-cloud`. Lo stesso vale per `MEMOBRAIN_HOST` → `CLARAE_HOST` e `MEMOBRAIN_SITE` → `CLARAE_SITE`.
4. **Non cambiate** `KC_REALM`, i bucket, i segreti, i volumi. Con `KC_REALM=memobrain` il servizio usa da solo audience, client e bucket della 1.x, e il namespace delle metriche `memobrain`: non serve impostare altro.
5. `docker compose config -q`, poi `docker compose pull && docker compose up -d`.

Il servizio `s3-init` crea i bucket con lo stesso criterio del servizio. Se `KC_REALM` fosse `clarae` ma i dati fossero ancora nei bucket della 1.x (e `S3_BUCKET_BLOBS` non fosse impostato), `s3-init` e il Cloud Service **rifiutano di partire** e indicano la variabile da impostare (`S3_BUCKET_BLOBS=memobrain-blobs`, `S3_BUCKET_EXPORTS=memobrain-exports`): senza questo controllo verrebbe creato un bucket vuoto e tutti i blob risulterebbero mancanti.

Keycloak parte con `--import-realm`: se il realm `KC_REALM` esiste già l'import viene saltato e il realm non viene toccato. Per questo `KC_REALM` deve essere il nome del realm esistente: con un altro nome Keycloak ne creerebbe uno **nuovo e vuoto** accanto al primo.

## Helm

Il nome del chart cambia (`clarae`) e con esso il nome predefinito degli oggetti e dei selector dei pod. I selector di un Deployment sono **immutabili**: senza `nameOverride`, `helm upgrade` fallirebbe con un errore di campo immutabile. Per aggiornare sul posto, impostate `nameOverride: memobrain` nel file dei valori, **in modo permanente** (serve a ogni aggiornamento successivo, non solo al primo):

```yaml
# values.yaml dell'installazione
nameOverride: memobrain
```

```sh
helm upgrade <release> oci://ghcr.io/<owner>/charts/clarae --version 1.5.1 -f values.yaml --dry-run   # i nomi degli oggetti sono quelli di prima
helm upgrade <release> oci://ghcr.io/<owner>/charts/clarae --version 1.5.1 -f values.yaml
```

Con `nameOverride: memobrain` gli oggetti restano `<release>-memobrain`, `<release>-memobrain-api`, `<release>-memobrain-worker`, `<release>-memobrain-grpc` e le etichette `app.kubernetes.io/name: memobrain`, come nella 1.x (`task helm-check` verifica questo rendering con `ci/values-legacy.yaml`). `fullnameOverride`, se lo volete, sostituisce l'intero nome `<release>-<nome>`.

Differenze dei valori rispetto alla 1.x:

- `config:` non elenca più `OIDC_AUDIENCE`, `OIDC_ALLOWED_AZP`, `S3_BUCKET_BLOBS`, `S3_BUCKET_EXPORTS`, `KC_REALM`, `KC_ADMIN_CLIENT_ID`: li decide il servizio dall'issuer (realm `memobrain` → nomi della 1.x, altrimenti `clarae-*`). Un valore impostato nei vostri `values` continua a vincere. **Attenzione:** se il vostro realm **non** si chiama `memobrain` ma i client usano i nomi `memobrain-*` e vi affidavate ai default del chart 1.x, impostate esplicitamente in `config:` `OIDC_AUDIENCE`, `OIDC_ALLOWED_AZP`, `OIDC_DESKTOP_CLIENT_ID`, `OIDC_WEB_CLIENT_ID`, `KC_ADMIN_CLIENT_ID` e i bucket: all'avvio il servizio scrive nel log il riepilogo `names in use` con i nomi effettivi.
- `ingress.grpc.legacyPath` (default `/memobrain.v1.NotifyService`): con `ingress.grpc.mode: path` l'Ingress gRPC instrada anche il servizio della 1.x; con `mode: host` ogni path va al servizio. Vuoto = non instradato.
- `image.repository` di default è `ghcr.io/e2br/clarae-cloud`. Se i vostri valori impostano `ghcr.io/<owner>/memobrain-cloud` continua a funzionare per la 1.5 e la 1.6, ma **non per la 1.7**, che non pubblica quell'immagine: passate a `ghcr.io/<owner>/clarae-cloud` (o togliete l'override) prima di portare la versione a 1.7.
- `config.CLARAE_ALLOW_PLACEHOLDER_SECRETS` (e, fino a una release major successiva alla 2.0 (ADR-0070), `config.MEMOBRAIN_ALLOW_PLACEHOLDER_SECRETS`) per le prove con segreti segnaposto.
- `values.schema.json` accetta `nameOverride`, `fullnameOverride` e `ingress.grpc.legacyPath`.

Durante l'aggiornamento a rotazione dalla 1.4 alla 1.5 (o alla 1.6) girano per un po' repliche vecchie e nuove insieme: gli advisory lock a doppio nome le tengono in mutua esclusione (nessuna azione richiesta). Questo vale **solo fino alla 1.6**: dalla 1.7 il doppio nome non c'è più e una replica 1.4 o precedente non deve girare insieme a una 1.7 (vedi [Aggiornare alla 1.7](#aggiornare-alla-17)).

## Keycloak

**Il realm esistente non si reimporta e non si rinomina.** Cambiarne il nome cambierebbe l'URL dell'issuer e invaliderebbe sessioni, token e configurazioni dei client. Si fanno solo due cose, entrambe facoltative per il funzionamento del cloud ma consigliate:

1. **Redirect del client desktop.** Nel client `memobrain-desktop` del realm aggiungete ai _Valid redirect URIs_ `clarae://auth/callback` e ai _Valid post logout redirect URIs_ `clarae://auth/logout`, **tenendo** quelli `memobrain://auth/callback` e `memobrain://auth/logout` (servono ai client 1.4.0). Finché manca il redirect nuovo, secondo ADR-0052 il client desktop 1.5 ricade sul vecchio. I realm importati dalla 1.5 (`deploy/keycloak*/realm-clarae.json`) hanno già entrambi.
2. **Ruoli (rinomina facoltativa).** Il servizio riconosce come amministratore chi ha `clarae-admin` **oppure** `memobrain-admin` (`OIDC_ADMIN_ROLES`, default `clarae-admin,memobrain-admin`): non serve rinominare niente. Se rinominate il ruolo nella console Keycloak, le assegnazioni restano; i token già emessi continuano a portare il vecchio nome fino al rinnovo, e per questo i due nomi sono accettati insieme. Dalla console admin del cloud, la promozione assegna il primo ruolo della lista presente nel realm, e la revoca toglie tutti quelli posseduti (un realm con il solo `memobrain-admin` continua a funzionare). Restringere l'elenco a un solo nome richiede di impostare `OIDC_ADMIN_ROLES` e dura finché il nome della 1.x non viene rimosso (in una release major successiva alla 2.0, ADR-0070).

I client `memobrain-web`, `memobrain-admin-svc` e il service account non cambiano. Lo scope che aggiunge `aud=memobrain-api` resta com'è.

## Metriche

Con il realm `memobrain` il servizio **mantiene il namespace `memobrain`** (`memobrain_http_requests_total`, …): dashboard e alert della 1.x continuano a funzionare. La dashboard e gli alert distribuiti con la 1.5 (`deploy/observability`) interrogano invece `clarae_*`, quindi su un'installazione della 1.x risultano vuoti finché non scegliete:

- **passare ai nomi nuovi:** impostate `METRICS_NAMESPACE=clarae` (Compose: nel `.env`; Helm: in `config:`), riavviate e **reimportate dashboard e regole di alerting** dalla 1.5 (le serie con il vecchio prefisso smettono di aggiornarsi e le regole vecchie non scattano più);
- **restare sui nomi vecchi:** non fate niente e continuate con la dashboard e le regole della 1.x, oppure sostituite il prefisso `clarae_` con `memobrain_` in quelle della 1.5.

`METRICS_NAMESPACE` ammette lettere minuscole, cifre e `_`, senza cifra iniziale; un valore non valido fa fallire l'avvio.

## Client desktop e cartella di configurazione dei vault

Il cloud non aggiorna i client. Le build desktop pubblicate non hanno l'aggiornamento automatico: ogni utente installa la 1.5 a mano (passi per sistema operativo in [Aggiornare dalla 1.x](../user-guide/installazione.md#aggiornare-dalla-1x)), e un client 1.4.0 e uno 1.5 possono usare lo stesso vault cloud nello stesso periodo.

- **Cartella di configurazione dei vault.** La 1.5 la chiama `.clarae/` (prima `.memobrain/`). All'apertura di un vault sposta nella nuova la parte locale (indice, stato di sincronizzazione, snapshot, layout), che non viaggia nel cloud. Le **impostazioni sincronizzate** (editor, scorciatoie, aspetto, template, …) di un vault **collegato** restavano nella vecchia cartella nella 1.5 e nella 1.6, perché un client 1.4.0 dello stesso vault le legge e le scrive lì: spostarle subito gliele farebbe ricreare, con conflitti. Dalla 1.7 si spostano per default (vedi sotto).
- **Lo spostamento lo comanda il Config Profile**, con la chiave `features.config_dir_v2` (default `false` nella 1.5 e nella 1.6, **`true` dalla 1.7**, vedi [la tabella delle chiavi](profili-quote-audit.md)). Acceso, il client sposta ogni impostazione sincronizzata nella cartella nuova come un normale spostamento di file (stesso id e stessa cronologia), a fine ciclo, solo per file senza modifiche locali, in modo ripristinabile dopo un'interruzione. Spento, il client legge entrambe le cartelle e non sposta nulla. Spegnerlo ferma solo gli spostamenti: quelli fatti restano dove sono.
  - **Parte solo dopo aver letto un profilo del server**, fresco o in cache: senza (non collegati, primo avvio offline, nessuna cache) il client non sposta nulla, così un'organizzazione che ha spento la chiave apposta ha voce prima che parta lo spostamento.
  - **Il cloud decide il valore.** Un cloud 1.7 distribuisce `true`, uno 1.5 o 1.6 `false`: un client 1.7 contro un cloud più vecchio non sposta nulla. Per questo **aggiornate prima ogni dispositivo dei vault collegati, poi il cloud**.
  - **Per non spostare**, impostate `"features": {"config_dir_v2": false}` nel profilo globale o in quello di un gruppo e toglietelo quando ogni dispositivo è aggiornato.
  - **Un vault non collegato** e **un mount in sola lettura** non vengono spostati dal motore di sincronizzazione.
  - **Un dispositivo 1.4 rimasto sul vault dopo lo spostamento** non vede le impostazioni nella cartella nuova, scrive le sue in quella vecchia e ricrea quelle che non trova: restano due copie, con id diversi, da riconciliare a mano. Il motore non sposta un file se nella cartella nuova c'è già quel nome, quindi non si perdono dati.
  - **Limite noto:** se nella stessa sessione si passa a un altro server la cui cache è fresca, il valore del server precedente vale fino al refresh successivo.
- **Un vault non collegato** sposta le sue impostazioni all'apertura; se poi si collega al cloud con la chiave spenta, il client le rimette nella cartella vecchia (un file già presente lì resta com'è).
- **Pulizia della cartella vecchia (dalla 1.7.2, ADR-0059).** Le versioni dalla 1.5 alla 1.7.1 non cancellavano mai nulla della vecchia cartella: se un file esisteva in entrambe, vinceva `.clarae/` e la copia legacy restava per sempre, sul disco e, per un vault collegato, anche sul server. La 1.7.2 ripulisce:
  - **sul dispositivo**, all'apertura di ogni vault e **una volta per versione dell'app**: toglie dalla vecchia cartella ciò che `.clarae/` ha già (indice, stato di sync, layout, cache, snapshot identici, file di sistema come `.DS_Store`) e rimuove la cartella se resta vuota; le impostazioni diverse di un vault non collegato vanno nel cestino del vault (`.trash/`). Non tocca il `sync.db` in uso né ciò che esiste solo lì;
  - **sul server**, per un vault collegato e **solo con `features.config_dir_v2` acceso, cioè con un cloud ≥ 1.7**: se `.clarae/<nome>` esiste già, il client cancella la riga della vecchia cartella con una normale operazione di cancellazione (la revisione resta nello storico) e toglie il file dal disco (nel cestino del vault se il contenuto era diverso). Con un cloud 1.5 o 1.6 la chiave è `false`, e la parte sincronizzata non si ripulisce;
  - **nello ZIP** scaricato dalla Web UI: i file della vecchia cartella escono sotto `.clarae/`, e se lo stesso nome esiste in `.clarae/` vince quello.

  **Un dispositivo 1.4 o precedente** rimasto su un vault ricrea le impostazioni che non trova nella cartella vecchia: l'ordine non cambia (prima i dispositivi, poi il cloud).

- **Cosa non entra nel cloud:** i client non scrivono mai in locale un percorso remoto che non sincronizzano (database, cache, layout del dispositivo): un `sync.db` caricato in un vault privato da un client vecchio viene ignorato.
- **File dei vault:** i disegni (`.excalidraw`) e le presentazioni (`.marp`) scritti dalla 1.x si leggono sempre. La 1.5 scrive i nomi nuovi solo quando un file viene modificato, e un client 1.4.0 non li riconosce: su un disegno toccato dalla 1.5 non vede più le formule modificabili né l'ordine delle diapositive, su una presentazione mostra le slide escluse. Per questo conviene aggiornare tutti i dispositivi insieme.
- **Vault privati (E2EE):** le etichette crittografiche non cambiano, quindi i vault esistenti si aprono con le stesse passphrase e chiavi di recupero.

## Variabili deprecate e rimozioni

| Che cosa                                                                                        | Rimozione                  |
| ----------------------------------------------------------------------------------------------- | -------------------------- |
| Immagine pubblicata anche come `memobrain-cloud`                                                | 1.7 (eseguita nella 1.7.0) |
| Advisory lock con il nome `memobrain.*` (presi prima di quelli nuovi)                           | 1.7 (eseguita nella 1.7.0) |
| Default `false` di `features.config_dir_v2` (diventa acceso)                                    | 1.7 (eseguita nella 1.7.0) |
| Variabili `MEMOBRAIN_HOST`, `_SITE`, `_IMAGE`, `_VERSION`, `_ALLOW_PLACEHOLDER_SECRETS`         | major dopo la 2.0          |
| Default della 1.x per il realm `memobrain` (audience, client, bucket, namespace delle metriche) | major dopo la 2.0          |
| Ruolo admin `memobrain-admin` nel default di `OIDC_ADMIN_ROLES`                                 | major dopo la 2.0          |
| Servizio gRPC `memobrain.v1.NotifyService` e `ingress.grpc.legacyPath`                          | major dopo la 2.0          |
| Redirect `memobrain://` nei realm                                                               | major dopo la 2.0          |

Le release di rimozione sono quelle scritte nei commenti del codice e in `scripts/rebrand/allowlist.tsv`; se cambiano, cambiano lì e qui. Le tre rimozioni che la 1.5.0 indicava per la **1.6** sono passate alla **1.7** (decisione del 2026-11-15): la 1.6.0 non toglie nulla e la 1.7.0 le esegue tutte e tre (ordine di aggiornamento in [Aggiornare alla 1.7](#aggiornare-alla-17)). Le rimozioni indicate per la **2.0** sono passate a una release major successiva (decisione del 2026-11-27, ADR-0070): la 2.0.0 non toglie nulla.

## Rollback

Il database non ha migrazioni nuove: tornare alla 1.4.0 non richiede di ripristinare il backup. **Dalla 1.7 il ritorno alla 1.4.0 è possibile solo se nessun pod 1.7 è più in esecuzione**: i pod 1.4 e 1.7 insieme sullo stesso database non si escluderebbero sui lock di blob, quota ed export. Tornare dalla 1.7 alla 1.5 o alla 1.6 non ha questo vincolo.

- **Compose:** riportate la versione a `1.4.0` (`MEMOBRAIN_VERSION`, o `CLARAE_VERSION`) e l'immagine a `ghcr.io/<owner>/memobrain-cloud` (`MEMOBRAIN_IMAGE`), poi `docker compose up -d`. Le righe aggiunte al `.env` sono innocue per la 1.x.
- **Helm:** `helm rollback <release> <revisione>` (con `nameOverride: memobrain` selector e nomi sono gli stessi in entrambe le versioni).
- I client desktop 1.5 contro un cloud 1.4 non trovano `clarae.v1.NotifyService` (`UNIMPLEMENTED`): dopo due tentativi gRPC falliti ricadono sullo stream SSE (`GET /api/v1/events`) e ritentano gRPC a intervalli. Il resto del protocollo non cambia.

## Verifica finale

1. **Avvio:** `docker compose logs cloud-api` (o i log del pod `api`) mostra `names in use` con il realm, l'audience, i bucket e `legacy_names=true` per un realm `memobrain`, e il warning `the OIDC realm is the one of a 1.x installation`; nessun errore sul bucket. Un warning `... is deprecated, use CLARAE_...` indica una variabile `MEMOBRAIN_*` ancora in uso.
2. **Readiness:** `curl https://<host>/api/v1/readyz` risponde `ok` (con il dettaglio per dipendenza: `docker compose exec proxy wget -qO- http://cloud-api:18081/api/v1/readyz`, `database` e `storage` a `ok`).
3. **Login:** accesso alla console web con un utente esistente e, per un amministratore, apertura dell'area di amministrazione.
4. **Sincronizzazione:** un client 1.4.0 e uno 1.5 collegati allo stesso vault sincronizzano una modifica in entrambe le direzioni.
5. **Notifiche:** i client ricevono le modifiche senza attendere il polling. Per verificare che entrambi i servizi gRPC siano raggiungibili dal proxy o dall'Ingress, `grpcurl -d '{}' <host-notifiche>:443 memobrain.v1.NotifyService/Subscribe` e lo stesso con `clarae.v1.NotifyService/Subscribe` devono rispondere `Unauthenticated` (token mancante), non `Unimplemented`.
6. **Metriche:** `curl` su `/metrics` (o il listener del worker) mostra il prefisso atteso, `memobrain_` o `clarae_` secondo `METRICS_NAMESPACE`.
