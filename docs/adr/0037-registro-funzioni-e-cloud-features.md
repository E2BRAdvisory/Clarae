# ADR-0037 — Registro delle funzioni, modulo `@memobrain/cloud-features` e client Go generato

|                       |                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | accettata                                                                                                                                                                    |
| **Recepito in**       | `Specifications.md` v1.2 (2026-11-02): §2.5, §2.6.1, §2.6.6, §2.8.2, §3.1, §3.5.2, §4.1, §4.2, §4.4, §4.5 (Appendice C.4)                                                    |
| **Data**              | 2026-11-01                                                                                                                                                                   |
| **Riferimenti spec**  | §2.6.1 (creazione, rinomina, eliminazione logica e ripristino dei vault), §2.8 (spazio e dispositivi), §3.5 (API), §4.2 (frontend); D-02, D-05; ADR-0029, ADR-0030, ADR-0036 |
| **Devia dallo spec?** | no nei requisiti (li completa); sì nella struttura del frontend (§4.2) e nell'elenco dei contratti generati (§3.5) → da recepire nello spec                                  |

## Contesto

La parità tra desktop e workbench web è "per costruzione": stessa UI (`@memobrain/workbench`) e stesso core Go (Wails sul desktop, WebAssembly nel browser, ADR-0029/0030). La **gestione dei vault** però vive in tre posti:

1. il workbench, nei pannelli Cloud, Sync e Condivisione, che chiama i binding Go;
2. la console web (`web/src/pages`: Vaults, Devices, Usage, Shares), che chiama la REST tramite `@memobrain/api-client` generato da `api/openapi.yaml`;
3. il client REST Go del core (`apps/desktop/internal/sync/transport`), **scritto a mano** a imitazione del contratto.

L'analisi del 2026-11-01 ha misurato le conseguenze:

- **Comportamenti divergenti:**
  - livello della quota (soglia locale nella console, livello del server nel workbench);
  - protezione del dispositivo corrente;
  - feature flag `sharing`, ignorato dalla console;
  - nomi e default dei flag definiti in tre punti.
- **Requisiti mancanti ovunque:**
  - creazione di un vault cloud dalla console;
  - **rinomina, eliminazione logica e ripristino** di un vault (§2.6.1), che il server espone già (`updateVault`, `deleteVault`, `restoreVault`) ma che nessun client usa;
  - `PATCH /shares/{id}`, mai chiamato.
- **Un controllo di parità fragile:**
  - `scripts/parity.mjs` ricava i comandi da `registry.ts` con una regex e ne perde una quarantina (daily, bookmarks, workspaces, preview, drawing);
  - copre comandi e binding, non le _funzioni_;
  - non sa nulla della console.
- **Un contratto a rischio deriva:** un cambiamento dell'API rompe insieme desktop e workbench mentre la console continua a funzionare, perché solo il client TS è generato.

## Decisione

### 1. Registro delle funzioni (`shared/parity/features.yaml`)

Un file dichiarativo, unica fonte della parità, con **una voce per funzione utente**: per esempio `vault.create`, `vault.rename`, `vault.delete`, `vault.restore`, `crypto.unlock`, `crypto.change-passphrase`, `crypto.recovery-key`, `share.create`, `share.update`, `share.grants`, `invitations`, `mounts`, `devices`, `usage`, `revisions`, `conflicts`, `trash`, `export.zip`, `import`, `settings`, `config.flags`.

Per ogni voce:

- **desktop / workbench:** comandi (`commands[]`) e binding (`bindings[]`) che la realizzano, più l'eventuale capability richiesta;
- **console:** rotte (`routes[]`) e operazioni OpenAPI (`operationIds[]`);
- **stato per superficie:** `yes | partial | exception | console-only | missing`, con la motivazione obbligatoria per tutto ciò che non è `yes`;
- **test per target:** spec o titoli di test desktop, web e cloud.

`scripts/parity.mjs` viene riscritto. Non usa più la regex sul sorgente:

- importa il registro dei comandi a runtime (via `tsx`, con `configurePlatform('web')`) e legge un nuovo campo dichiarativo `Command.requires?: (keyof Capabilities)[]`;
- legge i binding generati e gli `operationId` di `api/openapi.yaml`.

`parity --check` (incluso in `task ci`, ADR-0036) **fallisce** in tre casi:

- un comando, un binding o un'operazione utente non compare in nessuna voce;
- una voce rimanda a un elemento che non esiste;
- uno stato diverso da `yes` non ha motivazione.

`docs/web-workbench-parity.md` resta generato, con una nuova tabella per funzione.

### 2. Modulo `@memobrain/cloud-features` con `CloudPort`

Un nuovo pacchetto TypeScript (`packages/cloud-features`) contiene **tutta la UI di gestione dei vault cloud**, una volta sola:

- `CloudVaultsTable`: elenco, creazione, rinomina, eliminazione, sezione dei vault eliminati con ripristino;
- `DevicesPanel`, con il dispositivo corrente protetto;
- `UsagePanel`: livello del server, dettaglio per vault;
- `SharesManager`, `InvitationsList`, `GrantEditor`, ricerca nella directory.

I componenti dipendono solo da un'interfaccia `CloudPort` (vault, dispositivi, utilizzo, condivisioni, grant, inviti, directory, configurazione effettiva). I tipi dei dati sono quelli generati da OpenAPI (`@memobrain/api-client`). Due adattatori:

- **`RestCloudPort`** per la console (REST, `unwrap()`/`ApiError`);
- **`CoreCloudPort`** per desktop e workbench (binding Go).

Una sola suite di test dei componenti gira su entrambi gli adattatori.

La migrazione procede **pannello per pannello**. La prima funzione nuova a nascere nel pacchetto è il **ciclo di vita dei vault** (creazione, rinomina, eliminazione logica, ripristino) su console e desktop:

- nuovi metodi `SyncAPI.RenameCloudVault`, `DeleteCloudVault`, `RestoreCloudVault`, più l'elenco dei vault eliminati;
- **effetto locale di un'eliminazione:** il dispositivo collegato si scollega e **conserva i file**, mai una cancellazione locale (D-04);
- un **vault privato** si crea nel browser solo nel workbench, che contiene il codice crittografico Go (envelope, recovery key). La console apre il workbench su una rotta di creazione e non duplica la crittografia in TypeScript.

Se il server non elenca i vault eliminati, si aggiunge un parametro all'API: `GET /vaults?include_deleted=true`, compatibile all'indietro.

Regola per il futuro: ogni funzione di gestione dei vault cloud nasce in `@memobrain/cloud-features`, mai direttamente in `web/src/pages` o in `packages/workbench/src/settings`.

**Attuazione della fase B (2026-11-01).** Scelte fatte realizzando il ciclo di vita dei vault (dettagli in `packages/cloud-features/README.md`):

- `CoreCloudPort` sta in `packages/workbench/src/cloud`, accanto alla facciata dei binding: il pacchetto definisce solo l'interfaccia e la dipendenza va in un verso (workbench → cloud-features);
- i componenti usano `@memobrain/ui`; il workbench carica solo le regole dei componenti (`@memobrain/ui/components.css`) con i token mappati sui propri (`workbench.css`), senza stile inline;
- i testi it/en stanno nel pacchetto, l'host passa la lingua;
- binding: `SyncAPI.ListDeletedCloudVaults`, `RenameCloudVault`, `DeleteCloudVault`, `RestoreCloudVault`; il DTO `CloudVault` aggiunge `ownerId`, `lastSeq` e `deletedAt`;
- rotta di creazione dei vault privati: `/vaults/new/open?kind=private&name=…`.

### 3. Un solo contratto per la REST

- **Client Go generato:** oapi-codegen genera da `api/openapi.yaml` i tipi (e il client) in `shared/go/apiclient`, nell'ambito di `task gen-openapi`.
- **`sync/transport` diventa un involucro sottile:** retry, chiave di idempotenza, decodifica di `problem+json`, request id. Le strutture copiate a mano spariscono e i metodi morti si rimuovono o si collegano a una funzione del registro.
- **Contract test nella suite d'integrazione del cloud:** ogni richiesta e risposta di `transport` viene validata contro `openapi.yaml` (kin-openapi `openapi3filter`). Un test allinea l'enum `ErrorCode` alle costanti di `shared/go/syncproto`.
- **Fuori dal generatore:** tus e lo stream SSE (`/events`) restano fuori dall'interfaccia generata, ma vengono documentati nell'OpenAPI come rotte esterne.

## Alternative considerate

- **Lasciare tre implementazioni e coprire con più e2e:** i test troverebbero le divergenze dopo, senza impedirle. Ogni funzione nuova andrebbe comunque scritta tre volte. Scartata.
- **Console che usa il core WASM per tutto:** una sola implementazione, ma 8 MB di core e un worker per mostrare un elenco di dispositivi. Contraddice anche la scelta di tenere la console leggera, con una CSP stretta. Scartata, tranne per la creazione dei vault privati, dove la crittografia lo impone.
- **Registro in TypeScript invece che in YAML:** più comodo per il frontend, ma il registro deve essere letto anche da script e test Go. Scartato.

## Conseguenze

- **Positive:**
  - una funzione di gestione dei vault esiste su desktop, workbench e console per costruzione;
  - il controllo di parità copre le funzioni, non solo i nomi;
  - una deriva dell'API rompe la compilazione o un contract test, non un utente;
  - si chiudono i requisiti mancanti di §2.6.1.
- **Costi:**
  - un pacchetto in più;
  - i componenti della console e del workbench vanno migrati;
  - i binding Go dovranno restituire tipi compatibili con quelli OpenAPI (mappatura nell'adattatore finché non è così);
  - il registro va tenuto aggiornato: è il prezzo del controllo, e la CI locale lo rende esplicito.
- **Spec:** §4.2 (struttura del frontend) e §3.5 (contratti generati) vanno aggiornati. Se serve `include_deleted`, va aggiunto all'API.
