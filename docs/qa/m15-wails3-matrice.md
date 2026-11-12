# Matrice manuale — client desktop su Wails v3 (M15)

Da eseguire sui **binari di rilascio** (non sul dev server) di macOS, Windows 11 e Ubuntu 22.04 e 24.04, prima di accettare [ADR-0051](../adr/0051-wails-v3.md). Gli automatismi (vitest dello shim, `go test -race`, e2e su mock dei binding, smoke del binario) non vedono la finestra nativa: qui si verifica quello che solo un sistema operativo vero può dire. Uscita della milestone: **zero P0 e P1**. P0 = perdita di dati alla chiusura, login o deep link rotti, installazione sopra la 1.3.4 fallita (o aggiornamento fallito, per le build con chiave), crash all'avvio. **Nessun rollback a Wails v2** (decisione dell'owner, 2026-11-11, [ADR-0051](../adr/0051-wails-v3.md)): un P0 si corregge in avanti su v3.

Segnare `[x]` con data, sistema operativo e versione provata; un difetto va annotato sotto la voce con il suo livello (P0, P1, P2).

## Stato al 2026-11-11 (onda B-W7)

- **Provato su macOS (arm64, Go 1.27, Wails 3.1.0):** `task release-desktop OS=darwin V=…` e `scripts/release/package-macos.sh` producono `memobrain-<V>-darwin-universal.dmg` con `MemoBrain Notes.app` (x86_64 e arm64, firma ad hoc valida, `Info.plist` con `dev.memobrain.desktop`, `CFBundleExecutable memobrain`, versione stampata); l'app copiata dal `.dmg` si avvia con una data dir temporanea e, con SIGTERM, chiude subito scrivendo «stopped». Controllo dei tag del binario: `production` presente, `mcp`, `server` e `devtools` assenti.
- **Provato solo come cross-build (macOS → Windows):** `task release-desktop OS=windows` produce `memobrain.exe` (PE GUI, manifest e versione 1.3.5.0 resi) e `memobrain-amd64-installer.exe` con `makensis`; i template NSIS, manifest e `info.json` resi coincidono con quelli di v2 (stesse chiavi di registro, percorsi, `MemoBrain Notes.exe`, `Software\Classes\memobrain`).
- **Mai eseguito:** tutto il resto di questo documento. In particolare nessun avvio su Windows e Linux, nessuna build Linux con `-tags gtk3`, nessuna prova di aggiornamento, né via updater (§3) né con l'installazione manuale sopra la 1.3.4 (§1.1).
- **Nessun rollback a v2** (decisione dell'owner, 2026-11-11): in caso di problemi gravi si corregge in avanti su v3. La matrice non prova quindi nessun ritorno a una v2.
- **Criterio di aggiornamento di M15 (decisione dell'owner, 2026-11-11):** le build pubblicate non hanno l'aggiornamento automatico, quindi il criterio è l'installazione manuale sopra la 1.3.4 su ogni sistema operativo (§1.1). L'aggiornamento via updater (§3) resta da provare solo per build compilate con una chiave.

## Esiti automatici (2026-11-11)

Eseguiti da QA sul ramo di migrazione, macchina macOS arm64 sotto alimentazione di rete, Docker 29.9.3 disponibile, `caffeinate -i`. I log delle esecuzioni non sono versionati: valgono i numeri riportati qui sotto. Qui si prova solo quello che si può automatizzare: **nessuna riga manuale di questo documento è stata spuntata**.

### Suite

- **Integrazione cloud** (`task test-integration`, testcontainers): ok, `test/integration` 128,8 s, 2 min 16 s totali.
- **Sync a due dispositivi** (`task test-desktop-e2e`): ok, `internal/sync` 226,2 s e `internal/sync/transport` 21,2 s, 3 min 49 s totali.
- **`task e2e`** (desktop-mock, bundle di produzione, console web): ok, 127 + 43 + 94 = 264 passati, 36 saltati (solo nel primo gruppo), 3 min 24 s.
- **`task e2e-matrix`** (spec desktop su desktop-mock e web-core): al primo giro 245 passati, 77 saltati, **4 falliti** in 11 min 15 s: `drawing-wp5.spec.ts:79` e `:93` su desktop-mock, `drawing-embed.spec.ts:105` e `:125` su web-core. Tutti e quattro con lo stesso errore, `browserContext.close: ENOENT` su un file di traccia in `.dev/e2e-matrix/5199-5176/test-results/` (la cartella dei risultati è sparita sotto i piedi di Playwright: sulla macchina girava in parallelo un altro `e2e:workbench-ui`), mai un'asserzione. Rilanciate le due spec con `--repeat-each=3` su entrambi i target: 114 passati, 0 falliti, 6 saltati, 8 min 24 s. Classificazione: ambiente, non regressione. Per una prova pulita rieseguire la matrice intera a macchina libera.

### Smoke del binario v3 reale (macOS universale, versione `1.3.5-qa`)

Build: `scripts/build-desktop-bin.sh --version 1.3.5-qa` (17 s con cache calda; lo script scrive sempre in `apps/desktop/build/bin/`, cartella ignorata da git: il bundle è stato copiato nello scratchpad e la `MemoBrain Notes.app` preesistente ripristinata). Binario lanciato direttamente, con `MEMOBRAIN_DATA_DIR` temporanea.

- **Avvio:** il log `<data dir>/logs/memobrain.log` scrive «started» (versione `1.3.5-qa`) in 1,4 s.
- **Seconda istanza, stessa data dir, con `memobrain://open?…`:** esce con codice 0 dopo 0,6 s, la prima resta viva e registra «second instance launch» con l'URL oscurato. Non verificato: l'apertura della nota (nessun vault nello smoke).
- **Seconda istanza, data dir diversa:** convive (entrambi i processi vivi, un solo «started» per log).
- **SIGTERM:** entrambi i processi terminano in 0,15 s e il log chiude con «stopped» (soglia 5 s). Nessun processo residuo. Nessuna nota modificata nello smoke: il giro con nota sporca resta nella matrice manuale.
- **Tag:** `scripts/release/check-build-tags.sh` ok su entrambe le slice (x86_64 e arm64: tags `production`). `go version -m`: `-tags=production`, `-trimpath=true`, `CGO_ENABLED=1`, Go 1.27.4; nessuna traccia di `mcp`, `server`, `devtools`. La porta 9099 non è in ascolto.
- **Dimensione:** 129.624.928 byte contro i 127.936.608 della 1.3.4 installata in `/Applications` (+1.688.320 byte, +1,3%, entrambe universali). Il `.dmg` della 1.3.5 non è stato costruito qui.

Per rieseguire: `scripts/build-desktop-bin.sh --version 1.3.5-qa`, poi `MEMOBRAIN_DATA_DIR=$(mktemp -d) "apps/desktop/build/bin/MemoBrain Notes.app/Contents/MacOS/memobrain"`, e dalla stessa data dir una seconda esecuzione con l'URL; `scripts/release/check-build-tags.sh` sul binario.

### Ancora da eseguire

Windows 11, Ubuntu 22.04 e 24.04 e macOS Intel: nessuna prova (le righe sotto e il registro in §4 restano da compilare). Su macOS arm64 restano manuali la finestra nativa, il drop dei file, i dialoghi, il giro di chiusura con nota sporca (20 prove), i deep link a freddo e a caldo e l'installazione sopra la 1.3.4 (§1.1).

## 0. Costruire i binari da provare

Dalla radice del repository, con la CLI `wails3` installata (`task wails-cli`) solo per Windows:

```sh
# macOS (universale) → dist/memobrain-<V>-darwin-universal.dmg
ALLOW_UNSIGNED_UPDATES=1 task release-desktop OS=darwin V=1.3.5-rc.1 && scripts/release/package-macos.sh 1.3.5-rc.1
# Windows (anche da macOS con makensis) → apps/desktop/build/bin/memobrain-amd64-installer.exe
ALLOW_UNSIGNED_UPDATES=1 task release-desktop OS=windows ARCH=amd64 V=1.3.5-rc.1
# Linux (su Ubuntu con libgtk-3-dev e libwebkit2gtk-4.1-dev) → dist/*.deb e *.AppImage
ALLOW_UNSIGNED_UPDATES=1 task release-desktop OS=linux V=1.3.5-rc.1 && scripts/release/package-linux.sh all 1.3.5-rc.1
```

`task release-desktop` passa `--release` a `scripts/release/build-desktop.sh`: rifiuta la build senza `UPDATE_PUBLIC_KEY` e `UPDATE_BASE_URL` (salvo `ALLOW_UNSIGNED_UPDATES=1`) e rifiuta `MEMOBRAIN_AI`, `MEMOBRAIN_COLLAB`, `MEMOBRAIN_E2E` e `MEMOBRAIN_DIST` nell'ambiente (`MEMOBRAIN_LIVE_ENGINE` non esiste più dal 2026-11-12: ogni build ha Live su Milkdown, ADR-0049). Per le prove di §1.1 (build come quelle pubblicate) si usa `ALLOW_UNSIGNED_UPDATES=1`, che compila l'updater fuori dal binario, come `release.yml`: negli esempi sotto è già indicato. Per le prove di §3 servono invece chiave e URL di staging, **senza** `ALLOW_UNSIGNED_UPDATES`. Prima di ogni sessione: `scripts/release/check-build-tags.sh` sul binario (lo esegue già la build) e, su Linux, `ldd memobrain | grep -E 'webkit|gtk'` deve mostrare `libwebkit2gtk-4.1` e `libgtk-3`.

## 1. Installazione e disinstallazione

- [ ] **Windows:** l'installer chiede l'elevazione, installa in `C:\Program Files\E2BR-Advisory Sagl\MemoBrain Notes\` un solo `MemoBrain Notes.exe`, crea i collegamenti (menu Start e desktop) e **una sola** voce «MemoBrain Notes» in _App installate_ (chiave `Software\Microsoft\Windows\CurrentVersion\Uninstall\E2BR-Advisory SaglMemoBrain Notes`). Se WebView2 manca, il bootstrapper lo installa.
- [ ] **Windows:** `HKLM\Software\Classes\memobrain` (`URL Protocol`, `shell\open\command` verso `MemoBrain Notes.exe "%1"`) esiste dopo l'installazione e sparisce con la disinstallazione.
- [ ] **Windows:** la disinstallazione rimuove cartella, collegamenti, chiave di registro e `%AppData%\MemoBrain Notes.exe` (dati di WebView2); **non** tocca la data dir dell'app né i vault.
- [ ] **macOS:** il `.dmg` mostra `MemoBrain Notes.app` e il collegamento ad Applications; trascinata in `/Applications` si avvia (Gatekeeper avvisa: è non firmata); su macOS 12 o precedente Finder dice che serve macOS 13.
- [ ] **Linux:** il `.deb` si installa (`sudo apt install ./memobrain-*.deb` porta `libgtk-3-0` e `libwebkit2gtk-4.1-0`), l'icona compare nel menu e **nel dock** (`StartupWMClass`/`ProgramName` `memobrain`); l'AppImage si avvia con `--appimage-extract-and-run` e con FUSE.

### 1.1 Installazione manuale sopra la 1.3.4 (criterio di aggiornamento di M15)

È il percorso che gli utenti seguono davvero, e per decisione dell'owner (2026-11-11) è il criterio di aggiornamento di M15: le build pubblicate hanno l'updater spento (`.github/workflows/release.yml:112` imposta `ALLOW_UNSIGNED_UPDATES: '1'` senza `UPDATE_PUBLIC_KEY`; `README.md` dice che le nuove versioni si installano a mano), quindi §3, che prova l'aggiornamento via updater su un canale di staging, non lo copre e vale solo per build con chiave. Partire dagli installer veri della **1.3.4** (quelli pubblicati, nessun canale di staging) e installare sopra la build v3 (`1.3.5-rc.1` di §0, costruita come in `release.yml`: senza `UPDATE_PUBLIC_KEY` e con `ALLOW_UNSIGNED_UPDATES=1`).

- [ ] **Windows:** installare la 1.3.4 con il suo installer NSIS, aprire un vault di prova con note e un disegno, annotare cartella di installazione, data dir, vault recenti, impostazioni, `reg query HKLM\Software\Classes\memobrain`, la chiave Uninstall e `%AppData%\MemoBrain Notes.exe`. Lanciare sopra l'installer v3 (`memobrain-<V>-windows-amd64.exe`, UAC): nessun avviso di «già installato», stessa `UNINST_KEY` (`E2BR-Advisory SaglMemoBrain Notes`), stessa `InstallDir` (`C:\Program Files\E2BR-Advisory Sagl\MemoBrain Notes\`), **una sola** voce in _App installate_, `MemoBrain Notes.exe` sostituito e non duplicato.
- [ ] **macOS:** con la 1.3.4 in `/Applications` chiusa, trascinare sopra la `MemoBrain Notes.app` del `.dmg` v3 e scegliere _Sostituisci_: resta una sola app, Gatekeeper avvisa come per la 1.3.4 (non firmata), il bundle ID è `dev.memobrain.desktop`. Su macOS 12 o precedente il Finder rifiuta la v3 (serve macOS 13): la 1.3.4 resta com'era.
- [ ] **Linux, `.deb`:** con la 1.3.4 installata da `.deb`, `sudo apt install ./memobrain-<V>-linux-amd64.deb`: il pacchetto `memobrain` passa da 1.3.4 a 1.3.5 (`apt` lo tratta come un aggiornamento), resta una sola voce di menu e un solo eseguibile, l'icona compare nel dock.
- [ ] **Linux, AppImage:** sostituire il file della 1.3.4 con quello v3 (o lanciarlo accanto): stessa data dir, nessuna seconda cartella dati.
- [ ] **Dopo ogni installazione sopra** le stesse verifiche di §3.4, punto 3: la versione in About è 1.3.5; c'è una sola installazione; **data dir, vault recenti, impostazioni e login** sono quelli di prima senza rifare nulla; lo schema `memobrain://` funziona (W: chiave di registro intatta; M: `open memobrain://open?...`); W: `%AppData%\MemoBrain Notes.exe` è la stessa cartella, senza una seconda cartella di dati di WebView2; il giro di chiusura con una nota modificata (§2) passa sulla build installata. Annotare gli strumenti recenti di Excalidraw (M e L): si azzerano una volta.
      **Nessun ritorno a una v2** (decisione dell'owner, 2026-11-11): se un'installazione sopra la 1.3.4 fallisce o la v3 ha un difetto grave, si corregge in avanti con una nuova versione v3. Chi ha già installato la v3 non scende di versione.

## 2. Funzioni per sistema operativo

Ogni voce vale per macOS (M), Windows (W) e Linux (L) se non diversamente indicato.

### Chiusura (P0)

- [ ] Con una nota modificata e non salvata: chiusura col pulsante della finestra, poi con **Cmd+Q** (M) o **Alt+F4** (W, L), poi con «Esci» dell'updater: il file viene scritto, `app:before-close` compare **una sola volta** nel log, il processo termina entro 5 s e il log chiude con `stopped`. **20 prove per sistema operativo** e per gesto, contando i file scritti.
- [ ] Frontend che non risponde (ad esempio un loop nel devtools solo in una build di prova): la chiusura avviene dopo il timeout di 10 s, senza processi residui (Gestione attività, `ps`).
- [ ] Chiusura mentre un export o un sync è in corso: nessun file troncato, nessuna copia di conflitto spuria alla riapertura.
- [ ] SIGTERM/SIGINT (M, L): lo stesso giro di chiusura, senza perdita della nota.

### Deep link e account (P0)

- [ ] `memobrain://open?...` con l'app **chiusa** (avvio a freddo) e **aperta** (a caldo): la nota si apre, nessuna doppia consegna. **10 prove su 10** per sistema operativo.
- [ ] Login OIDC con callback loopback e con il ripiego `memobrain://auth/callback`: il token torna all'app (keychain: Portachiavi su M, Gestione credenziali su W, Secret Service su L).
- [ ] `location.reload()` (ricarica dell'interfaccia) con un deep link ancora in coda: il link viene consegnato una volta sola.
- [ ] **L:** seconda istanza (single-instance) su **Ubuntu 22.04 e 24.04**, con 50 data dir diverse (`MEMOBRAIN_DATA_DIR=$(mktemp -d)`): la seconda istanza passa gli argomenti alla prima e termina; nessuna uscita all'avvio (la regola D-Bus di v3 rifiuta l'ID di v2 in 614 casi su 1000, il 61,4%: misura dello spike B-W0 sull'ID, non un guasto osservato su Ubuntu). Sia X11 sia Wayland.
- [ ] **W:** seconda istanza: l'app aperta passa in primo piano e riceve l'URL.

### Drop di file

- [ ] Trascinare un PNG da Finder (M), Esplora risorse (W) o Nautilus (L) nell'**editor**, nel **file explorer** e su un disegno **Excalidraw**: l'allegato viene creato dove ci si aspetta, la finestra non naviga.
- [ ] Rilasciare un file **fuori** da ogni zona di drop: nessuna navigazione, nessun file aperto dal sistema.
- [ ] Trascinare del testo e un'immagine dal browser: stesso comportamento della 1.3.4.

### Dialoghi, con «Annulla»

- [ ] Scelta della cartella del vault, «Apri un'altra cartella…», import, «Salva una copia», Export HTML, Export ZIP: confermare salva/apre; **«Annulla» non mostra errori** e non cambia stato (anche su W: l'helper dei dialoghi trasforma l'annullamento in nessun errore; da verificare su Windows reale che il «Annulla» di `cfd` non faccia comparire nulla, P1).
- [ ] I dialoghi sono agganciati alla finestra (sheet su M, finestra proprietaria su W e L): non restano dietro l'app.
- [ ] Il dialogo di errore all'avvio (`app.db` illeggibile: provarlo rendendo il file non leggibile) compare una volta e l'app esce.

### Export grandi e chiamate lunghe

- [ ] **W (WebView2) e L (WebKitGTK):** export HTML da 65, 200 e 250 MiB con immagini incorporate; `SaveAttachment` da 32 MB; `ReadBinary` da 32 MB entro 1,25 volte il tempo della 1.3.4; una chiamata pendente per 3 minuti con altre in corso. Annotare tempi e memoria del processo WebView.
- [ ] **M:** gli stessi export. Il trasporto è lo stesso delle altre piattaforme e non è il canale nativo dei messaggi: gli argomenti oltre 32 MiB di JSON salgono a pezzi di 512 KiB su `/memobrain/upload/<id>` dell'asset server (B-W4b, ADR-0051). Già provato su macOS in un WKWebView reale (65, 200 e 250 MiB); qui si ripete sul binario di rilascio.
- [ ] Export HTML con il dialogo «Salva» aperto per qualche minuto e un'altra operazione in parallelo: nessun timeout.

### Menu, finestra e stampa

- [ ] **M:** menu App (senza Services), Edit (copia, incolla, annulla, ripeti, seleziona tutto) e Window; scorciatoie di modifica nell'editor; voce About con la versione; **Full Screen** (l'etichetta resta «Toggle Full Screen»).
- [ ] **W e L:** nessuna barra dei menu; il menu contestuale nativo è assente.
- [ ] **M:** titlebar con i semafori: l'intestazione si può trascinare dalla parte vuota e i pulsanti non avviano il trascinamento.
- [ ] Fullscreen delle presentazioni (`WindowFullscreen`, `WindowUnfullscreen`) e uscita con Esc; apertura di un link esterno (`BrowserOpenURL`) nel browser di sistema.
- [ ] **Stampa / Esporta in PDF:** il dialogo di stampa si apre e il PDF è leggibile (formule, immagini, diagrammi). **Esporta come immagine** (PNG): non fallisce con «canvas tainted».
- [ ] `navigator.clipboard.writeText` (copia di un link o di un blocco di codice) funziona.

### Sicurezza e compatibilità

- [ ] La CSP di produzione non produce violazioni (console del devtools in una build di prova); un iframe `https` non carica; Excalidraw funziona **senza rete** (scollegare la rete prima di aprire un disegno).
- [ ] Nel log, a uso normale, nessuna passphrase né contenuto di note (livello Warn minimo): sbloccare un vault privato e cercare la passphrase nel log (`<data dir>/logs/memobrain.log`).
- [ ] Il binario non apre la porta 9099 in ascolto (`lsof -iTCP:9099 -sTCP:LISTEN` / `netstat -ano`): conferma l'assenza del tag `mcp`.
- [ ] **M e L:** gli strumenti recenti di Excalidraw sono azzerati una volta (l'origine passa da `wails://wails` a `wails://localhost`): atteso, annotarlo. **W:** invariati.
- [ ] Avvio a freddo: tempo fino alla prima interfaccia utilizzabile non peggiore di 1,5 volte quello della 1.3.4 (vault di 5.000 note).

## 3. Aggiornamento 1.3.4 → v3 via updater (solo build con chiave)

Prova l'aggiornamento **via updater**, che le build pubblicate non hanno (vedi §1.1 per l'installazione manuale, il percorso reale). Non eseguibile con i binari pubblicati: URL e chiave del canale sono compilati nel client (`internal/updater/key.go`) e l'unico canale vero non si può usare per una prova. Serve un **canale di staging** e una 1.3.4 ricostruita con la sua chiave e il suo URL. Non è il criterio di M15 (vedi §1.1): serve solo se si distribuisce una build con chiave pubblica. Non c'è un passo di ritorno a una v2 (nessun rollback).

### 3.1 Canale di staging

1. Un host **HTTPS** raggiungibile dalle macchine di prova, con un certificato valido per il sistema (l'updater rifiuta `http://` anche su loopback: `AllowInsecureLoopback` esiste solo nei test). Va bene un bucket S3/RustFS dietro TLS, una pagina statica o un tunnel; indichiamo l'URL con `$STAGING` (`https://staging.example/desktop`).
2. Una coppia di chiavi di staging: `task release-tool` poi `bin/release gen-key` (stampa privata e pubblica; non salva nulla). Tenere la privata in `$STAGING_KEY` (variabile d'ambiente o file) e la pubblica in `$STAGING_PUB`. Mai le chiavi di produzione.
3. Il canale è `$STAGING/stable/manifest.json` più `manifest.json.sig`; gli artefatti stanno sotto `$STAGING/`.

### 3.2 Le due build

Tutte con `UPDATE_PUBLIC_KEY=$STAGING_PUB` e `UPDATE_BASE_URL=$STAGING`, **senza** `ALLOW_UNSIGNED_UPDATES`:

| Build                     | Da dove                                                                    | Versione | Note                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| A, la «1.3.4» di partenza | `git worktree add ../mb-134 v1.3.4`, poi gli script del tag (CLI Wails v2) | `1.3.4`  | Stessa versione del rilascio vero, ma chiave e URL di staging. Non si installa mai su una macchina con la 1.3.4 vera. |
| B, v3                     | il ramo della migrazione (questo repository)                               | `1.3.5`  | `task release-desktop OS=<os> V=1.3.5` e i pacchetti.                                                                 |

I nomi dei file sono `memobrain-<versione>-<os>-<arch>.<ext>` (`dmg`, `exe` NSIS, `AppImage`, `deb`), uguali nelle due epoche.

### 3.3 Pubblicare il passo

Con gli artefatti della build B in una cartella `art/`:

```sh
# Windows: l'installer esce da `release-desktop` con un nome fisso (§0) che `gen-manifest` scarta in silenzio
# (classify, tools/release/main.go:64-67: servono almeno quattro parti); va rinominato come in release.yml
cp apps/desktop/build/bin/memobrain-amd64-installer.exe art/memobrain-1.3.5-windows-amd64.exe
bin/release gen-manifest -channel stable -version 1.3.5 -sequence 1 -artifacts-dir art -base-url $STAGING -out manifest.json
bin/release sign-manifest -in manifest.json -key-env STAGING_KEY      # scrive manifest.json.sig
bin/release verify-manifest -in manifest.json -pubkey $STAGING_PUB
# caricare art/* sotto $STAGING/ e manifest.json + manifest.json.sig sotto $STAGING/stable/
```

Dopo `gen-manifest` controllare che `manifest.json` elenchi un artefatto per ogni sistema operativo provato: un file con il nome sbagliato non dà errore e manca dal manifest. Non alzare `-min-version` in questa prova (la `sequence` deve crescere a ogni manifest pubblicato: il client rifiuta come replay uno più vecchio).

### 3.4 Svolgimento (per ogni OS)

1. Installare la build **A** (macOS: in `/Applications`; Windows: installer; Linux: AppImage e, in una seconda sessione, `.deb`). Aprire un vault di prova con note, un disegno e un account di staging se serve; annotare: cartella di installazione, data dir, vault recenti, impostazioni e **registro** su Windows (`reg query HKLM\Software\Classes\memobrain`, chiave Uninstall), `%AppData%\MemoBrain Notes.exe`.
2. Pubblicare il passo 1 (versione 1.3.5, build B). Nell'app: _Verifica aggiornamenti_ (comando o impostazioni; canale _Stabile_). Deve comparire la 1.3.5; scaricare e _Installa e riavvia_ (W: UAC, installer silenzioso a app chiusa e riavvio; M: l'app esce, il `.dmg` viene montato e la `.app` sostituita; L AppImage: file sostituito in posizione, riavvio a mano; L deb: `xdg-open` della cartella e `sudo apt install`).
3. Dopo il riavvio sulla **v3** verificare (P0 se uno fallisce):
   - la versione in About è 1.3.5 e c'è **una sola** installazione (W: una voce in _App installate_, stessa cartella; M: un solo `MemoBrain Notes.app`; L: un solo eseguibile);
   - **data dir, vault recenti, impostazioni e login** sono quelli del punto 1, senza rifare nulla;
   - lo schema `memobrain://` funziona ancora (W: chiave di registro intatta; M: `open memobrain://open?...`);
   - W: `%AppData%\MemoBrain Notes.exe` è la stessa cartella (nessuna seconda cartella di dati di WebView2), la stessa finestra WebView2 conserva le impostazioni dell'interfaccia;
   - il giro di chiusura con una nota modificata (§2) passa sulla build aggiornata.
4. Prova negativa: con l'updater in v3 puntato a un manifest con firma alterata (un byte cambiato in `manifest.json.sig`) l'app mostra l'errore e **non** scarica nulla.
5. Smontare il canale: cancellare le chiavi di staging, disinstallare le due build dalle macchine di prova.

Esito atteso: l'aggiornamento riesce sui tre sistemi operativi senza perdere cartella di installazione, schema URL, data dir né dati di WebView2. Un solo fallimento è un P0.

## 4. Registro dell'esito

| Sistema operativo    | Data | Chi | Versione provata | P0  | P1  | P2  | Note |
| -------------------- | ---- | --- | ---------------- | --- | --- | --- | ---- |
| macOS (arm64)        |      |     |                  |     |     |     |      |
| macOS (Intel)        |      |     |                  |     |     |     |      |
| Windows 11 (amd64)   |      |     |                  |     |     |     |      |
| Ubuntu 22.04 (amd64) |      |     |                  |     |     |     |      |
| Ubuntu 24.04 (amd64) |      |     |                  |     |     |     |      |
