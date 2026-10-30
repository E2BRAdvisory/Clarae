# ADR-0032 — Task (go-task) al posto di make

|                       |                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| **Stato**             | proposta                                                                                        |
| **Data**              | 2026-10-30                                                                                      |
| **Riferimenti spec**  | §4.1 (Monorepo, `Makefile`) e §4.5 (Convenzioni di sviluppo, `make gen`) di `Specifications.md` |
| **Devia dallo spec?** | sì (§4.1 e §4.5) → `Makefile` diventa `Taskfile.yml`, `make <target>` diventa `task <target>`   |

## Contesto

Gli entry point del monorepo erano in un `Makefile`. Make non è disponibile di default su Windows (uno dei tre sistemi del client desktop), la sua versione varia tra macOS (GNU make 3.81) e Linux, e la sintassi (tab obbligatori, `$$`, variabili ricorsive) è fragile. Gli altri tool di sviluppo sono già pinnati come `tool` in `tools/go.mod` (ADR-0006).

## Decisione

- Gli entry point stanno in `Taskfile.yml` (Task v3, `github.com/go-task/task/v3/cmd/task`), con gli stessi nomi dei target del `Makefile` e la stessa descrizione; il `Makefile` è rimosso.
- Task è pinnato come `tool` in `tools/go.mod` (v3.54.0): bootstrap con `cd tools && GOWORK=off go install github.com/go-task/task/v3/cmd/task`; poi `task tools` reinstalla anche Task con gli altri tool. La CI lo installa nello stesso modo.
- Variabili: `task perf PERF_NOTES=10000`, `task release-desktop OS=darwin V=1.0.0-rc.1`, `task rename-module NEW=…`; anche come variabili d'ambiente (`VERSION`, `IMAGE`, `PLATFORMS`, `WEB=0` per `dev-cloud`). Argomenti extra agli script dopo `--` (`task dev-stop -- --stack`; resta `ARGS=--stack`).
- `task` senza argomenti (o `task --list`) sostituisce `make help`. Il target file `packages/workbench/wailsjs/go/models.ts` diventa il task `wailsjs` (eseguito solo se i binding mancano, via `status`).
- I target composti (`gen`, `lint`, `test`, `e2e`, `ci`, `web-build`) chiamano i sotto-task in sequenza (`cmds`, non `deps`), come faceva make senza `-j`.

## Alternative considerate

- **Tenere make** — scartata: non portabile su Windows senza MSYS/WSL.
- **Script shell o `just`** — scartata: script ad hoc senza elenco/descrizioni; `just` non si pinna in `tools/go.mod` (Rust).
- **Mage (Go)** — scartata: più verboso per comandi che sono quasi tutti invocazioni di CLI.

## Conseguenze

- Un passo di bootstrap in più (installare Task) prima di `task tools`.
- I comandi di Task girano nell'interprete `mvdan.cc/sh` (POSIX), non in bash: i comandi che richiedono bash (`dev-cloud`, `release-desktop`) lo invocano esplicitamente.
- Gli ADR precedenti, il `CHANGELOG` e `Specifications.md` citano ancora `make <target>`: i nomi dei target sono invariati, quindi basta leggere `task` al posto di `make`. Lo spec va aggiornato dall'owner.
