# Contribuire a MemoBrain Notes

Grazie per il contributo. Questa pagina raccoglie le regole che valgono per ogni modifica; il quadro d'insieme è in [docs/architecture.md](docs/architecture.md), la parità tra desktop e browser in [docs/desktop-web-sync.md](docs/desktop-web-sync.md).

## Fonti di verità

- [`Specifications.md`](Specifications.md) definisce architettura, vincoli (V-01…V-10), decisioni (D-01…D-08), schema del database, API e protocollo di sync. Lo modifica solo il proprietario del progetto.
- [`docs/roadmap.md`](docs/roadmap.md) è il piano per milestone, con work package e criteri di uscita: prima di iniziare leggi la milestone corrente.
- Gli [ADR](docs/adr/README.md) registrano le decisioni di dettaglio e le deviazioni dallo spec.

## Preparare l'ambiente

Prerequisiti (Go 1.27, Wails CLI v2.17 (`task wails-cli`), Node 24, Yarn 4 via corepack, Docker, Task) e primo avvio sono nel [README](README.md#ambiente-di-sviluppo); comandi, script e suite di test in [docs/dev-setup.md](docs/dev-setup.md). In breve:

```sh
task tools   # tool Go pinnati in tools/go.mod + yarn install
task gen     # codice generato (OpenAPI, proto, sqlc, binding Wails)
task ci      # il controllo completo da passare prima di un merge
```

Nei comandi da shell usa percorsi assoluti o sottocartelle; se il tuo `grep` è un alias (per esempio di `ugrep`), negli script usa `command grep`.

## Lingua

- **Inglese:** codice, commenti, identificatori, messaggi di commit, log, messaggi d'errore dell'API e testi di `api/openapi.yaml`.
- **Italiano:** documentazione in `docs/`, ADR, README, questo file e il CHANGELOG.
- I testi dell'interfaccia passano dall'i18n (italiano e inglese), mai scritti nel codice: per esempio il titolo di un comando è la chiave `commands.<id con : e - sostituiti da _>`.

## Messaggi di commit

Il formato usato nella storia del repository è:

```text
type(scope): what changed and why it matters, in one line [Mx-WPy]

Optional body: the reason, the alternatives, what was verified.
```

- `type`: `feat`, `fix`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`.
- `scope` (facoltativo): l'area, per esempio `cloud`, `desktop`, `web`, `sync`, `release`, `markdown`.
- Tra parentesi quadre il riferimento al lavoro: il work package della roadmap (`[M10-WP4]`), oppure lo step di un piano o di un ADR (`[GAP-F4-S2]`, `[ADR-0032-S1]`).
- Un commit, un cambiamento coerente. Commit e push li decide chi mantiene il branch: gli strumenti automatici (agenti compresi) non fanno commit, push né tag senza una richiesta esplicita.

## Quando scrivere un ADR

Scrivi un ADR in `docs/adr/` (modello [`0000-template.md`](docs/adr/0000-template.md), numero successivo, riga nell'[indice](docs/adr/README.md)) quando:

- una modifica **devia dallo spec** (struttura, API, schema, comportamento): l'ADR, in stato _proposta_, si propone al proprietario, che aggiorna `Specifications.md`. Lo spec non si modifica nella stessa PR;
- una scelta di dettaglio non è decisa dallo spec ma vincola il lavoro futuro (una libreria, un formato, un protocollo).

L'ADR dice contesto, decisione, alternative scartate e conseguenze, e se devia dallo spec indica la sezione da aggiornare. Le proposte di aggiornamento raccolte stanno in [`docs/spec-v1.2-proposta.md`](docs/spec-v1.2-proposta.md).

## File generati: mai a mano

| Generato                                                                    | Sorgente                                                      | Comando                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------ |
| `services/cloud/internal/api/api.gen.go`                                    | `api/openapi.yaml` (+ `api/oapi-codegen.yaml`)                | `task gen-openapi`                   |
| `shared/go/apiclient/apiclient.gen.go`                                      | `api/openapi.yaml` (+ `api/oapi-codegen-client.yaml`)         | `task gen-openapi`                   |
| `packages/api-client/src/gen/schema.d.ts`                                   | `api/openapi.yaml`                                            | `task gen-openapi`                   |
| `services/cloud/internal/<modulo>/<modulo>db/*.go` (tranne `doc.go`)        | `services/cloud/internal/db/queries/<modulo>.sql`, migrazioni | `task gen-sqlc`                      |
| `shared/go/notifyv1/*.pb.go`                                                | `api/proto/memobrain/v1/notify.proto`                         | `task gen-proto`                     |
| `packages/workbench/wailsjs/` (non versionato)                              | i binding Go di `App.Services()`                              | `task gen-wails`                     |
| `apps/desktop/frontend/wailsjs/runtime/`                                    | runtime JavaScript di Wails                                   | Wails CLI                            |
| tabelle tra `parity:begin` e `parity:end` di `docs/web-workbench-parity.md` | `shared/parity/features.yaml` e sorgenti                      | `node scripts/parity.mjs`            |
| inventario degli endpoint in `docs/security/pentest-scope.md`               | `api/openapi.yaml`                                            | `node scripts/pentest-inventory.mjs` |

`task gen` rigenera tutto; `task check-gen` (dentro `task ci`) fallisce se `task gen` cambia l'albero. Si cambia la sorgente e si rigenera.

## Regole dei moduli del cloud (ADR-0033)

Il cloud è un _modular monolith_: `services/cloud/internal/<modulo>`, stesso binario con `--role=api|worker|all`.

- Ogni modulo ha le sue query in `internal/db/queries/<modulo>.sql`, generate da sqlc in `internal/<modulo>/<modulo>db`. **Nessun altro modulo importa quel pacchetto:** lo impedisce una regola depguard per modulo in `.golangci.yml`.
- Un modulo dipende solo da `db`, `storage`, `audit`, `notify` e dalle interfacce o funzioni esportate degli altri moduli, **mai dalle loro tabelle**. Gli accessi incrociati passano dalle funzioni del proprietario (`internal/<modulo>/exported.go`), che prendono un `db.DBTX` per partecipare alla transazione del chiamante.
- Le tabelle di ciascun modulo e le eccezioni ammesse sono in `internal/db/ownership_test.go`: una query nuova su una tabella altrui fa fallire quel test. Un'eccezione nuova va motivata (ADR-0033).
- Le migrazioni sono file SQL versionati in `internal/db/migrations`; non si modifica una migrazione già rilasciata.
- Errori come `application/problem+json` con un `code` di `shared/go/syncproto`; ID UUID v7.

## Dati: nessuna perdita silenziosa

- **D-04:** nessuna perdita silenziosa. Una versione scartata resta nello storico (cloud) o nella cronologia locale; un conflitto che non si fonde produce una copia di conflitto; una copia locale con modifiche non inviate non si cancella senza chiedere. Il merge è sempre sul client (`shared/go/merge`), il server ordina e conserva.
- **Scritture sul vault atomiche** (file temporaneo, fsync, rename), con rifiuto del path traversal (`apps/desktop/internal/vault`).
- **`WriteNote` con `expectedHash`:** la scrittura fallisce se il file è cambiato nel frattempo, invece di sovrascrivere una modifica esterna.
- **Vault privati (D-02):** il server non vede mai contenuto né path in chiaro; un'operazione non ammessa risponde `VAULT_ENCRYPTED`. Il codice crittografico condiviso sta in `shared/go/vaultcrypto`, con vettori di test che verificano anche `packages/vaultcrypto-web`.
- **Perimetro per vault (D-06):** nessuna funzione attraversa due vault.

## Sicurezza e vincoli

- **Architettura chiusa (V-02, D-01):** niente plugin, temi di terze parti né CSS personalizzato.
- **Niente stili inline:** né `<style>` né l'attributo `style` nell'HTML generato o renderizzato; l'HTML che arriva dal contenuto si sanifica con DOMPurify. Le CSP del desktop e della Web UI lo impongono, e i test di CSP e SRI lo verificano.
- **Il frontend non accede a disco o rete:** tutto passa dai binding Go ed eventi Go → TypeScript.
- **Excalidraw offline:** asset locali, nessuna richiesta di rete (test dedicato).
- Nessun segreto nel repository; le credenziali di sviluppo valgono solo per lo stack locale.

## Parità desktop/web

Desktop e workbench web condividono UI e core, e la gestione dei vault cloud ha un modulo comune (ADR-0029, ADR-0030, ADR-0037). Per ogni modifica che aggiunge o cambia una funzione:

- [ ] **Registro:** aggiungi o estendi la voce in `shared/parity/features.yaml` (comandi, binding, operazioni, rotte, test; motivazione per ogni stato diverso da `yes`). Guida: [dev-setup, «Registro delle funzioni»](docs/dev-setup.md#registro-delle-funzioni).
- [ ] **Solo desktop?** Un comportamento che il browser non può avere passa da una capability (`packages/workbench/src/platform`), dichiarata nel comando con `Command.requires`, e nel registro ha stato `exception` o `partial` con motivazione. Niente controlli sparsi sull'ambiente.
- [ ] **Gestione dei vault cloud** (elenco, ciclo di vita, dispositivi, utilizzo, condivisioni): l'interfaccia nasce in `@memobrain/cloud-features` (`packages/cloud-features`), dietro `CloudPort`, mai direttamente in `web/src/pages` o in `packages/workbench/src/settings`.
- [ ] **Binding nuovo:** ha un test web (`web/e2e`, `web/e2e-cloud` o lo spec desktop eseguito sul web) oppure una motivazione dichiarata nel registro.
- [ ] **Verifica:** `task parity` e lo spec web sul core vero, `yarn workspace @memobrain/web e2e:workbench-ui` (prima `task wasm-core`).
- [ ] **WASM:** il codice Go di `apps/desktop/internal` deve compilare e passare i test per `js/wasm` (`task test-wasm`). Ciò che dipende dall'host va dietro l'interfaccia `Host` (`internal/app/host.go`) o in file `*_js.go` / `*_native.go`.

## Checklist della pull request

- [ ] `task ci` verde in locale (ADR-0036: non c'è un servizio di CI, questo è il cancello prima del merge e prima di un tag). Comprende lint, typecheck, govulncheck, test Go (con i binding obbligatori), Vitest, conformance, test WASM, parità e controllo del codice generato.
- [ ] `task gen` non produce differenze (è il passo `check-gen` di `task ci`).
- [ ] Le suite lente dell'area toccata, elencate in [dev-setup](docs/dev-setup.md#verifiche): `task test-integration` (cloud), `task test-desktop-e2e` (sync e contract test), `task e2e` e gli e2e web, `e2e:cloud` ed `e2e:security`.
- [ ] Test nuovi per il comportamento nuovo o corretto; le fixture condivise (`shared/conformance`) se cambia il parsing, il merge o la crittografia.
- [ ] Un ADR se la modifica devia dallo spec o prende una decisione vincolante.
- [ ] Documentazione aggiornata (guide utente o di amministrazione, `docs/dev-setup.md`) e una riga nella sezione _Unreleased_ di [CHANGELOG.md](CHANGELOG.md) per un cambiamento visibile.
