# ADR-0008 — Endpoint pubblico `GET /client-config` per il bootstrap del client

|                       |                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------- |
| **Stato**             | accettata (spec §3.5.1 aggiornato)                                                          |
| **Data**              | 2026-10-23                                                                                  |
| **Riferimenti spec**  | §1.3 (flusso di login), §3.3.1 (client Keycloak), §2.6.6 (elenco server nel Config Profile) |
| **Devia dallo spec?** | no (dopo l aggiornamento di §3.5.1)                                                         |

## Contesto

Per avviare il login PKCE il client desktop deve conoscere l'issuer OIDC (URL del realm Keycloak) e il `client_id` `nodus-desktop`, oltre all'endpoint gRPC delle notifiche. Lo spec prevede che il Config Profile contenga un "elenco server/URL", ma la config effettiva è disponibile solo **dopo** il login. Chiedere all'utente di inserire a mano issuer e client id è fragile.

## Decisione

Il cloud espone `GET /api/v1/client-config` **senza autenticazione** con `{issuer, desktop_client_id, audience, grpc_endpoint, api_version}`. L'utente inserisce solo l'URL del server; il client scarica il documento, esegue la discovery OIDC sull'issuer e avvia il login. I valori provengono dalla configurazione del servizio (`OIDC_ISSUER`, `OIDC_DESKTOP_CLIENT_ID`, `OIDC_AUDIENCE`, `PUBLIC_GRPC_ADDR`). Nessuna informazione sensibile: issuer e client id pubblico sono già osservabili nel flusso del browser.

## Alternative considerate

- **Issuer e client id nelle impostazioni del client** — scartata: errori di configurazione frequenti, nessuna rotazione centralizzata.
- **Documento statico `/.well-known/nodus`** — equivalente; si è preferito restare sotto `/api/v1` per versionamento e contratto OpenAPI.

## Conseguenze

Endpoint implementato (`services/cloud/internal/system`) e coperto dai test di integrazione; la riga corrispondente è stata aggiunta a `Specifications.md` §3.5.1 su richiesta dell'owner.
