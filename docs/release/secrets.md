# Segreti e variabili della pipeline di rilascio

Elenco completo di ciò che si può configurare nel repository GitHub (Settings, Secrets and variables, Actions) perché `release.yml` firmi. **Nessuna chiave o certificato è nel repository** e nessuna è stata generata qui.

**Nessun segreto è obbligatorio** (ADR-0031): senza certificati la pipeline produce un canale **non firmato** (installer senza firma, updater disattivato, release segnata come prerelease con la nota "unsigned"). Per tornare al comportamento rigido, in cui un segreto mancante su un tag fa fallire la pipeline, impostare la variabile `REQUIRE_SIGNING=true`. La firma si attiva da sola quando i segreti compaiono: non serve toccare i workflow.

## Cosa succede con o senza ciascun segreto

| Manca                                                | Effetto (`REQUIRE_SIGNING` non impostata)                                                                                     | Con `REQUIRE_SIGNING=true` su un tag |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `APPLE_CERT_P12_BASE64` o `APPLE_SIGNING_IDENTITY`   | `.dmg` non firmato né notarizzato: Gatekeeper avvisa (tasto destro, Apri).                                                    | La pipeline fallisce in `meta`.      |
| `APPLE_API_KEY_*`                                    | `.dmg` firmato ma non notarizzato (se il resto c'è).                                                                          | Come sopra.                          |
| `WINDOWS_CERT_PFX_BASE64`                            | `memobrain.exe` e installer non firmati: SmartScreen avvisa (Ulteriori informazioni, Esegui comunque).                        | La pipeline fallisce in `meta`.      |
| `UPDATE_SIGNING_KEY` o variabile `UPDATE_PUBLIC_KEY` | Il desktop è compilato con l'updater **disattivato** (`updater.DisabledByBuild`) e non si pubblica nessun manifest.           | La pipeline fallisce in `meta`.      |
| nessuno dei precedenti                               | Release in prerelease "unsigned", bozza (vedi `RELEASE_AUTO_PUBLISH`). Le immagini Docker restano firmate (cosign è keyless). | La pipeline fallisce in `meta`.      |

Il rilascio parte solo da un tag: non esiste più un dry run da `workflow_dispatch`.

## Variabili (pubbliche, tab Variables)

| Nome                    | Uso                                                                                                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPDATE_PUBLIC_KEY`     | Chiave pubblica ed25519 (base64) che i client usano per verificare il manifest di aggiornamento; compilata nel binario con ldflags. Senza di essa l'updater è disattivato nella build: `build-desktop.sh --release` non compila mai con la chiave di sviluppo.                    |
| `UPDATE_BASE_URL`       | URL pubblico del canale di aggiornamento (contiene `stable/manifest.json` e `beta/manifest.json`, con i `.sig`). Serve solo con l'updater attivo.                                                                                                                                 |
| `REQUIRE_SIGNING`       | (opzionale) `true`: un tag senza tutti i segreti di firma fallisce. Default: canale non firmato.                                                                                                                                                                                  |
| `RELEASE_AUTO_PUBLISH`  | (opzionale) `true`: la release è pubblicata subito. Default: bozza, che una persona promuove dopo la checklist su tre sistemi.                                                                                                                                                    |
| `ENABLE_ATTESTATIONS`   | (opzionale) `true`: pubblica le attestazioni di provenienza GitHub (immagine e file della release). Servono un repository pubblico o un piano che le includa: su un repository privato senza piano il passo fallisce ("Feature not available"). Cosign firma comunque l'immagine. |
| `LINUX_ARM64_RUNNER`    | (opzionale) etichetta di un runner arm64, es. `ubuntu-24.04-arm` (gratuito nei repository pubblici). Senza, nessun installer Linux arm64.                                                                                                                                         |
| `WINDOWS_TIMESTAMP_URL` | (opzionale) server RFC 3161, default `http://timestamp.digicert.com`.                                                                                                                                                                                                             |

## Segreti (tab Secrets)

### Manifest di aggiornamento (opzionale: senza, niente aggiornamenti automatici)

| Nome                 | Contenuto                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPDATE_SIGNING_KEY` | Chiave **privata** ed25519, base64 (64 byte o seed da 32). Generazione: vedi "Generare la chiave" sotto. Custodire anche una copia offline cifrata. |

### macOS (firma e notarizzazione)

| Nome                                   | Contenuto                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `APPLE_CERT_P12_BASE64`                | Certificato **Developer ID Application** con chiave privata, esportato in `.p12`, in base64. |
| `APPLE_CERT_PASSWORD`                  | Password del `.p12`.                                                                         |
| `APPLE_SIGNING_IDENTITY`               | Nome dell'identità, es. `Developer ID Application: Nome Cognome (TEAMID)`.                   |
| `APPLE_API_KEY_P8_BASE64`              | Chiave API App Store Connect (`AuthKey_XXXX.p8`) in base64, per `notarytool`.                |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | Key ID e Issuer ID della chiave API.                                                         |

Alternativa locale a `APPLE_API_*`: `NOTARY_KEYCHAIN_PROFILE` (profilo di `xcrun notarytool store-credentials`) oppure `APPLE_ID` + `APPLE_APP_PASSWORD` + `APPLE_TEAM_ID` (`scripts/release/package-macos.sh` accetta tutte e tre le forme).

### Windows (Authenticode)

| Nome                      | Contenuto                                                                 |
| ------------------------- | ------------------------------------------------------------------------- |
| `WINDOWS_CERT_PFX_BASE64` | Certificato di code signing (OV/EV) con chiave privata in `.pfx`, base64. |
| `WINDOWS_CERT_PASSWORD`   | Password del `.pfx`.                                                      |

Un certificato EV su token hardware non è utilizzabile da un runner ospitato da GitHub: serve un runner self-hosted o un servizio di firma in cloud (in quel caso definire direttamente `MEMOBRAIN_SIGNTOOL_CMD`, vedi `build/windows/installer/project.nsi`).

### Immagini OCI e chart Helm

Nessun segreto aggiuntivo: la firma `cosign` è **keyless** (identità OIDC del workflow, permesso `id-token: write`) e il push su GHCR usa `GITHUB_TOKEN` (`packages: write`). Il pacchetto GHCR creato al primo push è privato: renderlo pubblico (Package settings, Change visibility) o concedere l'accesso al repository dalle impostazioni del pacchetto. Il package del chart (`.../charts/memobrain`) è separato e va reso pubblico a parte.

## Generare la chiave del manifest

Su una macchina fidata, offline (il tool stampa solo su stdout, non scrive file):

```sh
task release-tool
bin/release gen-key      # private -> segreto UPDATE_SIGNING_KEY, public -> variabile UPDATE_PUBLIC_KEY
```

Salvare la chiave privata in un password manager o in un HSM/vault e tenerne una copia offline cifrata. Per ricavare la pubblica da una privata esistente: `MEMOBRAIN_UPDATE_SIGNING_KEY=... bin/release pubkey`. Prima di impostare i segreti verificare la coppia: `bin/release gen-manifest ... && bin/release sign-manifest -in manifest.json && bin/release verify-manifest -in manifest.json -pubkey <pubblica>`.

## Chiave di sviluppo

Senza `UPDATE_PUBLIC_KEY` una build locale si fida della chiave di sviluppo, derivata da una frase pubblica (`internal/updater/key.go`): **chiunque** può firmare manifest accettati da quei binari. Va bene per test locali, mai per build distribuite: per questo `--release` fallisce, a meno di `ALLOW_UNSIGNED_UPDATES=1` (la pipeline lo imposta quando mancano le chiavi), che compila l'updater **fuori** dal binario.

## Rotazione e compromissione

Vedi `docs/release/README.md`, sezione "Ruotare la chiave di aggiornamento".
