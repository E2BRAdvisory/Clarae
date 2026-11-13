# Cartella `build`

Risorse e configurazione per compilare l'app desktop (Wails v3, ADR-0051). Il binario si costruisce con
`scripts/build-desktop-bin.sh` (`task build-desktop`): `go build` con i tag di produzione, senza `wails3 build`.

- `project.json` — dati del prodotto (nome, nome dell'eseguibile, bundle id, schema `clarae://`, azienda,
  copyright). È la sorgente dei template qui sotto, resi da `scripts/release/render-assets.go`. Prima era `wails.json`.
- `config.yml` — configurazione del watcher di sviluppo (`wails3 tool watcher`, `task dev-desktop`): avvia il server
  esbuild su `127.0.0.1:5173`, ricompila il binario a ogni modifica dei `.go` e lo riavvia.
- `bin/` — output (ignorato da git): su macOS `Clarae notanda.app` universale, su Windows `clarae.exe`, su Linux
  `clarae`; in sviluppo `clarae-dev` (su macOS `clarae.dev.app`).
- `appicon.png` — icona macOS a 1024 px, generata come le altre da `scripts/brand/gen-brand-assets.py`
  (`assets/brand/README.md`); la build usa `darwin/icon.icns` e `windows/icon.ico`.

## macOS (`darwin/`)

- `Info.plist` — template del bundle di produzione. `Info.dev.plist` — quello del bundle di sviluppo
  (`clarae.dev.app`, bundle id diverso e `NSAllowsLocalNetworking`).
- `icon.icns` — copiata in `Contents/Resources/iconfile.icns` (`CFBundleIconFile` è `iconfile`).
- `entitlements.plist` — usato dalla firma di `scripts/release/package-macos.sh`.

## Windows (`windows/`)

- `icon.ico`, `wails.exe.manifest` e `info.json` (template dei dati di versione) diventano il file `.syso` che
  `wails3 generate syso` produce durante la build e che il linker aggiunge all'exe.
- `installer/` — i file dell'installer NSIS (`project.nsi`, `wails_tools.nsh`), resi e compilati dagli script di
  rilascio.

## Linux (`linux/`)

`clarae.desktop`, icone, metainfo e `nfpm.yaml` per i pacchetti `.deb` e AppImage (`scripts/release/package-linux.sh`).
Si compila con `-tags gtk3` (GTK3 + WebKit2GTK 4.1).
