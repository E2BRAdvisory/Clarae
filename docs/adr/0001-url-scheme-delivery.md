# ADR-0001 — Consegna degli URL `memobrain://` per sistema operativo (SPIKE-01)

|                       |                                                                                  |
| --------------------- | -------------------------------------------------------------------------------- |
| **Stato**             | accettata (verifica manuale su macOS/Windows/Linux in `docs/qa/m0-checklist.md`) |
| **Data**              | 2026-10-23                                                                       |
| **Riferimenti spec**  | §1.3, §2.2.1 (URI scheme), D-07, D-08                                            |
| **Devia dallo spec?** | no                                                                               |

## Contesto

Lo scheme `memobrain://` serve ad aprire note (`memobrain://open?vault=…&file=…`) e come fallback del redirect OIDC (`memobrain://auth/callback`). Wails v2 (2.12) consegna l'URL in modo diverso per OS: su macOS tramite `Mac.OnUrlOpen` (anche ad app già in esecuzione, gestito dal sistema con l'handler di apertura URL); su Windows (solo installer NSIS) e Linux (`.desktop` con `x-scheme-handler`) il sistema avvia una **seconda istanza** con l'URL in `argv`, che il `SingleInstanceLock` inoltra all'istanza attiva tramite `OnSecondInstanceLaunch`.

## Decisione

- `main.go` registra entrambi i canali: `Mac.OnUrlOpen → app.HandleURL` e `SingleInstanceLock.OnSecondInstanceLaunch → platform.FindSchemeURL(args) → app.HandleURL`; la prima istanza controlla anche i propri `os.Args`.
- `UniqueId` del lock è derivato dalla **directory dati** (`platform.InstanceID`), così due istanze con `--data-dir` diversi coesistono (test multi-dispositivo in M2).
- Gli URL ricevuti prima che il frontend sia pronto vengono accodati e consegnati in `OnDomReady`.
- Il loopback resta il percorso primario del login (D-08); lo scheme è fallback e la sicurezza del callback si basa su PKCE + `state` tenuti solo in memoria dell'istanza che ha avviato il login.

## Alternative considerate

- **Solo custom scheme** — scartata: registrazione non garantita (AppImage, policy aziendali, Linux senza `.desktop`).
- **Solo loopback** — scartata: alcuni ambienti bloccano i listener locali o Keycloak può rifiutare `invalid_redirect_uri`.

## Conseguenze

Il comportamento "URL verso app già aperta" va verificato manualmente su ciascun OS (checklist M0); la registrazione dello scheme negli installer è parte di M7-WP3 (NSIS, `Info.plist` generato da `wails.json` `info.protocols`, `.desktop`).
