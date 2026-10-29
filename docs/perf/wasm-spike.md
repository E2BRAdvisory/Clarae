# Spike core WASM (M9-WP1)

Misure di ADR-0030, rieseguibili. Nessun file del repo viene modificato: la build usa `go build -overlay` con file temporanei. Dati del 2026-10-29 (Go 1.27.3, macOS arm64, Node 24).

## 1. Compilazione e dimensione

Servono tre file temporanei, da scrivere fuori dal repo (`$TMP`):

- `store.go`: copia di `apps/desktop/internal/store/store.go` senza la riga `_ "modernc.org/sqlite"` (il driver non compila per `js`);
- `detach.go`: sostituto di `internal/updater/detach_unix.go` (`syscall.SysProcAttr.Setsid` non esiste per `js`), con `func detach(cmd *exec.Cmd) {}`;
- `main.go`: un `main` (`//go:build js && wasm`) che chiama `app.New(app.Options{})`, istanzia i 20 servizi `app.New*API` di `apps/desktop/main.go` e somma `reflect.TypeOf(s).NumMethod()`, per tenerli collegati come farà il dispatcher.

`overlay.json` mappa i tre file sui percorsi `internal/store/store.go`, `internal/updater/detach_unix.go` e `cmd/spike-core/main.go` (quest'ultimo non esiste su disco: l'overlay lo crea).

```sh
cd apps/desktop
GOOS=js GOARCH=wasm go build -overlay "$TMP/overlay.json" -trimpath -ldflags "-s -w" -o "$TMP/core.wasm" ./cmd/spike-core
brotli -q 9 -k "$TMP/core.wasm"   # 36,6 MB -> 6,4 MB
```

## 2. Esecuzione in Node

`go_js_wasm_exec` fallisce se l'ambiente è troppo grande: si lancia con `env -i`.

```sh
EXEC="$(go env GOROOT)/lib/wasm/go_js_wasm_exec"
env -i PATH="$(dirname "$(which node)"):/usr/bin:/bin" "$EXEC" "$TMP/core.wasm"   # stampa "methods: 122", ~0,1 s
```

## 3. Parser Go sotto WASM

Un benchmark temporaneo `BenchmarkParseNote` (nota da ≈ 18 kB: titoli, wikilink, tag, task, callout) in `internal/parser`, aggiunto con l'overlay:

```sh
go test -overlay "$TMP/overlay.json" -run xxx -bench ParseNote ./internal/parser           # nativo: 2,46 ms/op, 7,2 MB/s
GOOS=js GOARCH=wasm go test -overlay "$TMP/overlay.json" \
  -exec "env -i PATH=$(dirname "$(which node)"):/usr/bin:/bin $EXEC" -run xxx -bench ParseNote ./internal/parser   # WASM: 11,2 ms/op, 1,6 MB/s
```

## 4. SQLite-wasm con FTS5

In una directory vuota e separata: `npm i @sqlite.org/sqlite-wasm@3.54.1-build1`, poi uno script `.mjs` che:

1. apre `:memory:` e applica la parte `Up` di `internal/store/migrations/index/0001_index.sql` e `0002_properties_tasks.sql`;
2. inserisce 5.000 note da 500 parole (26 MB) in `files` e `fts_content` in una transazione (1,7 s);
3. esegue 200 query `MATCH` su un termine (p50 3,6 ms, p95 4,4 ms).

`sqlite3.wasm` pesa 0,88 MB.

## Limiti

Niente OPFS, niente driver `database/sql`, niente indexer reale: vedi ADR-0030, "Non verificato".
