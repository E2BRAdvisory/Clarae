# Keycloak

Il servizio è solo **resource server**: non gestisce password né sessioni. Keycloak autentica gli utenti (OIDC, Authorization Code + PKCE) e il servizio valida i JWT (chiavi JWKS, `iss`, `aud`, `azp`). In più controlla lo stato dell'utente nel proprio database (sospensione, cache `OIDC_STATUS_CACHE_TTL`).

`deploy/keycloak/realm-clarae.json` è il realm di riferimento (usato anche dallo stack di sviluppo): **importarlo e poi rivedere** i valori sensibili (segreti, redirect URI, utenti di prova) prima di un ambiente reale. `deploy/keycloak-prod/realm-clarae.json` è la sua variante di produzione, senza utenti di prova e con segreto e origine della Web UI presi dall'ambiente.

## Realm `clarae`

| Impostazione            | Valore nel realm di riferimento | Note                                                            |
| ----------------------- | ------------------------------- | --------------------------------------------------------------- |
| `sslRequired`           | `external`                      | In produzione usare solo HTTPS.                                 |
| `registrationAllowed`   | `false`                         | Gli utenti si creano dalla console admin (o in Keycloak).       |
| `bruteForceProtected`   | `true`                          | Blocca i tentativi ripetuti; sbloccare da Keycloak se serve.    |
| `accessTokenLifespan`   | 300 s                           | Il desktop rinnova in silenzio con il refresh token (keychain). |
| `ssoSessionIdleTimeout` | 8 h                             |                                                                 |

## Client

| Client             | Tipo                                        | Uso                                                                                                                     |
| ------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `clarae-desktop`   | pubblico, PKCE S256, scope `offline_access` | App desktop. Redirect: `http://127.0.0.1/*` (loopback), `clarae://auth/callback` (fallback, D-08).                      |
| `clarae-web`       | pubblico, PKCE                              | Web UI. Redirect URI, post-logout redirect URI e Web origins sull'origine pubblica `WEB_UI_ORIGIN` (vedi sotto).        |
| `clarae-api`       | solo audience                               | Il claim `aud` dei token deve contenere `clarae-api` (client scope `clarae-api-audience`, già assegnato ai due client). |
| `clarae-admin-svc` | confidential, **service account**           | Usato dal servizio per le operazioni admin sugli utenti (Admin REST API).                                               |

### Client `clarae-web`: redirect e logout

Il realm di produzione `deploy/keycloak-prod/realm-clarae.json` (importato dallo stack Compose) prende l'origine da `WEB_UI_ORIGIN`, sostituita da Keycloak all'import. Con Helm il Keycloak è esterno e il client si configura a mano (scheda _Settings_ → _Access settings_), con l'origine pubblica della Web UI, per esempio `https://clarae.example.com`:

| Campo                           | Valore                                                                |
| ------------------------------- | --------------------------------------------------------------------- |
| Valid redirect URIs             | `https://clarae.example.com/*` (il login torna su `/auth/callback`)   |
| Valid post logout redirect URIs | `https://clarae.example.com/*` (oppure `+`, che riusa i redirect URI) |
| Web origins                     | `https://clarae.example.com` (uguale a `WEB_UI_ORIGIN`)               |

Il post-logout redirect URI è obbligatorio: all'uscita la Web UI chiede a Keycloak di tornare su `https://<host>/`, e se l'indirizzo non è ammesso Keycloak mostra «Invalid redirect uri» **senza chiudere la sessione SSO**. La Web UI sembra disconnessa, ma chi preme di nuovo _Accedi_ dallo stesso browser entra senza password con l'utente precedente (fino a `ssoSessionIdleTimeout`). Non lasciare origini di sviluppo (`localhost`, `127.0.0.1`) nel client della Web UI; il test `services/cloud/internal/keycloak/realm_test.go` lo verifica sul realm di produzione.

I nomi dei client e dell'audience sono configurabili (`OIDC_DESKTOP_CLIENT_ID`, `OIDC_WEB_CLIENT_ID`, `OIDC_AUDIENCE`, `OIDC_ALLOWED_AZP`, `KC_ADMIN_CLIENT_ID`).

## Service account `clarae-admin-svc`: ruoli minimi

Al service account vanno assegnati **solo** questi ruoli del client `realm-management` (ADR-0012):

- `manage-users`: creare utenti, reimpostare password, abilitare/disabilitare;
- `view-users`: leggere i dati degli utenti;
- `query-users`: cercare e filtrare.

**Non** assegnare `view-realm`, `manage-realm` né altri ruoli: la console non ne ha bisogno, e un segreto compromesso resterebbe limitato alla gestione utenti. Il segreto (`KC_ADMIN_CLIENT_SECRET`) va in un Secret; ruotarlo dalla scheda _Credentials_ del client e aggiornare il Secret.

## Ruoli di realm

| Ruolo          | Effetto                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `clarae-user`  | Utente standard.                                                                                                                           |
| `clarae-admin` | Accesso alla console di amministrazione (Web UI) e agli endpoint `/admin/*`. Assegnabile dalla console (azione `user.role`) o in Keycloak. |

Il servizio impedisce di rimuovere, sospendere o eliminare l'**ultimo amministratore** (errore `INVALID_STATE`); il controllo prende un lock sulle righe degli amministratori attivi, quindi due amministratori che si rimuovono a vicenda nello stesso istante non possono lasciare il servizio senza amministratori.

**Cambio di ruolo e token già emessi (ADR-0041).** Il ruolo vive in Keycloak ed è rispecchiato nel database a ogni accesso. Quando lo si cambia dalla console, il servizio lo aggiorna in Keycloak e nel database e da quel momento il database prevale sui token emessi **prima** del cambio: una revoca del ruolo `clarae-admin` vale dalla richiesta successiva (al più `OIDC_STATUS_CACHE_TTL` sulle altre repliche) anche se il token dell'utente porta ancora il ruolo, e una promozione vale senza attendere un nuovo token. I token emessi dopo il cambio tornano a rispecchiare Keycloak, quindi un ruolo assegnato o tolto in seguito direttamente in Keycloak prevale al primo rinnovo del token. Per questo il cambio di ruolo dalla console richiede l'Admin API di Keycloak (`KC_ADMIN_*`): senza, la console risponde `INVALID_STATE` invece di applicare un ruolo che il token successivo annullerebbe.

**Conflitto di identità.** Il collegamento tra account Keycloak e account Clarae notanda avviene per `sub`, mai per e-mail. Se un account Keycloak viene eliminato e ricreato con la stessa e-mail (nuovo `sub`) mentre l'account Clarae notanda precedente è ancora attivo o sospeso, il nuovo accesso non può creare una seconda riga con la stessa e-mail: ogni richiesta risponde `409 INVALID_STATE` con un messaggio esplicito (non più `500`), senza scrivere nulla. Il servizio non ricollega automaticamente l'account per e-mail, perché chi controlla un indirizzo e-mail nel provider di identità otterrebbe i vault di un altro account. Rimedio nel [runbook](runbook.md#un-utente-riceve-409-invalid_state-a-ogni-richiesta).

## Gruppi

I gruppi di Clarae notanda (condivisione, config profile) vivono nel database del servizio e **non** sono i gruppi di Keycloak: nessun claim di gruppo nel token, nessuna importazione da LDAP/Keycloak (D-05). Se usate LDAP/AD come fonte utenti federata in Keycloak, gli utenti compaiono in Clarae notanda al primo accesso; l'appartenenza ai gruppi Clarae notanda si gestisce dalla console.

## Console di amministrazione non pubblica

La console di Keycloak e la sua API REST (`/admin/...`) e il realm `master` (dove accede l'amministratore del server) non servono ai client: desktop e Web UI usano solo `/realms/clarae/...` (endpoint OIDC, pagine di login e account) e gli asset dei temi (`/resources/...`); il servizio cloud chiama l'API admin direttamente su Keycloak, non tramite il proxy pubblico.

- **Compose on-premise:** il proxy Caddy risponde `403` su `/admin` e `/realms/master` (anche con varianti di maiuscole, slash doppi, codifica `%xx` o parametri `;`) a meno che l'indirizzo del client sia in `KEYCLOAK_ADMIN_FROM` (CIDR separati da spazio; il default `127.0.0.1/32` non corrisponde a nessun client esterno). Per amministrare: impostare in `.env` la rete degli amministratori (VPN, ufficio), `docker compose up -d proxy`, lavorare, poi togliere la variabile e ripetere il comando. Caddy deve vedere l'IP reale del client: con un altro proxy o NAT davanti, verificare `remote_ip` nei log (`docker compose logs proxy`); le connessioni dall'host stesso (per esempio un tunnel SSH verso la porta 443) arrivano dall'indirizzo del bridge Docker, che non va aperto per intero.
- **Kubernetes:** Keycloak è esterno al chart. Applicare la stessa regola sull'ingress o sul proxy di Keycloak (pubblicare solo `/realms/clarae` e `/resources`, oppure esporre la console su un host o una porta interna, opzione `hostname-admin` di Keycloak).

Il primo avvio richiede comunque la console (ruolo `clarae-admin` al primo amministratore, utenti, rotazione del segreto di `clarae-admin-svc`): aprirla con `KEYCLOAK_ADMIN_FROM` per il tempo necessario.

## Verifica rapida

```sh
curl -s https://auth.example.com/realms/clarae/.well-known/openid-configuration | head
curl -s https://clarae.example.com/api/v1/client-config
```

Dopo il primo accesso un token deve contenere `aud: clarae-api` e `azp: clarae-web` (o `clarae-desktop`); in caso contrario vedere [Il login non funziona](runbook.md#il-login-non-funziona).
