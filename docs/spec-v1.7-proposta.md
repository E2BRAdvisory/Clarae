# Proposta di aggiornamento di `Specifications.md` alla v1.7

|                 |                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**       | **recepita** in `Specifications.md` v1.7 il 2026-11-16 (con la nomenclatura di ADR-0052 in tutto lo spec); resta come storia del recepimento                                                                                                                                                                                                                                                                               |
| **Data**        | 2026-11-16                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Base**        | `Specifications.md` v1.6 (15 novembre 2026), 2027 righe; i numeri di riga sono quelli di questa versione                                                                                                                                                                                                                                                                                                                   |
| **Fonti**       | [ADR-0052](adr/0052-rebrand-clarae-notanda.md), [0057](adr/0057-identita-dispositivo-desktop-hostname.md), [0058](adr/0058-logout-completo-da-keycloak.md), [0059](adr/0059-pulizia-cartella-configurazione-legacy-e-zip-coerente.md), [0060](adr/0060-web-viewer-acceso-di-default.md) e [0061](adr/0061-budget-iniziale-console-720.md), tutti **accettati dall'owner il 2026-11-16** e già implementati (1.5.0 e 1.7.2) |
| **Come usarla** | ogni voce indica la sezione e la riga, il **testo attuale** (citato alla lettera, in un blocco `text`) e il **testo proposto**. Dove il testo proposto sostituisce un frammento, si sostituisce solo quel frammento; dove si aggiunge, la voce dice dopo quale riga                                                                                                                                                        |

Gli ADR 0057–0061 sono il lavoro di M21 (correttivi dello schizzo del 2026-11-15, [roadmap](roadmap.md) §13-quaterdecies), rilasciato come 1.7.2. [ADR-0052](adr/0052-rebrand-clarae-notanda.md) (rebrand, M17, 1.5.0) è accettato lo stesso giorno e va recepito nella stessa v1.7: **tutto il testo proposto qui sotto usa la nomenclatura nuova** (_Clarae notanda_, `clarae`, `.clarae/`). Dove cita il nome vecchio è perché parla dei dati o dei client della 1.x, o di un'etichetta congelata (vedi §3).

Il testo proposto **non** dice nulla di Wails v3: [ADR-0051](adr/0051-wails-v3.md) non è accettato e lo spec continua a dire Wails v2 (D-07, A-03).

---

## 1. Riepilogo

| ADR  | Cosa cambia nello spec                                                                                                                                             | Sezioni                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| 0052 | Nome del prodotto e identificatori in tutto lo spec, salvo le eccezioni del §3                                                                                     | intestazione, §1.1 … §4.5, C.2, C.4 (vedi §3)              |
| 0057 | Il dispositivo desktop è identificato dal nome del computer: colonna `hostname`, indice unico parziale, registrazione come upsert (sempre `201`), revoca al logout | §1.7, §2.6.1, §3.2.2 (e l'elenco delle migrazioni), §3.5.1 |
| 0058 | Uscita completa: flusso di logout del desktop, `/signed-out` e `prompt=login`, post-logout redirect del client web                                                 | §1.3, §3.3.1                                               |
| 0059 | Pulizia della cartella di configurazione legacy; lo ZIP ha la sola `.clarae/`                                                                                      | §2.8.2, §3.4.6, §3.5.2                                     |
| 0060 | `features.web_viewer` **acceso** per default; «Nuova applicazione» nell'esploratore                                                                                | §2.2.1, §2.6.6, C.2, C.4                                   |
| 0061 | Budget iniziale della console 720 kB                                                                                                                               | §4.4, C.4                                                  |

Più, per tutti: intestazione e registro delle revisioni (§2) e Appendice C.4 (§4.10).

---

## 2. Intestazione e registro delle revisioni

**Titolo (riga 1)** e **nome del prodotto (riga 9)**: sono sostituzioni di ADR-0052 (vedi §3). Testo attuale della riga del nome:

```text
| **Nome del prodotto** | *MemoBrain Notes* (identificatori `memobrain`; già "Nodus" come nome in codice) |
```

Testo proposto:

```text
| **Nome del prodotto** | *Clarae notanda* (identificatori `clarae`; già *MemoBrain Notes* e, come nome in codice, "Nodus") |
```

**Versione e data (righe 7-8).** Testo attuale:

```text
| **Versione documento** | 1.6 — Decisioni D-01…D-08 e ADR 0009–0022, 0024, 0026–0044 e 0053–0056 recepiti (vedi Appendice C) |
```

```text
| **Data** | 15 novembre 2026 |
```

Testo proposto:

```text
| **Versione documento** | 1.7 — Decisioni D-01…D-08 e ADR 0009–0022, 0024, 0026–0044 e 0052–0061 recepiti (vedi Appendice C) |
| **Data** | 16 novembre 2026 |
```

**Registro delle revisioni.** Aggiungere in testa, prima della riga 1.6 (riga 17), la riga:

```text
| 1.7 | 16 novembre 2026 | Recepiti gli ADR accettati dall'owner il 16 novembre 2026 (Appendice C.4), già implementati (1.5.0 e 1.7.2): **ADR-0052** rebrand a *Clarae notanda* (identificatori `clarae`, cartella `.clarae/`, schema `clarae://`; restano congelate le etichette crittografiche `memobrain/v1/*` e `memobrain/v2/*`, e per i dati e i client della 1.x i nomi vecchi restano letti fino alla 2.0); **ADR-0057** identità del dispositivo desktop per nome del computer (colonna `devices.hostname` con indice unico parziale, registrazione come upsert sempre con `201`, revoca del proprio dispositivo al logout); **ADR-0058** logout completo da Keycloak (revoca dei token, logout back-channel del desktop, pagina `/signed-out` della console, `prompt=login` dopo un'uscita esplicita); **ADR-0059** pulizia della cartella di configurazione legacy `.memobrain/` e ZIP con la sola `.clarae/` (emenda ADR-0052: non più «mai cancellazioni»); **ADR-0060** `features.web_viewer` **acceso per default** e «Nuova applicazione» nell'esploratore dei file (emenda ADR-0056); **ADR-0061** budget iniziale della console a 720 kB (emenda ADR-0020). Sezioni modificate: il nome in tutto lo spec (ADR-0052), §1.3, §1.7, §2.2.1, §2.6.1, §2.6.6, §2.8.2, §3.2.2, §3.3.1, §3.4.6, §3.5.1, §3.5.2, §4.4, C.2, C.4. **Non** sono recepiti ADR-0023 (proposta) e gli ADR 0045–0051 (0045, 0046, 0047, 0048 e 0049 accettati; 0050 e 0051 in proposta): lo spec continua a dire Wails v2. |
```

Le righe già presenti del registro (1.1–1.6) sono cronologia e **non** si riscrivono, anche se citano `.memobrain/`, `@memobrain/…` o «MemoBrain Notes». La riga 1.6 dice che lo spec «continua a dire Wails v2 e _MemoBrain Notes_… finché non sono recepiti»: resta com'è, perché racconta la v1.6.

---

## 3. Recepimento di ADR-0052 (rebrand)

La base è la sezione «Sostituzioni da riportare in `Specifications.md`» di [ADR-0052](adr/0052-rebrand-clarae-notanda.md#sostituzioni-da-riportare-in-specificationsmd): lì stanno le tabelle «Sostituzione semplice» e «Non basta sostituire». **I numeri di riga di quell'elenco sono quelli della v1.5**: la v1.6 ha aggiunto righe, quindi vanno ricalcolati. Il comando `command grep -n -i memobrain Specifications.md` dà 102 righe sulla v1.6.

### 3.1 Cosa deve restare con il nome vecchio

Dopo il recepimento `grep -i memobrain` deve trovare solo queste righe (le stesse eccezioni di `scripts/rebrand/allowlist.tsv`, `task lint-brand`):

| Eccezione                                                                                               | Righe della v1.6 (da ricalcolare)                                                                                                                                                                                                                                | Perché                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Etichette crittografiche congelate** `memobrain/v1/*` e `memobrain/v2/*` (§3.8.2, §3.8.3)             | 1552–1554, 1563, 1587                                                                                                                                                                                                                                            | Sono l'input di HKDF e l'AAD di AES-GCM: cambiarle rende indecifrabili i vault privati già creati. Aggiungere la nota «etichette di dominio congelate: il prefisso non segue il nome del prodotto» (ADR-0052, punto 2.1) |
| **Registro delle revisioni** (righe 1.1–1.6)                                                            | 17–21                                                                                                                                                                                                                                                            | Cronologia                                                                                                                                                                                                               |
| **Righe di C.4** (storico degli ADR già recepiti; l'introduzione, riga 1986, si riscrive come in §4.10) | 1986, 1994, 1996–1997, 1999, 2003–2004, 2008–2009, 2014, 2016, 2022, 2024                                                                                                                                                                                        | Storico: lasciarle com'erano e aggiungere la nota di ADR-0052 (la riga nuova di C.4, §4.10)                                                                                                                              |
| **Dati e client della 1.x** (periodo di compatibilità, fino alla 2.0)                                   | dove il testo lo dice (cartella `.memobrain/`, schema `memobrain://`, `MEMOBRAIN_AUTH_REDIRECT`, `customData.memobrain`, proto `memobrain.v1`, realm, client e audience `memobrain…` delle installazioni create prima della 1.5, Web Lock `memobrain-workbench`) | Servono a descrivere il periodo di transizione di ADR-0052                                                                                                                                                               |

### 3.2 Righe che non sono una semplice sostituzione

Seguire la tabella «Non basta sostituire» di ADR-0052. In sintesi, con le righe della v1.6:

| Punto                                               | Righe della v1.6                                                                                    | Cosa scrivere                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cartella `.memobrain/` → `.clarae/`                 | 300, 341–342, 353–355, 362, 483, 615, 618, 620–621, 632, 634, 670, 1089, 1172–1173, 1208, 1213–1216 | `.clarae/`, con il periodo di transizione: i client leggono anche `.memobrain/`; la parte locale si sposta all'apertura, le impostazioni sincronizzate dei vault collegati con `features.config_dir_v2` (acceso dalla 1.7.0). Il titolo e la tabella di **§3.4.6** nominano entrambe le cartelle (vedi §4.6 per la parte di ADR-0059) |
| Temporanei `.memobrain-tmp-*`                       | 1089                                                                                                | `.clarae-tmp-*`; i temporanei col vecchio nome restano esclusi (regola a doppio nome)                                                                                                                                                                                                                                                 |
| Schema URL, CLI                                     | 209–210, 373–374, 685, 1031, 1962                                                                   | `clarae://` registrato dagli installer; `memobrain://` ancora registrato e accettato; il redirect ha entrambi gli URI; CLI `clarae open`, `clarae new` (P2)                                                                                                                                                                           |
| `MEMOBRAIN_AUTH_REDIRECT`                           | 209                                                                                                 | `CLARAE_AUTH_REDIRECT` ha la precedenza; `MEMOBRAIN_AUTH_REDIRECT` vale ancora, con un avviso                                                                                                                                                                                                                                         |
| Realm, client, audience, ruoli (§1.3, §1.6, §3.3.1) | 187, 204, 209, 268, 646, 1031–1035                                                                  | `clarae…` per le installazioni nuove; su quelle esistenti vale il vecchio nome se l'issuer è `/realms/memobrain` (famiglia dell'issuer, `docs/admin-guide/configurazione.md`)                                                                                                                                                         |
| gRPC (§3.6)                                         | 1481                                                                                                | `package clarae.v1;`, con la nota: `memobrain.v1` è servito ancora dallo stesso handler                                                                                                                                                                                                                                               |
| Chiave Excalidraw (§2.7)                            | 615, 632                                                                                            | `customData.clarae`; i client leggono anche `customData.memobrain`                                                                                                                                                                                                                                                                    |
| Web Lock del workbench (§1.7)                       | 285                                                                                                 | `clarae-workbench`; la scheda nuova prende anche il lock vecchio                                                                                                                                                                                                                                                                      |
| Feature flag `features.config_dir_v2` (§2.6.6)      | tabella dei flag                                                                                    | Riga nuova, vedi §3.3                                                                                                                                                                                                                                                                                                                 |

### 3.3 Riga nuova nella tabella dei flag (§2.6.6)

Il flag `features.config_dir_v2` non è nello spec v1.6 e ADR-0059 ne dipende (la parte sincronizzata della pulizia vale solo con il flag acceso). Aggiungere dopo la riga di `features.web_viewer` (riga 591):

```text
| `features.config_dir_v2` | **acceso dalla 1.7.0** | Sposta le impostazioni sincronizzate dei vault collegati dalla cartella di configurazione della 1.x (`.memobrain/`) a `.clarae/`, come uno spostamento ordinario che conserva gli id dei file e lo storico (ADR-0052). Un client 1.4 o precedente legge e scrive ancora la cartella vecchia e ricreerebbe ogni impostazione: si aggiornano prima i dispositivi, poi il cloud, oppure lo si imposta a `false` nel frattempo. Spento ferma solo lo spostamento (un'impostazione già spostata resta dov'è e il client legge entrambe le cartelle). Un cloud 1.5 o 1.6 distribuisce `false`, uno 1.7 `true`; la pulizia sincronizzata di ADR-0059 richiede un cloud 1.7 o successivo |
```

Fonte: `api/config-profile.schema.json` (`features.config_dir_v2`, default `true`).

### 3.4 Un'avvertenza sul testo già nello spec

Il testo aggiunto dalle revisioni 1.3–1.6 usa `memobrain` e `.memobrain/` dove descrive il comportamento di allora. Il recepimento di ADR-0052 sostituisce il nome anche lì (è nelle righe delle liste di §3.2), **tranne** dove il testo descrive un file o un client della 1.x.

---

## 4. Modifiche per sezione

Nelle citazioni qui sotto, il testo attuale è quello della v1.6 **con il nome vecchio**, come sta oggi nello spec; il testo proposto è già con la nomenclatura nuova.

### 4.1 ADR-0057 — §1.7 «Workbench web e core del client in WebAssembly»

Il §1.7 contiene i due punti sull'identità e sulla revoca dei dispositivi. Il titolo della sezione non cambia.

**(a) Riga 287, punto «Dispositivo revocato».** Testo attuale (frammento):

```text
offre "Registra di nuovo questo dispositivo", che registra un nuovo dispositivo dello stesso account e invia ciò che era in attesa.
```

Testo proposto (sostituisce il frammento):

```text
offre "Registra di nuovo questo dispositivo", che registra il dispositivo dello stesso account (sul desktop riattiva la riga dello stesso nome del computer, sul browser ne crea una nuova) e invia ciò che era in attesa. Il client **non** ripete da solo la registrazione: una revoca fatta dalla console non si annulla dal computer stesso al primo `commit` rifiutato (ADR-0057).
```

**(b) Aggiunta.** Dopo il punto «Dispositivo revocato» (riga 287) aggiungere:

```text
- **Identità del dispositivo desktop (ADR-0057).** Il client desktop si registra con il nome del computer (`os.Hostname()`, oppure la variabile d'ambiente `CLARAE_DEVICE_NAME`, che serve a due istanze sullo stesso computer e ai test). Per `windows`, `macos` e `linux` il cloud identifica il dispositivo da `(utente, piattaforma, nome senza maiuscole né spazi ai lati)`: registrare di nuovo lo stesso nome e la stessa piattaforma (il login successivo a un logout, o "Registra di nuovo questo dispositivo") restituisce lo stesso `id`, riattivato se era revocato, e non aggiunge righe all'elenco (`POST /me/devices`, §3.5.1). Al logout il client revoca il proprio dispositivo (§1.3), a miglior sforzo: senza rete la riga resta attiva e il login successivo la riprende. **Limiti accettati:** due computer dello stesso utente con lo stesso nome e la stessa piattaforma sono un solo dispositivo (condividono `id` e ultimo accesso, e una revoca vale per entrambi); un computer rinominato compare come dispositivo nuovo e il vecchio resta attivo finché non lo si revoca; **una revoca dalla console si annulla al login successivo della stessa macchina**, perché la registrazione riattiva la riga: vale quindi per un computer che non rientra con lo stesso nome, e per escludere un utente restano la sospensione dell'account e la revoca delle sessioni (§2.6.5). Il browser (`web`) non cambia: un dispositivo per profilo, con l'identità in IndexedDB.
```

### 4.2 ADR-0057 — §2.6.1 «Gestione vault»

Riga 537. Testo attuale (frammento):

```text
nome, piattaforma (`platform: "web"` per il workbench web, uno per profilo del browser, §1.7), ultimo accesso;
```

Testo proposto (sostituisce il frammento):

```text
nome (per `windows`, `macos` e `linux` è il nome del computer e identifica il dispositivo: uno per utente, piattaforma e nome, anche dopo un logout, §1.7, ADR-0057), piattaforma (`platform: "web"` per il workbench web, uno per profilo del browser, §1.7), ultimo accesso;
```

### 4.3 ADR-0057 — §3.2.2 «DDL di riferimento»

**(a) Tabella `devices`** (dalla riga 814, 10 righe). Testo attuale:

```text
CREATE TABLE devices (
  id           UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  platform     TEXT NOT NULL,
  app_version  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
```

Testo proposto:

```text
CREATE TABLE devices (
  id           UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  platform     TEXT NOT NULL,
  app_version  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  hostname     TEXT                         -- solo desktop: lower(btrim(name)); NULL per `web` e per le righe che hanno perso l'identità del loro computer (migrazione 0016, ADR-0057)
);
CREATE UNIQUE INDEX devices_hostname_uq ON devices (user_id, platform, hostname) WHERE hostname IS NOT NULL;  -- un dispositivo desktop per utente, piattaforma e nome
```

**(b) Elenco delle migrazioni** (riga 1020). Testo attuale (due frammenti):

```text
- **Migrazioni (ADR-0009, ADR-0011, ADR-0012, ADR-0021).**
```

```text
`0008_role_changed_at`, `0009_upload_chunk_keys`.
```

Testo proposto (sostituiscono i due frammenti):

```text
- **Migrazioni (ADR-0009, ADR-0011, ADR-0012, ADR-0021, ADR-0057).**
```

```text
`0008_role_changed_at`, `0009_upload_chunk_keys`, `0016_device_hostname` (colonna `devices.hostname`; per ogni `(utente, piattaforma, nome)` resta attivo il dispositivo con l'attività più recente, gli altri si **revocano** e perdono il nome, ma le righe non si cancellano perché le revisioni dei file puntano a `device_id`; indice unico parziale `devices_hostname_uq`; ADR-0057). Le migrazioni `0010`–`0015` non sono descritte in questo elenco.
```

### 4.4 ADR-0057 — §3.5.1 «Profilo, dispositivi, configurazione»

**Riga 1265.** Testo attuale:

```text
| POST | `/me/devices` | U | Registra dispositivo (ritorna `device_id`; `platform: "web"` per il workbench web, §1.7) |
```

Testo proposto:

```text
| POST | `/me/devices` | U | Registra dispositivo (ritorna `device_id`; `platform: "web"` per il workbench web, §1.7). Per `windows`, `macos` e `linux` `name` è il nome del computer e identifica il dispositivo: lo stesso nome e la stessa piattaforma restituiscono lo stesso `id`, riattivato se era revocato, con nome e `app_version` aggiornati; per `web` ogni registrazione crea un dispositivo. La risposta è sempre `201` (ADR-0057) |
```

**Riga 1266.** Testo attuale:

```text
| DELETE | `/me/devices/{id}` | U | Revoca dispositivo; il `commit` successivo di quel dispositivo risponde `403 FORBIDDEN` con `extra.reason = "device_revoked"` (§1.7) |
```

Testo proposto:

```text
| DELETE | `/me/devices/{id}` | U | Revoca dispositivo; il `commit` successivo di quel dispositivo risponde `403 FORBIDDEN` con `extra.reason = "device_revoked"` (§1.7). Il client desktop lo chiama sul proprio dispositivo al logout (§1.3, ADR-0057) |
```

### 4.5 ADR-0058 — §1.3 e §3.3.1

**(a) §1.3 «Flusso di autenticazione (client desktop)».** Il flusso del login non cambia. Dopo l'ultimo punto di «Regole chiave» (riga 211) aggiungere:

```text
- **Uscita (ADR-0058).** «Esci» non lascia sessioni vive. *Client desktop*, in quest'ordine e a miglior sforzo (un errore si scrive nel log e l'uscita prosegue; i passi di rete hanno un tetto comune di 8 s): ferma la sync; revoca il proprio dispositivo sul cloud (`DELETE /me/devices/{id}`, §3.5.1, ADR-0057) finché il token è valido; chiude la sessione dell'identity provider con una `POST` back-channel sull'`end_session_endpoint` della discovery (`client_id` e refresh token, senza browser né `id_token_hint`) e poi revoca il refresh token dal `revocation_endpoint` (se la discovery non lo annuncia, l'URL di Keycloak derivato dall'issuer, `<issuer>/protocol/openid-connect/revoke`); scrive il marcatore `auth-logged-out` nella cartella dati dell'app (fuori dal vault, non sincronizzato) e cancella la sessione locale. Il login successivo aggiunge `prompt=login` all'URL di autorizzazione, così Keycloak chiede le credenziali anche se una sessione SSO è sopravvissuta (un broker, un realm vecchio), e cancella il marcatore. Una sessione ospitata (il core nel browser) non esegue nulla di questo: i token sono della pagina. *Console web e workbench* (stessa sessione della pagina): `signOut` revoca i token (a miglior sforzo), chiama `signoutRedirect` con `id_token_hint`, `client_id` e `post_logout_redirect_uri = <origine>/signed-out`, e scrive in `localStorage` il marcatore `clarae.auth.forceLogin`, che fa passare `prompt=login` al `signIn` successivo; `/signed-out` è una pagina pubblica («Sei uscito da Clarae notanda», con il pulsante «Accedi») che **non** avvia l'accesso da sola. Un accesso che non segue un'uscita esplicita (scadenza della sessione, primo accesso) non forza il prompt. **Limite:** il logout back-channel dipende dal comportamento di Keycloak 26 e non è ancora provato su un Keycloak vero (le prove automatiche usano un server OIDC finto); su un identity provider diverso la chiamata può fallire senza effetti, e `prompt=login` copre la sessione residua.
```

**(b) §3.3.1 «Configurazione Keycloak»**, tabella. Riga 1031, frammento attuale:

```text
scope `openid profile email offline_access`
```

Testo proposto (sostituisce il frammento):

```text
scope `openid profile email offline_access`, post-logout redirect URI `clarae://auth/logout` (`memobrain://auth/logout` per la 1.x) e `http://127.0.0.1/*` (il logout del desktop è back-channel e non apre il browser, §1.3, ADR-0058)
```

Riga 1032, frammento attuale:

```text
redirect `https://<host>/*`, Web Origins = host
```

Testo proposto (sostituisce il frammento):

```text
redirect `https://<host>/*`, **post-logout redirect URI** `https://<host>/*` (la console esce su `https://<host>/signed-out`, ADR-0058), Web Origins = host
```

Aggiungere dopo la tabella (dopo la riga «Sicurezza», riga 1037):

```text
**Realm già importato (ADR-0058).** Il file del realm si importa con `--import-realm`, che **non sovrascrive** un realm esistente: su un'installazione esistente le modifiche al file non hanno effetto. `post.logout.redirect.uris` del client web si controlla dalla console di Keycloak e deve ammettere `<origine>/signed-out`; altrimenti Keycloak risponde con l'errore «URI di redirect non valido» al logout e non chiude la sessione SSO (guida di amministrazione, sezione Keycloak).
```

### 4.6 ADR-0059 — §2.8.2, §3.4.6, §3.5.2

**(a) §2.8.2 «Vista Utente standard», riga «Download ZIP»** (riga 670). Primo frammento attuale:

```text
(path originali, escluse le parti di `.memobrain/` specifiche del dispositivo)
```

Testo proposto (sostituisce il frammento):

```text
(path originali, escluse le parti di `.clarae/` specifiche del dispositivo; i file della cartella di configurazione della 1.x, `.memobrain/`, escono sotto `.clarae/` e, se lo stesso nome esiste in entrambe, vince `.clarae/`: lo ZIP ha una sola cartella di configurazione, ADR-0059)
```

Secondo frammento attuale (stessa riga, lo ZIP dei vault privati):

```text
per ogni file si verifica lo SHA-256 del cifrato e i percorsi non sicuri o i blob corrotti sono saltati e riportati.
```

Testo proposto (sostituisce il frammento):

```text
per ogni file si verifica lo SHA-256 del cifrato e i percorsi non sicuri o i blob corrotti sono saltati e riportati. La stessa riscrittura dei path `.memobrain/…` in `.clarae/…` vale nel browser (`archivePath` in `packages/vaultcrypto-web/src/configdir.ts`): la voce `.memobrain/` che ha la gemella in `.clarae/` non entra nell'archivio, qualunque sia l'ordine del manifest, e nel rapporto compare come `duplicate_path` (ADR-0059).
```

**(b) §3.4.6 «Scope di sincronizzazione della cartella `.clarae/`»** (titolo e tabella: sostituzioni di ADR-0052, vedi §3.2; la tabella nomina entrambe le cartelle durante la transizione). Aggiungere dopo la tabella e prima di «**Chiavi di `graph.json`»:

```text
**Pulizia della cartella legacy (ADR-0059).** Un vault passato per la 1.x può avere due cartelle di configurazione, `.clarae/` e `.memobrain/`. All'apertura del vault, **una volta per versione dell'app** (marcatore locale `.clarae/cache/legacy-config-cleanup`, che sta in `cache/` e quindi non si sincronizza), il client ripulisce la cartella vecchia: cancella le voci solo locali (`index.db*`, `sync.db*`, `workspace*.json`, `cache/`) che `.clarae/` ha già (`sync.db*` solo se il database aperto è quello di `.clarae/`); sposta in `.clarae/snapshots/` gli snapshot senza collisione e cancella quelli identici, mentre quelli diversi restano dove sono (sono l'unica copia di quella versione); per un vault non collegato cancella le impostazioni identiche a quelle di `.clarae/` e manda nel cestino del vault (`.trash/`) quelle diverse; toglie i file spazzatura del sistema (`.DS_Store`, `Thumbs.db`, `desktop.ini`) e le cartelle rimaste vuote, `.memobrain/` compresa. Non tocca i link simbolici né ciò che esiste solo nella cartella vecchia. **Vault collegato:** le impostazioni sincronizzate ancora in `.memobrain/` le gestisce la sync: se `.clarae/<nome>` esiste già e le due righe sono pulite (sincronizzate, senza modifiche locali, tentativi, errori o conflitti), il motore toglie il file legacy dal disco (cancellato se identico a quello corrente, nel cestino del vault se diverso) e invia una normale **operazione di cancellazione con `base_rev`**: la revisione resta nello storico del cloud, quindi nessuna perdita silenziosa (D-04, §3.4.5). Al massimo 64 file per passata, insieme agli spostamenti. Vale solo con `features.config_dir_v2` acceso, cioè contro un cloud 1.7 o successivo (§2.6.6): con un cloud 1.5 o 1.6 la parte sincronizzata non si corregge. **Limiti:** un dispositivo 1.4 o precedente rimasto sul vault ricrea le impostazioni che non trova nella cartella vecchia (due copie con id diversi, da riconciliare a mano), quindi si aggiornano prima i dispositivi e poi il cloud; un client che esegue la pulizia prima dell'aggiornamento del cloud la rifà alla versione successiva. La pulizia sostituisce la regola «mai cancellazioni» della fase 1 di ADR-0052: cancella solo ciò che `.clarae/` ha già o che è un duplicato, e nessun dato che esiste in una sola copia viene eliminato. Il doppio nome e la pulizia si tolgono insieme con la 2.0.
```

**(c) §3.5.2 «Vault e storico»**, due righe dell'export. Frammento attuale della riga `…/exports/{eid}/download`:

```text
ZIP di un job pronto (valido 24 h) |
```

Testo proposto:

```text
ZIP di un job pronto (valido 24 h); i path della cartella di configurazione della 1.x escono sotto `.clarae/` (§2.8.2, ADR-0059) |
```

Frammento attuale della riga `…/export.zip`:

```text
ZIP in streaming (vault condivisi fino a 512 MB, oltre `409 INVALID_STATE`: serve un job; `409 VAULT_ENCRYPTED` per i privati) |
```

Testo proposto:

```text
ZIP in streaming (vault condivisi fino a 512 MB, oltre `409 INVALID_STATE`: serve un job; `409 VAULT_ENCRYPTED` per i privati); stessa riscrittura dei path di `.memobrain/` in `.clarae/` (§2.8.2, ADR-0059) |
```

### 4.7 ADR-0060 — §2.2.1, §2.6.6, C.2

**(a) §2.2.1 «Matrice di parità», riga «Web viewer»** (riga 367). Frammento attuale (fine della cella):

```text
Dietro `features.web_viewer`, **spento per default** (§2.6.6) |
```

Testo proposto (sostituisce il frammento):

```text
Dietro `features.web_viewer`, **acceso per default dalla 1.7.2** (§2.6.6, ADR-0060): un profilo può spegnerlo. **Esploratore dei file:** un pulsante «Nuova applicazione» nella barra degli strumenti e la stessa voce nei due menu contestuali (su un elemento e sulla zona vuota) creano il file `.webapp` nella cartella selezionata, o nella radice se non c'è una selezione; compaiono solo con il flag acceso e su un vault non in sola lettura. L'esploratore e le schede mostrano il nome senza `.webapp`. Fuori da macOS, e nel workbench web, la scheda è un riquadro con «Apri nel browser» |
```

**(b) §2.6.6, tabella dei flag**, riga di `features.web_viewer` (riga 591). Primo frammento attuale:

```text
| `features.web_viewer` | spento |
```

Testo proposto:

```text
| `features.web_viewer` | **acceso dalla 1.7.2** |
```

Secondo frammento attuale (fine della cella):

```text
Resta spento per default finché la matrice manuale di prove sulla finestra reale non è eseguita |
```

Testo proposto (sostituisce il frammento):

```text
Fino alla 1.7.1 era spento per default; dalla 1.7.2 è **acceso** (decisione dell'owner, ADR-0060), perché una funzione spenta era invisibile a chi non amministra il cloud. La matrice manuale di prove sulla finestra reale (`docs/qa/m18-webview-matrice.md`) **non è ancora eseguita**: chi non vuole le applicazioni le spegne dal profilo, globale o di gruppo (`{"features": {"web_viewer": false}}`). Un profilo che ha già `false` esplicito lo conserva; un client che non ha ancora letto un profilo usa il default di prodotto (acceso), quindi le applicazioni compaiono anche prima dell'accesso al cloud. Le misure di sicurezza di ADR-0056 non dipendono dal flag |
```

Fonte: `api/config-profile.schema.json` (`features.web_viewer`, `"default": true`).

**(c) Appendice C.2 «Rischi tecnici»**, riga «Web viewer in iframe…» (riga 1954). Frammento attuale:

```text
Funzione dietro `features.web_viewer`, spento di default |
```

Testo proposto (sostituisce il frammento):

```text
Funzione dietro `features.web_viewer`, acceso di default dalla 1.7.2 (ADR-0060): la matrice manuale di prove sulla finestra reale non è ancora eseguita, e il flag si spegne dal profilo |
```

### 4.8 ADR-0061 — §4.4 «Web UI»

Riga 1870. Frammento attuale:

```text
console iniziale ≤ 700 kB e totale ≤ 1000 kB
```

Testo proposto (sostituisce il frammento):

```text
console iniziale ≤ 720 kB (700 kB fino alla 1.7.1, ADR-0061) e totale ≤ 1000 kB
```

La console resta un file unico coperto da SRI (`splitting: false`): il limite alzato è per le funzioni di M21 (pagina «Sei uscito», logout completo, tooltip della quota, gemelle legacy nello ZIP privato); la console pesa 701 kB.

### 4.9 Voci senza ADR (a scelta dell'owner)

La 1.7.2 contiene anche l'Onda F di M21 (registro di audit, [roadmap](roadmap.md) §13-quaterdecies), **senza un ADR**: nessun accettato la copre, quindi non è una deviazione dallo spec. Lo spec documenta le variabili d'ambiente del servizio in §1.6 (`SHUTDOWN_DRAIN`, `TRUSTED_PROXIES`), quindi si propone, **se l'owner lo ritiene utile**, questo paragrafo dopo «Spegnimento e repliche (ADR-0022)» (§1.6):

```text
**Aggiornamento senza perdere il database.** Con `DB_EXPECT_INITIALIZED=true` i ruoli `api` e `all` che trovano il database vuoto (nessuna migrazione applicata) non creano lo schema e terminano con un errore, invece di avviarsi su un database nuovo senza dati né registro di audit. Il chart Helm lo imposta a ogni `helm upgrade` (`.Release.IsUpgrade`), a meno che `config` non lo contenga già; con Compose si imposta in `.env` dopo il primo avvio. All'avvio dei ruoli `api` e `all`, dopo le migrazioni, il servizio scrive nel log una riga `database state` con la versione dello schema, il numero di righe di `audit_log` e la data della prima. Nessuna migrazione cancella `audit_log`: un test sulle migrazioni lo verifica sulle sezioni `+goose Up` (`services/cloud/internal/db/audit_migrations_test.go`).
```

Fonti: `services/cloud/internal/config/config.go` (`ExpectInitialized`), `deploy/helm/clarae/templates/configmap.yaml`, `services/cloud/cmd/clarae-cloud/main.go` (`database state`), `docs/admin-guide/configurazione.md`.

### 4.10 Appendice C.4 «ADR recepiti»

**(a) Introduzione** (riga 1986). Primo frammento attuale:

```text
0053–0056 nella v1.6, già implementati, in 1.6.0, 1.7.0 e 1.7.1)
```

Testo proposto (sostituisce il frammento):

```text
0053–0056 nella v1.6, già implementati, in 1.6.0, 1.7.0 e 1.7.1; 0052 e 0057–0061 nella v1.7, già implementati, in 1.5.0 e 1.7.2)
```

Secondo frammento attuale (fine della riga):

```text
e gli ADR 0045–0052, posteriori alla v1.5 e non toccati da questa revisione (0045, 0046, 0047, 0048 e 0049 accettati; 0050, 0051 e 0052 in stato *proposta*). Per questo lo spec dice ancora Wails v2 e *MemoBrain Notes* (identificatori `memobrain`, cartella `.memobrain/`): il testo aggiunto dalla v1.6 segue la nomenclatura dello spec, mentre nel codice i nomi sono *Clarae notanda* e `.clarae/` (ADR-0052).
```

Testo proposto (sostituisce il frammento):

```text
e gli ADR 0045–0051, posteriori alla v1.5 e non toccati dalle revisioni 1.6 e 1.7 (0045, 0046, 0047, 0048 e 0049 accettati; 0050 e 0051 in stato *proposta*). Per questo lo spec dice ancora Wails v2 (ADR-0051 non è recepito). I nomi sono quelli di ADR-0052: *Clarae notanda*, identificatori `clarae`, cartella `.clarae/`, con le sole eccezioni che l'ADR elenca (etichette crittografiche congelate `memobrain/v1/*` e `memobrain/v2/*`; dati e client della 1.x). ADR-0059 emenda ADR-0052 (la cartella `.memobrain/` si ripulisce dopo l'aggiornamento), ADR-0060 emenda ADR-0056 (`features.web_viewer` acceso per default) e ADR-0061 emenda ADR-0020 (budget iniziale della console 720 kB): valgono i più recenti.
```

**(b) Righe da modificare.** Riga di ADR-0056 (riga 2027), frammento attuale:

```text
`features.web_viewer` **spento di default**.
```

Testo proposto (sostituisce il frammento):

```text
`features.web_viewer` **spento di default** nella 1.7.0 e nella 1.7.1, **acceso dalla 1.7.2** (ADR-0060).
```

Riga di ADR-0020 (riga 2001), frammento attuale:

```text
(console 700/1000 kB,
```

Testo proposto (sostituisce il frammento):

```text
(console 720/1000 kB, 700/1000 fino alla 1.7.1 per ADR-0061,
```

**(c) Righe nuove**, in fondo alla tabella, dopo la riga di ADR-0056 (ultima riga dello spec). Le colonne sono: ADR, Tema, Decisione, Recepito in.

```text
| ADR-0052 | Rebrand | Il prodotto si chiama *Clarae notanda* (identificatori `clarae`): scope `@clarae/*`, binari `clarae-core` e `clarae-cloud`, cartella di configurazione `.clarae/` (e `.clarae-tmp-*`), schema `clarae://`, package gRPC `clarae.v1`, chiave `customData.clarae` dei disegni, Web Lock `clarae-workbench`, flag `features.config_dir_v2`; realm, client e audience `clarae…` per le installazioni nuove. **Congelate** le etichette crittografiche `memobrain/v1/*` e `memobrain/v2/*` (cambiarle rende indecifrabili i vault privati). Per i dati e i client della 1.x restano letti i nomi vecchi (cartella `.memobrain/`, schema `memobrain://`, `customData.memobrain`, proto `memobrain.v1`, realm e audience delle installazioni esistenti) fino alla 2.0; migrazione automatica della cartella dati, dello storage del browser e del keychain; emendato da ADR-0059 (v1.7) | Intestazione, §1.3, §1.6, §1.7, §2.1, §2.5, §2.6.6, §2.7, §3.3.1, §3.4.2, §3.4.5, §3.4.6, §3.6, §3.8 (etichette invariate), §4, C.2, C.4 |
| ADR-0057 | Identità del dispositivo desktop | Un dispositivo desktop è identificato da `(utente, piattaforma, nome del computer)`: colonna `devices.hostname` (`lower(btrim(name))`, NULL per `web`) e indice unico parziale (migrazione `0016`, che revoca i duplicati senza cancellare righe); `POST /me/devices` per `windows`, `macos` e `linux` è un upsert che restituisce lo stesso `id`, riattivato se revocato, sempre con `201`; il logout del desktop revoca il proprio dispositivo (a miglior sforzo, dopo aver fermato la sync); `CLARAE_DEVICE_NAME` sostituisce il nome del computer; nessuna nuova registrazione automatica dopo una revoca dalla console. Limiti: due computer con lo stesso nome e piattaforma sono un solo dispositivo, e una revoca dalla console si annulla al login successivo della stessa macchina (v1.7) | §1.7, §2.6.1, §3.2.2, §3.5.1 |
| ADR-0058 | Logout completo da Keycloak | Console e workbench: `signOut` revoca i token, passa `id_token_hint`, `client_id` e `post_logout_redirect_uri = <origine>/signed-out`; pagina pubblica `/signed-out` senza login automatico; `prompt=login` al primo accesso dopo un'uscita esplicita (marcatore `clarae.auth.forceLogin` in `localStorage`). Desktop: logout back-channel sull'`end_session_endpoint` della discovery, poi revoca dal `revocation_endpoint` (ripiego sull'URL di Keycloak), marcatore `auth-logged-out` e `prompt=login` al login successivo; passi di rete con tetto di 8 s e a miglior sforzo. Un realm già importato non cambia da solo: `post.logout.redirect.uris` si controlla dalla console di Keycloak. Non provato su un Keycloak vero; la causa del rientro senza password su E2BR non è accertata (v1.7) | §1.3, §3.3.1 |
| ADR-0059 | Cartella di configurazione legacy | `vaultdir.CleanupLegacy` ripulisce `.memobrain/` all'apertura del vault, una volta per versione (voci locali già presenti in `.clarae/`, snapshot identici, impostazioni identiche; le diverse nel cestino del vault); per i vault collegati il motore di sync cancella la riga legacy con una normale operazione di cancellazione con `base_rev` (solo con `features.config_dir_v2` acceso, cioè con un cloud 1.7 o successivo); lo ZIP del server e quello del browser riscrivono `.memobrain/…` in `.clarae/…` e, in caso di collisione, vince `.clarae/`. Emenda ADR-0052 («mai cancellazioni») (v1.7) | §2.8.2, §3.4.6, §3.5.2 |
| ADR-0060 | Web viewer acceso di default | `features.web_viewer` ha default `true` nello schema del Config Profile (un profilo può spegnerlo); pulsante e voce di menu «Nuova applicazione» nell'esploratore dei file, e nomi senza `.webapp` in esploratore e schede; la vista incorporata resta solo su macOS. La matrice manuale di prove sulla finestra reale non è ancora eseguita. Emenda ADR-0056 (v1.7) | §2.2.1, §2.6.6, C.2, C.4 |
| ADR-0061 | Budget iniziale della console | Il limite iniziale della console passa da 700 a 720 kB (`BUDGET.console.initialKB` in `web/scripts/esbuild.mjs`); totale, workbench e WASM invariati; la console resta un file unico coperto da SRI. Emenda ADR-0020 (v1.7) | §4.4 |
```

---

## 5. Verifiche che spettano all'owner

1. **Citazioni alla lettera.** I blocchi «testo attuale» sono estratti automaticamente da `Specifications.md` v1.6 (2027 righe): se lo spec cambia prima dell'applicazione, vanno riestratti.
2. **ADR-0057, punto 7 e «Contesto».** Il punto 7 dice che un `device_id` che il cloud non conosce lascia il client nello stato `device_revoked`; ma il «Contesto» dell'ADR, e il codice, dicono altro: il cloud risponde `400 VALIDATION_FAILED` con dettaglio `unknown device_id` (`services/cloud/internal/sync/service.go:128`) e il client riconosce `device_revoked` solo dal `403 FORBIDDEN` con `extra.reason` (`apps/desktop/internal/sync/transport/client.go:107-121`). Il testo proposto parla **solo** della revoca, e non promette nulla per un `device_id` sconosciuto. L'ADR va letto di conseguenza (o corretto) dall'owner.
3. **ADR-0057, `lower(name)`.** L'ADR scrive `hostname = lower(name)`; il codice (migrazione `0016`, `UpsertDesktopDevice`) usa `lower(btrim(name))`, e riattivando non azzera `app_version` né `Idempotency-Key`. Il testo proposto segue il codice; l'ADR porta una nota «Come implementato».
4. **ADR-0058, punto 1.** L'ADR dice `UserManager` con `revokeTokensOnSignout: true`; il codice **non** lo imposta (un test lo verifica, `web/src/auth/oidc.test.ts`) e chiama `revokeTokens()` a parte, a miglior sforzo. Il testo proposto segue il codice; l'ADR porta una nota «Come implementato».
5. **ADR-0058, passo 0.** L'ADR chiedeva di accertare la causa del rientro senza password su E2BR prima dell'accettazione. L'owner ha accettato senza: il testo proposto lo dichiara come limite (back-channel non provato, causa non accertata) e non promette che il sintomo sparisca.
6. **Deriva dello spec non legata agli ADR.** (a) Il DDL di `devices` (§3.2.2) non ha la colonna `idempotency_key` (migrazione `0012`) né l'indice `devices_user_ix`: la proposta aggiunge solo ciò che serve ad ADR-0057. (b) L'elenco delle migrazioni (riga 1020) si ferma a `0009`: la proposta aggiunge `0016` e dichiara che `0010`–`0015` non sono descritte. Se si vuole, la v1.7 può descriverle (stato dei file in `services/cloud/internal/db/migrations/`).
7. **`features.config_dir_v2` non è nello spec.** ADR-0052 lo prevedeva (§2.6.6) e ADR-0059 ne dipende: la riga è proposta al §3.3. Verificare il testo contro `api/config-profile.schema.json`.
8. **Versioni.** La v1.7 dello spec è una versione del **documento**: non coincide con la versione del prodotto (1.7.2). Il registro lo dice scrivendo «già implementati (1.5.0 e 1.7.2)».
9. **Voci senza ADR (§4.9).** Il paragrafo sull'aggiornamento senza perdere il database è un'aggiunta facoltativa, non una deviazione.
10. **ADR-0045…0051 restano non recepiti** (e ADR-0023): lo spec dice ancora Wails v2 (D-07, A-03, §4.5). Il testo proposto non nomina Wails v3. Se l'owner accetta ADR-0051, il recepimento è un altro passo.
11. **`CLAUDE.md`** cita «`Specifications.md` (v1.5 …)» e dice che ADR-0051 è «in proposta»: è dell'owner e non l'ho toccato.
12. **Sezioni che gli ADR citano, controllate sullo spec v1.6:** ADR-0057 → §1.7 (righe 286-287), §2.6.1, §3.2.2, §3.5.1; ADR-0058 → §1.3, §3.3.1, D-08 (riga 209); ADR-0059 → §2.8.2, §3.4.6, §3.5.2; ADR-0060 → §2.6.6, §2.2.1, C.2, C.4; ADR-0061 → **§4.4** (l'ADR dice che il budget «non è nello spec»: è in §4.4, riga 1870, e nella riga di ADR-0020 di C.4; l'ADR è stato corretto). Tutti i numeri di riga e le sezioni citati dagli ADR sono corretti sulla v1.6.

---

## 6. Dopo il recepimento

- Gli ADR 0052 e 0057–0061 passano a «accettata (recepita nello spec v1.7)» nell'indice [`docs/adr/README.md`](adr/README.md), e ognuno riceve la riga **Recepito in** (come ADR-0053…0056): `Specifications.md` v1.7 (2026-11-16) con le sezioni elencate in §1.
- Il comando di controllo del nome: `command grep -n -i memobrain Specifications.md` deve dare solo le eccezioni del §3.1; `task lint-brand` non controlla lo spec (`Specifications.md` è `history` nell'allowlist): la verifica è a mano.
- Questo documento resta come storia, con una nota in testa come `spec-v1.2-proposta.md`.
- `CHANGELOG.md`: la voce _Documentazione_ di _Unreleased_ si aggiorna («`Specifications.md` v1.7»); roadmap §13-quaterdecies: «spec v1.7 applicato».
