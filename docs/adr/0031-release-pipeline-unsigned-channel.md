# ADR-0031 — Pipeline di rilascio: correzioni, canale non firmato, matrice estesa (M10)

|                       |                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | implementata; installer provati da un dry run su GitHub, **immagine Docker e firme non verificate** (vedi "Verificato e non")                |
| **Data**              | 2026-10-29                                                                                                                                   |
| **Riferimenti spec**  | §4 (supply chain, release policy: macOS firmato e notarizzato, Authenticode, immagine OCI immutabile), M7; ADR-0001, ADR-0006, ADR-0023      |
| **Devia dallo spec?** | sì, temporaneamente: rilasci desktop non firmati finché mancano i certificati → richiede una nota in `Specifications.md` da parte dell'owner |

## Contesto

`release.yml` (installer desktop) e `release-images.yml` (immagine cloud e chart) sono stati scritti in M7-WP3 ma non sono mai stati eseguiti (ADR-0023, "Verificato e non"). Una lettura del codice ha trovato questi problemi:

- **Dockerfile:** `services/cloud/Dockerfile` copia `.yarn`, che è ignorato da git. Su un checkout pulito la build dell'immagine fallisce.
- **Wails CLI:** il workflow installa `wails@v2.12.0` con `go install`, ma con Go 1.27 la CLI non compila (x/tools v0.30, vedi `scripts/install-wails.sh`).
- **Firme:** con un tag, la pipeline rifiuta di proseguire se mancano Apple Developer ID, Authenticode e la chiave del manifest di aggiornamento. Oggi l'owner non ha nessuno di questi certificati, quindi un rilascio non può partire.
- **Copertura architetture:** mancano Windows e Linux arm64.
- **Immagini cloud:**
  - la compilazione arm64 passa da QEMU ed è lenta;
  - le immagini escono solo dai tag;
  - i workflow di rilascio non attendono i test di `ci.yml`.
- **Placeholder:** restano `ghcr.io/ORG` e `memobrain.example`.

## Decisione

1. **Dockerfile.**
   - Copiare solo `.yarnrc.yml` (Yarn arriva da corepack).
   - Stage node e Go su `--platform=$BUILDPLATFORM`, con cross-compilazione `GOOS=$TARGETOS GOARCH=$TARGETARCH` (`CGO_ENABLED=0`).
   - Aggiungere uno stage `wasm` per il core del workbench (ADR-0030).
2. **Wails CLI.** Installata ovunque con `scripts/install-wails.sh`, con cache. `make build-desktop` passa `-tags webkit2_41` su Linux.
3. **Canale non firmato.**
   - La variabile di repository `REQUIRE_SIGNING` (default `false`) decide cosa succede su un tag:
     - `true`: comportamento di ADR-0023 (fallisce se manca un segreto);
     - `false`: firma dove i segreti esistono; altrimenti produce artefatti non firmati, con un avviso nel job summary e nelle note di rilascio. La release è marcata `prerelease` con l'etichetta "unsigned".
   - Senza `UPDATE_PUBLIC_KEY` e `UPDATE_SIGNING_KEY` il binario è compilato con `updater.DisabledByBuild=1` e il manifest non viene pubblicato. Un client non deve mai fidarsi della chiave di sviluppo.
   - Con le chiavi, il flusso di ADR-0023 resta invariato.
4. **Windows.** Con il certificato si firma anche `memobrain.exe` prima di creare l'NSIS, non solo installer e uninstaller.
5. **Matrice desktop.**

   | Piattaforma   | Artefatto         | Build                                 |
   | ------------- | ----------------- | ------------------------------------- |
   | macOS         | universal `.dmg`  | `macos-14`                            |
   | Windows amd64 | NSIS              | `windows-2022`                        |
   | Windows arm64 | NSIS              | cross-compilato: WebView2 non usa CGO |
   | Linux amd64   | `.deb` + AppImage | `ubuntu-24.04`                        |
   | Linux arm64   | `.deb` + AppImage | `ubuntu-24.04-arm`                    |

6. **Immagini.**
   - Push su GHCR da `main` (`edge`, `sha-<short>`) e dai tag (`X.Y.Z`, `X.Y`, `latest` solo per le versioni stabili).
   - Firma cosign keyless, SBOM e provenance invariati.
7. **Gate di test.**
   - `ci.yml` diventa riusabile (`workflow_call`) ed è il primo job di `release.yml` e `release-images.yml`.
   - Una sola GitHub Release per tag, con:
     - gli installer;
     - `SHA256SUMS`;
     - il riferimento all'immagine con digest;
     - il riferimento al chart.
   - La release resta in bozza se `RELEASE_AUTO_PUBLISH` non è `true`.
8. **Placeholder.**
   - `ghcr.io/ORG` diventa `ghcr.io/e2br` (owner del repository, minuscolo).
   - La homepage del `.deb` è l'URL del repository GitHub. `UPDATE_BASE_URL` resta una variabile di repository, e il valore predefinito `updates.memobrain.example` in `internal/updater/key.go` non si usa più nelle build di rilascio: senza chiavi l'updater è compilato fuori, con le chiavi la variabile è passata con ldflags.
   - Le icone segnaposto restano finché l'owner non fornisce l'artwork.

## Implementazione (M10)

- `release.yml` è l'unico workflow di un tag: `meta` (versione, quali firme sono attive, matrice) → `ci` (richiama `ci.yml`) → `images` (richiama `release-images.yml`) e `build` in parallelo → `release` (una sola GitHub Release).
- La matrice è calcolata in `meta`. Linux arm64 entra solo se la variabile `LINUX_ARM64_RUNNER` nomina un runner (WebKitGTK è CGO, serve un host arm64), perché la disponibilità di `ubuntu-24.04-arm` dipende dalla visibilità del repository.
- `scripts/release/build-desktop.sh` ora legge `ARCH`, compila l'updater fuori con `ALLOW_UNSIGNED_UPDATES=1` quando mancano le chiavi, e su Windows firma `memobrain.exe` e poi esegue `makensis` direttamente. Per farlo `scripts/release/nsis-render.go` rende `wails_tools.nsh` (un template Go) come fa `wails build -nsis`, e lo script scarica il bootstrapper di WebView2.
- `release-images.yml` ha tre modi: `build` (PR, dispatch: niente push), `edge` (push su `main`) e `release` (richiamato con `version`).
- Trovato e corretto durante la verifica: `ci.yml` aveva un nome di job con `:` non quotato (YAML non valido: il workflow non sarebbe mai partito); la variabile `MEMOBRAIN_SIGNTOOL_CMD` non impostata arrivava a NSIS come testo letterale e `!finalize` la eseguiva come comando.

## Verificato e non

- **Verificato su GitHub (dry run `workflow_dispatch` dal branch `m10-release-dryrun`, versione `0.0.0-dryrun.3`, senza segreti, senza CI, senza immagini):** `meta`, build di macOS universale, Windows amd64, Windows arm64 (cross-compilato), Linux amd64 (`.deb` e AppImage), job `release` (checksum, SBOM) e raccolta degli artefatti. Il run completo è verde in circa 6 minuti, e produce installer da 62 MB (Linux), 65 MB (macOS), 33 MB (Windows amd64) e 32 MB (Windows arm64). Gli installer sono **non firmati**, come previsto.
- **Difetti trovati dai dry run e corretti:**
  1. Windows: `corepack enable` prima di `setup-node` perdeva lo shim di Yarn 4 (corretto anche nel job `desktop-build` di `ci.yml`).
  2. Linux: `nfpm` non espande `${STAGE}` nei percorsi dei file (ora reso da `package-linux.sh`).
  3. Linux: `appimagetool` richiede `desktop-file-utils`.
  4. (Prima dei dry run) `ci.yml` aveva un nome di job con `:` non quotato, e `MEMOBRAIN_SIGNTOOL_CMD` non impostata arrivava a NSIS come testo letterale.
- **Verificato in locale:** `actionlint`, `bash -n`, installer NSIS arm64 con `makensis` da macOS (template reso, exe finto, firma simulata), `helm lint`.
- **Non verificato:**
  - **L'immagine Docker**: nel dry run il job `images` è saltato per costruzione, e la build locale `docker buildx build --platform linux/amd64,linux/arm64` è fallita due volte per la rete di Docker (`unexpected EOF` da `sum.golang.org`, `ERR_SOCKET_CLOSED_BEFORE_CONNECTION` da yarn), non per il Dockerfile, ma resta senza esito. Va provata da GitHub (push su `main`, che pubblica `edge`, oppure un tag).
  - Il gate `ci.yml` richiamato da `release.yml` (saltato nel dry run) e `ci.yml` stesso dopo le modifiche.
  - Linux arm64 (senza `LINUX_ARM64_RUNNER` non entra nella matrice; il repository è privato).
  - Firma Authenticode e Apple, notarizzazione, firma di `memobrain.exe`, manifest di aggiornamento firmato.
  - Cosign, attestazioni, push su GHCR, visibilità dei package, chart OCI, i `permissions` e gli `outputs` del reusable workflow.
  - Che gli installer **si avviino** su Windows, macOS e Linux (nessuno è stato eseguito).
  - La creazione della GitHub Release (nel dry run non si crea).
- **Da fornire dall'owner:** certificati di firma, icone definitive, `LINUX_ARM64_RUNNER`, rendere pubblici i package GHCR.

## Proposta di modifica dello spec

§4 (release policy): "Fino alla disponibilità dei certificati (Apple Developer ID, Authenticode) gli installer possono essere pubblicati come prerelease non firmate, con avviso esplicito. L'aggiornamento automatico resta disattivato in queste build. Un rilascio stabile richiede `REQUIRE_SIGNING=true`."

## Alternative considerate

- **Bloccare ogni rilascio fino all'arrivo dei certificati**: scartata, l'owner vuole installer pubblicabili subito.
- **Firma self-signed o ad-hoc (`codesign -s -`)**: scartata, non elimina gli avvisi di Gatekeeper e SmartScreen e dà un falso senso di sicurezza. L'ad-hoc resta solo per la build universale macOS, dove è necessario.
- **goreleaser**: scartato, gli script esistenti coprono già Wails, nfpm, AppImage e il manifest. Introdurlo ora aggiungerebbe un'altra configurazione da mantenere.

## Conseguenze

- Gli installer non firmati mostrano gli avvisi del sistema operativo. La guida utente deve spiegare come aprirli: macOS "Apri" dal menu contestuale, Windows SmartScreen "Ulteriori informazioni".
- Le build non firmate non si aggiornano da sole: l'utente scarica la versione nuova a mano.
- Con l'arrivo dei segreti basta impostare `REQUIRE_SIGNING=true`, senza toccare i workflow.
- Il package GHCR va reso pubblico a mano dopo il primo push (passo documentato in `docs/release/README.md`).
