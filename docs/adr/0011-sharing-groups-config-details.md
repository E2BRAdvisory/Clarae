# ADR-0011 — Dettagli implementativi di condivisione, gruppi e configurazione distribuita (M4)

|                       |                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| **Stato**             | proposta (da recepire nello spec a cura dell'owner)                                                       |
| **Data**              | 2026-10-24                                                                                                |
| **Riferimenti spec**  | §2.6.4–2.6.6 (condivisione, gruppi, config), §3.3.2 (RBAC), §3.4.7 (scope), §3.5.4, §3.6, D-04…D-06       |
| **Devia dallo spec?** | sì, in modo additivo (parametro `scope` esteso, codice `INVALID_STATE`, `web_client_id`, migrazione 0004) |

## Contesto

M4 aggiunge gruppi, share con grant, mount sul desktop, Config Profile e la Web UI utente. Lo spec fissa il modello ma non alcuni dettagli che l'implementazione ha dovuto scegliere.

## Decisioni

1. **Migrazione `0004_groups_sharing.sql`** (la `0003` è già `vaults`): `groups`, `group_members`, `shares`, `share_grants`, trigger `shares_vault_kind_chk` (`VAULT_ENCRYPTED`), `config_profiles`, `config_assignments` e la riga `settings['config.revision']`.
2. **`scope=share:{id}` su tutte le operazioni sul contenuto**, non solo `changes`: `tree`, `commit`, `blobs:check`, `PUT/GET blobs`, upload tus (`?scope=`), `files/{id}/revisions…`. Senza scope il vault è raggiungibile solo dal proprietario. Il percorso nel mount è relativo alla radice dello share; per un documento condiviso è il nome del file.
3. **Pacchetto `internal/access`** (permessi, `Scope`, interfaccia `Authorizer`) implementato da `sharing`: sync, blobs, revisions e vaults dipendono dall'interfaccia, mai dalle tabelle degli share. `Authorize` risponde `404` per ciò che il chiamante non deve conoscere (share inesistente, revocato, scaduto, estraneo) e `403 FORBIDDEN` per un livello insufficiente su una risorsa visibile (es. `viewer` che scrive). L'`Evaluator` applica l'algoritmo §3.3.2 con la cache dei grant per richiesta.
4. **Trasformazione dei `changes` per scope**: un file che esce dal prefisso appare come `delete`, uno che vi entra come `create`; per un documento condiviso un cambio di cartella che non cambia il nome è invisibile. Il changelog del vault è scandito a lotti (500, max 20 per richiesta) e filtrato; il cursore salta a `last_seq` quando lo scan lo raggiunge (la presa del lock di vault garantisce che i `seq` committati siano contigui). Dopo un `move_prefix` che rinomina la radice, i destinatari ricevono un `create` per file già noti (stesso `file_id`): il client lo tratta come aggiornamento.
5. **Confinamento dei commit**: i path del mount sono rilasciati con `scope.Abs` (niente `..`, niente assoluti), le op su file esistenti verificano che il file sia nello share (altrimenti `NOT_FOUND`), uno share documento ammette solo `modify` e `delete`. `SHARE_ROOT_MOVE`: dal mount non si rinomina la radice; sul vault del proprietario un `move` file-per-file non può togliere l'ultimo file da una cartella condivisa, mentre `move_prefix` trascina i `shares.path_prefix` interessati.
6. **Lettura dei blob per scope**: il destinatario scarica solo blob di file che lo share copre (controllo sul percorso corrente del file: perdere l'accesso a un file perde anche le sue vecchie revisioni).
7. **Inviti**: un grant a un gruppo è accettato per tutto il gruppo da un suo membro qualsiasi; il rifiuto vale solo per i grant a utente (altrimenti `409 INVALID_STATE`, codice nuovo). Gli inviti pendenti non danno accesso.
8. **Eventi**: canali NOTIFY `share_changed` (JSON con tipo, share ed eventuali utenti espliciti: la revoca di un grant elenca chi lo perde) e `config_changed` (revisione). Il hub consegna gli eventi di vault anche ai destinatari di share accettati (cache dei destinatari 5 s, azzerata dagli eventi di share), invia `ShareChanged` e `ConfigChanged` e li replica alla riconnessione (`known_seq`, `config_version`). Il flusso SSE usa `?config=` come analogo.
9. **Config Profile**: `api/config-profile.schema.json` è il contratto, copiato in `internal/configprofiles/schema.json` per `go:embed` (un test li tiene identici). `version` in `GET /config/effective` è una revisione globale che cresce a ogni modifica di profilo, assegnazione o appartenenza a un gruppo; l'ETag copre revisione e contenuto. Le chiavi `locked` sono unite tra globale e gruppi. L'override utente è applicato dal client (default gestiti → scelte dell'utente → chiavi `locked` forzate); `editor.json` e `appearance.json` memorizzano ormai solo le chiavi scelte dall'utente. `linkFormat` nello schema usa i valori dell'app (`shortest|path|relative`). Il client applica `sync.interval_seconds` (vincolante se `locked`, altrimenti default) e i feature flag (`features.*`).
10. **Desktop**: ogni share accettato è un vault a sé in `<data>/mounts/<share_id>/` (stesso `sync.db`, `scope` e livello nei meta); anche i documenti singoli hanno il proprio mount (nessun mount virtuale unico "Condivisi con me": il pannello Condivisione li elenca insieme). Un `viewer` ha l'engine in sola lettura e le scritture dei binding rifiutate (`read-only:`), oltre al rifiuto del server. La revoca è rilevata dal `NOT_FOUND` della sync o dal reconcile dopo un evento: il mount si ferma, l'utente sceglie se eliminare la copia o conservarla come vault ordinario in `<data>/kept/`.
11. **Web UI**: `client-config` espone `web_client_id`; il binario serve la SPA con CSP rigida e SRI (`services/cloud/web-embed`); il `Dockerfile` ha uno stadio Node che la compila e la incorpora. Nessuna finestra di creazione share nella Web UI (solo gestione); la barra della quota usa `<progress>` perché `style-src 'self'` vieta gli stili inline.

## Limiti noti

- Nessuna API admin per gruppi e profili prima di M5 (solo servizio interno, usato dai test).
- Il consumo dei template di gruppo (mount in sola lettura) è solo predisposto (`templates.library_share_id`); arriva con M6-WP3.
- D-06 vieta le funzioni cross-vault: i link tra un mount e altri vault non si risolvono.
- Un utente non può cedere la proprietà di un vault; un `manager` gestisce i grant ma non crea share né li revoca.
