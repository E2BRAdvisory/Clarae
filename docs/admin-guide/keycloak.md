# Keycloak

Il servizio è solo **resource server**: non gestisce password né sessioni. Keycloak autentica gli utenti (OIDC, Authorization Code + PKCE) e il servizio valida i JWT (chiavi JWKS, `iss`, `aud`, `azp`). In più controlla lo stato dell'utente nel proprio database (sospensione, cache `OIDC_STATUS_CACHE_TTL`).

`deploy/keycloak/realm-nodus.json` è il realm di riferimento (usato anche dallo stack di sviluppo): **importarlo e poi rivedere** i valori sensibili (segreti, redirect URI, utenti di prova) prima di un ambiente reale.

## Realm `nodus`

| Impostazione            | Valore nel realm di riferimento | Note                                                            |
| ----------------------- | ------------------------------- | --------------------------------------------------------------- |
| `sslRequired`           | `external`                      | In produzione usare solo HTTPS.                                 |
| `registrationAllowed`   | `false`                         | Gli utenti si creano dalla console admin (o in Keycloak).       |
| `bruteForceProtected`   | `true`                          | Blocca i tentativi ripetuti; sbloccare da Keycloak se serve.    |
| `accessTokenLifespan`   | 300 s                           | Il desktop rinnova in silenzio con il refresh token (keychain). |
| `ssoSessionIdleTimeout` | 8 h                             |                                                                 |

## Client

| Client            | Tipo                                        | Uso                                                                                                                   |
| ----------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `nodus-desktop`   | pubblico, PKCE S256, scope `offline_access` | App desktop. Redirect: `http://127.0.0.1/*` (loopback), `nodus://auth/callback` (fallback, D-08).                     |
| `nodus-web`       | pubblico, PKCE                              | Web UI. Impostare i redirect URI sull'URL pubblico (`https://<host>/auth/callback`) e Web origins su `WEB_UI_ORIGIN`. |
| `nodus-api`       | solo audience                               | Il claim `aud` dei token deve contenere `nodus-api` (client scope `nodus-api-audience`, già assegnato ai due client). |
| `nodus-admin-svc` | confidential, **service account**           | Usato dal servizio per le operazioni admin sugli utenti (Admin REST API).                                             |

I nomi dei client e dell'audience sono configurabili (`OIDC_DESKTOP_CLIENT_ID`, `OIDC_WEB_CLIENT_ID`, `OIDC_AUDIENCE`, `OIDC_ALLOWED_AZP`, `KC_ADMIN_CLIENT_ID`).

## Service account `nodus-admin-svc`: ruoli minimi

Al service account vanno assegnati **solo** questi ruoli del client `realm-management` (ADR-0012):

- `manage-users`: creare utenti, reimpostare password, abilitare/disabilitare;
- `view-users`: leggere i dati degli utenti;
- `query-users`: cercare e filtrare.

**Non** assegnare `view-realm`, `manage-realm` né altri ruoli: la console non ne ha bisogno, e un segreto compromesso resterebbe limitato alla gestione utenti. Il segreto (`KC_ADMIN_CLIENT_SECRET`) va in un Secret; ruotarlo dalla scheda _Credentials_ del client e aggiornare il Secret.

## Ruoli di realm

| Ruolo         | Effetto                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `nodus-user`  | Utente standard.                                                                                                                           |
| `nodus-admin` | Accesso alla console di amministrazione (Web UI) e agli endpoint `/admin/*`. Assegnabile dalla console (azione `user.role`) o in Keycloak. |

Il servizio impedisce di rimuovere o sospendere l'**ultimo amministratore** (errore `invalidState`).

## Gruppi

I gruppi di Nodus (condivisione, config profile) vivono nel database del servizio e **non** sono i gruppi di Keycloak: nessun claim di gruppo nel token, nessuna importazione da LDAP/Keycloak (D-05). Se usate LDAP/AD come fonte utenti federata in Keycloak, gli utenti compaiono in Nodus al primo accesso; l'appartenenza ai gruppi Nodus si gestisce dalla console.

## Verifica rapida

```sh
curl -s https://auth.example.com/realms/nodus/.well-known/openid-configuration | head
curl -s https://nodus.example.com/api/v1/client-config
```

Dopo il primo accesso un token deve contenere `aud: nodus-api` e `azp: nodus-web` (o `nodus-desktop`); in caso contrario vedere [Il login non funziona](runbook.md#il-login-non-funziona).
