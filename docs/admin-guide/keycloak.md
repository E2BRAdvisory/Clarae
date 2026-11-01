# Keycloak

Il servizio è solo **resource server**: non gestisce password né sessioni. Keycloak autentica gli utenti (OIDC, Authorization Code + PKCE) e il servizio valida i JWT (chiavi JWKS, `iss`, `aud`, `azp`). In più controlla lo stato dell'utente nel proprio database (sospensione, cache `OIDC_STATUS_CACHE_TTL`).

`deploy/keycloak/realm-memobrain.json` è il realm di riferimento (usato anche dallo stack di sviluppo): **importarlo e poi rivedere** i valori sensibili (segreti, redirect URI, utenti di prova) prima di un ambiente reale.

## Realm `memobrain`

| Impostazione            | Valore nel realm di riferimento | Note                                                            |
| ----------------------- | ------------------------------- | --------------------------------------------------------------- |
| `sslRequired`           | `external`                      | In produzione usare solo HTTPS.                                 |
| `registrationAllowed`   | `false`                         | Gli utenti si creano dalla console admin (o in Keycloak).       |
| `bruteForceProtected`   | `true`                          | Blocca i tentativi ripetuti; sbloccare da Keycloak se serve.    |
| `accessTokenLifespan`   | 300 s                           | Il desktop rinnova in silenzio con il refresh token (keychain). |
| `ssoSessionIdleTimeout` | 8 h                             |                                                                 |

## Client

| Client                | Tipo                                        | Uso                                                                                                                           |
| --------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `memobrain-desktop`   | pubblico, PKCE S256, scope `offline_access` | App desktop. Redirect: `http://127.0.0.1/*` (loopback), `memobrain://auth/callback` (fallback, D-08).                         |
| `memobrain-web`       | pubblico, PKCE                              | Web UI. Impostare i redirect URI sull'URL pubblico (`https://<host>/auth/callback`) e Web origins su `WEB_UI_ORIGIN`.         |
| `memobrain-api`       | solo audience                               | Il claim `aud` dei token deve contenere `memobrain-api` (client scope `memobrain-api-audience`, già assegnato ai due client). |
| `memobrain-admin-svc` | confidential, **service account**           | Usato dal servizio per le operazioni admin sugli utenti (Admin REST API).                                                     |

I nomi dei client e dell'audience sono configurabili (`OIDC_DESKTOP_CLIENT_ID`, `OIDC_WEB_CLIENT_ID`, `OIDC_AUDIENCE`, `OIDC_ALLOWED_AZP`, `KC_ADMIN_CLIENT_ID`).

## Service account `memobrain-admin-svc`: ruoli minimi

Al service account vanno assegnati **solo** questi ruoli del client `realm-management` (ADR-0012):

- `manage-users`: creare utenti, reimpostare password, abilitare/disabilitare;
- `view-users`: leggere i dati degli utenti;
- `query-users`: cercare e filtrare.

**Non** assegnare `view-realm`, `manage-realm` né altri ruoli: la console non ne ha bisogno, e un segreto compromesso resterebbe limitato alla gestione utenti. Il segreto (`KC_ADMIN_CLIENT_SECRET`) va in un Secret; ruotarlo dalla scheda _Credentials_ del client e aggiornare il Secret.

## Ruoli di realm

| Ruolo             | Effetto                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `memobrain-user`  | Utente standard.                                                                                                                           |
| `memobrain-admin` | Accesso alla console di amministrazione (Web UI) e agli endpoint `/admin/*`. Assegnabile dalla console (azione `user.role`) o in Keycloak. |

Il servizio impedisce di rimuovere o sospendere l'**ultimo amministratore** (errore `invalidState`).

## Gruppi

I gruppi di MemoBrain Notes (condivisione, config profile) vivono nel database del servizio e **non** sono i gruppi di Keycloak: nessun claim di gruppo nel token, nessuna importazione da LDAP/Keycloak (D-05). Se usate LDAP/AD come fonte utenti federata in Keycloak, gli utenti compaiono in MemoBrain Notes al primo accesso; l'appartenenza ai gruppi MemoBrain Notes si gestisce dalla console.

## Console di amministrazione non pubblica

La console di Keycloak e la sua API REST (`/admin/...`) e il realm `master` (dove accede l'amministratore del server) non servono ai client: desktop e Web UI usano solo `/realms/memobrain/...` (endpoint OIDC, pagine di login e account) e gli asset dei temi (`/resources/...`); il servizio cloud chiama l'API admin direttamente su Keycloak, non tramite il proxy pubblico.

- **Compose on-premise:** il proxy Caddy risponde `403` su `/admin` e `/realms/master` (anche con varianti di maiuscole, slash doppi, codifica `%xx` o parametri `;`) a meno che l'indirizzo del client sia in `KEYCLOAK_ADMIN_FROM` (CIDR separati da spazio; il default `127.0.0.1/32` non corrisponde a nessun client esterno). Per amministrare: impostare in `.env` la rete degli amministratori (VPN, ufficio), `docker compose up -d proxy`, lavorare, poi togliere la variabile e ripetere il comando. Caddy deve vedere l'IP reale del client: con un altro proxy o NAT davanti, verificare `remote_ip` nei log (`docker compose logs proxy`); le connessioni dall'host stesso (per esempio un tunnel SSH verso la porta 443) arrivano dall'indirizzo del bridge Docker, che non va aperto per intero.
- **Kubernetes:** Keycloak è esterno al chart. Applicare la stessa regola sull'ingress o sul proxy di Keycloak (pubblicare solo `/realms/memobrain` e `/resources`, oppure esporre la console su un host o una porta interna, opzione `hostname-admin` di Keycloak).

Il primo avvio richiede comunque la console (ruolo `memobrain-admin` al primo amministratore, utenti, rotazione del segreto di `memobrain-admin-svc`): aprirla con `KEYCLOAK_ADMIN_FROM` per il tempo necessario.

## Verifica rapida

```sh
curl -s https://auth.example.com/realms/memobrain/.well-known/openid-configuration | head
curl -s https://memobrain.example.com/api/v1/client-config
```

Dopo il primo accesso un token deve contenere `aud: memobrain-api` e `azp: memobrain-web` (o `memobrain-desktop`); in caso contrario vedere [Il login non funziona](runbook.md#il-login-non-funziona).
