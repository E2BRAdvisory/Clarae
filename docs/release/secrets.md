# Segreti e variabili della pipeline di rilascio

Elenco completo di ciò che va configurato nel repository GitHub (Settings, Secrets and variables, Actions) perché `release.yml` e `release-images.yml` firmino. **Nessuna chiave o certificato è nel repository** e nessuna è stata generata qui. Senza questi valori le pipeline si comportano così: su un tag **falliscono con un errore esplicito**, nei dry-run (`workflow_dispatch`) producono artefatti non firmati con un `::warning::` ben visibile.

## Variabili (pubbliche, tab Variables)

| Nome                    | Uso                                                                                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPDATE_PUBLIC_KEY`     | Chiave pubblica ed25519 (base64) che i client usano per verificare il manifest di aggiornamento; compilata nel binario con ldflags. **Obbligatoria su tag**: `build-desktop.sh --release` rifiuta di compilare con la chiave di sviluppo. |
| `UPDATE_BASE_URL`       | URL pubblico del canale di aggiornamento (contiene `stable/manifest.json` e `beta/manifest.json`, con i `.sig`). Obbligatoria su tag.                                                                                                     |
| `WINDOWS_TIMESTAMP_URL` | (opzionale) server RFC 3161, default `http://timestamp.digicert.com`.                                                                                                                                                                     |

## Segreti (tab Secrets)

### Manifest di aggiornamento (obbligatorio su tag)

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

Nessun segreto aggiuntivo: la firma `cosign` è **keyless** (identità OIDC del workflow, permesso `id-token: write`) e il push su GHCR usa `GITHUB_TOKEN` (`packages: write`). Il pacchetto GHCR creato al primo push è privato: renderlo pubblico o concedere l'accesso al repository dalle impostazioni del pacchetto.

## Generare la chiave del manifest

Su una macchina fidata, offline (il tool stampa solo su stdout, non scrive file):

```sh
make release-tool
bin/release gen-key      # private -> segreto UPDATE_SIGNING_KEY, public -> variabile UPDATE_PUBLIC_KEY
```

Salvare la chiave privata in un password manager o in un HSM/vault e tenerne una copia offline cifrata. Per ricavare la pubblica da una privata esistente: `MEMOBRAIN_UPDATE_SIGNING_KEY=... bin/release pubkey`. Prima di impostare i segreti verificare la coppia: `bin/release gen-manifest ... && bin/release sign-manifest -in manifest.json && bin/release verify-manifest -in manifest.json -pubkey <pubblica>`.

## Chiave di sviluppo

Senza `UPDATE_PUBLIC_KEY` i binari si fidano della chiave di sviluppo, derivata da una frase pubblica (`internal/updater/key.go`): **chiunque** può firmare manifest accettati da quei binari. Va bene per test locali, mai per build distribuite: per questo `--release` fallisce.

## Rotazione e compromissione

Vedi `docs/release/README.md`, sezione "Ruotare la chiave di aggiornamento".
