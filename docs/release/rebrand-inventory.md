# Rebrand: da "Nodus" a "MemoBrain Notes"

Il nome del prodotto è **MemoBrain Notes**. "Nodus" era il nome in codice (segnaposto) usato fino a M7. Il rename è stato eseguito prima del primo rilascio: nessuna migrazione né alias di compatibilità, perché non esistono installazioni, vault o token emessi con i nomi precedenti.

## Convenzioni

| Contesto                                                           | Forma                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Nome visualizzato (UI, installer, docs, titoli)                    | `MemoBrain Notes`                                                                                                   |
| Slug, path, chiavi, metriche, bucket, realm, client, chart, binari | `memobrain` (kebab/snake/dot come prima: `memobrain-cloud`, `memobrain_http_requests_total`, `memobrain.web.theme`) |
| Variabili d'ambiente                                               | `MEMOBRAIN_*`                                                                                                       |
| Identificatori Go/TS in PascalCase                                 | `Memobrain…` (es. `MemobrainClient`)                                                                                |
| ID inverso dell'app                                                | `dev.memobrain.desktop`                                                                                             |
| Schema URL                                                         | `memobrain://`                                                                                                      |
| Cartella di configurazione del vault                               | `.memobrain/`                                                                                                       |
| Scope npm / modulo Go / package proto                              | `@memobrain/*` / `memobrain/…` / `memobrain.v1`                                                                     |

Resta invariato il magic byte `NDS1` del formato E2EE: è un identificatore di formato, non il nome del prodotto.

## Verifica dei residui

```sh
scripts/rebrand-inventory.sh            # conteggi del nome cercato (default: nodus); deve essere vuoto
scripts/rebrand-inventory.sh --name foo # cerca un altro nome
```

Residui voluti: `Specifications.md` (v1.1) cita ancora "Nodus", `.nodus/`, `nodus://`, `nodus-api`, ecc. e va aggiornato dall'owner; gli ADR 0001–0023 usano ora il nome nuovo.

## Fuori perimetro (da fare a parte)

Logo e icone definitive, nome nello store/installer firmato e certificati di firma (il nome entra nell'identità del certificato), dominio e URL pubblici (`memobrain.example.com` sono segnaposto), testi legali.
