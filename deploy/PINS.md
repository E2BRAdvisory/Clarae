# Dipendenze fissate (pin) e loro aggiornamento

Tutto ciò che build, rilascio e installazione scaricano da terzi è fissato a un riferimento immutabile. Nessun bot aggiorna i pin: si rinfrescano a mano, almeno a ogni rilascio e quando esce una correzione di sicurezza, leggendo le note di rilascio della dipendenza. Un pin si cambia sempre insieme al suo digest/checksum, nello stesso commit.

| Cosa                                                                                               | Dove                                                                                                                                                   | Forma                                                  |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Immagini container (golang, node, distroless, caddy, postgres, rustfs, aws-cli, keycloak, busybox) | `services/cloud/Dockerfile`, `scripts/chaos/Dockerfile.cloud`, `deploy/compose/compose.yaml`, `deploy/docker/compose.dev.yaml`, `deploy/k3d/deps.yaml` | `nome:versione@sha256:<digest dell'indice multi-arch>` |
| GitHub Actions                                                                                     | `.github/workflows/*.yml`                                                                                                                              | `owner/repo@<SHA del commit> # vX.Y.Z`                 |
| appimagetool e runtime AppImage                                                                    | versioni in `release.yml` (`APPIMAGETOOL_VERSION`, `APPIMAGE_RUNTIME_VERSION`), checksum in `scripts/release/checksums.sha256`                         | versione + SHA-256 verificato in CI                    |
| Helm, nfpm                                                                                         | `release.yml` (`HELM_VERSION`, `NFPM_VERSION`)                                                                                                         | versione esatta (nfpm: modulo Go, `go.sum`)            |
| Wails (libreria, CLI, bootstrapper WebView2)                                                       | solo `apps/desktop/go.mod`                                                                                                                             | modulo Go, verificato da `go.sum`                      |
| Tool Go di sviluppo                                                                                | `tools/go.mod` (ADR-0006)                                                                                                                              | modulo Go                                              |

## Immagini

```sh
docker buildx imagetools inspect postgres:17.12      # riga "Digest:" = indice multi-arch
```

Sostituire `nome:vecchia@sha256:…` con `nome:nuova@sha256:<digest>` in tutti i file della tabella (`command grep -rn 'postgres:' services deploy scripts`). Usare un tag di versione esplicito (mai `latest` o solo la major): il tag documenta, il digest decide. Verifica: `docker compose -f deploy/compose/compose.yaml --env-file <copia di .env.example> config -q`, `task docker-build`.

## GitHub Actions

```sh
git ls-remote --tags https://github.com/actions/checkout 'refs/tags/v7*'
```

Con un tag annotato compaiono due righe: usare lo SHA della riga che termina con `^{}` (il commit), non quello del tag. Scrivere `uses: actions/checkout@<sha> # v7.0.2`.

## appimagetool e runtime AppImage

```sh
curl -fsSLO https://github.com/AppImage/appimagetool/releases/download/<ver>/appimagetool-x86_64.AppImage
curl -fsSLO https://github.com/AppImage/type2-runtime/releases/download/<ver>/runtime-x86_64
sha256sum appimagetool-x86_64.AppImage runtime-x86_64
gh api repos/AppImage/type2-runtime/releases/tags/<ver> --jq '.assets[] | "\(.digest) \(.name)"'   # confronto, se pubblicato
```

Aggiornare la versione in `release.yml` e la riga corrispondente di `scripts/release/checksums.sha256` (il nome del file contiene la versione: una versione senza checksum fa fallire il job). Non usare le release `continuous`: cambiano contenuto.

## Wails

La versione esiste in un solo posto, `apps/desktop/go.mod`; `scripts/install-wails.sh` costruisce la CLI di quella versione e la cache di `release.yml` dipende da quel file.

```sh
go -C apps/desktop get github.com/wailsapp/wails/v2@vX.Y.Z && go -C apps/desktop mod tidy
task wails-cli && task gen-wails      # poi un build desktop su ogni OS
```

Il bootstrapper WebView2 dell'installer Windows è quello incluso nel modulo Wails (hash coperto da `go.sum`); l'URL `fwlink` di Microsoft serve un file che cambia a ogni aggiornamento e non è fissabile.

## Fuori da questo elenco

Le immagini avviate dai test con testcontainers (`postgres:17` in `services/cloud/test/integration` e `apps/desktop/internal/cloudtest`) e lo script `scripts/chaos/restore-drill.sh` usano ancora tag mobili.
