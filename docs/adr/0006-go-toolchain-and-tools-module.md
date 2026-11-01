# ADR-0006 — Go 1.26 e modulo `tools/` per gli strumenti di sviluppo

|                       |                                      |
| --------------------- | ------------------------------------ |
| **Stato**             | accettata                            |
| **Data**              | 2026-10-23                           |
| **Riferimenti spec**  | §4.5 (toolchain, generazione codice) |
| **Devia dallo spec?** | no                                   |

## Contesto

Lo spec chiede "Go ≥ versione stabile corrente" e `make gen` con oapi-codegen, buf, sqlc, protoc. Aggiungere i tool con `tool` directive nel `go.mod` del servizio cloud trascinava nel modulo applicativo centinaia di dipendenze indirette (sqlc porta driver ClickHouse, Azure, TiDB…), inquinando `govulncheck` e la supply chain. sqlc 1.31 e buf 1.75 richiedono Go ≥ 1.26.

## Decisione

- **Go 1.26** come versione di linguaggio in tutti i moduli (`go 1.26`); il toolchain viene scaricato automaticamente da `GOTOOLCHAIN=auto`.
- Tutti i tool (oapi-codegen, sqlc, goose, buf, golangci-lint, govulncheck, protoc-gen-go, protoc-gen-go-grpc) sono pinnati con `tool` directive in **`tools/go.mod`**, modulo separato **fuori da `go.work`**; `make tools` esegue `cd tools && GOWORK=off go install tool`. `protobuf` è fissato alla pseudo-versione richiesta da buf.
- I moduli applicativi non hanno dipendenze da tool.

## Alternative considerate

- **`tool` directive nel modulo cloud** — scartata per l'inquinamento delle dipendenze descritto sopra.
- **Versioni dei tool solo nel Makefile** — scartata: non verificabili da `go mod verify`, nessun lockfile.

## Conseguenze

La CI usa `tools/go.mod` come `go-version-file`. Aggiornare un tool = `cd tools && GOWORK=off go get -tool <pkg>@<ver>`.

## Aggiornamento

Il toolchain è passato a **Go 1.27.3** (`go.work`, i moduli, `tools/`, immagini Docker, CI), anche per le correzioni della libreria standard che `govulncheck` segnalava sulla 1.26.0; i test sono rimasti verdi. Le decisioni di questo ADR restano valide.

**Wails CLI (2026-11).** La CLI di Wails non è in `tools/go.mod`: la sua versione è quella della libreria in `apps/desktop/go.mod` (oggi v2.17.0), unica fonte di verità. `scripts/install-wails.sh` la legge da lì e installa `github.com/wailsapp/wails/v2/cmd/wails@<versione>` con il Go del repository, senza più sostituire `golang.org/x/tools` (la v2.17 compila con Go 1.27 così com'è pubblicata); `--check` blocca `task gen-wails`, `dev-desktop` e `build-desktop` se la CLI installata è di un'altra versione, e `wails dev`/`wails build` girano con `-nosyncgomod`.
