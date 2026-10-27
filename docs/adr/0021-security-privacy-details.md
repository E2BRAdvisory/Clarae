# ADR-0021 — Sicurezza e privacy: endpoint GDPR, anonimizzazione, gate di CI (M7-WP2)

|                       |                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | proposta (da recepire nello spec a cura dell'owner)                                                                           |
| **Data**              | 2026-10-27                                                                                                                    |
| **Riferimenti spec**  | §3.5 (API), §3.8 (E2EE), §2.6.2 (retention), D-02, D-03, D-05                                                                 |
| **Devia dallo spec?** | sì, in modo additivo: `GET /me/export`, `DELETE /me`, migrazione `0006`, impostazione `privacy.account_purge_days`, job purge |

## Contesto

La 1.0 deve rispondere ai diritti di accesso/portabilità (GDPR art. 15 e 20) e di cancellazione (art. 17), che lo spec §3.5 non prevede, e deve poter essere sottoposta ad audit e penetration test esterni. L'amministratore può già eliminare un utente (ADR-0012), ma l'utente stesso non può, e i dati personali restavano nelle righe di `users` e `audit_log`.

## Decisione

1. **`GET /me/export`** (bearer): un file JSON (`Content-Disposition: attachment`) con profilo, **tutti** i dispositivi (anche revocati), gruppi, vault posseduti (solo metadati e tipi di envelope), share create o su vault propri con i relativi grant, grant ricevuti e voci di audit di cui l'utente è attore o bersaglio. **Non contiene contenuto dei vault**: i privati sono cifrati e il server non può leggerli (lo scrive il campo `notice`); i condivisi si esportano con l'export ZIP esistente. L'export è registrato in audit (`account.export`).
2. **`DELETE /me`** con corpo `{confirm, acknowledge_data_loss?}`: `confirm` deve essere uguale allo username; se l'utente possiede vault privati, `acknowledge_data_loss` deve essere `true` (altrimenti `400` con l'avviso di irrecuperabilità). L'ultimo amministratore attivo riceve `409 INVALID_STATE` (con blocco delle righe admin contro le cancellazioni concorrenti). A differenza di `DELETE /admin/users/{id}`, un amministratore **può** cancellare il proprio account se ne esiste un altro.
3. **Anonimizzazione, non cancellazione della riga.** `users` diventa un tombstone: username `deleted-<id8>`, email `deleted-<id>@deleted.invalid`, nome `NULL`, stato `deleted`, `deleted_at`; id, ruolo e date restano perché `audit_log.actor_id`, `file_revisions.author_id` (in vault di altri) e `share_grants.granted_by` sono chiavi esterne e la traccia deve restare integra. In `audit_log` si azzerano `ip` e `details.username` per le righe dell'utente; `action`, `target_*` e gli id non cambiano. I dispositivi sono cancellati (o, se referenziati da revisioni, revocati e resi anonimi); appartenenze, grant ricevuti e concessi, upload in corso sono cancellati; gli export pronti scadono subito. `UpsertUserFromToken` non riscrive più username, email e nome su una riga `deleted`: il login risponde `USER_SUSPENDED`.
4. **Keycloak**: `keycloak.Admin.SetEnabled(false)` (con fine delle sessioni), tollerando `Disabled` e `ErrNotFound`. L'eliminazione definitiva dell'account nel realm resta a carico del gestore (`Admin` non espone `DeleteUser`): lacuna dichiarata in `docs/security/data-retention.md`.
5. **Purge**: i vault dell'utente sono eliminati (soft) all'istante. `jobs.PurgeDeletedAccounts` (nella manutenzione giornaliera) dopo `privacy.account_purge_days` (predefinito 30, migrazione `0006`) rimuove ogni vault ancora posseduto (righe, file, revisioni, envelope, riferimenti ai blob e quota), ripete l'anonimizzazione (copre gli account cancellati da un admin, che restano logici fino ad allora), sostituisce `keycloak_sub` con `purged:<id>` e valorizza `purged_at`. I blob liberati sono raccolti dal GC esistente. L'operazione è idempotente.
6. **Gate di CI** (`.github/workflows/security.yml`, nuovo file; `ci.yml` invariato): `govulncheck` sui tre moduli (bloccante, toolchain `1.26.x` più recente); `yarn npm audit --all --recursive` con gate **high** bloccante e report completo non bloccante (moderate/low e deprecazioni sono triagiati ogni settimana); SBOM con syft (SPDX del binario cloud, CycloneDX del repository) e riepilogo licenze come artefatti, con avviso su copyleft forte; gitleaks facoltativo (non bloccante); build reale della Web UI e verifica di CSP, SRI e header (test Go, `web/e2e-security` in Chromium); rigenerazione dei vettori crittografici con `git diff --exit-code`; controllo che l'inventario degli endpoint di `pentest-scope.md` sia allineato a `api/openapi.yaml` (`scripts/pentest-inventory.mjs --check`). Esecuzione a ogni PR, su `main` e ogni lunedì.

## Alternative considerate

- **Cancellare la riga `users`.** Scartata: richiederebbe di annullare o riscrivere ovunque le chiavi esterne (audit, revisioni, grant) e di perdere la traccia delle azioni amministrative.
- **Export ZIP con i contenuti.** Scartata per i vault privati (il server non può decifrare) e ridondante per i condivisi (export ZIP già disponibile).
- **Cancellazione solo differita (retention prima, anonimizzazione poi).** Scartata: lascerebbe dati personali per 30 giorni dopo una richiesta di cancellazione; la retention vale per il contenuto dei vault, non per l'identità.
- **`DELETE /me` senza avviso esplicito per i vault privati.** Scartata: la perdita è irreversibile (D-02).
- **Gate `moderate` su `yarn npm audit`.** Scartata per ora: rimane una deprecazione senza correzione a monte (`sliced`, via Excalidraw) e avvisi moderati ricorrenti nell'albero transitivo; si rivaluta dopo il primo ciclo settimanale.

## Conseguenze

- Spec da aggiornare: §3.5 con i due endpoint, §2.6.2 con `privacy.account_purge_days`, la politica di anonimizzazione e la differenza con `DELETE /admin/users/{id}`.
- Debito: nessuna retention automatica dell'`audit_log`; nessuna cancellazione dell'account Keycloak; backup non riscritti. Tutti elencati in `docs/security/data-retention.md`.
- Il `package.json` radice ora dichiara `resolutions` (nanoid, lodash-es, katex) per correggere avvisi _high_ transitivi di Excalidraw/chevrotain; vanno riviste a ogni aggiornamento di Excalidraw.
- `tools/go.mod` (toolchain di `ci.yml`) è a go1.26.7, che ha 13 vulnerabilità della libreria standard raggiunte dal codice (correzioni in 1.26.9/1.26.10): va aggiornato, altrimenti il passo `govulncheck` di `ci.yml` resta rosso.
