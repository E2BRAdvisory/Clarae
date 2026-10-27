# ADR-0023 — Distribuzione e aggiornamenti: dettagli (M7-WP3)

|                       |                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| **Stato**             | proposta (le pipeline non sono mai state eseguite: vedi "Verificato e non")                        |
| **Data**              | 2026-10-27                                                                                         |
| **Riferimenti spec**  | §4 (modulo `updater`, supply chain, release), tabella rischi (scheme `memobrain://`), M7; ADR-0001 |
| **Devia dallo spec?** | no. Chiarisce: chiave di firma del manifest distinta dai certificati di code signing               |

## Contesto

M7 richiede installer firmati, aggiornamento automatico dal canale firmato, immagini OCI e chart Helm. Mancano le credenziali reali (Authenticode, Apple Developer ID, cosign, chiave del manifest): la pipeline deve firmare quando i segreti ci sono e fallire in modo esplicito quando mancano.

## Decisione

**Manifest.** `manifest.json` (schema 1: `channel`, `version`, `sequence`, `min_version`, `released_at`, `notes`, `artifacts[]` con `os`, `arch`, `kind`, `url`, `sha256`, `size`) più `manifest.json.sig`, firma ed25519 detached in base64 sui byte esatti del file preceduti da un separatore di dominio (`memobrain-update-manifest-v1\n`). Codice in `shared/go/updatemanifest`, usato dal client (`apps/desktop/internal/updater`) e dal tool `tools/release` (`gen-manifest`, `sign-manifest`, `verify-manifest`, `gen-key`, `pubkey`). Il client scarica manifest e firma (limiti 256 KiB / 1 KiB) e **verifica la firma prima di fare il parse**; l'URL base è compilato (`ManifestBaseURL`) e il canale è nel percorso (`stable/`, `beta/`).

**Chiavi.** La chiave pubblica è incorporata con ldflags (`updater.PublicKeyB64`); se vuota vale la chiave di **sviluppo**, derivata da una frase pubblica (inutile come segreto). `build-desktop.sh --release` rifiuta di compilare senza `UPDATE_PUBLIC_KEY`. La privata sta nel segreto `UPDATE_SIGNING_KEY` e in una copia offline. Rotazione e compromissione: `docs/release/README.md`.

**Anti-rollback.** (1) `sequence` cresce a ogni manifest di un canale (numero di run del workflow); il client ne persiste il massimo per canale (`updater.json`, scritto solo dopo la verifica della firma) e rifiuta valori inferiori (replay). (2) `min_version` è una soglia di revoca: il client ne persiste il massimo e rifiuta manifest con `version` sotto la soglia; un client sotto la soglia vede l'aggiornamento come obbligatorio. (3) Mai offerta una versione `<=` di quella in esecuzione (semver con pre-release). (4) Un manifest di un altro canale è rifiutato. Il file di stato è locale: chi lo cancella perde la protezione, ma resta vincolato alla firma.

**Download.** Solo `https` (`http` ammesso solo su loopback, per test); la dimensione firmata è il limite assoluto, l'hash SHA-256 è controllato prima del `rename` atomico in `<data>/updates/`. Nome del file generato, mai preso dall'URL. Resume non implementato.

**Privacy e opt-out.** Le uniche richieste sono due GET (manifest, firma) con User-Agent fisso `MemobrainUpdater`, senza versione, cookie o identificativi. Controllo all'avvio (dopo 45 s) e ogni 24 h + jitter fino a 2 h; impostazioni: canale e controllo automatico (il comando `update:check` funziona sempre). Disattivazione amministrativa: variabile `MEMOBRAIN_UPDATES=off` o ldflag `DisabledByBuild=1` (pacchetti gestiti da un package manager). Le build di sviluppo (versione non semver) non controllano. Non è stata aggiunta una chiave `updates.*` al Config Profile: richiede di aggiornare le due copie dello schema e il test di parità, fuori dal perimetro del WP.

**Applicazione per OS.**

| Piattaforma          | Artefatto     | Cosa fa il client                                                                                                                                                                                                             | Automazione                                              |
| -------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Windows              | `nsis` (.exe) | script `cmd` che, dopo l'uscita dell'app, esegue l'installer `/S` e rilancia l'app                                                                                                                                            | sì (UAC: l'installer chiede privilegi di amministratore) |
| macOS                | `dmg`         | script helper: attende l'uscita, monta il dmg, `codesign --verify` e `spctl --assess`, sostituisce il `.app` tenendo il vecchio fino al successo, rilancia; se il bundle non è scrivibile o un controllo fallisce apre il dmg | sì, con ripiego manuale                                  |
| Linux AppImage       | `appimage`    | se `$APPIMAGE` è impostata sostituisce il file in loco (rename atomico)                                                                                                                                                       | sì, riavvio manuale                                      |
| Linux `.deb` / altro | `deb`         | mostra il file verificato nel file manager                                                                                                                                                                                    | no (serve root)                                          |

**Installer.** Wails v2: universale `.app` per macOS; NSIS dal template Wails (registra `memobrain://` da `wails.json`, come da ADR-0001) con `signtool` attivato da `MEMOBRAIN_SIGNTOOL_CMD`; `.dmg` con `hdiutil`, firma `codesign` (hardened runtime, `entitlements.plist` vuoto), `notarytool` e `stapler`; Linux `.deb` (nfpm) e AppImage (appimagetool), `.desktop` con `MimeType=x-scheme-handler/memobrain;` e metadata AppStream. Il Bundle ID macOS è `dev.memobrain.desktop` (prima `com.wails.memobrain`).

**Cloud.** Immagine multi-arch su GHCR, firma `cosign` keyless, SBOM e provenienza BuildKit; chart Helm completo (HPA, PDB, topology spread, probe, preStop, NetworkPolicy, ExternalSecret, Ingress HTTP e gRPC, `values.schema.json`) pubblicato come artefatto OCI firmato; `deploy/compose` per l'on-premise. Corretto il `Dockerfile` (mancava `api/config-profile.schema.json`: la build della Web UI falliva).

## Verificato e non

- **Verificato qui**: test Go (firma valida/invalida/manomessa/chiave errata, downgrade, replay, hash, dimensione, server `httptest` end to end, apply per OS con runner finti) e UI con mock; `wails build` universale macOS e `.dmg` non firmato; installer NSIS per Windows cross-compilato (non eseguito); `helm lint`/`template` e deploy su k3d usa e getta; `docker compose` con avvio completo e `/readyz`; `actionlint`.
- **Non verificato**: esecuzione dei workflow; firma Authenticode, firma/notarizzazione Apple, cosign, attestazioni; build Linux, `.deb`, AppImage; l'applicazione reale dell'aggiornamento su Windows, macOS e Linux; TLS e gRPC attraverso il proxy; HPA con carico.

## Alternative considerate

- **Aggiornatore terzo (Sparkle, go-update, Squirrel)** — scartato: aggiunge un canale di fiducia e dipendenze per OS; il manifest firmato è piccolo e testabile.
- **Firma con i certificati di code signing** — scartata: Authenticode/Apple non coprono il manifest e legano la fiducia ai fornitori; ed25519 è semplice e ruotabile.
- **Solo timestamp o scadenza anti-replay** — scartata: richiede orologi affidabili; il `sequence` monotono non dipende dall'ora.

## Conseguenze

Servono i segreti elencati in `docs/release/secrets.md`; il primo RC deve esercitare l'intera catena su macchine pulite. La regola anti-rollback impedisce i downgrade automatici per scelta. Il `sequence` basato sul numero di run richiede di non rieseguire vecchi tag. Da rivalutare: resume dei download, aggiornamento in-place su Linux `.deb` tramite repository APT.
