# MemoBrain Notes — Specifiche Tecniche e Funzionali

**Applicazione desktop e cloud nativa per note e knowledge base (ispirata a Obsidian)**

| | |
|---|---|
| **Versione documento** | 1.3 — Decisioni D-01…D-08 e ADR 0029, 0030, 0032, 0036–0044 recepiti (vedi Appendice C) |
| **Data** | 2 novembre 2026 |
| **Nome del prodotto** | *MemoBrain Notes* (identificatori `memobrain`; già "Nodus" come nome in codice) |
| **Stack** | Wails (Go + React/TypeScript) · Cloud Service in Go · Keycloak · PostgreSQL · Object Storage S3-compatibile |
| **Riferimento funzionale** | Obsidian Help — <https://obsidian.md/help/> |

**Registro delle revisioni**

| Versione | Data | Modifiche |
|---|---|---|
| 1.3 | 2 novembre 2026 | Recepiti gli ADR accettati dall'owner il 2 novembre 2026 (Appendice C.4): **ADR-0029** workbench del vault nella Web UI (stessa UI del client desktop, `@memobrain/workbench`, su `/vaults/:id/open`; il browser è un dispositivo di sync come gli altri, online-first con copia in OPFS; politica dei vault privati nel browser; CSP e SRI della pagina del workbench; flag `features.web_workbench`); **ADR-0030** core Go del client desktop compilato in WebAssembly (`apps/desktop/cmd/memobrain-core`, dispatcher `internal/rpc`, interfaccia `Host`, sqlite-wasm con `opfs-sahpool`, shim `fs` su OPFS, solo SSE, budget di dimensione, `task test-wasm` in `task ci`); **ADR-0032** Task (`Taskfile.yml`, pinnato in `tools/go.mod`) come unico task runner al posto di make. A-03 non dice più che la Web UI non è un editor. **Feature flag:** l'owner ha acceso per default `features.envelope_v2` e `features.path_v2`, cioè il rilascio N+1 di ADR-0034 (envelope della VMK v2 con AAD) e di ADR-0042 (token di path `enc2`): i client scrivono envelope v2 (convertendo i v1 allo sblocco) e token `enc2`, migrano in background i token `enc1` rimasti e poi rifiutano `enc1` per quel vault (pin forte); i client desktop fino alla 1.2.4 non sbloccano vault con envelope v2 né leggono path `enc2` (§3.8.7). ADR-0034 resta in stato *proposta*: il comportamento dei suoi rilasci N e N+1 è registrato qui (§3.8.2, §3.8.7) come implementato, perché l'owner ha acceso il flag. Sezioni modificate: §0.1, §0.3 (A-03), §1.1, §1.2, §1.7 (nuova), §2.1, §2.1.1, §2.5, §2.6.1, §2.6.6, §2.8 (con §2.8.3 nuova), §3.5.1, §3.6, §3.7, §3.8.1, §3.8.2, §3.8.6, §3.8.7, §4.1–§4.5, App. A, C.2, C.3, C.4. |
| 1.2 | 2 novembre 2026 | Recepiti gli ADR accettati dall'owner (decisioni e sezioni in Appendice C.4): **ADR-0036** verifiche locali con `task ci` al posto di un servizio di CI; **ADR-0037** registro delle funzioni, `@memobrain/cloud-features` con `CloudPort`, client Go generato, ciclo di vita dei vault su tutte le superfici, feature flag generati dallo schema del Config Profile; **ADR-0038** retention delle revisioni, copie di conflitto e finestra effettiva del changelog; **ADR-0039** candidati al merge persistenti e quarantena in `sync.db`; **ADR-0040** `move_prefix` come rename delle cartelle condivise (anche solo maiuscole/minuscole) e regole sulle radici condivise; **ADR-0041** ruolo autorevole dopo un cambio dalla console, conflitti di identità, ultimo amministratore, eliminazione unificata degli account con riattribuzione dei grant, rubrica, `config_version`, `POST /shares` da parte di un manager, ruolo `manager` dei gruppi riservato, hub delle notifiche; **ADR-0042** token di path `enc2` legati al file; **ADR-0043** primitive UI condivise in `@memobrain/ui`; **ADR-0044** watcher con FSEvents su macOS e modalità degradata. Sezioni modificate: §1.3, §1.4, §2.3.3, §2.4, §2.5, §2.6.1–§2.6.6, §2.7.3, §2.8.1, §2.8.2, §3.1, §3.2.2, §3.3.2, §3.4.3–§3.4.5, §3.4.7, §3.5.1–§3.5.5, §3.6, §3.7, §3.8.3, §3.8.5, §3.8.7, §4.1–§4.5, App. A, C.2, C.4 (nuova). Restano in stato *proposta* e **non** sono recepiti gli ADR 0009–0024 e 0026–0035: la raccolta `docs/spec-v1.2-proposta.md`, che li riguarda, resta da decidere e confluirà in una versione successiva. |
| 1.1 | 23 ottobre 2026 | Decisioni D-01…D-08 recepite (Appendice C.1). |

---

## Indice

0. [Introduzione, ambito e assunzioni](#0-introduzione-ambito-e-assunzioni)
1. [System Architecture & Data Flow](#1-system-architecture--data-flow)
2. [Functional Specifications](#2-functional-specifications)
3. [Technical & API Specifications](#3-technical--api-specifications)
4. [Project Directory Structure](#4-project-directory-structure)
- [Appendice A — Requisiti non funzionali](#appendice-a--requisiti-non-funzionali)
- [Appendice B — Roadmap per milestone](#appendice-b--roadmap-per-milestone)
- [Appendice C — Registro delle decisioni, rischi e punti aperti](#appendice-c--registro-delle-decisioni-rischi-e-punti-aperti)

---

## 0. Introduzione, ambito e assunzioni

### 0.1 Scopo

Il documento definisce l'architettura e le specifiche di *MemoBrain Notes*, un'applicazione di knowledge management **local-first** composta da:

1. **Client desktop** (Windows, macOS, Linux) realizzato con Wails: backend nativo in Go, frontend React/TypeScript. Funziona interamente offline su vault locali (cartelle di file Markdown).
2. **Cloud Service** in Go: sincronizzazione multi-dispositivo dei vault, condivisione, gruppi, quote, distribuzione centralizzata delle configurazioni.
3. **Web UI del Cloud Service**: console amministrativa, area utente (quota, dispositivi, condivisioni, download ZIP) e **workbench del vault** (modifica nel browser con le stesse funzioni e la stessa interfaccia del client desktop, §2.8.3, ADR-0029).
4. **Keycloak** come Identity Provider (OIDC/OAuth2, JWT).

### 0.2 Vincoli non negoziabili

| ID | Vincolo |
|---|---|
| V-01 | Client: Wails (Go + React/TS). Cloud: Go, API REST e gRPC. |
| V-02 | **Architettura chiusa**: nessun supporto a plugin, temi, script di terze parti né CSS personalizzato (D-01). Ogni funzione è compilata nell'eseguibile. |
| V-03 | Copertura funzionale delle feature documentate dall'help ufficiale di Obsidian (con le esclusioni motivate al §2.2.3). |
| V-04 | Excalidraw.js integrato nativamente. |
| V-05 | Identità e token gestiti da Keycloak; il Cloud Service è *resource server* OIDC. |
| V-06 | RBAC globale + permessi per cartella/documento. |
| V-07 | Wails **v2** (D-07). |
| V-08 | Alla creazione, ogni vault cloud è **privato cifrato** (E2EE, non condivisibile) oppure **condiviso non cifrato**; la scelta è immutabile (D-02). |
| V-09 | Nessuna funzione cross-vault (D-06). |
| V-10 | Gruppi gestiti esclusivamente dal Cloud Service (D-05). |

### 0.3 Assunzioni

- **A-01** — Il formato di storage resta *file-first*: il vault è una cartella di file ordinari (`.md`, immagini, PDF, `.canvas`, `.base`, `.excalidraw`). Nessun lock-in: l'utente può aprire il vault con qualsiasi editor.
- **A-02** — L'help di Obsidian è il riferimento per il *comportamento*; la sintassi Markdown estesa (wikilink, embed, callout, ecc.) è mantenuta compatibile così che un vault Obsidian esistente si apra senza conversioni.
- **A-03** — Wails **v2** (D-07) è desktop-only e gestisce una sola finestra per processo: **le app mobile non sono nel perimetro** e le finestre separate (pop-out) non sono nativamente disponibili (§2.2.1). La Web UI del cloud comprende console amministrativa, area utente e un **workbench del vault** con le stesse funzioni del client desktop, salvo le eccezioni dichiarate di ADR-0029 (updater, vault su cartella locale, integrazioni native del sistema operativo: §2.8.3). Il workbench web è un dispositivo di sync come gli altri: **online-first**, con copia locale nel browser, e non è un'app mobile né una PWA offline (ADR-0029).
- **A-04** — Il cloud è single-tenant per installazione (una realm Keycloak, un'organizzazione). Il multi-tenant è fuori ambito.
- **A-05** — La collaborazione è **asincrona** (sync + merge) e il merge multi-utente è garantito per i soli file `.md` condivisi (D-04). L'editing simultaneo in tempo reale (CRDT, presenza) non è previsto.
- **A-06** — Cifratura (D-02): TLS in transito e cifratura a riposo lato server per tutti i vault. I vault **privati** sono inoltre cifrati end-to-end dal client (§3.8) e non possono essere condivisi; i vault **condivisi** non sono cifrati end-to-end, perché la condivisione con utenti e gruppi (con revoca, ACL e membership dinamiche) richiederebbe una gestione di chiavi condivise fuori ambito.
- **A-07** — Un vault è un perimetro chiuso (D-06): link, embed, backlink, grafo, ricerca, bookmark e template non attraversano i vault (§2.1.2).
- **A-08** — I gruppi esistono solo nel Cloud Service (D-05); Keycloak gestisce soltanto identità e ruoli globali.

### 0.4 Glossario

| Termine | Significato |
|---|---|
| **Vault** | Cartella radice di note e allegati. Unità di sincronizzazione. |
| **Vault privato** | Vault cloud cifrato end-to-end, utilizzabile da un solo utente (nessuna condivisione). |
| **Vault condiviso** | Vault cloud non cifrato end-to-end, su cui si possono creare share verso utenti e gruppi. |
| **VMK** | *Vault Master Key*: chiave simmetrica casuale a 256 bit di un vault privato, mai inviata al server in chiaro. |
| **Mount** | Vista locale (sul client del destinatario) di una cartella o un documento condiviso, trattata come vault separato. |
| **File ID** | UUID stabile di un file nel cloud, indipendente dal path (consente rename senza perdere identità). |
| **Revision** | Versione immutabile di un file, con numero progressivo per file (`rev_no`). |
| **Seq** | Contatore monotono per vault; ordina tutte le modifiche del vault. |
| **Share** | Concessione di accesso a un vault, a una cartella (prefisso di path) o a un documento. |
| **Grant** | Associazione share → utente/gruppo con un livello di permesso. |
| **Config Profile** | Insieme versionato di impostazioni distribuite dal cloud ai membri di uno o più gruppi. |
| **Blob** | Contenuto binario immutabile identificato da SHA-256 (content-addressed). |

---

## 1. System Architecture & Data Flow

### 1.1 Vista dei componenti

```mermaid
flowchart LR
  subgraph DESK["Client Desktop (Wails)"]
    direction TB
    FE["Frontend React/TS<br/>Editor CodeMirror 6 · Graph · Excalidraw · Canvas · Bases"]
    BE["Backend Go (Wails bindings)<br/>Vault FS · Indexer · Search · Sync Engine · Auth · Crypto"]
    LFS[("Vault locale<br/>file system")]
    LDB[("index.db + sync.db<br/>SQLite")]
    KR[("OS Keychain<br/>refresh token · chiavi vault")]
    FE <-->|"Wails bindings + events"| BE
    BE <--> LFS
    BE <--> LDB
    BE <--> KR
  end

  subgraph CLOUD["Cloud Service (Go)"]
    direction TB
    GW["API Gateway / Router<br/>REST + gRPC + SSE"]
    SYNC["Sync Module"]
    VAULT["Vault & Revision Module"]
    SHARE["Sharing & ACL Module"]
    ADM["Admin Module<br/>Users · Groups · Quota · Config"]
    EXP["Export Worker (ZIP)"]
    WEB["Web UI statica<br/>console (SPA) · workbench del vault"]
    GW --> SYNC & VAULT & SHARE & ADM
    ADM --> EXP
  end

  KC["Keycloak<br/>OIDC / OAuth2 / JWT"]
  PG[("PostgreSQL<br/>metadati, ACL, quote")]
  S3[("Object Storage S3<br/>blob content-addressed")]

  BE <-->|"HTTPS: REST + gRPC stream"| GW
  BE -->|"Authorization Code + PKCE<br/>(browser di sistema)"| KC
  subgraph BROWSER["Browser: workbench web (ADR-0029, ADR-0030)"]
    direction TB
    WFE["@memobrain/workbench<br/>(stessa UI del desktop)"]
    WCORE["Web Worker: core Go in WASM<br/>stessi binding · sqlite-wasm"]
    OPFS[("OPFS<br/>copia del vault · index.db · sync.db")]
    WFE <-->|"bridge window.go / RPC"| WCORE
    WCORE <--> OPFS
  end

  WEB -->|"PKCE (SPA)"| KC
  WEB -->|"REST /api/v1"| GW
  WEB -.->|"serve workbench.html + asset con SRI"| WFE
  WCORE <-->|"HTTPS: REST + SSE"| GW
  GW -->|"JWKS: validazione JWT"| KC
  ADM -->|"Admin REST API<br/>(service account)"| KC
  SYNC & VAULT & SHARE & ADM --> PG
  SYNC & VAULT & EXP --> S3
```

**Scelta architetturale: modular monolith.** Il Cloud Service è un unico binario Go suddiviso in moduli con confini netti (package `internal/<modulo>`, interfacce esplicite, nessun accesso incrociato alle tabelle). Motivi: un solo deploy, transazioni locali tra metadati e quote, costo operativo basso. L'`Export Worker` è lo stesso binario avviato con `--role=worker` per scalare in modo indipendente. L'estrazione in microservizi resta possibile senza riscrivere i moduli.

### 1.2 Responsabilità dei componenti

| Componente | Responsabilità |
|---|---|
| **Frontend (React/TS)** | UI, editor, rendering, grafo, Excalidraw, Canvas, Bases, nel pacchetto `@memobrain/workbench` condiviso da client desktop e workbench web (ADR-0029). Nessun accesso diretto a rete o disco: tutto passa dai binding Wails (nel browser, dagli stessi binding serviti dal core in WebAssembly). |
| **Backend client (Go)** | Accesso al file system del vault, watcher, parsing/indicizzazione, ricerca FTS, sync engine, cifratura/decifratura dei vault privati, OIDC, keychain, auto-update, import. Lo stesso codice, compilato per `js/wasm`, è il core del workbench web (§1.7, ADR-0030). |
| **Workbench web** | Pagina della Web UI che apre un vault cloud nel browser: UI del client desktop, core Go in un Web Worker, copia del vault e database in OPFS; dispositivo di sync `web` (§1.7, §2.8.3). |
| **API Gateway** | TLS, routing, validazione JWT, rate limiting, request-id, CORS (solo origine Web UI), OpenTelemetry. |
| **Sync Module** | Changelog per vault, commit con concorrenza ottimistica, rilevamento conflitti, notifiche realtime. |
| **Vault & Revision** | CRUD vault, storico revisioni, restore, snapshot/tree, GC dei blob. |
| **Sharing & ACL** | Share, grant, valutazione permessi effettivi, mount dei vault condivisi. |
| **Admin Module** | Utenti, gruppi, ruoli, quote, Config Profile, audit; orchestrazione verso Keycloak Admin API. |
| **Keycloak** | Credenziali, MFA, SSO, federazione (LDAP/SAML opzionali), emissione token. |
| **PostgreSQL** | Fonte di verità per metadati e permessi. |
| **Object Storage** | Contenuti dei file (blob immutabili, deduplicati per hash; nei vault privati sono ciphertext). |

### 1.3 Flusso di autenticazione (client desktop)

Authorization Code Flow + PKCE (RFC 7636, RFC 8252) con **browser di sistema**; le credenziali non transitano mai nell'app.

```mermaid
sequenceDiagram
  autonumber
  actor U as Utente
  participant FE as Frontend
  participant BE as Backend Go (client)
  participant BR as Browser di sistema
  participant KC as Keycloak
  participant API as Cloud API

  U->>FE: "Accedi al cloud"
  FE->>BE: Auth.Login()
  BE->>BE: genera code_verifier/challenge, state, apre listener 127.0.0.1:porta-casuale
  BE->>BR: apre /auth?client_id=memobrain-desktop&code_challenge&redirect_uri=http://127.0.0.1:port/cb
  BR->>KC: login (password, MFA, SSO)
  KC-->>BR: redirect con code
  BR->>BE: GET /cb?code&state
  BE->>KC: POST /token (code + code_verifier)
  KC-->>BE: access_token (JWT, 5 min) + refresh_token (offline) + id_token
  BE->>BE: salva refresh_token nel keychain di sistema
  BE->>API: GET /api/v1/me (Bearer access_token)
  API->>API: valida JWT (JWKS cache), upsert utente, controlla status
  API-->>BE: profilo, ruolo, quota, config version
  BE-->>FE: evento auth:ready
  Note over BE,KC: Rinnovo silenzioso con refresh token (rotation attiva).<br/>Se refresh fallisce (sospensione/revoca) → stato "disconnesso", il lavoro locale continua.
```

**Regole chiave**

- Access token vita breve (5 min); refresh con **rotation** e riuso rilevato da Keycloak.
- Validazione JWT lato Cloud: firma (JWKS in cache con rotazione), `iss`, `aud` (= `memobrain-api`), `exp`, `azp`.
- **Sospensione utente**: Keycloak `enabled=false` + revoca sessioni; in aggiunta il Cloud controlla `users.status` (cache 30 s) così l'accesso decade entro secondi e non alla scadenza del token. La cache memorizza per lo stesso TTL anche i rifiuti (account sospeso, conflitto di identità), mai gli errori interni; attivazione, cambio di ruolo ed eliminazione la invalidano (ADR-0041).
- **Provisioning just-in-time (ADR-0041).** L'utente è collegato all'identità **solo per `sub`**. La riga `users` si legge per `sub` e si scrive solo se il token porta un cambio di profilo o di ruolo, o se `last_login_at` ha più di 15 minuti; gli account sospesi o eliminati non vengono mai scritti.
- **Ruolo autorevole dopo un cambio dalla console (ADR-0041).** Un cambio di ruolo fatto dalla console imposta `users.role_changed_at`. Il provisioning prende il ruolo dai realm role del token solo se il suo `iat` è successivo a `role_changed_at`; il principal della richiesta usa sempre il ruolo della riga. Una degradazione vale dalla richiesta successiva (subito sulla replica che la esegue, entro il TTL della cache sulle altre), una promozione non attende un nuovo token, e i token emessi dopo il cambio tornano a rispecchiare Keycloak, che resta la fonte del ruolo per chi lo gestisce lì.
- **Conflitto di identità (ADR-0041).** Un token con un'e-mail già usata da un altro account non eliminato produce `409 INVALID_STATE` (gRPC `FAILED_PRECONDITION`) con l'indicazione di rivolgersi a un amministratore; non si crea né si modifica alcuna riga e **non si ricollega mai un account per e-mail** (darebbe i vault di un account a chiunque controlli quell'indirizzo nel provider di identità). Il rimedio (eliminare o rinominare l'account precedente) è nel runbook.
- **Redirect (D-08).** Modalità predefinita `auto`: il client prova il redirect **loopback** con porta variabile (RFC 8252 §7.3) e passa al **custom URI scheme** `memobrain://auth/callback` se (a) non riesce ad aprire il listener, (b) Keycloak risponde `invalid_redirect_uri`, oppure (c) la modalità è forzata a `scheme` da Config Profile. Entrambi gli URI sono registrati sul client `memobrain-desktop`.
- Il callback via custom scheme arriva al sistema operativo come URL `memobrain://…` e viene consegnato all'istanza già in esecuzione tramite il single-instance lock di Wails v2 (argomenti della seconda istanza; su macOS tramite l'handler di apertura URL, da verificare sulla versione v2 adottata). Registrazione dello scheme: installer Windows (chiave di registro), `Info.plist` su macOS, file `.desktop` con `x-scheme-handler/memobrain` su Linux.
- Poiché uno scheme custom può essere rivendicato da altre applicazioni, la sicurezza si basa su PKCE (S256) e sul controllo di `state`; `code_verifier` e `state` restano solo in memoria dell'istanza che ha avviato il login.

### 1.4 Flusso di sincronizzazione

```mermaid
sequenceDiagram
  autonumber
  participant FS as File system locale
  participant SE as Sync Engine (client)
  participant API as Cloud API
  participant PG as PostgreSQL
  participant S3 as Object Storage

  FS-->>SE: watcher, FSEvents su macOS e fsnotify altrove (debounce 1–2 s) / riconciliazione all'avvio
  SE->>SE: calcola SHA-256, confronta con sync.db → coda locale (outbox)

  rect rgb(235,245,255)
  Note over SE,API: FASE 1 — PULL
  SE->>API: GET /vaults/{id}/changes?since=cursor
  API->>PG: SELECT revisioni con seq > cursor (filtrate per ACL/scope)
  API-->>SE: elenco modifiche + next_seq
  SE->>S3: (via API) GET blob mancanti
  SE->>FS: scrittura atomica (tmp + rename) dei file senza modifiche locali pendenti
  end

  rect rgb(240,255,240)
  Note over SE,API: FASE 2 — PUSH
  SE->>API: POST /blobs:check {hash[]}
  API-->>SE: hash mancanti
  SE->>API: PUT /blobs/{sha256} (solo mancanti)
  API->>S3: put (content-addressed)
  SE->>API: POST /commit {ops[] con base_rev}
  API->>PG: tx: controlla ACL + quota + base_rev, assegna seq
  API-->>SE: per ogni op: accepted | conflict | rejected
  end

  alt conflict
    SE->>SE: risoluzione (§3.4.5) → nuova op su base_rev aggiornata
    SE->>API: POST /commit (op risolutiva / conflict copy)
  end

  API-->>SE: (stream gRPC/SSE) evento "vault X seq N" agli altri dispositivi
```

Il protocollo completo è definito al §3.4. Il merge è sempre eseguito dal client: il server ordina le modifiche e archivia blob, ma non interpreta mai il contenuto dei file. Per questo il protocollo è identico per i vault privati, i cui blob sono cifrati dal client prima dell'upload (§3.8).

### 1.5 Flusso di condivisione e distribuzione configurazione

- **Condivisione** (solo da vault *condivisi*): l'owner crea uno *share* (cartella o documento) con grant a utenti/gruppi → il destinatario vede un invito, lo accetta e il client **monta** il contenuto condiviso come vault aggiuntivo separato (*mount*), sincronizzato in modo scoped sul prefisso condiviso (§3.4.7).
- **Config distribuita**: l'amministratore associa Config Profile a gruppi → il client scarica `GET /config/effective` (ETag), applica la configurazione e blocca in UI le chiavi marcate `locked`. Il cambio di versione arriva come evento realtime.

### 1.6 Topologia di deploy (riferimento)

| Livello | Componenti | Note |
|---|---|---|
| Edge | Reverse proxy / Ingress (TLS 1.2+) | HTTP/2 abilitato per gRPC |
| Applicazione | `memobrain-cloud` (N repliche stateless) + `memobrain-cloud --role=worker` | Scalabilità orizzontale; stato solo in PG/S3 |
| Identità | Keycloak (HA, DB dedicato) | Realm `memobrain` |
| Dati | PostgreSQL (primary + replica), S3-compatibile (MinIO/AWS S3) | Backup PITR su PG; versioning/replica su bucket |
| Osservabilità | OpenTelemetry → Prometheus/Grafana/Loki | `/healthz`, `/readyz`, `/metrics` |

Pacchetti: container OCI + Helm chart + `docker-compose` per sviluppo e piccole installazioni on-premise.

### 1.7 Workbench web e core del client in WebAssembly (ADR-0029, ADR-0030)

La Web UI apre un vault cloud nel browser con **le stesse funzioni e la stessa interfaccia** del client desktop. Non c'è una seconda implementazione: la UI è il pacchetto `@memobrain/workbench` (`packages/workbench`), montato da entrambi gli host, e la logica è il backend Go del client compilato con `GOOS=js GOARCH=wasm`.

- **Il browser è un dispositivo come gli altri.** Registra un dispositivo (`POST /me/devices`, `platform: "web"`, uno per profilo del browser), apre il vault con il flusso di "Collega vault esistente" (copia locale, pull, indice locale, commit con `base_rev`, merge sul client) e usa il protocollo di sync e le API invariati: nessuna API di contenuto nuova, il server resta cieco al contenuto (§3.4.1). Calcolo lato server (indice, ricerca) escluso: violerebbe §3.4.1 e non funzionerebbe sui vault privati.
- **Core** (`apps/desktop/cmd/memobrain-core`, eseguito in un **Web Worker** dedicato). Il dispatcher `internal/rpc` chiama i binding per nome (`Call(service, method, argsJSON)`) con la semantica di Wails; `App.Services()` (`internal/app/services.go`) è l'**unico elenco** dei servizi, usato da `main.go` per Wails e da `memobrain-core` per il dispatcher, così le due API non possono divergere (test di parità dispatcher ↔ binding generati, obbligatorio in `task ci`). Nella pagina un bridge installa `window.go`/`window.runtime` sopra un RPC verso il worker: i binding generati non cambiano.
- **Host.** `internal/app` dipende da un'interfaccia `Host` (`host.go`: eventi verso la UI, dialoghi, download, apertura URL, stampa, uscita, errori fatali), implementata da `host_wails.go` (`!js`, unico file che importa Wails) e da `host_web.go` (`js`, inoltra a `globalThis.__memobrainHost` del worker). Ciò che dipende dalla piattaforma sta dietro `Host` o in file `*_js.go`/`*_native.go` (driver SQLite, watcher, updater, budget della cache di ricerca, notifiche); una costante `isWeb` spegne ciò che il browser non ha (updater, cestino di sistema, file watcher). Nel browser la sessione è quella OIDC della pagina (`SessionHost`: token chiesto alla pagina a ogni richiesta, niente refresh token né keychain) e le chiavi dei vault privati stanno solo in memoria (`crypto.MemoryStore`).
- **Dati nel browser.** Il pacchetto `os` di Go su `js` passa da `globalThis.fs`: il worker fornisce uno shim `fs` su **OPFS** (`FileSystemSyncAccessHandle`, `move()` per i rename), quindi scrittura atomica (tmp + fsync + rename) e rifiuto del path traversal restano quelli di `vault`. I database (`index.db`, `sync.db`, `app.db`) usano **sqlite-wasm** con il VFS **`opfs-sahpool`**, tramite il driver `database/sql` `internal/sqlitejs` (chiamate sincrone verso `@memobrain/sqlite-bridge` nello stesso worker); migrazioni, FTS5 `trigram` e query sono gli stessi del desktop. Senza fsnotify, le modifiche arrivano dal callback di `vault.FS` dopo ogni scrittura del core; la riconciliazione periodica è spenta (§2.5).
- **Rete.** `net/http` su `js/wasm` usa la Fetch API, same-origin. Le notifiche usano solo **SSE** (`/api/v1/events`): il client gRPC non è compilato per `js/wasm` (nel browser non c'è TCP) e la sessione ospitata non annuncia l'endpoint gRPC (§3.6).
- **Una scheda per browser.** Gli handle sincroni di OPFS e il pool di SQLite sono esclusivi per l'origine: un Web Lock (`memobrain-workbench`) consente un solo workbench aperto per browser; una seconda scheda mostra "aperto in un'altra scheda", come l'istanza singola del desktop.
- **Identità del dispositivo.** La registrazione (id del dispositivo, account, server) sta in IndexedDB, fuori dalla cartella OPFS cancellata da logout e "Dimentica questo browser": un browser resta un solo dispositivo per profilo e per account. Se il dispositivo è stato revocato, il core ne registra uno nuovo all'apertura.
- **Dispositivo revocato** (client desktop e workbench). Il cloud rifiuta il `commit` con `403 FORBIDDEN` ed `extra.reason = "device_revoked"`; il client ferma gli engine di quel dispositivo senza toccare file, `sync.db` né outbox, porta la sessione nello stato `device_revoked` e offre "Registra di nuovo questo dispositivo", che registra un nuovo dispositivo dello stesso account e invia ciò che era in attesa.
- **Online-first con cache.** Le modifiche fatte durante brevi disconnessioni restano nell'outbox; non ci sono service worker né installazione PWA e serve una sessione OIDC valida. La politica dei vault privati nel browser è al §2.8.3.
- **Build e budget.** `task wasm-core` produce `memobrain-core.wasm` (`-trimpath -ldflags "-s -w"`) e `wasm_exec.js` della stessa toolchain; la build della Web UI lo copia con hash e SRI e il cloud lo serve compresso. La build fallisce oltre il budget: core ≤ 8 MB gzip (circa 6,8 MB a novembre 2026), `sqlite3.wasm` ≤ 1,5 MB gzip. `task test-wasm` esegue i test Go di `apps/desktop/internal/...` e `cmd/...` sotto `GOOS=js GOARCH=wasm` in Node con sqlite-wasm ed è parte di `task ci` (§4.5). Il codice Go sotto WASM è circa 4,5 volte più lento del nativo: l'indicizzazione iniziale di vault grandi nel browser è lunga e avviene in background.

---

## 2. Functional Specifications

### 2.1 Modello di prodotto

- **Local-first**: ogni funzione di editing, ricerca, grafo e Excalidraw lavora senza rete. Il cloud è un livello opzionale di sync/condivisione.
- **Workbench web** (ADR-0029): gli stessi vault cloud si possono aprire e modificare anche dal browser, con le stesse funzioni del client desktop; lì il funzionamento è *online-first* con copia locale nel browser (§1.7, §2.8.3).
- Un utente può avere **più vault locali** (anche non sincronizzati) e collegare al cloud solo quelli scelti, scegliendone il tipo al momento del collegamento (§2.1.1).
- **Configurazione vault** in `.memobrain/` (analoga a `.obsidian/`), con scope di sync differenziato (§3.4.6).

### 2.1.1 Tipologie di vault cloud (D-02)

In fase di creazione (o di collegamento di un vault locale al cloud) l'utente sceglie una delle due modalità. **La scelta è definitiva**: non esiste conversione tra i due tipi; per passare dall'uno all'altro si copia il contenuto in un nuovo vault (ad esempio con l'Importer "cartella Markdown").

| Aspetto | **Vault privato** (cifrato) | **Vault condiviso** (non cifrato) |
|---|---|---|
| Cifratura | End-to-end lato client (§3.8) + cifratura a riposo del server | TLS + cifratura a riposo del server |
| Condivisione con utenti/gruppi | **No** (solo l'owner) | **Sì** (vault, cartelle, documenti) |
| Cosa vede il server | Nome del vault, dimensione, numero di file, timestamp, sequenza delle modifiche; **contenuto e path sono opachi** | Contenuto e path in chiaro (non esposti da UI e API admin) |
| Merge e conflitti | Sempre sul client | Sempre sul client |
| Download ZIP dalla Web UI | Decifratura nel browser con passphrase (§2.8.2) | Streaming dal server |
| Recupero dell'accesso | Passphrase **oppure** recovery key; **senza nessuna delle due i dati sono irrecuperabili**, anche per l'amministratore | Il reset delle credenziali Keycloak è sufficiente |
| Template e cartelle distribuiti dai gruppi | Non applicabile | Sì (§2.6.6) |

**Wizard di creazione** (client desktop o workbench web, §2.6.1): 1) scelta del tipo, con descrizione esplicita delle conseguenze (irrecuperabilità e impossibilità di condividere per il privato); 2) solo per il privato: definizione della passphrase del vault, distinta dalla password Keycloak, con indicatore di robustezza e minimo 12 caratteri; 3) visualizzazione della **recovery key** con obbligo di conferma dell'avvenuto salvataggio (ri-digitazione di alcuni caratteri); 4) avvio del primo upload.

### 2.1.2 Perimetro del vault (D-06)

Non esistono funzioni cross-vault. Link, embed, backlink, grafo, ricerca full-text, tag, quick switcher, bookmark, template e daily notes operano **esclusivamente sul vault aperto**. Un wikilink verso una nota di un altro vault resta *non risolto*. Il contenuto condiviso da altri utenti compare come **mount**, cioè come vault separato, e valgono le stesse regole. L'applicazione non offre operazioni di copia o spostamento di note tra vault (si usano il file system o l'Importer).

### 2.2 Copertura delle funzionalità Obsidian

#### 2.2.1 Matrice di parità

Priorità: **P0** = MVP · **P1** = release 1.0 · **P2** = post-1.0.

| Area Obsidian (help) | Modulo MemoBrain Notes | Prio | Note di implementazione |
|---|---|---|---|
| Creare vault, aprire cartella come vault, più vault | `vault` | P0 | Vault manager, vault recenti, switch rapido |
| Creare note, rinominare, spostare, eliminare (cestino) | `vault` | P0 | Cestino di sistema o `.trash/` per vault (impostazione) |
| Basic formatting syntax | `editor` | P0 | CommonMark + GFM |
| Advanced formatting (tabelle, diagrammi Mermaid, math LaTeX, footnote) | `editor`, `render` | P0 | KaTeX, Mermaid renderizzati offline (bundled) |
| Obsidian Flavored Markdown (`==highlight==`, `%%commenti%%`, callout, `^block-id`) | `parser`, `render` | P0 | Estensioni goldmark + Lezer |
| Link interni `[[Nota]]`, `[[Nota\|alias]]`, `[[Nota#Heading]]`, `[[Nota#^blockid]]` | `links` | P0 | Risoluzione "shortest path" configurabile |
| Link Markdown standard e URL esterni | `links` | P0 | |
| Embed `![[nota]]`, `![[img.png\|300]]`, `![[doc.pdf#page=3]]`, audio/video | `render` | P0 | Embed ricorsivi con guardia anti-ciclo |
| Backlinks (collegamenti e menzioni non collegate) | `backlinks` | P0 | Pannello laterale + per-nota |
| Outgoing links | `backlinks` | P0 | |
| Aggiornamento automatico dei link al rename/move | `links` | P0 | Operazione atomica client-side |
| Graph view globale e locale (filtri, gruppi, forze, timelapse) | `graph` | P1 | Canvas/WebGL, layout force-directed in Web Worker |
| Properties (YAML frontmatter, tipi: testo, elenco, numero, checkbox, data, data/ora) + vista Properties | `properties` | P0 | Editor tipizzato; schema tipi per vault in `.memobrain/types.json` |
| Tag (annidati `#a/b`), vista Tags | `tags` | P0 | |
| Outline (struttura heading) | `outline` | P0 | |
| Ricerca full-text (operatori `file:`, `path:`, `content:`, `tag:`, `line:`, `section:`, `task:`, `[property:value]`, regex, `match-case`) | `search` | P0 | Vedi §2.4 |
| Embedded search (code block `query`) | `search` | P1 | |
| Quick switcher | `navigation` | P0 | Fuzzy match su nome, alias, heading |
| Command palette | `commands` | P0 | Registro comandi unico, hotkey personalizzabili |
| Slash commands | `editor` | P1 | Menu `/` nell'editor |
| Live Preview / Source mode / Reading view | `editor`, `render` | P0 | Vedi §2.3 |
| Pannelli, tab, split, linked panes, sidebar | `workspace` | P0 | Tab e split all'interno della finestra unica |
| Finestre separate (pop-out) | `workspace` | P2 | Wails v2 gestisce una sola finestra per processo: realizzabile solo come processo secondario con IPC locale (D-07) |
| Workspaces (layout salvati) | `workspace` | P1 | |
| Bookmarks | `bookmarks` | P1 | Gruppi, bookmark di nota/heading/ricerca/grafo |
| Daily notes | `daily` | P1 | Formato data, cartella e template configurabili |
| Unique note creator | `daily` | P1 | Prefisso timestamp configurabile |
| Templates (variabili `{{date}}`, `{{time}}`, `{{title}}`) | `templates` | P1 | Template di gruppo distribuibili (§2.6) |
| Note composer (merge note, estrai selezione in nuova nota) | `composer` | P1 | |
| Page preview (hover) | `render` | P1 | |
| Random note | `navigation` | P2 | |
| Word count | `statusbar` | P0 | Parole, caratteri, selezione |
| File recovery (snapshot locali) | `history` | P1 | Snapshot in `.memobrain/snapshots`; con cloud anche revisioni server |
| Canvas (formato JSON Canvas) | `canvas` | P1 | File `.canvas`, nodi testo/nota/media/link/gruppo |
| Bases (viste tabella/card su properties, filtri, formule) | `bases` | P1 | File `.base` (YAML) |
| Slides (presentazione da note) | `slides` | P2 | Separatore `---` |
| Audio recorder | `audio` | P2 | `MediaRecorder` del webview; permessi per-OS da validare |
| Web viewer | `webview` | P2 | Limitato: molti siti bloccano l'incorniciamento; valutare pannello nativo |
| Importer (Markdown/HTML, Evernote ENEX, Notion, Roam, Bear, Google Keep, CSV) | `importer` | P1 | Parsing nel backend Go; Apple Notes solo macOS (P2) |
| Format converter (da Roam/Logseq, ecc.) | `importer` | P2 | |
| Tema chiaro/scuro, colore accento, font, zoom, larghezza di lettura | `appearance` | P0 | Temi *integrati* (vedi §2.2.3) |
| Hotkeys personalizzabili | `commands` | P0 | |
| Impostazioni (editor, file e link, aspetto, lingua) | `settings` | P0 | Alcune chiavi bloccabili da config di gruppo |
| URI scheme (`memobrain://open?vault=…&file=…`) | `platform` | P0 | Registrato dall'installer; gestisce anche il callback OIDC di fallback (§1.3) |
| Linea di comando (`memobrain open <vault>`, `memobrain new`) | `platform` | P2 | Sottoinsieme rispetto a Obsidian CLI |
| **Excalidraw nativo** | `drawing` | P0 | Vedi §2.7 |
| **Sync** (servizio a pagamento di Obsidian) | Cloud Service | P0 | Sostituito dal servizio cloud (§2.5, §3) |

#### 2.2.2 Obsidian Flavored Markdown supportato

| Elemento | Sintassi | Comportamento |
|---|---|---|
| Wikilink | `[[Nota]]`, `[[Nota\|Alias]]`, `[[Nota#Sezione]]`, `[[#Sezione]]`, `[[Nota#^id]]` | Autocompletamento con `[[`; link non risolto = nota "fantasma" nel grafo |
| Embed | `![[Nota]]`, `![[Nota#Sezione]]`, `![[img.png\|WxH]]`, `![[file.pdf#page=2]]`, `![[disegno.excalidraw]]`, `![[mappa.canvas]]` | Render inline in Live Preview e Reading view |
| Block id | `testo ^id` | Indicizzato; ID generato su richiesta quando si crea un link a blocco |
| Callout | `> [!note] Titolo` (+ `+`/`-` per foldable) | Tipi built-in + alias; icone incluse |
| Highlight / commento | `==testo==` / `%%testo%%` | I commenti non compaiono in reading/export |
| Task | `- [ ]`, `- [x]`, stati personalizzati (`- [/]`, `- [-]`) | Indicizzati per ricerca `task:` |
| Math | `$inline$`, `$$blocco$$` | KaTeX offline |
| Mermaid | ```` ```mermaid ```` | Render in sandbox |
| Footnote | `[^1]`, `^[inline]` | |
| Tabelle | GFM | Editing tabellare assistito in Live Preview |
| Frontmatter | YAML `---` | Properties tipizzate; chiavi speciali `tags`, `aliases` (`cssclasses` è ignorata: nessun CSS personalizzato, D-01) |
| Tag | `#tag`, `#a/b/c` | |
| HTML inline | sottoinsieme sanificato | DOMPurify; niente `<script>`, `<iframe>` remoti, `<style>` e attributo `style` (D-01) |

#### 2.2.3 Esclusioni e deviazioni motivate

| Elemento Obsidian | Decisione | Motivo |
|---|---|---|
| Community plugins e store plugin | **Escluso** | V-02: architettura chiusa |
| Core plugins attivabili/disattivabili | **Deviazione**: tutte le funzioni sono native; l'amministratore può *disattivare funzioni via Config Profile* (feature flag lato client) | V-02 + requisito di config centralizzata |
| Temi community / marketplace | **Escluso**; temi chiaro/scuro integrati + accento | V-02 |
| CSS snippets e CSS personalizzato | **Escluso** (D-01) | Nessuna personalizzazione via CSS, né locale né distribuita; l'aspetto si regola solo con le opzioni integrate |
| Obsidian Publish | Escluso | Servizio separato di Obsidian; possibile estensione futura |
| Web Clipper (estensione browser) | Escluso | Prodotto separato; l'Importer copre il caso d'uso migrazione |
| App mobile | Escluso | A-03 (Wails desktop-only) |

### 2.3 Editor e rendering (frontend)

#### 2.3.1 Modalità di visualizzazione

| Modalità | Descrizione |
|---|---|
| **Source mode** | Markdown grezzo con syntax highlighting, senza decorazioni. |
| **Live Preview** | Modalità predefinita: il Markdown viene renderizzato in-place, la sintassi riappare sulla riga con il cursore. Implementata con **decorations e widget di CodeMirror 6**. |
| **Reading view** | Render completo non editabile (pipeline remark/rehype), con TOC, embed e callout. |

Passaggio tra modalità da hotkey e dal menu del pannello; ricordata per nota/pannello.

#### 2.3.2 Funzioni dell'editor

- Autocompletamento: `[[` (note, heading `#`, block `^`), `#` (tag), `/` (slash commands), proprietà frontmatter.
- Auto-pair di parentesi/virgolette, continuazione liste/task/quote, indentazione con Tab, riordino liste.
- Smart paste: incolla URL su testo selezionato → link Markdown; incolla HTML → Markdown; incolla immagine → salva in cartella allegati e inserisce embed.
- Drag & drop di file nel vault e nell'editor; ridimensionamento immagini via sintassi `|300`.
- Folding (heading e liste), multi-cursore, ricerca/sostituzione nella nota (con regex), selezione rettangolare.
- Spellcheck (dizionario del sistema), line wrapping, larghezza di lettura, numeri di riga opzionali.
- Modalità Vim opzionale (CodeMirror vim) — P2.
- Export: PDF (stampa dal webview con stile "reading"), HTML autonomo — P1.

#### 2.3.3 Pipeline di rendering e coerenza del parsing

Esistono due consumatori del Markdown con esigenze diverse:

| Consumatore | Tecnologia | Output |
|---|---|---|
| **Indicizzazione** (backend) | `goldmark` + estensioni custom | link, embed, tag, heading, block-id, task, properties, footnote |
| **Rendering/Editor** (frontend) | Lezer-markdown (editor), remark/rehype (reading) | DOM |

Per evitare divergenze (es. un link visto dal grafo ma non dal renderer) si impone una **suite di conformità condivisa**: fixture `.md` + JSON atteso in `shared/conformance/`, eseguita sia in Go che in TypeScript da `task conformance`, parte del cancello locale `task ci` (§4.5, ADR-0036). Nessun merge su `main` né release con fixture non verdi.

### 2.4 Indicizzazione e ricerca locale

**Indicizzatore (Go, incrementale)**

1. All'apertura del vault: scansione e confronto `(path, mtime, size, hash)` con `index.db`; re-parse solo dei file cambiati.
2. A runtime: eventi del watcher (FSEvents su macOS, `fsnotify` altrove, §2.5) con debounce; coalescing di rename (stesso hash, path diverso).
3. Per ogni nota estrae: titolo, alias, heading (con livello e posizione), link/embed (con target, heading, block, testo alias, posizione), tag, properties tipizzate, task (stato, riga), block-id, footnote, conteggio parole.
4. Per i file `.excalidraw`/`.canvas`: testo degli elementi e link degli elementi (diventano archi del grafo e occorrenze di ricerca).
5. `index.db` è **derivato e non sincronizzato**: può essere ricostruito in ogni momento (comando "Ricostruisci indice").

**Motore di ricerca**: SQLite FTS5 (driver pure-Go `modernc.org/sqlite`, nessun CGO) con tokenizer `trigram` per supportare la ricerca per sottostringa come Obsidian (min. 3 caratteri; sotto soglia → scansione lineare sui candidati). Un parser di query converte la sintassi in piano di esecuzione: predicati strutturali su tabelle indicizzate + FTS + post-filtro per regex e `line:/block:/section:`.

| Operatore | Esempio | Semantica |
|---|---|---|
| Termini / frase | `riunione "piano Q4"` | AND implicito; frase esatta |
| `OR`, `-`, `( )` | `(a OR b) -c` | Booleani e raggruppamento |
| `file:` / `path:` | `file:budget path:"Progetti/2026"` | Nome / percorso |
| `content:` | `content:"verbale"` | Solo corpo |
| `tag:` | `tag:#cliente/acme` | Con gerarchia |
| `line:()` / `block:()` / `section:()` | `line:(foo bar)` | Co-occorrenza nello stesso ambito |
| `task:` / `task-todo:` / `task-done:` | `task-todo:"chiamare"` | Task |
| `[prop:val]` | `[stato:attivo]`, `[scadenza:<2026-12-31]` | Properties tipizzate |
| `match-case:` / `ignore-case:` | | Override sensibilità |
| `/regex/` | `/\d{4}-\d{2}/` | Regex (RE2) |

Risultati con contesto (snippet evidenziati), ordinamento (rilevanza, nome, modifica), "Spiega termini di ricerca", ricerche salvabili come bookmark. Obiettivo prestazionale: < 200 ms su vault da 50.000 note.

### 2.5 Backend client (Go): moduli

| Modulo | Responsabilità | Dettagli chiave |
|---|---|---|
| `vault` | Operazioni su file, vault manager | Scritture **atomiche** (tmp + fsync + rename); rifiuto path traversal (`..`, symlink fuori vault); normalizzazione NFC dei nomi |
| `watcher` | Eventi FS | **macOS: FSEvents**, un solo stream ricorsivo sulla radice del vault (latenza 50 ms), nessun descrittore per file; CoreServices è raggiunto con `purego`, senza cgo; se FSEvents non si inizializza si torna a `fsnotify`. I flag di eventi persi (`MustScanSubDirs`, `UserDropped`, `KernelDropped`, `RootChanged`) producono una riconciliazione completa. **Linux/Windows: `fsnotify`** (un watch per cartella); al raggiungimento di un limite di sistema (`ENOSPC` di `max_user_watches`, `EMFILE`/`ENFILE`) modalità degradata: nessun nuovo watch, cartelle non osservate contate e registrate una volta, riconciliazione ogni minuto. Ovunque riconciliazione periodica (5 min), perché gli eventi FS non sono affidabili su tutte le piattaforme; nel core eseguito nel browser (workbench web, ADR-0029) è disattivata per default, perché scrive solo il core, che notifica ogni scrittura (ADR-0044) |
| `parser` / `indexer` | §2.4 | Pool di worker, backpressure |
| `search` | Query FTS5 | |
| `links` | Risoluzione link, refactoring al rename | Preview dei file impattati; riscrittura transazionale |
| `graph` | Costruisce nodi/archi dall'indice | Calcolo layout lato frontend |
| `history` | Snapshot locali | Retention configurabile (default 7 giorni / ogni 5 min se modificato) |
| `importer` | Conversione da altri sistemi | Anteprima, report di conversione |
| `crypto` | Cifratura E2EE dei vault privati (§3.8) | Cifra/decifra blob e path; gestione di VMK, passphrase (Argon2id) e recovery key; VMK nel keychain di sistema (nel workbench web solo in memoria del worker, §1.7); il vault locale resta in chiaro sul disco |
| `sync` | Engine di sincronizzazione (§3.4) | Esecuzione in goroutine dedicate, pause/resume, indicatori di stato |
| `auth` | OIDC + token store | Refresh silenzioso; keychain: macOS Keychain, Windows Credential Manager, Secret Service (Linux). Nel workbench web: sessione ospitata, token dato dalla pagina (§1.7) |
| `config` | Config locale + config effettiva da cloud | Merge e `locked` (§2.6) |
| `updater` | Aggiornamenti app | Canale firmato (code signing + verifica firma); disattivato nel workbench web, servito dal cloud |
| `platform` | URI scheme, single-instance lock, menu nativo, dialoghi | Finestra singola (Wails v2) |

**Superficie Wails (esempio, tipizzata e generata)**

```go
// internal/app/bindings.go — esposti al frontend; tutti ricevono context e validano input
type VaultAPI interface {
    OpenVault(path string) (VaultInfo, error)
    ListFiles(vaultID string, dir string) ([]FileEntry, error)
    ReadNote(vaultID, relPath string) (NoteContent, error)
    WriteNote(vaultID, relPath string, content string, expectedHash string) (WriteResult, error)
    RenameWithLinkUpdate(vaultID, from, to string) (RenamePlan, error)
}
type SearchAPI interface {
    Query(vaultID, q string, opts SearchOptions) (SearchResults, error)
}
type SyncAPI interface {
    Status(vaultID string) (SyncStatus, error)
    SyncNow(vaultID string) error
    ListConflicts(vaultID string) ([]ConflictItem, error)
    ResolveConflict(vaultID, conflictID string, choice ResolutionChoice) error
    // ciclo di vita dei vault cloud (§2.6.1, ADR-0037)
    ListDeletedCloudVaults() ([]CloudVault, error)
    RenameCloudVault(cloudVaultID, name string) (CloudVault, error)
    DeleteCloudVault(cloudVaultID string) error              // scollega i dispositivi, conserva i file locali
    RestoreCloudVault(cloudVaultID string) (CloudVault, error)
}
type VaultCryptoAPI interface {            // solo vault privati
    CreateEncryptedVault(name, passphrase string) (VaultInfo, RecoveryKey, error)
    Unlock(vaultID, passphraseOrRecoveryKey string) error
    ChangePassphrase(vaultID, oldPass, newPass string) error
    RegenerateRecoveryKey(vaultID, passphrase string) (RecoveryKey, error)
}
// Eventi (Go → TS): vault:file-changed, index:progress, sync:status, sync:conflict, vault:locked, auth:state, config:updated
```

`WriteNote` richiede `expectedHash` (hash del contenuto letto) per evitare di sovrascrivere modifiche esterne avvenute nel frattempo.

**Stesso backend nel browser (ADR-0030).** Tutti i moduli della tabella compilano e passano i test anche per `js/wasm` (`task test-wasm`, in `task ci`): sono il core del workbench web (§1.7). Le differenze di piattaforma stanno solo dietro l'interfaccia `Host` di `internal/app` o in file `*_js.go`/`*_native.go`; `updater`, file watcher, keychain e cestino di sistema sono esclusi o neutralizzati nel build `js`. I binding esposti sono quelli elencati da `App.Services()`, identici sui due host.

### 2.6 Servizio cloud — moduli funzionali

#### 2.6.1 Gestione vault

- Creazione con scelta del tipo (privato cifrato / condiviso, §2.1.1; immutabile), rinomina, eliminazione logica (retention 30 giorni, ripristinabile dall'utente; purge definitivo dopo). Il nome del vault è un metadato in chiaro anche per i vault privati.
- Più vault per utente; un vault locale esistente può essere "caricato" nel cloud (upload iniziale con barra di avanzamento e ripresa).
- Un secondo dispositivo si collega scaricando il *manifest* (`/tree`) e poi i blob mancanti. Per i vault privati serve prima lo sblocco con passphrase o recovery key (§3.8.4).
- Registro dispositivi (`devices`): nome, piattaforma (`platform: "web"` per il workbench web, uno per profilo del browser, §1.7), ultimo accesso; revoca da Web UI e dal client (il dispositivo corrente è indicato come tale e non si revoca dal proprio elenco, ADR-0037).
- **Ciclo di vita su tutte le superfici (ADR-0037).** Creazione, rinomina, eliminazione logica, elenco dei vault eliminati (`GET /vaults?include_deleted=true`) e ripristino sono disponibili nel client desktop, nel workbench web (ADR-0029) e nella console web, realizzati una volta sola in `@memobrain/cloud-features` (§4.2). L'eliminazione di un vault, vista da un dispositivo collegato, lo **scollega e conserva i file locali**: mai una cancellazione locale (D-04). Un vault privato si crea solo dove è disponibile il codice crittografico Go (client desktop o workbench web): la console apre il workbench su una rotta di creazione (`/vaults/new/open?kind=private&name=…`) e non duplica la crittografia in TypeScript.

#### 2.6.2 Storico revisioni e ripristino

Ogni commit crea una revisione immutabile. Retention di sistema configurabile (default: tutte le revisioni per 30 giorni, poi 1 al giorno fino a 90 giorni). Il job di retention scorre i candidati con paginazione keyset per `(file_id, server_time, id)`, così la regola "ultima revisione del giorno" vale anche tra una pagina e l'altra; le copie di conflitto non lo bloccano (il riferimento `conflict_of` si azzera quando la revisione dell'originale viene potata, §3.2.2); nella stessa transazione avanza la compattazione del changelog (§3.4.4 B) (ADR-0038). UI client "Cronologia nota": elenco, diff, ripristino come nuova revisione. Nei vault privati le revisioni sono ciphertext: il diff è calcolato dal client dopo la decifratura e il ripristino riutilizza il blob della revisione scelta.

#### 2.6.3 Quote di archiviazione

- Quota **globale di default** (`settings.storage.default_quota_bytes`) e **override per utente** (anche "illimitata").
- Uso = somma delle dimensioni dei file correnti dei vault di cui l'utente è owner (le cartelle condivise gravano sull'owner). Lo storico revisioni **non** è conteggiato (D-03). Nei vault privati si misura la dimensione del ciphertext (pochi byte in più per file).
- Soglie: 80% avviso, 95% avviso forte, 100% blocco delle scritture (`413 QUOTA_EXCEEDED`); letture, cancellazioni ed export restano consentiti.
- Il contatore `users.used_bytes` è aggiornato nella stessa transazione del commit; un job notturno di riconciliazione corregge eventuali derive (ogni correzione blocca la riga, ricalcola il valore e scrive solo se differisce, ADR-0038).

#### 2.6.4 Condivisione

- Solo i vault di tipo **condiviso** possono essere condivisi (D-02). Unità condivisibile: **vault intero**, **cartella** (prefisso di path) o **documento singolo**.
- Destinatari: utenti e/o gruppi. Livelli: `viewer`, `editor`, `manager`.
- **Chi crea uno share (ADR-0041).** L'owner del vault, oppure un utente con un grant `manager` **accettato** su uno share attivo (non revocato né scaduto) dello stesso vault, ma solo **dentro l'ambito** di quello share (vault ⊇ cartella con il prefisso ⊇ file) e con grant iniziali non superiori a `manager`; lo share creato ha `created_by` = il manager. Revoca dello share ed eliminazione del vault restano al solo owner (§3.3.2). Il manager che ha creato uno share può rinominarlo, cambiarne la scadenza e gestirne i grant finché conserva un grant `manager` valido su uno share che lo contiene; se lo perde (revoca o scadenza), gli share che ha creato **restano attivi** con i loro grant e passano alla sola gestione dell'owner. Una richiesta fuori dall'ambito di ogni share gestito risponde `403 FORBIDDEN`; l'audit `share.create` registra il manager come attore e lo share che copre l'ambito (`via_share`). Senza il vincolo di contenimento un manager di una cartella potrebbe condividere l'intero vault.
- **Cancellazione di un account che ha concesso grant (ADR-0041, modifica ADR-0021).** I grant concessi dall'utente come `manager` su vault di **altri** proprietari restano validi e sono riattribuiti al proprietario del vault (`granted_by`), con audit `share.grants_reattributed` e notifica `ShareChanged{kind: updated}` per ogni share toccato; i grant sui vault dell'account stesso sono cancellati, perché quei vault entrano in conservazione.
- Il destinatario vede la risorsa come **mount**, cioè come vault separato (cartella radice col nome dello share). I documenti singoli compaiono in un mount virtuale "Condivisi con me".
- Nessuna funzione cross-vault (D-06): un link tra una nota di un altro vault e una nota del mount (o viceversa) non viene risolto; grafo, ricerca e backlink non attraversano i vault.
- **Collaborazione asincrona** (D-04): non c'è editing simultaneo né presenza. Il merge automatico tra utenti diversi è garantito per i soli file `.md`; per gli altri tipi di file un conflitto tra autori diversi produce sempre una copia di conflitto (§3.4.5).
- Revoca immediata: al successivo evento/sync il client smonta il contenuto condiviso e lo rimuove (opzione: mantenere copia locale scollegata).
- Lo spostamento di file fuori dal prefisso condiviso appare ai destinatari come cancellazione. Il rename di una cartella condivisa (anche se cambia solo maiuscole/minuscole) è invece un'operazione atomica `move_prefix`: lo share segue la cartella e i destinatari continuano a sincronizzare (§3.4.7, ADR-0040).

#### 2.6.5 Utenze e gruppi

| Funzione | Descrizione |
|---|---|
| Utenti | Provisioning just-in-time al primo login + creazione da admin (che crea l'utente in Keycloak via Admin API con azione richiesta "imposta password / verifica email"). |
| Gruppi | **Entità applicative** nel DB del Cloud (non gruppi Keycloak), per tenere separati identità e autorizzazione. Un utente può appartenere a più gruppi; ruolo nel gruppo `member` / `manager`. In v1 il ruolo `manager` è **riservato**: memorizzato e mostrato, ma senza effetti di autorizzazione (gruppi e membri si gestiscono solo da `/admin/groups`, §3.5.5); un'estensione, ad esempio la gestione dei membri del proprio gruppo, va decisa in una versione successiva dello spec (ADR-0041). I gruppi sono gestiti **esclusivamente** dal Cloud Service (D-05): nessun import da Keycloak/LDAP e nessun claim di gruppo nel token; la membership è sempre risolta lato server. |
| Ruoli ed eliminazione | Il ruolo globale (`admin`/`user`) cambiato dalla console prevale sui token emessi prima del cambio (§1.3); il cambio richiede l'Admin API di Keycloak (`409 INVALID_STATE` se non è configurata, invece di un ruolo che il token successivo annullerebbe). Sospensione, degradazione ed eliminazione non possono lasciare il servizio senza amministratori attivi: la verifica avviene sotto lock delle righe di tutti gli amministratori attivi, rileggendo il bersaglio. L'eliminazione dalla console segue lo stesso percorso della cancellazione dell'account (§3.7): anonimizzazione immediata, vault in conservazione, rimozione di appartenenze, grant ricevuti, upload ed export pronti, riattribuzione dei grant concessi su vault altrui (§2.6.4) (ADR-0041). |
| Condivisione di massa | Un grant a un gruppo vale per tutti i membri presenti e futuri. |
| Config distribuita | Vedi §2.6.6. |

#### 2.6.6 Distribuzione centralizzata delle configurazioni

**Config Profile**: documento JSON versionato, validato da JSON Schema, assegnabile a uno o più gruppi con priorità.

**Schema unico e feature flag generati (ADR-0037).** Lo schema è uno solo, `api/config-profile.schema.json`. Ogni feature flag (`features.<nome>`, booleani piatti con underscore, es. `web_workbench`, `sharing`, `path_v2`) vi è dichiarato con default e descrizione; `task gen` ne ricava nomi, default dei flag e default di prodotto per Go (`shared/go/features`, usato dal cloud e dal core del client, che incorpora una copia byte per byte dello schema per la validazione) e per TypeScript (`@memobrain/api-client/features`, usato da workbench e console). Nessun altro punto elenca i flag a mano. Un flag sconosciuto alla build è considerato acceso salvo che la configurazione lo spenga, così una funzione più recente della build resta disponibile.

Flag con effetti su sicurezza e compatibilità:

| Flag | Default | Effetto |
|---|---|---|
| `features.web_workbench` | acceso | Apertura dei vault nel browser (workbench web, §2.8.3, ADR-0029); spento, la console non offre "Apri" né la creazione di vault privati e la pagina del workbench rifiuta l'apertura. Il client desktop lo ignora |
| `features.envelope_v2` | **acceso dalla v1.3** | Scrittura degli envelope della VMK in formato v2, legati a vault e tipo (§3.8.2); rilascio N+1 di ADR-0034 |
| `features.path_v2` | **acceso dalla v1.3** | Scrittura dei token di path `enc2` e migrazione dei token `enc1` (§3.8.3, §3.8.7); rilascio N+1 di ADR-0042 |

Spegnere `envelope_v2` o `path_v2` rimanda la migrazione su un'istanza con client desktop non aggiornati (fino alla 1.2.4: §3.8.7), ma non declassa nulla: un dispositivo che ha già visto il formato v2 di un vault continua a scriverlo (pin).

Ordine di risoluzione (ultimo vince):

```
default di prodotto → profilo globale → profili dei gruppi (priorità crescente) → override utente (solo chiavi non "locked")
```

Contenuti tipici: feature flag (es. disabilitare Audio recorder o Web viewer), impostazioni editor/aspetto di default, hotkey di default, intervallo di sync, limite dimensione allegati, cartelle e formati di default per daily note, **libreria di template** (distribuita come cartella condivisa read-only montata sui membri del gruppo), elenco server/URL.

Il client conserva l'ultima config valida in cache locale (utilizzabile offline). Le chiavi `locked` appaiono disabilitate in UI con indicazione "gestita dall'amministratore".

### 2.7 Integrazione nativa di Excalidraw.js

**Obiettivo:** creare, modificare, incorporare e sincronizzare disegni senza plugin esterni.

#### 2.7.1 Modello dati

| Aspetto | Specifica |
|---|---|
| Formato file | `nome.excalidraw` = **JSON standard Excalidraw** (`type: "excalidraw"`, `elements`, `appState` ridotto, `files`). Apribile con qualsiasi tool Excalidraw. |
| Posizione | Nella cartella allegati del vault (impostazione), creato da "Nuovo disegno" o "Inserisci disegno" |
| Embed in nota | `![[nome.excalidraw]]` (opzioni: `![[nome.excalidraw\|600]]`) |
| Anteprima | SVG generato con `exportToSvg` e cache `.memobrain/cache/drawings/<hash>.svg` (non sincronizzata) |
| Immagini nel disegno | Mantenute nel campo `files` (dataURL); soglia di 10 MB per disegno con avviso, oltre cui si suggerisce di spostare le immagini come allegati |
| Libreria forme | `.memobrain/excalidraw-library.json`, sincronizzata (strato "impostazioni utente") |

#### 2.7.2 Comportamento UI

1. **Nuovo disegno** (palette comandi / slash `/disegno`): crea il file, lo apre in un tab "Disegno" e, se invocato da una nota, inserisce l'embed.
2. **Doppio clic su un embed** (Live Preview o Reading) → apre l'editor Excalidraw in un tab o in overlay a schermo intero; al salvataggio l'anteprima si aggiorna nella nota.
3. **Salvataggio automatico** con debounce (2 s) tramite binding `WriteNote` binario, con controllo `expectedHash`.
4. **Export** PNG (con/senza sfondo, 1x–3x), SVG, copia negli appunti.
5. **Tema**: segue chiaro/scuro dell'app.
6. **Link tra elementi e note**: gli elementi Excalidraw possono avere un `link` verso `[[Nota]]`; il click apre la nota; i link entrano nel grafo e nei backlink (la nota target mostra "Disegno X" tra i backlink).
7. **Ricerca**: il testo degli elementi `text` è indicizzato nella ricerca full-text.
8. Modalità presentazione/zen e *read-only* (obbligatoria quando i permessi sono `viewer`).

#### 2.7.3 Requisiti tecnici

- Dipendenza `@excalidraw/excalidraw` (licenza MIT) caricata **lazy** (code-splitting) per non penalizzare l'avvio.
- **Offline obbligatorio**: di default Excalidraw può caricare font/asset da CDN; impostare `window.EXCALIDRAW_ASSET_PATH` verso asset locali inclusi nel bundle e verificare con i test end-to-end (`task e2e`, suite da eseguire prima di ogni rilascio, §4.5, ADR-0036) l'assenza di richieste di rete.
- Verificare la compatibilità tra la versione di Excalidraw e la major di React adottata prima di fissare il lockfile.
- Il disegno è un file come gli altri per sync, storico, quota e permessi; la strategia di merge specifica è al §3.4.5.

### 2.8 Interfaccia web del servizio cloud

Applicazione React/TS servita dal Cloud Service (asset incorporati nel binario), autenticata via OIDC PKCE verso Keycloak (client pubblico `memobrain-web`); la visibilità delle viste dipende dal ruolo nel token **e** viene riverificata lato API (la UI non è un controllo di sicurezza). È composta da due documenti HTML distinti, ciascuno con bundle, foglio di stile e CSP propri, tra cui si passa sempre con un caricamento completo della pagina:

- la **console** (`index.html`, SPA): vista amministratore (§2.8.1) e vista utente (§2.8.2), con la CSP più stretta;
- il **workbench del vault** (`workbench.html`, §2.8.3, ADR-0029): la UI del client desktop sul core Go in WebAssembly (§1.7). Lo stile globale della UI desktop non deve toccare la console, per questo il workbench non è una rotta della SPA.

#### 2.8.1 Vista Amministratore

| Schermata | Funzioni |
|---|---|
| **Dashboard storage** | Spazio totale usato, top utenti per consumo, utenti oltre soglia, trend. |
| **Limiti di archiviazione** | Modifica quota globale di default; quota personalizzata per singolo utente (valore, "usa default", "illimitata"); azioni in blocco da selezione. |
| **Utenti** | Tabella con ricerca/filtri (stato, ruolo, gruppo); creazione; **attivazione / sospensione**; assegnazione ruolo (`admin`/`user`, prevale sui token emessi prima del cambio e richiede l'Admin API di Keycloak, §2.6.5); reset password (azione Keycloak); eliminazione con conferma (stesso percorso della cancellazione dell'account; mai l'ultimo amministratore attivo, §2.6.5); dettaglio con vault (nome, tipo privato/condiviso, dimensione, **mai il contenuto**), dispositivi, sessioni. |
| **Gruppi** | CRUD gruppi; gestione membri (aggiunta/rimozione, ruolo nel gruppo); profili di configurazione assegnati con priorità. |
| **Config Profile** | Editor JSON con validazione da schema, anteprima della config effettiva per un utente, cronologia versioni, rollback. |
| **Audit log** | Ricerca per attore/azione/periodo; export CSV. |

Principio di riservatezza: gli amministratori gestiscono **metadati** (utenti, quote, dimensioni); l'accesso al contenuto delle note non è esposto dalla UI né dalle API admin. Per i vault privati contenuto e path sono inaccessibili anche al servizio (E2EE, §3.8).

#### 2.8.2 Vista Utente standard

| Schermata | Funzioni |
|---|---|
| **Spazio utilizzato** | Barra di utilizzo vs quota, dettaglio per vault, avvisi alle soglie. |
| **I miei vault** | Elenco con tipo (privato cifrato / condiviso), dimensione, numero file, ultima sincronizzazione; creazione, rinomina, eliminazione logica e sezione dei vault eliminati con ripristino (gli stessi componenti del client, §2.6.1; un vault privato si crea aprendo il workbench, ADR-0037); **Apri** nel workbench (§2.8.3); **Download ZIP**. |
| **Download ZIP** | Archivio dell'ultima revisione di tutti i file del vault (path originali, escluse le parti di `.memobrain/` specifiche del dispositivo). **Vault condivisi:** lo ZIP è generato dal server (streaming immediato per i vault piccoli; job asincrono con link temporaneo, scadenza 24 h, per i grandi). **Vault privati:** il server non può leggere i contenuti, quindi i blob cifrati vengono scaricati e decifrati **nel browser** dopo l'inserimento della passphrase (o della recovery key) e lo ZIP è assemblato localmente in streaming; passphrase e chiavi non lasciano mai il browser. Per vault molto grandi si raccomanda l'esportazione dal client desktop ("Esporta vault come ZIP"). |
| **Dispositivi** | Elenco e revoca. |
| **Condivisioni** | Cartelle condivise da me / con me; le condivisioni ricevute e accettate si aprono nel workbench come mount (§2.8.3). |

#### 2.8.3 Workbench del vault (ADR-0029)

Il workbench apre un vault cloud nel browser con le stesse funzioni e la stessa interfaccia del client desktop (`@memobrain/workbench` sul core in WebAssembly, §1.7). È governato dal flag `features.web_workbench` del Config Profile (acceso per default, spegnibile per gruppo, §2.6.6); il controllo vale anche per un indirizzo digitato a mano.

| Rotta | Cosa apre |
|---|---|
| `/vaults/:id/open` | Il vault cloud `:id`, collegato al browser come dispositivo `web` |
| `/vaults/:id/open?share=<id>` | Una condivisione ricevuta e accettata, come mount (§2.6.4) |
| `/vaults/new/open?kind=private&name=…` | Creazione di un vault privato nel browser: passphrase, envelope e recovery key li produce il core Go (§2.1.1, §2.6.1); al termine l'indirizzo diventa `/vaults/<id>/open`. Altri valori di `kind`, un nome vuoto o oltre 120 caratteri sono un errore |

**Eccezioni di parità** (le sole funzioni del client desktop assenti o diverse nel browser; elenco misurato in `docs/web-workbench-parity.md`, generato dal registro delle funzioni, §4.5): aggiornamento automatico (la Web UI è servita dal cloud ed è sempre aggiornata); vault su una cartella del computer e importer da cartella (si aprono solo vault cloud copiati nel browser); avviso sul disco non cifrato; link `memobrain://` (sostituiti dalle rotte); schermo intero della finestra (solo Fullscreen API); cestino di sistema (si usa `.trash/` del vault); più vault aperti insieme (uno per browser). Salvataggi, stampa e scelta dei file passano dalle API del browser (download, `window.print()`, `<input type=file>`). Ogni altra funzione del client desktop è presente.

**Copia locale e scheda singola.** Copia del vault e database in OPFS, un solo workbench aperto per browser (Web Lock, §1.7). "Rimuovi da questo browser" sostituisce "Scollega": scrive le modifiche, sincronizza, attende lo svuotamento dell'outbox e solo allora cancella la copia; se restano modifiche o conflitti chiede conferma (D-04).

**Vault privati nel browser.** La copia di un vault privato nel browser è in chiaro, quindi non deve sopravvivere al blocco:

1. Sblocco con passphrase o recovery key, con la stessa UI del desktop; la VMK resta solo in memoria nel worker.
2. Il **core è l'unico timer di inattività**, come sul desktop (`security.vault_lock_minutes` del Config Profile o impostazione dell'utente); la UI gli segnala l'attività dell'utente e la sync in background non lo riavvia.
3. Al blocco **manuale o per inattività**, se non ci sono modifiche da inviare né conflitti, il workbench chiude il vault, **cancella la copia in chiaro** (cartella OPFS e database del vault) e torna alla console. Se invece qualcosa è in attesa (o il conteggio è ignoto) la copia non si cancella: un overlay bloccante dice cosa resta e offre "Sblocca", "Elimina comunque" o "Torna alla console" (D-04, nessuna perdita silenziosa).
4. Uscire dal workbench (ritorno alla console, logout, richiesta della console) scrive le modifiche, sincronizza, attende lo svuotamento dell'outbox (al massimo 15 s), blocca e decide come al punto 3.
5. Logout e "Dimentica questo browser" cancellano le copie dei vault nel browser; se una copia ha modifiche non inviate o conflitti, la console elenca i vault e chiede conferma.
6. **Sweep all'avvio:** le copie in chiaro lasciate da una scheda chiusa vengono rimosse, salvo quelle con modifiche non inviate.
7. **Unlock gate:** una copia privata conservata va sbloccata prima che il workbench ne mostri il contenuto.

**Sicurezza della pagina.** `workbench.html` ha una CSP dedicata, derivata da quella di rilascio del client desktop, mentre la console mantiene la propria, più stretta (§3.7). Ogni script della build è verificato con **SRI** lungo una catena che parte dalla pagina: script e CSS d'ingresso con `integrity`; chunk statici e lazy fissati da un **import map** inline con il campo `integrity` (unico script inline ammesso, autorizzato dal suo hash nella CSP); worker (core, layout del grafo, pdf.js) scaricati con `fetch` + `integrity` e avviati da un URL `blob:` dei byte verificati, perché `new Worker()` non accetta `integrity`; WASM del core e di sqlite verificati nel worker (un hash mancante è un errore); lo script di Excalidraw aggiunto da un tag con `integrity`. SRI protegge da file alterati tra il server e il browser o nello storage degli asset, non da un server d'origine compromesso (§3.8.1).

### 2.9 Gestione conflitti: aspetti di esperienza utente

- Indicatore di stato sync per vault (sincronizzato / in corso / offline / errore / conflitti).
- Vista **"Risoluzione conflitti"**: lista dei file con copia in conflitto, diff affiancato (locale vs remoto), azioni *Tieni locale*, *Tieni remoto*, *Unisci manualmente*, *Mantieni entrambi*.
- Nessuna perdita silenziosa: ogni versione scartata resta nello storico revisioni (ripristinabile).

---

## 3. Technical & API Specifications

### 3.1 Convenzioni generali

| Tema | Specifica |
|---|---|
| Versionamento | `/api/v1`; modifiche breaking → `/api/v2`. |
| Contratto | **OpenAPI 3.1** come fonte unica (`api/openapi.yaml`); con `oapi-codegen` e il generatore TS si producono gli stub del server Go, il client TS tipizzato (`@memobrain/api-client`) e il **client Go** (tipi e client in `shared/go/apiclient`) usato dal motore di sync del client, il cui `sync/transport` è un involucro sottile (retry, `Idempotency-Key`, decodifica di `problem+json`, request id) senza strutture copiate a mano. Upload tus e stream SSE `/events` restano fuori dal codice generato ma sono documentati nell'OpenAPI. **Contract test**: ogni richiesta e risposta del client di sync è validata contro `openapi.yaml` (kin-openapi `openapi3filter`) e un test allinea l'enum `ErrorCode` alle costanti di `shared/go/syncproto` (ADR-0037). gRPC con `proto/` + `buf`. |
| Autenticazione | `Authorization: Bearer <JWT Keycloak>` su ogni chiamata (tranne `/healthz`, `/readyz`). |
| Formato | JSON UTF-8; timestamp RFC 3339 UTC; dimensioni in byte; ID = UUID v7. |
| Errori | `application/problem+json` (RFC 9457) con campo `code` applicativo. |
| Paginazione | Cursor-based: `?limit=` (max 500) e `?cursor=`; risposta `{items, next_cursor}`. |
| Idempotenza | Header `Idempotency-Key` sulle `POST` mutanti; ogni op di commit ha comunque un `op_id` univoco. |
| Concorrenza | `ETag`/`If-Match` sulle risorse modificabili; `base_rev` per i file. |
| Rate limit | Token bucket per utente e per IP; header `RateLimit-*`; `429` con `Retry-After`. |
| Tracciamento | `X-Request-Id` propagato; OpenTelemetry. |
| Compressione | gzip/br sulle risposte JSON; i blob viaggiano non ricompressi. |

**Formato errore**

```json
{
  "type": "https://memobrain.example/errors/quota-exceeded",
  "title": "Quota di archiviazione superata",
  "status": 413,
  "code": "QUOTA_EXCEEDED",
  "detail": "Utilizzo 5.00 GiB su 5.00 GiB.",
  "request_id": "01JBX7…",
  "extra": { "used_bytes": 5368709120, "quota_bytes": 5368709120 }
}
```

Codici applicativi principali: `UNAUTHENTICATED`, `FORBIDDEN`, `USER_SUSPENDED`, `NOT_FOUND`, `VALIDATION_FAILED`, `QUOTA_EXCEEDED`, `FILE_TOO_LARGE`, `REV_CONFLICT`, `PATH_INVALID`, `PATH_COLLISION`, `SHARE_ROOT_MOVE`, `BLOB_MISSING`, `VAULT_ENCRYPTED` (operazione non ammessa su vault privato: share, export lato server, `move_prefix`), `VAULT_KIND_IMMUTABLE`, `CURSOR_EXPIRED` (§3.4.4 B), `INVALID_STATE` (operazione non ammessa nello stato corrente, con `detail`: ad es. conflitto di identità al login, cambio di ruolo senza Admin API di Keycloak, ADR-0041), `RATE_LIMITED`.

### 3.2 Schema del database (PostgreSQL)

#### 3.2.1 Diagramma ER

```mermaid
erDiagram
  USERS ||--o{ VAULTS : "possiede"
  USERS ||--o{ DEVICES : "usa"
  USERS ||--o{ GROUP_MEMBERS : "appartiene"
  GROUPS ||--o{ GROUP_MEMBERS : "contiene"
  VAULTS ||--o{ FILES : "contiene"
  FILES ||--o{ FILE_REVISIONS : "ha"
  FILE_REVISIONS }o--|| BLOBS : "punta a"
  VAULTS ||--o{ SHARES : "origina"
  SHARES ||--o{ SHARE_GRANTS : "concede"
  GROUPS ||--o{ CONFIG_ASSIGNMENTS : "riceve"
  CONFIG_PROFILES ||--o{ CONFIG_ASSIGNMENTS : "assegnato"
  USERS ||--o{ EXPORT_JOBS : "richiede"
  USERS ||--o{ AUDIT_LOG : "genera"
```

#### 3.2.2 DDL di riferimento

```sql
CREATE EXTENSION IF NOT EXISTS citext;

-- ===== Identità e organizzazione =====
CREATE TABLE users (
  id                    UUID PRIMARY KEY,
  keycloak_sub          TEXT        NOT NULL UNIQUE,         -- claim "sub"
  username              TEXT        NOT NULL,
  email                 CITEXT      NOT NULL,
  display_name          TEXT,
  role                  TEXT        NOT NULL DEFAULT 'user'
                         CHECK (role IN ('admin','user')),   -- realm role del token, salvo cambio più recente dalla console
  role_changed_at       TIMESTAMPTZ,                         -- ultimo cambio di ruolo dalla console: vale il token solo se iat > role_changed_at (ADR-0041)
  status                TEXT        NOT NULL DEFAULT 'active'
                         CHECK (status IN ('pending','active','suspended','deleted')),
  quota_bytes_override  BIGINT      CHECK (quota_bytes_override >= -1),  -- NULL=default, -1=illimitata
  used_bytes            BIGINT      NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX users_email_uq ON users (email) WHERE status <> 'deleted';

CREATE TABLE groups (
  id          UUID PRIMARY KEY,
  name        CITEXT      NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE group_members (
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  member_role TEXT NOT NULL DEFAULT 'member' CHECK (member_role IN ('member','manager')),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE settings (                 -- chiave/valore globali
  key        TEXT PRIMARY KEY,          -- es. 'storage.default_quota_bytes', 'history.retention_days'
  value      JSONB       NOT NULL,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- ===== Vault, file, revisioni =====
CREATE TABLE vaults (
  id          UUID PRIMARY KEY,
  owner_id    UUID NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('private','shared')),  -- immutabile (D-02)
  last_seq    BIGINT NOT NULL DEFAULT 0,          -- contatore monotono del changelog
  compaction_seq BIGINT NOT NULL DEFAULT 0,       -- le voci del changelog fino a qui non sono più servite (§3.4.4 B, ADR-0038)
  total_bytes BIGINT NOT NULL DEFAULT 0,
  file_count  INT    NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  UNIQUE (owner_id, name)
);

-- Solo per vault kind='private': chiavi avvolte. Il server non vede mai la VMK in chiaro.
CREATE TABLE vault_key_envelopes (
  id          UUID PRIMARY KEY,
  vault_id    UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('passphrase','recovery')),
  kdf         JSONB NOT NULL,       -- {"alg":"argon2id","t":3,"m_kib":65536,"p":4,"salt":"…"} | {"alg":"hkdf-sha256","salt":"…"}
  wrapped_vmk BYTEA NOT NULL,       -- nonce ‖ AES-256-GCM(KEK, VMK) ‖ tag
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vault_id, kind)
);

CREATE TABLE blobs (
  hash        CHAR(64) PRIMARY KEY,               -- SHA-256 hex
  size        BIGINT   NOT NULL,
  storage_key TEXT     NOT NULL,
  ref_count   INT      NOT NULL DEFAULT 0,        -- riferimenti da revisioni
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE files (
  id          UUID PRIMARY KEY,                   -- file_id stabile
  vault_id    UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,                      -- shared: path in chiaro (NFC); private: token opaco "enc1:…" o "enc2:…" (path cifrato, §3.8.3)
  path_key    TEXT NOT NULL,                      -- shared: NFC + casefold (unicità cross-OS); private: "hmac1:<hex>" (HMAC del path normalizzato)
  kind        TEXT NOT NULL DEFAULT 'other',      -- md|canvas|base|excalidraw|attachment|config|other ('opaque' nei vault privati)
  current_rev INT  NOT NULL,                      -- rev_no corrente
  current_seq BIGINT NOT NULL,
  blob_hash   CHAR(64) REFERENCES blobs(hash),    -- NULL se cancellato
  size        BIGINT NOT NULL DEFAULT 0,
  is_deleted  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX files_path_uq ON files (vault_id, path_key) WHERE NOT is_deleted;
CREATE INDEX files_vault_prefix_ix ON files (vault_id, path_key text_pattern_ops);
CREATE INDEX files_blob_ix ON files (blob_hash) WHERE blob_hash IS NOT NULL;  -- controllo del GC dei blob (ADR-0038)

CREATE TABLE file_revisions (                      -- append-only
  id          UUID PRIMARY KEY,
  file_id     UUID   NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  vault_id    UUID   NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  seq         BIGINT NOT NULL,                     -- posizione nel changelog del vault
  rev_no      INT    NOT NULL,                     -- progressivo per file
  op          TEXT   NOT NULL CHECK (op IN ('create','modify','move','delete','restore')),
  path        TEXT   NOT NULL,                     -- path dopo l'operazione
  prev_path   TEXT,                                -- per 'move'
  blob_hash   CHAR(64) REFERENCES blobs(hash),
  size        BIGINT NOT NULL DEFAULT 0,
  base_rev    INT,                                 -- revisione su cui il client ha basato la modifica
  author_id   UUID NOT NULL REFERENCES users(id),
  device_id   UUID REFERENCES devices(id),
  client_mtime TIMESTAMPTZ,                        -- solo informativo
  server_time TIMESTAMPTZ NOT NULL DEFAULT now(),  -- tempo autoritativo
  conflict_of UUID REFERENCES file_revisions(id) ON DELETE SET NULL,  -- conflict copy: revisione dell'originale (si azzera se la retention la pota)
  conflict_of_file UUID,                           -- conflict copy: file originale, scritto al commit; il changelog lo restituisce come conflict_of
  UNIQUE (vault_id, seq),                          -- serve anche il changelog per vault (nessun indice separato)
  UNIQUE (file_id, rev_no)
);
CREATE INDEX file_revisions_conflict_of_ix ON file_revisions (conflict_of) WHERE conflict_of IS NOT NULL;
CREATE INDEX file_revisions_retention_ix ON file_revisions (file_id, server_time, id);  -- paginazione keyset della retention

-- ===== Condivisione e permessi =====
CREATE TABLE shares (
  id            UUID PRIMARY KEY,
  vault_id      UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('vault','folder','file')),
  path_prefix   TEXT,                              -- per 'folder' (senza slash finale)
  file_id       UUID REFERENCES files(id),         -- per 'file'
  display_name  TEXT NOT NULL,
  created_by    UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  CHECK ((resource_type='folder' AND path_prefix IS NOT NULL)
      OR (resource_type='file'   AND file_id     IS NOT NULL)
      OR (resource_type='vault'))
);

CREATE TABLE share_grants (
  id             UUID PRIMARY KEY,
  share_id       UUID NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user','group')),
  principal_id   UUID NOT NULL,
  permission     TEXT NOT NULL CHECK (permission IN ('viewer','editor','manager')),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  granted_by     UUID NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (share_id, principal_type, principal_id)
);

-- ===== Configurazioni distribuite =====
CREATE TABLE config_profiles (
  id          UUID PRIMARY KEY,
  name        CITEXT NOT NULL UNIQUE,
  description TEXT,
  is_global   BOOLEAN NOT NULL DEFAULT FALSE,      -- al più uno
  version     INT NOT NULL DEFAULT 1,
  config      JSONB NOT NULL,
  locked_keys TEXT[] NOT NULL DEFAULT '{}',
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX config_one_global ON config_profiles (is_global) WHERE is_global;

CREATE TABLE config_assignments (
  profile_id UUID NOT NULL REFERENCES config_profiles(id) ON DELETE CASCADE,
  group_id   UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  priority   INT  NOT NULL DEFAULT 100,
  PRIMARY KEY (profile_id, group_id)
);

-- ===== Operatività =====
CREATE TABLE export_jobs (
  id         UUID PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id   UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','expired')),
  object_key TEXT,
  size       BIGINT,
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id    UUID REFERENCES users(id),
  action      TEXT NOT NULL,            -- user.suspend, quota.update, share.create, …
  target_type TEXT,
  target_id   TEXT,
  details     JSONB,
  ip          INET
);
CREATE INDEX audit_log_at_ix ON audit_log (at DESC);
```

**Note di progetto**

- `vaults.last_seq` è incrementato con `UPDATE … SET last_seq = last_seq + 1 RETURNING last_seq` nella transazione di commit (lock di riga per vault ⇒ ordinamento totale per vault, throughput più che adeguato per note).
- `path_key` (NFC + casefold) garantisce unicità coerente anche per client su file system case-insensitive (macOS/Windows) e segnala `PATH_COLLISION` prima che il problema emerga sul client.
- `blobs.ref_count` + sweeper in background (grace period 24 h) per la garbage collection; ricalcolo periodico per riconciliazione.
- Il **contenuto** non è mai in PostgreSQL: solo hash e metadati.
- I vault `private` non possono avere righe in `shares` (controllo applicativo + trigger `shares_vault_kind_chk`); `vaults.kind` è immutabile (trigger).
- Nei vault `private`, `files.path`, `file_revisions.path` e `prev_path` contengono token opachi; `blobs.hash` è lo SHA-256 del **ciphertext**; `files.kind` vale `opaque`.
- L'indice `files_vault_prefix_ix` serve solo i vault `shared` (scope di share per prefisso).
- Ricerca full-text lato server: **non prevista** (la ricerca è locale; i contenuti non vengono indicizzati dal server).
- **Copie di conflitto e retention (ADR-0038).** `conflict_of` è `ON DELETE SET NULL`: la retention può potare la revisione dell'originale senza fallire. Il changelog restituisce come `conflict_of` il valore di `conflict_of_file`, quindi la risposta API non dipende dalla sopravvivenza della revisione referenziata (migrazione `0007_retention_fixes.sql`).
- Il DDL è di riferimento: le tabelle operative non riportate (ad es. `uploads` delle sessioni tus, con `chunk_keys` dalla migrazione `0009_upload_chunk_keys.sql`) e i dettagli esatti sono nelle migrazioni versionate di `services/cloud/internal/db/migrations`, che fanno fede.

### 3.3 Autenticazione e autorizzazione

#### 3.3.1 Configurazione Keycloak

| Elemento | Valore |
|---|---|
| Realm | `memobrain` |
| Client `memobrain-desktop` | Public, Authorization Code + PKCE (S256), redirect URI: loopback `http://127.0.0.1/*` (primario) e `memobrain://auth/callback` (fallback, D-08), scope `openid profile email offline_access` |
| Client `memobrain-web` | Public, Authorization Code + PKCE, redirect `https://<host>/*`, Web Origins = host |
| Client `memobrain-api` | Bearer-only / resource server (audience mapper → `aud=memobrain-api`) |
| Client `memobrain-admin-svc` | Confidential, **service account** con soli ruoli `manage-users`, `view-users`, `query-users` della realm-management (Admin REST API) |
| Realm roles | `memobrain-admin`, `memobrain-user` |
| Token | Access 5 min; SSO session idle 8 h; refresh token rotation ON; offline token per il desktop |
| Sicurezza | MFA/WebAuthn a livello realm; brute-force protection; password policy; federazione LDAP/SAML opzionale (solo utenti: i gruppi restano nel Cloud, D-05) |

#### 3.3.2 RBAC e permessi risorsa

**Ruoli globali**

| Ruolo | Capacità |
|---|---|
| `admin` | Console admin: utenti, gruppi, ruoli, quote, config profile, audit. **Nessun accesso al contenuto** dei vault altrui. |
| `user` | Gestione dei propri vault, condivisioni, download ZIP. |

**Permessi per risorsa (share)**

| Azione | viewer | editor | manager | owner del vault |
|---|:---:|:---:|:---:|:---:|
| Leggere / sincronizzare in pull | ✓ | ✓ | ✓ | ✓ |
| Scaricare ZIP del contenuto condiviso | — | — | — | ✓ (solo vault proprio) |
| Creare/modificare/rinominare/cancellare file nello scope | — | ✓ | ✓ | ✓ |
| Vedere storico revisioni | ✓ | ✓ | ✓ | ✓ |
| Ripristinare revisioni | — | ✓ | ✓ | ✓ |
| Gestire grant dello share | — | — | ✓ | ✓ |
| Creare share (il manager solo dentro l'ambito dello share che gestisce e con grant fino a `manager`, ADR-0041) | — | — | ✓ | ✓ |
| Eliminare lo share / il vault | — | — | — | ✓ |

**Algoritmo di permesso effettivo** per `(utente U, vault V, path P)`:

0. Se `V.kind = 'private'`: nessuna share è ammessa e accede solo l'owner.
1. Se `V.owner = U` → `owner`.
2. Raccogli i grant `accepted` di U e dei gruppi di U su share non revocati/scaduti di V il cui scope copre P (`vault`, `folder` con `path_key` prefisso di P, `file` con `file_id`).
3. Risultato = **permesso massimo** tra i grant raccolti (nessun deny esplicito in v1); vuoto → accesso negato (`403` o `404` per non rivelare l'esistenza).

L'enforcement avviene **lato server su ogni operazione** (changes, blob, commit); il client applica la stessa logica solo per UX. Risultati cacheati per richiesta, invalidati su modifica di share/gruppi.

### 3.4 Protocollo di sincronizzazione dei file Markdown

#### 3.4.1 Principi

1. **Il server ordina, il client riconcilia.** Il server mantiene un changelog totalmente ordinato per vault (`seq`); la concorrenza è ottimistica (`base_rev`).
2. **Tempo autoritativo = server.** Gli `mtime` dei client sono solo metadati; nessuna decisione dipende da orologi dei client.
3. **Content-addressed.** I contenuti sono blob SHA-256: deduplicazione, trasferimenti idempotenti, verifica d'integrità.
4. **Nessuna perdita silenziosa.** Ogni versione soppiantata resta nello storico.
5. **Atomicità lato client.** Scritture con file temporaneo + rename; mai file parziali nel vault.
6. **Il server non interpreta il contenuto.** Nessun merge né parsing lato server: tutta la logica di riconciliazione è sul client, per questo il protocollo non cambia tra vault privati e condivisi.

#### 3.4.2 Regole su file e path

| Regola | Dettaglio |
|---|---|
| Codifica path | UTF-8, normalizzazione **NFC**, separatore `/`, relativo alla radice del vault |
| Lunghezza / caratteri | ≤ 1024 byte totali, ≤ 255 byte per segmento; vietati `\0`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `\|`, segmenti `.`/`..`; segmenti riservati Windows (`CON`, `NUL`, …) e terminazioni `.`/spazio rifiutati (`PATH_INVALID`) |
| Case | Unicità su `path_key` casefold (`PATH_COLLISION`) |
| Contenuto `.md` | Byte inalterati (nessuna normalizzazione di newline/BOM); hash su byte grezzi |
| Esclusi dal sync | `.DS_Store`, `Thumbs.db`, `*.tmp`, `.trash/` (opzionale), `.memobrain/workspace*.json`, `.memobrain/cache/`, `.memobrain/snapshots/`, symlink |
| Dimensione massima | Default 100 MB/file (configurabile da Config Profile e da setting di sistema); `FILE_TOO_LARGE` |
| Config sincronizzata | Strato "impostazioni" (§3.4.6) |
| Vault privati | Validazione di path e dimensione eseguita dal client prima della cifratura; il server controlla solo formato e lunghezza dell'identificativo opaco (§3.8) |

#### 3.4.3 Stato locale del client (`sync.db`)

```
sync_files(vault_id, path, file_id, server_rev, server_hash, local_hash, local_size, local_mtime, state)
   state ∈ { synced, local_modified, local_new, local_deleted, local_moved, conflict }
sync_cursor(vault_id, last_seq)
outbox(op_id, vault_id, kind, payload, created_at, attempts)
conflicts(id, vault_id, file_id, path, local_hash, remote_rev, created_at, status)
pending_remote(file_id PK, rev, change JSON, created_at)   -- candidati al merge (ADR-0039)
quarantine(file_id PK, rev, reason, created_at)            -- voci del server illeggibili (ADR-0039)
```

Regole (ADR-0039):

- **Candidati al merge persistenti.** Una modifica remota che trova il file con modifiche locali si scrive in `pending_remote` **nella stessa transazione** che avanza il cursore della pagina di pull. Il candidato si cancella solo dopo un merge riuscito o quando è superato da una revisione più nuova; se il file cambia durante il merge resta per il ciclo successivo. Un file con un candidato pendente non viene pushato; un commit rifiutato con una revisione corrente più nuova genera un candidato sintetico, così il ciclo successivo esegue il merge invece di ritentare alla cieca. Un candidato irrisolvibile (es. blob sparito) tiene il file fuori dal push e segnala un errore a ogni ciclo, finché una modifica più recente del server non lo sostituisce.
- **Vault privato bloccato.** Un errore di tipo "bloccato" interrompe il pull **prima** che il cursore avanzi (fase `locked`); il blocco manuale attende la fine del ciclo in corso.
- **Quarantena.** Un path che non si decifra per un motivo diverso dal blocco (o un token rifiutato dal pinning di §3.8.7) va in `quarantine`, con `last_error` della riga e log: il file locale non si tocca. Nel bootstrap ogni voce dell'albero conta come "nota" prima della decifratura, quindi non è mai interpretata come una cancellazione del server.
- **Transazioni.** Una pagina di pull, l'adozione nel bootstrap, il merge (copia di conflitto, conflitto, originale) e il rename dalla UI sono atomici su `sync.db`.
- Unlink del vault e rimozione di un mount svuotano anche `pending_remote` e `quarantine`.

#### 3.4.4 Ciclo di sincronizzazione

**A. Rilevamento locale.** Eventi del watcher (FSEvents su macOS, `fsnotify` su Linux/Windows, §2.5, ADR-0044; debounce 1–2 s) + riconciliazione all'avvio e ogni 5 min (ogni minuto in modalità degradata): per ogni file confronta `(mtime,size)` e, se diversi, ricalcola SHA-256 → aggiorna `state`. Un rename è riconosciuto se sparisce un path e ne compare un altro con **stesso hash** (o, per modifiche contestuali, stesso `file_id` noto tramite il binding `RenameWithLinkUpdate`) → op `move`.

**B. Pull.**

```
GET /vaults/{vid}/changes?since={cursor}&limit=500[&scope=…]
```

Per ogni modifica remota (in ordine di `seq`):

| Stato locale del file | Azione |
|---|---|
| `synced` | Scarica blob, scrittura atomica, aggiorna `server_rev/hash` |
| Non esiste localmente | Crea |
| `local_modified` / `local_moved` / `local_deleted` | **Candidato conflitto**, salvato in `pending_remote` (§3.4.3) → risoluzione (§3.4.5), dopo aver completato il pull |
| Modifica originata dallo stesso `device_id` | Ignora (eco) |

Il `cursor` avanza solo dopo l'applicazione durevole del batch (i candidati al conflitto sono salvati nella stessa transazione, §3.4.3). Se `since` è più vecchio della finestra di compattazione del changelog (`since < vaults.compaction_seq`) → risposta `410 CURSOR_EXPIRED` e il client esegue **bootstrap** da `GET /tree`.

**Finestra effettiva del changelog (ADR-0038).** La finestra nominale è `sync.changelog_window_days` (90 giorni), ma la retention dello storico (§2.6.2) pota prima le revisioni non correnti. Per non servire mai un changelog con dei salti, nella stessa transazione del prune `compaction_seq` avanza, per ogni vault, fino al `seq` più alto tra le revisioni cancellate con operazione **diversa da `modify`** (`create`, `move`, `delete`, `restore`). Le `modify` superate si possono perdere senza danno, perché una revisione successiva dello stesso file porta il contenuto aggiornato. Un cursore precedente a un'operazione strutturale potata riceve quindi `CURSOR_EXPIRED` e il client esegue il bootstrap, che non cestina alcun file locale senza prova: per un client rimasto indietro oltre una tale operazione la finestra effettiva si riduce a circa `history.retention_days`.

**C. Push.**

1. `POST /vaults/{vid}/blobs:check` con gli hash da caricare → ritorna i mancanti.
2. `PUT /vaults/{vid}/blobs/{sha256}` per ciascuno (≤ 32 MB singola richiesta; oltre, sessione resumable **tus 1.0**). Il server ricalcola l'hash e rifiuta se non coincide.
3. `POST /vaults/{vid}/commit` con un batch di operazioni; ogni op è valutata **in modo indipendente** (non transazionale sull'intero batch), in ordine, ciascuna in una transazione che: verifica ACL e quota, verifica `base_rev == current_rev`, assegna `seq`, scrive revisione, aggiorna `files`/`blobs`/`users.used_bytes`.

Nelle op `create` il `file_id` è generato dal client (UUID v7; nei vault privati entra anche nei dati autenticati della cifratura, §3.8); il server rifiuta identificativi già esistenti.

**D. Notifica.** Dopo il commit, il server emette un evento (`vault_id`, `seq`) via stream gRPC `Subscribe` (o SSE `/events` come fallback per proxy aziendali). I client interessati avviano un pull; in assenza di stream, polling adattivo (30 s → 5 min). Comportamento dell'hub (riallineamento dopo una riconnessione, limiti per utente) al §3.6.

Backoff esponenziale con jitter su errori di rete e `5xx`; `429` rispetta `Retry-After`.

#### 3.4.5 Rilevamento e risoluzione dei conflitti

**Rilevamento.** Conflitto se un'operazione ha `base_rev` ≠ `current_rev` del file (modifica concorrente da un altro dispositivo/utente) **oppure** se al pull un file remoto modificato ha `state ≠ synced` in locale.

**Ambito della collaborazione (D-04).** Il modello è asincrono. Il merge automatico è garantito per i file `.md`, sia tra dispositivi dello stesso utente sia tra utenti diversi di un vault condiviso. Per gli altri tipi di file il merge per elemento si applica solo ai conflitti tra dispositivi dello **stesso utente**; se gli autori sono utenti diversi (vault condiviso) il conflitto produce sempre una *conflict copy*, senza merge automatico.

**Strategia per tipo di file**

| Tipo | Strategia | Dettaglio |
|---|---|---|
| **Markdown `.md`** | **Merge a 3 vie** (base = revisione `base_rev`, ours = locale, theirs = remota) | 1) Frontmatter YAML unito **per chiave**; stessa chiave modificata in modo diverso → vince il valore remoto e il locale va nella copia. 2) Corpo: diff3 a livello di riga (diff-match-patch per localizzare). Hunk **non sovrapposti** → merge automatico. Hunk sovrapposti → **nessun merge automatico**: il path mantiene la versione già sul server, la versione locale è salvata come *conflict copy* e il conflitto compare nella vista dedicata. |
| **`.excalidraw`** | Merge per `element.id` (stesso utente; autori diversi → conflict copy) | Come la riconciliazione di Excalidraw: per ogni id vince l'elemento con `version` maggiore (a parità `versionNonce` più basso); unione degli id; unione della mappa `files`; elementi cancellati (`isDeleted`) rispettati. |
| **`.canvas`** | Merge per id di nodo/arco (stesso utente; autori diversi → conflict copy) | Unione per id; stesso id modificato su entrambi i lati → vince la revisione più recente per tempo server; l'altra va in *conflict copy*. |
| **`.base`** (YAML) | Come `.md` (3 vie su testo) se stesso utente; autori diversi → conflict copy | |
| **Config JSON (`.memobrain/*.json` sincronizzati)** | Last-Write-Wins **per chiave di primo livello** | Tempo server |
| **Allegati binari** (immagini, PDF, audio…) | Stesso utente: **Last-Write-Wins** (ultimo commit accettato vince); autori diversi: conflict copy | La versione perdente resta nello storico, con notifica |
| **Cancellazione vs modifica** | **La modifica vince** (il file viene ripristinato) | Evita perdita di lavoro |
| **Rename vs modifica** | Entrambe applicate | Garantito dall'identità `file_id` |
| **Rename vs rename (stesso file)** | Vince il primo commit; il secondo viene rimappato | |
| **Create vs create sullo stesso path** (file_id diversi) | Il secondo diventa `nome (1).md` | `PATH_COLLISION` |

**Conflict copy**: nome `<nome> (conflitto <dispositivo> <AAAA-MM-GG HH-mm>).<ext>`, creato come nuovo file (nuovo `file_id`, `conflict_of` valorizzato), sincronizzato come ogni altro file affinché tutti i dispositivi lo vedano. La copia si scrive sul disco **prima** di sovrascrivere l'originale e lo stato in `sync.db` (copia, conflitto, originale) si aggiorna in una sola transazione; il nome si tronca su confini di carattere UTF-8, entro i limiti di §3.4.2 (ADR-0039).

**Flusso di decisione (client, per ogni candidato conflitto)**

```mermaid
flowchart TD
  A["Op con base_rev ≠ current_rev<br/>o file locale modificato + remoto modificato"] --> A2{"Autori diversi<br/>e file non .md?"}
  A2 -->|"Sì"| I
  A2 -->|"No"| B{"Tipo di file?"}
  B -->|".md / .base"| C["Scarica base e remoto → merge a 3 vie"]
  B -->|".excalidraw / .canvas"| D["Merge per id elemento"]
  B -->|"config JSON"| E["LWW per chiave"]
  B -->|"binario"| F["LWW: ultimo commit vince<br/>perdente nello storico"]
  C --> G{"Hunk sovrapposti?"}
  G -->|No| H["Merge automatico → commit su rev corrente"]
  G -->|Sì| I["Tieni remoto sul path<br/>locale → conflict copy<br/>segnala in UI"]
  D --> H
  E --> H
  F --> H
  H --> J["POST /commit con base_rev aggiornato"]
  I --> J
  J -->|"nuovo REV_CONFLICT"| A
```

Il ciclo si ripete fino a convergenza (limite 5 tentativi, poi stato `conflict` con intervento manuale).

#### 3.4.6 Scope di sincronizzazione della cartella `.memobrain/`

| Contenuto | Sincronizzato | Note |
|---|---|---|
| Note, allegati, `.canvas`, `.base`, `.excalidraw` | Sì | Contenuto del vault |
| `.memobrain/appearance.json`, `editor.json`, `hotkeys.json`, `types.json`, `templates/`, `excalidraw-library.json` | Sì (per utente) | Rispettando le chiavi `locked` della config di gruppo |
| `.memobrain/workspace.json`, `workspaces.json` (layout) | No | Specifico del dispositivo |
| `.memobrain/cache/`, `snapshots/`, `index.db`, `sync.db` | No | Derivati/locali |

#### 3.4.7 Sincronizzazione di vault condivisi (scope)

Applicabile ai soli vault condivisi. Il client di un destinatario sincronizza **solo il sottoalbero** condiviso:

```
GET /vaults/{owner_vault}/changes?since=…&scope=share:{share_id}
```

Il server filtra le revisioni per prefisso e ACL e applica queste trasformazioni: un file che esce dal prefisso appare come `delete`; uno che vi entra appare come `create`. Le op `commit` dei destinatari con permesso `editor` sono vincolate al prefisso (`FORBIDDEN` altrimenti). I path nel vault montato sono **relativi alla radice dello share**.

Un rename della cartella radice condivisa è gestito con l'op atomica `move_prefix` (aggiorna anche `shares.path_prefix`); un rename "file per file" che sposterebbe fuori dallo scope l'intera radice è rifiutato con `SHARE_ROOT_MOVE`.

**Rename di cartelle nei vault condivisi (ADR-0040).** `move_prefix` (una revisione `move` per ogni file sotto il prefisso, nella stessa transazione, con ribasamento degli share di cartella) e `SHARE_ROOT_MOVE` sono l'unico modo di rinominare una cartella condivisa.

*Regole del server:*

- `move_prefix` ammette il rename che cambia solo maiuscole/minuscole (stessa `path_key`, path diverso); un path identico è rifiutato con `VALIDATION_FAILED`, lo spostamento di una cartella dentro sé stessa con `PATH_INVALID`;
- una `move_prefix` di una cartella **dentro** uno share di cartella verso un path **fuori** da esso, che porterebbe via tutti i file dello share, è rifiutata con `SHARE_ROOT_MOVE`, come la `move` dell'ultimo file; se nello share resta almeno un file è un rename normale e i destinatari vedono le cancellazioni;
- una `move_prefix` fatta da un editor **attraverso un mount** ribasa gli share annidati nella cartella spostata; la radice del mount non è rinominabile (`SHARE_ROOT_MOVE`). La stessa protezione degli share annidati vale per le `move` per file fatte da un mount, con i path dell'errore relativi al mount.

*Comportamento del client* (motore di sync del desktop, che è anche il core del workbench web):

- **vault condiviso:** una cartella rinominata (azione della UI o scansione) diventa una sola `move_prefix` quando tutti i file che il server ha sotto la vecchia cartella risultano spostati allo stesso path relativo sotto la nuova (o cancellati) e la vecchia cartella non esiste più sul disco, con confronto esatto del nome, così il rename solo-maiuscole su un file system case-insensitive è riconosciuto; si sceglie la cartella più esterna che soddisfa la regola. Le `delete` sotto la cartella partono prima della `move_prefix`; dopo `accepted` le revisioni arrivano con l'eco delle `move` al pull successivo. Un file con un candidato al merge pendente trattiene l'intero rename;
- **`move_prefix` rifiutata** (collisione, `FORBIDDEN`, `NOT_FOUND`, …): il round successivo invia le `move` singole, ciascuna con il proprio esito;
- **`SHARE_ROOT_MOVE` su una `move` singola:** il client chiede le radici degli share di cartella del vault (`GET /shares?scope=owned`) e, se il file ha mantenuto il suo posto sotto il nuovo nome della radice, invia la `move_prefix` della radice, e lo share segue. Altrimenti lo spostamento resta **parcheggiato** in locale (riga `local_moved` ferma, `last_error` con il codice del server, stato della sync che spiega che il file è uscito da una cartella condivisa), il file resta dove l'utente l'ha messo (D-04); riportarlo dentro o spostarlo di nuovo lo sblocca. Da un mount la radice non è ricostruibile e lo spostamento resta parcheggiato;
- **mount (destinatario editor):** stesso comportamento con path relativi alla radice dello share; dopo il rename della radice da parte dell'owner i file "rientrano" allo stesso path relativo e, con lo stesso blob, il client aggiorna solo la revisione senza riscaricarli;
- **pull:** una serie consecutiva di `move` che rinomina un'intera cartella locale (nessun altro file sotto la cartella, destinazione libera) si applica con un solo rename della directory e una transazione su `sync.db`; negli altri casi le `move` si applicano una per una;
- **vault privato:** invariato, `move` per file con il path cifrato di nuovo (§3.8.5).

### 3.5 Specifica delle API REST

Base URL: `https://<host>/api/v1`. Colonna **Ruolo**: `U` = utente autenticato (con i permessi sulla risorsa), `A` = admin.

#### 3.5.1 Profilo, dispositivi, configurazione

| Metodo | Path | Ruolo | Descrizione |
|---|---|---|---|
| GET | `/client-config` | pubblico | Bootstrap del client: `issuer` OIDC, `desktop_client_id`, `web_client_id` (console e workbench web), `audience`, `grpc_endpoint`, `api_version`. Permette di avviare il login conoscendo solo l'URL del server (ADR-0008) |
| GET | `/me` | U | Profilo, ruolo, quota effettiva, uso, versione config (`config_version` = revisione di configurazione `config.revision`, la stessa di `ConfigChanged.version` e della config effettiva: il client la confronta con la propria per sapere se rileggere `/config/effective`, ADR-0041) |
| GET | `/me/usage` | U | Uso per vault e soglie |
| GET | `/me/devices` | U | Dispositivi registrati |
| POST | `/me/devices` | U | Registra dispositivo (ritorna `device_id`; `platform: "web"` per il workbench web, §1.7) |
| DELETE | `/me/devices/{id}` | U | Revoca dispositivo; il `commit` successivo di quel dispositivo risponde `403 FORBIDDEN` con `extra.reason = "device_revoked"` (§1.7) |
| GET | `/me/groups` | U | Gruppi di cui sono membro |
| GET | `/config/effective` | U | Config effettiva (supporta `ETag`/`If-None-Match`) |
| GET | `/directory/users?q=` | U | Ricerca utenti per condivisione (campi minimi, senza e-mail): username e nome visualizzato per sottostringa (`%` e `_` letterali), e-mail solo per **corrispondenza esatta** senza distinzione di maiuscole, così non si ricostruisce un indirizzo per tentativi né si elencano gli utenti di un dominio (ADR-0041) |
| GET | `/directory/groups?q=` | U | Ricerca gruppi (campi minimi; caratteri jolly trattati come letterali) |

#### 3.5.2 Vault e storico

| Metodo | Path | Ruolo | Descrizione |
|---|---|---|---|
| GET | `/vaults` | U | Vault propri (+ campo `mounts`); con `?include_deleted=true` anche i propri vault eliminati logicamente e ancora ripristinabili (`deleted_at` valorizzato, mai in `mounts`; ADR-0037) |
| POST | `/vaults` | U | Crea vault `{name, kind, key_envelopes?}` (`kind` immutabile; `key_envelopes` obbligatorio per `private`) |
| GET | `/vaults/{vid}` | U | Dettaglio (dimensione, file, `last_seq`) |
| PATCH | `/vaults/{vid}` | U (owner) | Rinomina |
| DELETE | `/vaults/{vid}` | U (owner) | Eliminazione logica (i dispositivi collegati si scollegano e conservano i file, §2.6.1) |
| POST | `/vaults/{vid}:restore` | U (owner) | Ripristino entro la retention |
| GET | `/vaults/{vid}/tree` | U | Manifest completo `{path,file_id,rev,hash,size}` + `as_of_seq` |
| GET | `/vaults/{vid}/files/{fid}/revisions` | U | Storico di un file |
| GET | `/vaults/{vid}/files/{fid}/revisions/{rev}/content` | U | Contenuto di una revisione |
| POST | `/vaults/{vid}/files/{fid}/revisions/{rev}:restore` | U (editor+) | Ripristina come nuova revisione |
| POST | `/vaults/{vid}/exports` | U (owner) | Avvia export ZIP asincrono (solo vault condivisi; `409 VAULT_ENCRYPTED` per i privati) |
| GET | `/exports/{id}` | U | Stato job; se `ready` → `download_url` temporaneo |
| GET | `/vaults/{vid}/export.zip` | U (owner) | ZIP in streaming (vault condivisi entro soglia, es. 512 MB; `409 VAULT_ENCRYPTED` per i privati) |
| GET | `/vaults/{vid}/key-envelopes` | U (owner) | Envelope delle chiavi (solo vault privati) |
| PUT | `/vaults/{vid}/key-envelopes/{kind}` | U (owner) | Sostituisce l'envelope `passphrase` o `recovery` (cambio passphrase, nuova recovery key) |

**`POST /vaults` — vault privato**

```json
{
  "name": "Diario",
  "kind": "private",
  "key_envelopes": [
    { "kind": "passphrase",
      "kdf": { "alg": "argon2id", "t": 3, "m_kib": 65536, "p": 4, "salt": "base64…" },
      "wrapped_vmk": "base64…" },
    { "kind": "recovery",
      "kdf": { "alg": "hkdf-sha256", "salt": "base64…" },
      "wrapped_vmk": "base64…" }
  ]
}
```

**`POST /vaults` — vault condiviso:** `{ "name": "Progetto Alfa", "kind": "shared" }`

#### 3.5.3 Sincronizzazione

| Metodo | Path | Ruolo | Descrizione |
|---|---|---|---|
| GET | `/vaults/{vid}/changes` | U | Changelog da `since` (cursor `seq`), `limit`, `scope` |
| POST | `/vaults/{vid}/blobs:check` | U (editor+) | Elenca hash mancanti |
| PUT | `/vaults/{vid}/blobs/{sha256}` | U (editor+) | Upload blob (≤ 32 MB) |
| POST | `/vaults/{vid}/uploads` · `PATCH /uploads/{id}` | U (editor+) | Upload resumable (tus 1.0) per file grandi |
| GET | `/vaults/{vid}/blobs/{sha256}` | U | Download blob (`Range` supportato) |
| POST | `/vaults/{vid}/commit` | U (editor+) | Batch di operazioni |
| GET | `/events` | U | Stream SSE (fallback di gRPC `Subscribe`) |

**`GET /vaults/{vid}/changes`**

```json
{
  "items": [
    {
      "seq": 10482,
      "file_id": "0194f0a8-5e1c-7b1d-9a3e-2b8f4e7c1a10",
      "op": "modify",
      "path": "Progetti/Alfa/riunione.md",
      "prev_path": null,
      "rev": 7,
      "blob_hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "size": 4210,
      "author_id": "0194f0a8-1111-7000-8000-000000000001",
      "device_id": "0194f0a8-2222-7000-8000-000000000002",
      "server_time": "2026-10-23T09:41:12Z"
    }
  ],
  "next_seq": 10482,
  "has_more": false
}
```

**`POST /vaults/{vid}/commit`**

```json
{
  "device_id": "0194f0a8-2222-7000-8000-000000000002",
  "ops": [
    {
      "op_id": "0194f0b0-aaaa-7000-8000-000000000010",
      "op": "modify",
      "file_id": "0194f0a8-5e1c-7b1d-9a3e-2b8f4e7c1a10",
      "path": "Progetti/Alfa/riunione.md",
      "base_rev": 7,
      "blob_hash": "5d41402abc4b2a76b9719d911017c592e0f2d9b3b7c0a0b5d3f2e8f5c2f0c111",
      "size": 4388,
      "client_mtime": "2026-10-23T09:45:03Z"
    },
    {
      "op_id": "0194f0b0-aaaa-7000-8000-000000000011",
      "op": "create",
      "file_id": "0194f0b1-7c3d-7e2a-8b4f-1a2b3c4d5e6f",
      "path": "Progetti/Alfa/schema.excalidraw",
      "blob_hash": "…", "size": 18214
    },
    {
      "op_id": "0194f0b0-aaaa-7000-8000-000000000012",
      "op": "move_prefix",
      "from": "Progetti/Alfa",
      "to": "Archivio/Alfa"
    }
  ]
}
```

Risposta `200` (esito per operazione):

```json
{
  "results": [
    { "op_id": "…10", "status": "accepted", "file_id": "0194f0a8-…", "rev": 8, "seq": 10490 },
    { "op_id": "…11", "status": "accepted", "file_id": "0194f0b1-…", "rev": 1, "seq": 10491 },
    { "op_id": "…12", "status": "rejected", "code": "SHARE_ROOT_MOVE", "detail": "…" }
  ],
  "last_seq": 10491
}
```

Un conflitto è restituito come `{"status":"conflict","code":"REV_CONFLICT","current_rev":9,"current_hash":"…","current_seq":10488}` per la singola op.

L'op `move_prefix` (`from`, `to`) rinomina atomicamente una cartella dei vault condivisi, anche solo nelle maiuscole/minuscole; nei vault privati non è ammessa (`VAULT_ENCRYPTED`, §3.8.5). Regole del server e comportamento del client sono al §3.4.7 (ADR-0040).

#### 3.5.4 Condivisione

| Metodo | Path | Ruolo | Descrizione |
|---|---|---|---|
| GET | `/shares?scope=owned\|received` | U | Elenco share |
| POST | `/shares` | U (owner/manager) | Crea share con grant iniziali (solo vault condivisi; `409 VAULT_ENCRYPTED` altrimenti). L'owner del vault su qualunque ambito; un *manager* è chi ha un grant `manager` **accettato** su uno share attivo (non revocato né scaduto) dello stesso vault, e può creare share solo **dentro l'ambito** di quello share (vault ⊇ cartella con il prefisso ⊇ file) con grant iniziali fino a `manager`; `created_by` è il manager; fuori ambito `403 FORBIDDEN`; gli share creati restano attivi anche se il manager perde il grant (ADR-0041) |
| GET | `/shares/{id}` | U | Dettaglio (con grant se manager) |
| PATCH | `/shares/{id}` | U (manager+) | Nome, scadenza |
| DELETE | `/shares/{id}` | U (owner) | Revoca |
| PUT | `/shares/{id}/grants/{ptype}/{pid}` | U (manager+) | Aggiunge/aggiorna grant |
| DELETE | `/shares/{id}/grants/{ptype}/{pid}` | U (manager+) | Rimuove grant |
| POST | `/shares/{id}:accept` · `:decline` | U (destinatario) | Risposta all'invito |
| GET | `/shared-with-me` | U | Mount disponibili e relativo `scope` di sync |

```json
// POST /shares
{
  "vault_id": "0194f0a8-…",
  "resource_type": "folder",
  "path_prefix": "Progetti/Alfa",
  "display_name": "Alfa — documentazione",
  "grants": [
    { "principal_type": "group", "principal_id": "0194…", "permission": "editor" },
    { "principal_type": "user",  "principal_id": "0194…", "permission": "viewer" }
  ]
}
```

#### 3.5.5 Amministrazione (solo ruolo `admin`)

| Metodo | Path | Descrizione |
|---|---|---|
| GET | `/admin/users?q=&status=&role=&group=` | Elenco paginato |
| POST | `/admin/users` | Crea utente (anche in Keycloak) |
| GET · PATCH · DELETE | `/admin/users/{id}` | Dettaglio / modifica anagrafica (prima il DB, poi Keycloak nella stessa transazione: un'e-mail duplicata fallisce prima di toccare Keycloak, un errore di Keycloak annulla la modifica) / eliminazione (stesso percorso della cancellazione dell'account, §2.6.5) |
| POST | `/admin/users/{id}:suspend` · `:activate` | Sospensione/attivazione (propaga a Keycloak, revoca sessioni) |
| PUT | `/admin/users/{id}/role` | `{ "role": "admin" \| "user" }`; imposta `role_changed_at`; richiede l'Admin API di Keycloak (`409 INVALID_STATE` se non configurata). Sospensione, degradazione ed eliminazione dell'ultimo amministratore attivo sono rifiutate, con verifica sotto lock (ADR-0041) |
| PUT | `/admin/users/{id}/quota` | `{ "quota_bytes": 10737418240 }` · `null` = default · `-1` = illimitata |
| POST | `/admin/users/{id}:reset-password` | Invia azione richiesta Keycloak |
| GET | `/admin/users/{id}/vaults` | Solo metadati (nome, tipo, dimensioni) |
| GET · POST | `/admin/groups` | Elenco / creazione |
| GET · PATCH · DELETE | `/admin/groups/{id}` | Gestione gruppo |
| PUT · DELETE | `/admin/groups/{id}/members/{uid}` | Membership e ruolo nel gruppo |
| GET · PUT | `/admin/settings/storage` | Quota default globale, soglie, retention storico |
| GET | `/admin/storage/overview` | Totali, top consumatori, utenti oltre soglia |
| GET · POST | `/admin/config-profiles` | Elenco / creazione |
| GET · PUT · DELETE | `/admin/config-profiles/{id}` | Gestione (incrementa `version`) |
| PUT | `/admin/groups/{id}/config-profiles` | Assegnazioni con priorità |
| GET | `/admin/users/{id}/config/effective` | Anteprima config effettiva |
| GET | `/admin/audit-log?actor=&action=&from=&to=` | Audit |

```json
// PUT /admin/users/{id}/quota
{ "quota_bytes": 10737418240 }

// GET /admin/storage/overview
{
  "default_quota_bytes": 5368709120,
  "total_used_bytes": 842137100288,
  "users_over_80_percent": 12,
  "top_consumers": [
    { "user_id": "0194…", "username": "mrossi", "used_bytes": 4831838208, "quota_bytes": 5368709120 }
  ]
}
```

Ogni azione amministrativa che modifica stato produce una riga di `audit_log`.

### 3.6 gRPC

REST è il contratto normativo; gRPC è usato per lo **streaming di notifiche** e, opzionalmente, per i trasferimenti bulk. HTTP/2 richiesto; il client degrada a SSE/polling se il proxy lo blocca. Il core del workbench web usa solo SSE (`GET /events`): il client gRPC non è compilato per `js/wasm` (§1.7, ADR-0030).

```proto
syntax = "proto3";
package memobrain.v1;

service NotifyService {
  // Stream di eventi per tutti i vault/shared mount accessibili al token
  rpc Subscribe(SubscribeRequest) returns (stream Event);
}

message SubscribeRequest {
  string device_id = 1;
  map<string, int64> known_seq = 2;   // vault_id → ultimo seq noto (per replay)
  int32 config_version = 3;
}

message Event {
  oneof payload {
    VaultChanged vault_changed = 1;
    ConfigChanged config_changed = 2;
    ShareChanged share_changed = 3;
    AccountChanged account_changed = 4;  // sospensione, cambio quota
  }
}
message VaultChanged   { string vault_id = 1; int64 seq = 2; }
message ConfigChanged  { int32 version = 1; }
message ShareChanged   { string share_id = 1; string kind = 2; } // granted|revoked|updated
message AccountChanged { string kind = 1; }
```

Autenticazione: metadata `authorization: Bearer <JWT>`; a token scaduto lo stream è chiuso con `UNAUTHENTICATED` e il client lo riapre dopo il refresh.

**Hub delle notifiche (ADR-0041).**

- Il listener PostgreSQL (`LISTEN/NOTIFY`) non interroga il database: accoda gli eventi dei vault (coalescendoli per vault) e quelli degli share (coda limitata a 10 000; oltre, si svuota e si chiede un riallineamento) a un dispatcher che risolve proprietari e lettori di un intero lotto con due query. Gli iscritti sono indicizzati per utente; un evento di share invalida solo il vault dello share. Il canale e il payload di `vault_changed` sono definiti una sola volta nel modulo `notify`.
- **Riallineamento dopo una riconnessione:** quando la connessione `LISTEN` cade e torna in ascolto, l'hub riallinea ogni iscritto dal database, senza nuovi tipi di evento: `VaultChanged` per i vault e `ConfigChanged` per la revisione di configurazione più avanti di quanto l'iscritto conosce (posizioni inviate alla connessione con `known_seq`/`config_version` e quelle spedite dopo), e l'evento di sospensione, che chiude lo stream, per gli account sospesi o eliminati nel frattempo. Gli eventi di share non sono ricostruibili: un vault condiviso nel frattempo compare come evento di vault, uno revocato risponde `NOT_FOUND` al pull successivo.
- **Limiti:** al massimo 32 stream per utente e per replica (`RESOURCE_EXHAUSTED` su gRPC, `429 RATE_LIMITED` su SSE); ogni scrittura SSE ha una deadline di 30 s. gRPC: recovery dei panic, `MaxConnectionAge` 30 minuti con 1 minuto di grazia, spegnimento che chiude prima gli stream (`UNAVAILABLE`) e poi attende `GracefulStop` entro `SHUTDOWN_TIMEOUT`.

### 3.7 Sicurezza (sintesi dei requisiti)

| Ambito | Requisito |
|---|---|
| Trasporto | TLS ≥ 1.2, HSTS; certificate pinning **non** adottato (gestione operativa onerosa) |
| Token | Validazione completa JWT; clock skew ≤ 60 s; nessun token in log; refresh token solo nel keychain di sistema |
| Autorizzazione | Check server-side ad ogni operazione; risposte `404` per risorse non autorizzate dove l'esistenza è sensibile |
| Input | Validazione schema OpenAPI; limiti su dimensioni, profondità path e cardinalità batch (es. ≤ 500 op/commit) |
| Path | Anti path traversal sia client (vault FS) sia server (nomi virtuali, mai usati come path del filesystem) |
| Contenuti | Sanificazione HTML (DOMPurify), CSP restrittiva nel webview (`default-src 'self'`; niente `unsafe-eval`), Mermaid in modalità `strict`, nessun caricamento di risorse remote automatico negli embed |
| Web UI | Due CSP (ADR-0029). **Console:** `default-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'` (solo per compilare WebAssembly), `style-src 'self'` senza stili inline, `connect-src 'self'` più l'origine dell'issuer OIDC, nessun `blob:`. **Workbench** (solo `workbench.html`): derivata da quella di rilascio del desktop, con `script-src 'self' 'wasm-unsafe-eval' 'sha256-<import map>'` (l'unico script inline è l'import map con gli hash SRI dei chunk, il cui hash il server calcola all'avvio), `style-src 'self' 'unsafe-inline'` (stili calcolati da CodeMirror, KaTeX ed Excalidraw; gli script inline restano vietati), `worker-src 'self' blob:` (worker avviati dai byte verificati con SRI), `connect-src 'self' blob:` più l'issuer, `img-src`/`media-src` con `blob:`. Entrambe: `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`, nessuna risorsa di altre origini (D-01, V-02). SRI su ogni script della build (§2.8.3); header `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin` |
| Storage | Cifratura a riposo (SSE) del bucket e del volume PG; chiavi gestite dall'infrastruttura; vault privati: cifratura end-to-end aggiuntiva lato client (§3.8) |
| Segreti | Secret manager / variabili d'ambiente; secret del service account Keycloak ruotabile |
| Audit | Registro di azioni amministrative e di condivisione |
| Supply chain | SBOM, `govulncheck` (in `task ci`, ADR-0036), `npm audit`, lockfile firmati, firma e notarizzazione dei binari desktop |
| Privacy (GDPR) | Esportazione dati utente, cancellazione account con purge (anonimizzazione immediata, vault in conservazione; un solo percorso per la cancellazione chiesta dall'utente e l'eliminazione dalla console; i grant concessi su vault altrui sono riattribuiti al proprietario del vault, §2.6.4, ADR-0041), minimizzazione (nessun contenuto indicizzato server-side), retention documentata |

### 3.8 Cifratura end-to-end dei vault privati (D-02)

#### 3.8.1 Modello di minaccia

| | |
|---|---|
| **Protegge da** | Lettura di contenuti e path da parte di amministratori, operatori dell'infrastruttura, leak del database o del bucket, compromissione del server. |
| **Non protegge da** | Compromissione del dispositivo dell'utente; metadati osservabili dal server (nome del vault, dimensione e numero dei file, timestamp, sequenza e frequenza delle modifiche, elenco dispositivi); un server malevolo che serva JavaScript alterato alla **Web UI**: la decifratura nell'export ZIP e, con il workbench web (ADR-0029), anche la lettura e la **scrittura** dei vault privati nel browser si fidano del codice servito. Mitigazioni: CSP e SRI (§2.8.3, §3.7, che non proteggono da un server d'origine compromesso), VMK solo in memoria, blocco per inattività e cancellazione della copia in chiaro, flag `features.web_workbench` per disattivare il workbench; per il massimo livello di fiducia si usa il client desktop firmato. |
| **Fuori ambito** | Condivisione di vault cifrati; rotazione della VMK (post-1.0). |

#### 3.8.2 Gerarchia delle chiavi

```text
passphrase ───Argon2id───► KEK_pass ─┐
                                     ├─ unwrap AES-256-GCM ─► VMK (256 bit casuali, una per vault)
recovery key ──HKDF──────► KEK_rec ──┘                          │
                                                                ├─ HKDF("memobrain/v1/path-enc")        → K_path_enc
                                                                ├─ HKDF("memobrain/v1/path-key")        → K_path_key
                                                                └─ HKDF("memobrain/v1/file", file_id ‖ salt_file) → K_file (per file e per revisione)
```

| Elemento | Specifica |
|---|---|
| VMK | 256 bit da CSPRNG, generata sul client alla creazione; mai trasmessa in chiaro |
| Passphrase | Distinta dalla password Keycloak (che il server conosce al login). Minimo 12 caratteri, stima di robustezza (zxcvbn ≥ 3) |
| KDF della passphrase | Argon2id, parametri minimi t=3, m=64 MiB, p=4 (calibrati sul dispositivo e salvati nell'envelope) |
| Recovery key | 256 bit casuali mostrati come Base32 raggruppato con checksum; KEK derivata con HKDF-SHA256 |
| Envelope | `AES-256-GCM(KEK, VMK)` salvato sul server (`vault_key_envelopes`); la lettura richiede un token valido dell'owner. Due formati, distinti dalla lunghezza (ADR-0034): **v1** = `nonce (12) ‖ AES-256-GCM(KEK, VMK) ‖ tag (16)`, 60 byte senza AAD; **v2** = `0x02 ‖ nonce (12) ‖ AES-256-GCM(KEK, VMK; AAD) ‖ tag (16)`, 61 byte, con `AAD = "memobrain/v2/envelope" (21 B ASCII) ‖ vault_id (16 B) ‖ kind ("passphrase" \| "recovery")`. Tutti i client leggono entrambi; un v2 aperto con `vault_id` o `kind` diversi fallisce come una passphrase errata, e un v2 privato del byte di versione non si apre come v1. Il server accetta 60 byte, oppure 61 con il primo byte `0x02`, senza interpretare altro. Scrittura e migrazione: §3.8.7 |
| Cache locale | Dopo il primo sblocco la VMK è conservata nel keychain del sistema operativo; blocco manuale e timeout configurabili. Nel workbench web la VMK resta solo in memoria nel worker e il blocco cancella la copia in chiaro (§2.8.3) |
| Algoritmi | AES-256-GCM (disponibile sia in Go sia in WebCrypto, quindi stessa specifica per client e browser), HKDF-SHA256, HMAC-SHA256, Argon2id |

> **Trade-off dichiarato.** Poiché l'envelope della passphrase risiede sul server, chi ottenesse database e token dell'owner potrebbe tentare un attacco offline alla passphrase. Si mitiga con Argon2id e politica di robustezza; la scelta consente l'uso multi-dispositivo senza trasferire chiavi a mano (vedi O-03 in Appendice C).

#### 3.8.3 Formato del blob e dei path

```text
header : magic "NDS1" | versione (1 B) | salt_file (16 B) | chunk_size (4 B, default 64 KiB)
corpo  : chunk_0 ‖ chunk_1 ‖ … ‖ chunk_n          (ogni chunk = ciphertext ‖ tag GCM da 16 B)
nonce  : contatore a 96 bit = indice del chunk    (sicuro perché K_file è unica per file e per salt)
AAD    : vault_id ‖ file_id ‖ indice_chunk ‖ flag_ultimo_chunk
```

- Ogni upload usa un `salt_file` casuale: una nuova `K_file` per ogni revisione, quindi nessun riuso di nonce con la stessa chiave.
- L'AAD lega il ciphertext a vault, file e posizione: impedisce lo scambio di blob tra file e il troncamento.
- `blob_hash` è lo SHA-256 dell'intero blob **cifrato**: il server verifica l'integrità del trasferimento senza accedere al contenuto. Non c'è deduplicazione tra file; il client evita i re-upload confrontando l'hash del *plaintext*, conservato solo in `sync.db`.
- Path (ADR-0042): due formati del token, distinti dal prefisso, che è la versione. Stessa chiave `K_path_enc`, nonce casuale a 96 bit:

  ```text
  enc1 = "enc1:" + base64url(nonce (12) ‖ AES-256-GCM(K_path_enc, path NFC; AAD) ‖ tag (16))
         AAD = vault_id (16 B)
  enc2 = "enc2:" + base64url(nonce (12) ‖ AES-256-GCM(K_path_enc, path NFC; AAD) ‖ tag (16))
         AAD = "memobrain/v2/path" (17 B ASCII) ‖ vault_id (16 B) ‖ file_id (16 B)
  ```

  `enc2` lega il path al file, come l'AAD dei blob: un server che associ a un file il token di path di un altro file dello stesso vault viene rilevato (decifratura fallita, change in quarantena, file locale intatto, §3.4.3). Le due AAD hanno lunghezze diverse e la v2 ha un prefisso di dominio, quindi un token rietichettato da una versione all'altra non si apre (né upgrade né downgrade). Tutti i client leggono entrambi i formati (`DecryptPathFor(…, vault_id, file_id, token)` in Go, `decryptPathFor` in TS, che passano il `file_id` della change, della voce del tree o della voce del manifest dell'export); la scrittura segue la regola di migrazione del §3.8.7.
- Unicità e `PATH_COLLISION`: `path_key = "hmac1:" + hex(HMAC-SHA256(K_path_key, NFC+casefold(path)))`, identico per `enc1` ed `enc2` (dipende solo dal path, non dalla versione del token né dal `file_id`), così unicità, ricerca per prefisso e deduplica sul server restano invariate anche in un vault misto.

#### 3.8.4 Flussi

1. **Creazione.** Il client genera VMK e recovery key, deriva le KEK, produce i due envelope, chiama `POST /vaults` e carica i blob cifrati.
2. **Nuovo dispositivo.** Login Keycloak → `GET /vaults` (il vault risulta *bloccato*) → `GET /vaults/{vid}/key-envelopes` → inserimento di passphrase o recovery key → unwrap della VMK → VMK nel keychain → bootstrap da `/tree`, download e decifratura dei blob, scrittura del vault locale in chiaro.
3. **Cambio passphrase.** Nuovo envelope (re-wrap della stessa VMK), nessuna ri-cifratura dei dati: `PUT /vaults/{vid}/key-envelopes/passphrase`.
4. **Recupero con recovery key.** Sblocco con la recovery key, obbligo di impostare una nuova passphrase, rigenerazione facoltativa della recovery key.
5. **Perdita di passphrase e recovery key.** Dati irrecuperabili: l'amministratore non dispone di alcuno strumento di recupero e il reset della password Keycloak non incide sulla VMK.

#### 3.8.5 Impatti su protocollo e API

| Funzione | Vault condiviso | Vault privato |
|---|---|---|
| Contenuto dei blob | In chiaro | Ciphertext (§3.8.3) |
| Path nelle API (`changes`, `tree`, `commit`) | In chiaro | Token opaco `enc1:…` o `enc2:…`: il server accetta entrambi i prefissi e li convalida solo per forma (lunghezza, alfabeto base64url, niente separatori), senza interpretarli; nessuna migrazione dello schema (ADR-0042) |
| Merge e conflitti | Client | Client (invariato) |
| `move_prefix` e `scope=share` | Supportati (`move_prefix` è il rename delle cartelle, §3.4.7) | **Non supportati**: i rename di cartella sono emessi dal client come singole op `move`, ciascuna con il path cifrato di nuovo (ADR-0040) |
| Storico e ripristino | Server (riferimento al blob) + diff sul client | Come il condiviso; il diff richiede la decifratura sul client |
| Quota e limite di dimensione | Dimensione del file | Dimensione del ciphertext |
| Export ZIP | Server | Browser (WebCrypto) o client desktop |
| Ricerca | Locale | Locale (indice sul plaintext locale) |
| Share e grant | Sì | `409 VAULT_ENCRYPTED` |

#### 3.8.6 Dati locali

La copia del vault sul disco del dispositivo e gli indici locali (`index.db`, `sync.db`) sono **in chiaro**: la protezione a riposo sul dispositivo è demandata alla cifratura del disco del sistema operativo (BitLocker, FileVault, LUKS). Il client mostra un avviso se non rileva la cifratura del disco, dove rilevabile.

Nel **workbench web** la copia del vault e i database stanno in OPFS, nello storage dell'origine del browser, anch'essi in chiaro: per un vault privato questa copia non sopravvive al blocco, al logout né a "Dimentica questo browser", salvo che contenga modifiche non ancora inviate (in quel caso resta finché l'utente non decide, e il workbench la mostra solo dopo un nuovo sblocco: §2.8.3).

#### 3.8.7 Implementazione e verifica

Go: `crypto/aes`, `crypto/cipher`, `golang.org/x/crypto/argon2` e `hkdf`. Browser: WebCrypto più una libreria Argon2id in WASM. Formato e parametri sono definiti in `shared/go/vaultcrypto` con **test vector** condivisi (`shared/conformance`) eseguiti in Go e in TypeScript da `task ci` (ADR-0036). Audit esterno del design e dell'implementazione prima della 1.0.

**Test vector dei path (ADR-0042).** `shared/conformance/crypto/vectors.json` ha la sezione `paths_v2` (vault, file, path, nonce, AAD in esadecimale, token, `hmac1`), con lo stesso path cifrato per due `file_id` diversi; `negative-vectors.json`, sezione `paths` (campo opzionale `file_id`), copre: token `enc2` alterato, di un altro file (`file_id` scambiato), di un altro vault, `enc2` rietichettato `enc1` (downgrade), `enc1` rietichettato `enc2` (upgrade forgiato), `enc2` troncato o non base64url, prefisso sconosciuto `enc3:`. Go (`shared/go/vaultcrypto`) e TS (`packages/vaultcrypto-web`) li verificano entrambi.

**Migrazione dei path a `enc2` e pinning (ADR-0042).** Nessun passo può rendere illeggibile un vault a un dispositivo aggiornato (D-02):

1. **Rilascio N:** tutti i client leggono `enc1` ed `enc2`; il client scrive `enc2` solo se il flag del Config Profile `features.path_v2` è acceso oppure se il vault è già annotato come passato a `enc2` su quel dispositivo; altrimenti scrive `enc1`. Il token si riscrive solo quando un file nasce o si sposta. Il flag va acceso solo con un server che accetta `enc2` (§3.8.5).
2. **Rilascio N+1 (in vigore dalla v1.3):** `features.path_v2` è **acceso per default**. Il client scrive `enc2` e, a vault sbloccato, riscrive in background in `enc2` i path rimasti `enc1` (move verso lo stesso path, stesso `hmac1`: il server ammette un move il cui `path_key` resta quello del file stesso); quando un tree completo non contiene più token `enc1`, il client accende un **pin forte** di vault e da lì rifiuta qualunque `enc1` per quel vault.

Pinning (trust on first use, client desktop e core WASM, che hanno `sync.db`): il **pin di vault** `path_v2:<id cloud>` in `sync_meta` si accende quando il motore decifra un token `enc2` del vault o quando il server accetta un `enc2` scritto dal dispositivo, e da allora i nuovi token restano `enc2` anche a flag spento; il **pin di file** `path_v2_file:<file_id>` si accende alle stesse condizioni per quel file, e da allora un token `enc1` per quel file è rifiutato come downgrade e la change va in quarantena (§3.4.3) senza toccare il file locale. Durante il rilascio N restano esposti allo scambio di token i file ancora `enc1` mai visti in `enc2` dal dispositivo e l'export ZIP del browser, che non ha stato persistente, per i file `enc1`.

**Migrazione degli envelope a v2 e pinning (ADR-0034).** Stesso schema in due rilasci, per non chiudere fuori i dispositivi non aggiornati:

1. **Rilascio N:** tutti i client (desktop, core del workbench web, export ZIP del browser) leggono v1 e v2; scrivono v2 solo con `features.envelope_v2` acceso.
2. **Rilascio N+1 (in vigore dalla v1.3):** `features.envelope_v2` è **acceso per default**. Il client scrive v2 al cambio di passphrase e alla rigenerazione della recovery key; alla creazione il vault nasce con envelope v1 (l'id lo assegna il server) e il client carica subito le versioni v2. A ogni sblocco con passphrase di un envelope ancora v1, il client ri-avvolge la stessa VMK in v2 con gli stessi parametri KDF e lo carica (`PUT /vaults/{vid}/key-envelopes/passphrase`); l'envelope di recovery passa al v2 quando l'utente sblocca con la recovery key o la rigenera, e fino ad allora resta v1. Il caricamento è best effort (la VMK non cambia e l'envelope precedente continua a funzionare) e sostituisce l'envelope solo se sul server c'è ancora quello aperto, per non sovrascrivere una passphrase cambiata nel frattempo da un altro dispositivo. L'export ZIP del browser non riscrive mai gli envelope.

Pinning per **tipo** di envelope: il client annota in `sync.db` (`envelope_v2:<id cloud>:<kind>`) che quel tipo di envelope del vault è passato al v2, quando ne apre o ne carica uno; da allora rifiuta un v1 di quel tipo come downgrade e continua a scrivere v2 anche a flag spento. Il pin non riguarda l'intero vault, perché l'envelope di recovery legittimo può restare v1.

**Compatibilità del rilascio N+1 (v1.3).** I client desktop precedenti al rilascio che legge i formati v2 (fino alla **1.2.4** compresa) non sbloccano un vault con envelope v2 e non leggono i path `enc2`: prima di accendere i flag su un'istanza (o di aggiornare il cloud con i nuovi default) va distribuito il nuovo client desktop; dove non è possibile, l'amministratore spegne `features.envelope_v2` e `features.path_v2` nel profilo globale finché i dispositivi non sono aggiornati. Il workbench web è servito dal cloud ed è sempre aggiornato. Nessun dato va perso: la VMK e i blob non cambiano, un dispositivo vecchio che non riesce a sbloccare torna operativo dopo l'aggiornamento, e un token `enc1` scritto da un client vecchio (che ha ancora la VMK nel keychain) in un vault già passato al pin forte va in quarantena sui dispositivi aggiornati (§3.4.3), senza toccare i file locali né lo storico.

---

## 4. Project Directory Structure

### 4.1 Monorepo

```text
memobrain/
├── go.work                         # workspace Go: apps/desktop, services/cloud, shared/go
├── package.json                    # workspace npm (Yarn): apps/*/frontend, web, packages/*
├── Taskfile.yml                    # task ci | test | lint | gen | wasm-core | … (task runner Task, unico entry point; cancello locale `task ci`: §4.5, ADR-0032, ADR-0036)
├── tools/go.mod                    # strumenti di sviluppo Go pinnati, Task compreso (fuori dal workspace: GOWORK=off)
├── api/
│   ├── openapi.yaml                # contratto REST (fonte unica)
│   ├── config-profile.schema.json  # schema unico del Config Profile; da qui i feature flag generati (§2.6.6)
│   └── proto/memobrain/v1/notify.proto # gRPC
├── shared/
│   ├── go/                         # modulo Go condiviso client/server
│   │   ├── syncproto/              # tipi di commit/changes, codici errore, hashing
│   │   ├── pathrules/              # validazione/normalizzazione path (NFC, casefold, riservati)
│   │   ├── merge/                  # merge 3-way md, JSON per-id (excalidraw/canvas)
│   │   ├── vaultcrypto/            # formato blob E2EE, KDF, envelope, token di path enc1/enc2 (§3.8)
│   │   ├── apiclient/              # tipi e client Go generati da openapi.yaml (ADR-0037)
│   │   └── features/               # feature flag e default generati dallo schema del Config Profile
│   ├── parity/features.yaml        # registro delle funzioni per superficie (ADR-0037, §4.5)
│   └── conformance/                # fixture Markdown → JSON atteso + test vector crittografici (Go + TS)
├── packages/                       # pacchetti TS condivisi
│   ├── api-client/                 # client generato da openapi.yaml (+ feature flag generati)
│   ├── workbench/                  # UI del vault (@memobrain/workbench) condivisa da client desktop e workbench web (§4.2, ADR-0029)
│   ├── cloud-features/             # UI di gestione dei vault cloud con CloudPort (§4.2, ADR-0037)
│   ├── ui/                         # primitive UI condivise e token di stile (§4.2, ADR-0043)
│   ├── markdown/                   # estrattore Markdown TS verificato con le fixture di shared/conformance
│   ├── sqlite-bridge/              # bridge sincrono tra il driver database/sql del core WASM e sqlite-wasm (§1.7, ADR-0030)
│   └── vaultcrypto-web/            # decifratura nel browser (WebCrypto + Argon2id WASM) per lo ZIP dei vault privati
├── apps/
│   └── desktop/                    # progetto Wails; lo stesso backend Go compilato in WASM è il core del workbench web (§4.2)
├── services/
│   └── cloud/                      # servizio Go (§4.3)
├── web/                            # Web UI del cloud: console e workbench del vault (§4.4)
├── deploy/
│   ├── docker/                     # Dockerfile cloud, compose di sviluppo
│   ├── helm/memobrain/                 # chart Kubernetes
│   └── keycloak/realm-memobrain.json   # export realm (client, ruoli, mapper) per bootstrap
├── docs/                           # ADR, specifiche, runbook
└── .github/workflows/release.yml   # solo build e pubblicazione sui tag, senza controlli: nessun servizio di CI (ADR-0036, §4.5)
```

### 4.2 Client desktop (Wails, Go + React/TS)

```text
apps/desktop/
├── main.go                         # bootstrap Wails (finestra, menu, assetserver, single-instance); servizi da App.Services()
├── wails.json
├── build/                          # icone, manifest, installer (NSIS/dmg/AppImage), firma
├── cmd/
│   ├── memobrain-core/             # core per il browser (GOOS=js GOARCH=wasm): globalThis.__memobrainCore, protocollo in doc.go (ADR-0030)
│   └── e2e-device/                 # dispositivo desktop headless per gli e2e con client misti
├── internal/
│   ├── app/                        # composizione: DI, ciclo di vita, binding esposti al frontend
│   │   ├── bindings.go             # VaultAPI, SearchAPI, SyncAPI, AuthAPI, SettingsAPI…
│   │   ├── services.go             # App.Services(): unico elenco dei servizi, per Wails e per il dispatcher WASM
│   │   ├── host.go                 # interfaccia Host (eventi, dialoghi, download, URL, stampa, uscita, errori)
│   │   ├── host_wails.go           # Host con il runtime Wails (!js): unico file che importa Wails
│   │   ├── host_web.go             # Host verso globalThis.__memobrainHost del worker (js); sessione ospitata
│   │   └── events.go               # emissione eventi Go → TS
│   ├── rpc/                        # dispatcher per nome con la semantica dei binding Wails (core WASM)
│   ├── sqlitejs/                   # driver database/sql su sqlite-wasm tramite @memobrain/sqlite-bridge (solo js)
│   ├── vault/                      # operazioni FS atomiche, vault manager, cestino, allegati
│   ├── watcher/                    # FSEvents (macOS, via purego) / fsnotify + riconciliazione (ADR-0044)
│   ├── parser/                     # goldmark + estensioni OFM (wikilink, embed, callout, ^id, ==hl==, %%)
│   ├── indexer/                    # pipeline incrementale → index.db
│   ├── store/                      # SQLite: driver_native.go (modernc) / driver_js.go (sqlitejs); migrazioni index.db / sync.db / app.db
│   │   └── migrations/
│   ├── search/                     # parser query, esecutore FTS5, snippet
│   ├── links/                      # risoluzione link, refactoring al rename
│   ├── graph/                      # estrazione nodi/archi, filtri
│   ├── properties/                 # tipi e validazione frontmatter
│   ├── templates/                  # template, daily notes, unique notes
│   ├── composer/                   # merge/estrazione note
│   ├── history/                    # snapshot locali e recovery
│   ├── importer/                   # evernote, notion, roam, bear, keep, html, csv
│   ├── drawing/                    # supporto backend a Excalidraw: validazione JSON, cache SVG, indice testo
│   ├── canvas/                     # parsing/validazione JSON Canvas
│   ├── bases/                      # motore di query/formule per .base
│   ├── sync/
│   │   ├── engine.go               # ciclo pull/push, scheduler, backoff
│   │   ├── detect.go               # rilevamento modifiche locali, rename
│   │   ├── resolve.go              # risoluzione conflitti (usa shared/go/merge)
│   │   ├── transport/              # involucro del client Go generato (shared/go/apiclient) + gRPC stream (!js) + SSE fallback (unico canale nel core WASM)
│   │   └── scope.go                # vault shared (montaggio, scope)
│   ├── auth/                       # OIDC PKCE: loopback con fallback custom scheme (D-08), keychain, refresh
│   ├── crypto/                     # E2EE vault privati: VMK, envelope, cifratura blob e path (§3.8)
│   ├── config/                     # config locale + config effettiva da cloud (merge/locked)
│   ├── features/                   # feature flags (da Config Profile)
│   ├── updater/                    # update firmati (disattivato nel core WASM)
│   ├── platform/                   # URI scheme + single-instance lock, menu, notifiche (finestra singola, Wails v2)
│   └── telemetry/                  # log strutturati (zerolog), crash report opt-in
└── frontend/                       # host desktop della UI condivisa
    ├── index.html
    ├── scripts/esbuild.mjs         # build e dev server (ADR-0025)
    ├── src/main.tsx                # mountWorkbench(root) di @memobrain/workbench, kind "desktop"
    └── e2e/                        # Playwright sul mock dei binding; gli stessi spec girano sul workbench web
```

La UI del vault è il pacchetto `packages/workbench` (`@memobrain/workbench`, ADR-0029), montato da entrambi gli host con `mountWorkbench(root, options)`; le capability dell'host (`desktop` o `web`: cartelle locali, updater, finestra nativa, cestino di sistema, più vault, sessione propria…) decidono cosa la UI offre e i comandi che ne dipendono lo dichiarano (`Command.requires`).

```text
packages/workbench/
├── wailsjs/                        # binding generati da Wails (non modificare a mano), usati da entrambi gli host
└── src/
    ├── mount.tsx                   # mountWorkbench: monta la UI, imposta le capability, handle con flush()
    ├── platform/                   # capability dell'host (useCan, can)
    ├── app/                        # shell, routing, provider, tema
    ├── workspace/                  # pannelli, tab, split, sidebar, workspaces
    ├── editor/                     # CodeMirror 6: estensioni, live-preview, widget, autocomplete
    │   ├── extensions/             # wikilink, embed, callout, math, mermaid, table, tasks…
    │   └── commands/
    ├── reading/                    # pipeline remark/rehype, TOC, hover preview
    ├── drawing/                    # wrapper Excalidraw (lazy), embed SVG, export, libreria
    ├── canvas/                     # editor JSON Canvas
    ├── bases/                      # viste tabella/card
    ├── graph/                      # rendering grafo + worker layout
    ├── sidebar/                    # file explorer, search, tags, backlinks, outline, bookmarks, properties
    ├── search/                     # UI ricerca
    ├── sync/                       # stato sync, conflitti, cronologia, login, wizard di creazione vault (privato/condiviso), sblocco con passphrase
    ├── cloud/                      # CoreCloudPort: adattatore dei pannelli di @memobrain/cloud-features sui binding Go
    ├── settings/                   # pannelli impostazioni (rispetta le chiavi locked)
    ├── commands/                   # command palette, hotkeys, quick switcher
    ├── state/                      # store (Zustand) + query cache
    ├── i18n/                       # it, en (+ namespace common di @memobrain/ui)
    ├── styles/                     # temi chiaro/scuro sui token condivisi di @memobrain/ui
    └── test/                       # unit (Vitest) e componenti; gli e2e sono negli host
```

**Gestione dei vault cloud: `@memobrain/cloud-features` (ADR-0037).** Tutta la UI di gestione dei vault cloud vive una volta sola nel pacchetto `packages/cloud-features`: tabella dei vault con creazione, rinomina, eliminazione e sezione dei vault eliminati con ripristino (`CloudVaultsTable`), dispositivi con il dispositivo corrente protetto (`DevicesPanel`), utilizzo con il livello di quota del server e il dettaglio per vault (`UsagePanel`), condivisioni, inviti, grant e ricerca nella rubrica. I componenti dipendono solo dall'interfaccia `CloudPort` (vault, dispositivi, utilizzo, condivisioni, grant, inviti, rubrica, configurazione effettiva), con i tipi generati da OpenAPI (`@memobrain/api-client`), e da due adattatori: **`RestCloudPort`** per la console web (REST) e **`CoreCloudPort`** per client desktop e workbench web (binding Go), che sta nel frontend del client accanto alla facciata dei binding, così la dipendenza va in un solo verso. Una sola suite di test dei componenti gira su entrambi gli adattatori; i testi it/en stanno nel pacchetto e l'host passa la lingua. **Regola:** ogni funzione di gestione dei vault cloud nasce in `@memobrain/cloud-features`, mai direttamente nelle pagine della console né nelle impostazioni del client.

**Primitive UI condivise: `@memobrain/ui` (ADR-0043).** `@memobrain/ui` è il pacchetto delle **primitive** di interfaccia, senza stile globale, consumato dalla console, da `@memobrain/cloud-features` e dal frontend del client (workbench): un solo gestore del focus dei modali (`installModalFocus`: Tab ciclico sul modale in cima, ritorno del focus all'opener), il comportamento da tastiera dei menu (hook `useMenuKeyboard`: frecce, Home/End, Escape, chiusura al click esterno), la primitiva `Dialog`, attraverso cui rendono anche i dialoghi imperativi del workbench (`dialog.prompt/confirm/alert/pick`), i token di stile condivisi (`tokens.css`: colori, spaziature, raggi, focus ring, tema chiaro/scuro) con componenti che usano solo classi con prefisso `nd-` e token, mai selettori globali né stili inline, e un namespace i18n comune `common` (`@memobrain/ui/i18n/{en,it}.json`) per le stringhe condivise e i messaggi di errore dell'API (`errors.<code>`), che ogni host aggiunge alla propria istanza di i18next. Nessuna libreria di componenti esterna (V-02, D-01). Console e workbench mantengono ciascuno la propria CSP di pagina (la console senza stili inline) e i propri insiemi di componenti specifici (editor, albero, pannelli restano nel workbench).

### 4.3 Servizio cloud (Go)

```text
services/cloud/
├── cmd/
│   └── memobrain-cloud/
│       └── main.go                 # flag: --role=api|worker|all ; config da env/file
├── internal/
│   ├── config/                     # caricamento e validazione configurazione servizio
│   ├── httpserver/                 # router (chi), middleware: auth, ratelimit, logging, otel, recover
│   ├── grpcserver/                 # NotifyService + interceptor auth
│   ├── auth/                       # validazione JWT/JWKS, estrazione claims, user provisioning
│   ├── keycloak/                   # client Admin REST API (service account)
│   ├── users/                      # utenti, stato, ruoli, quota
│   ├── groups/                     # gruppi e membership
│   ├── vaults/                     # vault, tree, soft-delete/restore
│   ├── revisions/                  # storico, restore, retention
│   ├── vaultkeys/                  # key envelope dei vault privati (solo archiviazione: la VMK non è mai in chiaro)
│   ├── sync/                       # changes, commit, conflitti lato server, notifier
│   ├── blobs/                      # storage content-addressed, upload resumable (tus), GC
│   ├── sharing/                    # share, grant, valutazione permessi (ACL), mount — solo vault condivisi
│   ├── configprofiles/             # profili, assegnazioni, merge config effettiva, schema
│   ├── quota/                      # calcolo, soglie, riconciliazione
│   ├── exports/                    # job ZIP, streaming archive/zip (solo vault condivisi)
│   ├── audit/                      # scrittura/lettura audit log
│   ├── notify/                     # pub/sub interno (Postgres LISTEN/NOTIFY) → stream
│   ├── storage/                    # astrazione S3 (minio-go / aws-sdk) + filesystem per dev
│   ├── db/                         # pgx pool, transazioni, helper
│   │   ├── migrations/             # SQL versionato (goose/atlas)
│   │   └── queries/                # sqlc: query tipizzate
│   ├── jobs/                       # scheduler: GC blob, riconciliazione quote, purge, scadenze
│   ├── observability/              # metrics, tracing, health
│   └── api/                        # codice generato da openapi.yaml (stub + tipi)
├── web-embed/                      # artefatti compilati di /web inclusi con go:embed: scelta della pagina (console o workbench), CSP, header, cache e gzip (§4.4)
├── test/
│   ├── integration/                # testcontainers: PG + MinIO + Keycloak
│   └── contract/                   # verifica conformità a openapi.yaml
└── Dockerfile
```

Regole di modularità: ogni package `internal/<modulo>` espone una **interfaccia** e un'implementazione; dipendenze solo verso `db`, `storage`, `audit`, `notify` e verso interfacce di altri moduli (mai verso le loro tabelle). Lint di dipendenze in `task lint`, parte di `task ci` (`depguard`/`go-arch-lint`, ADR-0036).

### 4.4 Web UI del cloud

```text
web/
├── index.html                      # console (SPA)
├── workbench.html                  # workbench del vault (§2.8.3): pagina separata, import map con SRI
├── scripts/esbuild.mjs             # build e dev server (ADR-0025): SRI, import map, budget di dimensione
└── src/
    ├── main.tsx                    # ingresso della console
    ├── auth/                       # OIDC PKCE (oidc-client-ts), guardie di ruolo
    ├── pages/                      # usage, vaults, devices, shares, account: pannelli di @memobrain/cloud-features con RestCloudPort; download ZIP (decifratura nel browser per i privati)
    │   └── admin/                  # storage, limits, users, groups, config-profiles, audit
    ├── layout/                     # shell della console, tema, "Dimentica questo browser" (primitive e token da packages/ui, ADR-0043)
    ├── workbench/                  # host del browser del workbench (ADR-0029, ADR-0030):
    │                               #   main.tsx/launch.ts (OIDC, Web Lock, flag, apertura e collegamento del vault),
    │                               #   worker.ts (Web Worker: shim fs su OPFS, sqlite-wasm opfs-sahpool, core WASM),
    │                               #   bridge.ts (RPC, window.go / window.runtime), sri.ts (worker verificati),
    │                               #   guard.ts, markers.ts, overlay.ts (politica dei vault privati), device.ts (identità in IndexedDB)
    ├── export/                     # download ZIP: stream o job per i condivisi, decifratura nel browser per i privati
    ├── api/                        # usa packages/api-client
    ├── i18n/
    └── test/
```

La build produce asset statici incorporati nel binario `memobrain-cloud` (`go:embed`, pacchetto `services/cloud/web-embed`); le API stanno sotto `/api/v1`. Il server sceglie la pagina: un percorso `^/vaults/[^/]+/open/?$` riceve `workbench.html` con la CSP del workbench, ogni altro percorso senza estensione riceve `index.html` (fallback SPA) con la CSP della console (§3.7); un file inesistente con estensione è un 404. `task web-build` esegue `task wasm-core` e la build della Web UI include il core WASM e `sqlite3.wasm` con il loro hash; la build fallisce se un budget è superato (core ≤ 8 MB gzip, `sqlite3.wasm` ≤ 1,5 MB gzip, bundle iniziale della console e del workbench entro i limiti di ADR-0020).

### 4.5 Convenzioni di sviluppo

| Tema | Scelta |
|---|---|
| Linguaggi/toolchain | Wails v2 (versione fissata); Go ≥ versione stabile corrente; Node LTS + Yarn; TypeScript `strict` |
| Task runner | **Task** (`Taskfile.yml`, ADR-0032) è l'unico entry point del monorepo, al posto di make (non disponibile di default su Windows): `task` elenca i task; variabili come `task perf PERF_NOTES=1000`, argomenti extra dopo `--`. Task è pinnato come `tool` in `tools/go.mod` insieme agli altri strumenti Go (bootstrap: `cd tools && GOWORK=off go install github.com/go-task/task/v3/cmd/task`, poi `task tools`); i comandi girano in un interprete POSIX e quelli che richiedono bash lo invocano esplicitamente |
| Qualità Go | `golangci-lint`, `govulncheck`, test con `-race`, tabelle di test per parser e merge |
| Qualità TS | ESLint, Prettier, Vitest, Playwright (e2e sul webview; gli stessi spec del desktop girano anche sul workbench web con il core vero) |
| Migrazioni | SQL versionato, solo forward + script di rollback documentato |
| Generazione codice | `task gen`: schema del Config Profile → feature flag Go/TS, OpenAPI → stub Go del server, client Go (`shared/go/apiclient`) e client TS, proto → Go, sqlc, binding Wails |
| Branching/verifiche | Trunk-based. **Nessun servizio di CI** (ADR-0036): l'unico workflow, `release.yml`, parte sui tag e costruisce e pubblica senza eseguire controlli. Il cancello obbligatorio è **`task ci`** in locale, con esito verde prima di ogni merge su `main` e prima di ogni tag di rilascio: `lint` (golangci-lint, ESLint, Prettier), `typecheck` (tutti i pacchetti TypeScript), `vuln` (govulncheck), generazione dei binding Wails, `test-go` (`-race`, tag `webkit2_41` dove serve, `MEMOBRAIN_REQUIRE_BINDINGS=1`: il test dispatcher/binding fallisce invece di essere saltato), `test-ts`, `conformance` (fixture Markdown, merge e test vector crittografici, Go + TS), `test-wasm` (core Go in WebAssembly), `parity` (`scripts/parity.mjs --check`), `check-gen` (fallisce se `task gen` modifica l'albero). **Suite lente**, da eseguire quando si tocca l'area relativa e comunque prima di un rilascio: `task test-integration` (cloud con testcontainers), `task test-desktop-e2e` (sync a due dispositivi e contract test del client REST), `task e2e` e `e2e:workbench-ui` (Playwright), `e2e:cloud` ed `e2e:security` (stack di sviluppo); elenco aggiornato in `docs/dev-setup.md`. La protezione dipende dalla disciplina di chi fa merge e rilasci: con più contributori va valutato un workflow minimo che esegua `task ci` |
| Parità delle funzioni | Registro dichiarativo `shared/parity/features.yaml`, unica fonte della parità (ADR-0037): una voce per funzione utente (es. `vault.create`, `vault.rename`, `vault.delete`, `vault.restore`, `share.create`, `devices`, `usage`) con comandi e binding di client desktop e workbench, rotte e `operationId` della console, stato per superficie (`yes`, `partial`, `exception`, `console-only`, `missing`, con motivazione obbligatoria per tutto ciò che non è `yes`) e test per target. `scripts/parity.mjs --check` (in `task ci`) legge il registro dei comandi a runtime (campo `Command.requires`), i binding generati e gli `operationId` di `api/openapi.yaml`, e fallisce se un comando, un binding o un'operazione utente non compare in nessuna voce, se una voce rimanda a un elemento inesistente o se manca una motivazione; le tabelle di `docs/web-workbench-parity.md` sono generate |
| Release | Versionamento semantico; desktop firmato/notarizzato (macOS), firma Authenticode (Windows); cloud come immagine OCI immutabile |

---

## Appendice A — Requisiti non funzionali

| Categoria | Requisito | Verifica |
|---|---|---|
| **Prestazioni client** | Avvio a freddo < 3 s; apertura nota < 150 ms; digitazione senza lag su note ≤ 1 MB; ricerca < 200 ms; vault di riferimento 50.000 note | Benchmark automatici su dataset sintetico |
| **Indicizzazione** | Primo indice di 50.000 note < 3 min; incrementale < 100 ms per nota | Benchmark |
| **Grafo** | 10.000 nodi a ≥ 30 fps (WebGL), degradazione controllata oltre | Test di rendering |
| **Prestazioni cloud** | p95 `changes` < 200 ms, p95 `commit` (batch ≤ 50 op) < 500 ms a 1.000 utenti attivi | Load test (k6) |
| **Scalabilità** | Repliche stateless; cresce con PG/S3; target iniziale 5.000 utenti, 50 TB | Capacity plan |
| **Disponibilità** | Cloud 99,9% mensile; il client resta pienamente utilizzabile offline | SLO + chaos test |
| **Affidabilità dati** | RPO ≤ 5 min (PITR PG, versioning bucket); nessuna perdita silenziosa in conflitto; scritture client atomiche | Test di fault injection |
| **Sicurezza** | §3.7; pen test prima della 1.0 | Report |
| **Privacy** | Conformità GDPR; admin senza accesso al contenuto; vault privati E2EE | DPIA, audit crittografico |
| **Workbench web** | Core WASM ≤ 8 MB gzip e `sqlite3.wasm` ≤ 1,5 MB gzip (circa 6,8 MB e 0,4 MB a novembre 2026); stesse funzioni del client desktop salvo le eccezioni dichiarate (§2.8.3); indicizzazione di vault grandi in background | Budget nella build della Web UI; `task test-wasm` e controllo di parità in `task ci`; e2e del workbench prima del rilascio |
| **Accessibilità** | WCAG 2.1 AA per Web UI; navigazione da tastiera e screen reader nel client | Audit a11y |
| **Internazionalizzazione** | IT e EN; struttura per ulteriori lingue; date/numeri localizzati | Test i18n |
| **Piattaforme** | Windows 10+/11, macOS (versioni supportate da Wails), Linux (GTK/WebKitGTK) | Matrice di build di `release.yml` + verifiche locali per sistema prima del rilascio (ADR-0036) |
| **Osservabilità** | Log strutturati JSON, metriche RED, tracing distribuito, dashboard e alert | Runbook |
| **Manutenibilità** | Moduli con interfacce, copertura test ≥ 80% su `parser`, `merge`, `sync`, `sharing` | Misura locale prima del rilascio (nessun servizio di CI, ADR-0036) |

---

## Appendice B — Roadmap per milestone

| Milestone | Contenuto | Esito atteso |
|---|---|---|
| **M0 — Fondamenta** | Monorepo, CI, shell Wails + React, vault locale, parser/indexer base, schema DB, Keycloak realm, auth OIDC end-to-end (loopback con fallback custom scheme), URI scheme | "Hello vault" con login funzionante |
| **M1 — Core editing (P0)** | Editor CodeMirror (Source/Live Preview/Reading), wikilink/embed/callout, backlinks, tag, properties, outline, ricerca, quick switcher, command palette, workspace base | Parità funzionale P0 offline |
| **M2 — Sync (P0)** | Cloud Service: vault (privato E2EE / condiviso), key envelope e recovery key, changelog, blob, commit, merge Markdown sul client, notifiche; stato e risoluzione conflitti nel client | Multi-dispositivo affidabile |
| **M3 — Excalidraw + Canvas** | Integrazione Excalidraw completa (embed, export, link, indice), `.canvas`, merge per-id | Disegni nativi sincronizzati |
| **M4 — Condivisione e gruppi** | Share/grant/ACL, vault montati, gruppi, Config Profile e feature flag, Web UI utente | Collaborazione asincrona |
| **M5 — Console admin** | Web UI admin: utenti, sospensione, ruoli, quote, audit; export ZIP (server per i condivisi, browser per i privati) | Governance completa |
| **M6 — P1 residui** | Grafo, Bases, daily/unique notes, template, composer, bookmarks, workspaces, importer, history | Parità 1.0 |
| **M7 — Hardening** | Performance, pen test, audit esterno del design crittografico, accessibilità, installer firmati, aggiornamento automatico, documentazione | Release 1.0 |
| **Post-1.0 (P2)** | Slides, Audio recorder, Web viewer, Vim mode, CLI, finestre pop-out (processo secondario), rotazione VMK (re-key) dei vault privati | Roadmap successiva |

---

## Appendice C — Registro delle decisioni, rischi e punti aperti

### C.1 Registro delle decisioni

| ID | Tema | Decisione | Recepita in |
|---|---|---|---|
| D-01 | CSS snippets | Nessun CSS personalizzato (né locale né distribuito); la sanificazione HTML elimina anche `<style>` e `style` | §0.2, §2.2.2, §2.2.3 |
| D-02 | Cifratura end-to-end | Scelta alla creazione: vault **privato cifrato** (E2EE, non condivisibile) oppure vault **condiviso non cifrato**; tipo immutabile | §0.3, §2.1.1, §2.6, §3.2.2, §3.5, §3.8 |
| D-03 | Storico nella quota | Solo i file correnti | §2.6.3 |
| D-04 | Collaborazione | Asincrona; merge multi-utente garantito per i soli `.md` condivisi | §0.3, §2.6.4, §3.4.5 |
| D-05 | Gruppi | Gestiti esclusivamente dal Cloud Service | §0.2, §2.6.5, §3.3.1 |
| D-06 | Link tra vault | Nessuna funzionalità cross-vault | §2.1.2, §2.6.4 |
| D-07 | Versione Wails | v2 | §0.3, §2.2.1, §4.5 |
| D-08 | Redirect OIDC del desktop | Loopback come percorso primario, fallback su custom scheme | §1.3, §3.3.1 |

### C.2 Rischi tecnici

| Rischio | Impatto | Mitigazione |
|---|---|---|
| Parità di rendering Live Preview con Obsidian (complessità di CodeMirror decorations) | Alto | Rilascio incrementale per elemento; suite di conformità; budget dedicato in M1 |
| Divergenza parser Go ↔ TS | Medio | Fixture condivise, bloccanti in `task ci` eseguito in locale prima di merge e tag (§2.3.3, §4.5, ADR-0036) |
| Conflitti frequenti su note condivise | Medio | Merge a 3 vie, vista di risoluzione, sync rapido (debounce breve), notifiche push per ridurre la finestra di conflitto |
| Affidabilità del watcher (`fsnotify`, FSEvents) su volumi di rete / cartelle sincronizzate da altri tool; esaurimento di descrittori o watch su vault grandi | Medio | Riconciliazione periodica; avviso se il vault è in cartelle gestite da altri sync; FSEvents su macOS (nessun descrittore per file) e modalità degradata con riconciliazione ogni minuto ai limiti di sistema su Linux/Windows (§2.5, ADR-0044) |
| Dimensione bundle (Excalidraw, Mermaid, KaTeX) | Medio | Lazy loading, code-splitting, asset locali |
| Webview diversi per OS (WebView2/WKWebView/WebKitGTK) con differenze di comportamento | Medio | Matrice di test e2e per OS; polyfill/limiti documentati (es. Audio recorder) |
| Web viewer in iframe bloccato da `X-Frame-Options` | Basso | Funzione P2 con limitazioni dichiarate o webview nativa dedicata |
| Crescita del changelog | Basso | Compattazione con finestra (`CURSOR_EXPIRED` → bootstrap), avanzata anche dalla retention quando pota operazioni strutturali, così non si serve mai un changelog con dei salti (§3.4.4 B, ADR-0038) |
| Dipendenza da Keycloak Admin API (versioni) | Basso | Wrapper isolato in `internal/keycloak`, test d'integrazione con testcontainers |
| Perdita di passphrase e recovery key di un vault privato | Alto | Dati irrecuperabili per design: recovery key obbligatoria con conferma, testi espliciti nel wizard, promemoria periodico, nessuna promessa di recupero da parte dell'amministratore |
| Errori nell'implementazione crittografica o nel formato blob | Alto | Primitive standard (AES-GCM, HKDF, Argon2id), nessun algoritmo custom, test vector condivisi Go/TS, audit esterno prima della 1.0 |
| Web UI come anello debole dell'E2EE (JavaScript servito dal server), che con il workbench web (ADR-0029) vale anche per lettura e scrittura dei vault privati | Medio | Limite documentato (§3.8.1); CSP per pagina e SRI su ogni script della build, WASM compreso (§2.8.3, §3.7); VMK solo in memoria, blocco per inattività e cancellazione della copia in chiaro; flag `features.web_workbench` per disattivare il workbench; client desktop firmato come percorso ad alta fiducia |
| Prestazioni e dimensione del core WASM (Go sotto WASM circa 4,5× più lento del nativo; download di diversi MB) | Medio | Budget di dimensione bloccante nella build (§4.4), client gRPC escluso dal build `js`, indicizzazione in background, cache del browser per gli asset con hash (ADR-0030) |
| Divergenza tra client desktop e workbench web | Medio | Una sola UI (`@memobrain/workbench`) e un solo core (stesso codice Go, `App.Services()` come unico elenco dei binding), test dispatcher ↔ binding e `task test-wasm` in `task ci`, registro delle funzioni con `parity --check` (§1.7, §4.5) |
| Registrazione dello scheme `memobrain://` non riuscita (AppImage, installazioni portable, policy aziendali) | Medio | Loopback come percorso primario; diagnostica nel client; documentazione di installazione per Linux |
| Limiti di Wails v2 (finestra singola, API di piattaforma) | Basso | Pop-out rinviate (P2); test di single-instance lock e handler URL su ciascun OS |

### C.3 Tracciabilità vincoli → sezioni

| Requisito | Sezioni |
|---|---|
| Stack Wails/Go/React · Cloud Go REST/gRPC | §1, §2.5, §3.1, §3.6, §4 |
| Architettura chiusa, nessun plugin | §0.2, §2.2.3, §2.6.6 |
| Copertura funzionalità Obsidian | §2.2–§2.4, §2.9 |
| Excalidraw nativo | §2.7, §3.4.5, §4.2 |
| Sync multi-dispositivo e conflitti | §1.4, §3.4 |
| Condivisione cartelle/documenti | §2.6.4, §3.4.7, §3.5.4 |
| Gruppi e distribuzione config | §2.6.5, §2.6.6, §3.2.2, §3.5.5 |
| Keycloak, OIDC/JWT, RBAC e permessi | §1.3, §3.3 |
| Web UI Admin / Utente (quote, utenti, ZIP) | §2.8, §3.5.2, §3.5.5 |
| Workbench web e core in WebAssembly (ADR-0029, ADR-0030) | §0.3 (A-03), §1.7, §2.8.3, §3.7, §3.8.1, §3.8.6, §4.2, §4.4 |
| Tipologie di vault ed E2EE (D-02) | §2.1.1, §3.2.2, §3.8 |
| Perimetro per-vault (D-06) | §2.1.2, §2.6.4 |
| Redirect OIDC con fallback (D-08) | §1.3, §3.3.1 |
| Deliverable 1–4 | §1, §2, §3, §4 |

### C.4 ADR recepiti

Le deviazioni e le precisazioni rispetto allo spec si registrano come ADR in `docs/adr/`. Dalla v1.2 sono recepiti gli ADR accettati dall'owner elencati qui (0036–0044 nella v1.2; 0029, 0030 e 0032 nella v1.3); gli ADR 0001–0008 e 0025, già accettati, erano decisioni d'implementazione citate dove servono (es. ADR-0008 in §3.5.1). Restano in stato *proposta*, e quindi non recepiti, gli ADR 0009–0024, 0026–0028, 0031 e 0033–0035. Fa eccezione la parte di ADR-0034 sul formato e sulla migrazione degli envelope della VMK: con il flag `features.envelope_v2` acceso per default dall'owner, il comportamento implementato dei rilasci N e N+1 è registrato in §3.8.2 e §3.8.7 (v1.3), mentre l'ADR resta *proposta*.

| ADR | Tema | Decisione | Recepito in |
|---|---|---|---|
| ADR-0029 | Workbench web | Workbench del vault nella Web UI con la UI del client desktop (`@memobrain/workbench`) su `/vaults/:id/open` (anche `?share=` per i mount e `/vaults/new/open?kind=private` per creare un vault privato); browser come dispositivo `web`, online-first con copia in OPFS, un workbench per browser (Web Lock); vault privati: core come unico timer di blocco, cancellazione della copia in chiaro al blocco solo senza modifiche in attesa (overlay altrimenti), sweep all'avvio, unlock gate; identità del dispositivo in IndexedDB e stato `device_revoked`; CSP propria del workbench e SRI su ogni script; flag `features.web_workbench` (v1.3) | §0.1, §0.3 (A-03), §1.1, §1.2, §1.7, §2.1, §2.1.1, §2.5, §2.6.1, §2.6.6, §2.8, §2.8.3, §3.5.1, §3.7, §3.8.1, §3.8.2, §3.8.6, §4.1–§4.5, App. A, C.2, C.3 |
| ADR-0030 | Core WASM | Backend Go del client compilato per `js/wasm` (`cmd/memobrain-core`) in un Web Worker; dispatcher `internal/rpc` e `App.Services()` come unico elenco dei servizi; interfaccia `Host` (`host_wails.go`/`host_web.go`) e file `*_js.go`; sqlite-wasm con `opfs-sahpool` via `internal/sqlitejs`; shim `fs` su OPFS; solo SSE (gRPC escluso dal build `js`); budget core ≤ 8 MB gzip; `task test-wasm` in `task ci` (v1.3) | §1.1, §1.2, §1.7, §2.5, §3.6, §4.1, §4.2, §4.4, App. A, C.2 |
| ADR-0032 | Task runner | Task (`Taskfile.yml`, pinnato in `tools/go.mod`) al posto di make; stessi nomi dei target (v1.3) | §4.1, §4.5 |
| ADR-0036 | Verifiche | Nessun servizio di CI: `task ci` in locale è il cancello obbligatorio prima di merge e tag; suite lente prima dei rilasci | §2.3.3, §2.7.3, §3.7, §3.8.7, §4.1, §4.3, §4.5, App. A, C.2 |
| ADR-0037 | Parità e contratti | Registro delle funzioni `shared/parity/features.yaml` con `parity --check`; UI di gestione dei vault cloud in `@memobrain/cloud-features` (`CloudPort`, `RestCloudPort`, `CoreCloudPort`); client Go generato da OpenAPI e contract test; ciclo di vita dei vault su tutte le superfici (`GET /vaults?include_deleted=true`); feature flag generati dallo schema unico del Config Profile | §2.5, §2.6.1, §2.6.6, §2.8.2, §3.1, §3.5.2, §4.1, §4.2, §4.4, §4.5 |
| ADR-0038 | Retention e changelog | `conflict_of` `ON DELETE SET NULL` con `conflict_of_file`; compattazione del changelog avanzata dalla retention (finestra effettiva); paginazione keyset; indici; riconciliazione dei contatori sotto lock | §2.6.2, §2.6.3, §3.2.2, §3.4.4, C.2 |
| ADR-0039 | Stato locale di sync | `pending_remote` e `quarantine` in `sync.db`; pull interrotto prima del cursore a vault bloccato; transazioni; copia di conflitto prima dell'originale | §3.4.3, §3.4.4, §3.4.5 |
| ADR-0040 | Rename di cartelle condivise | `move_prefix` e `SHARE_ROOT_MOVE` restano il rename atomico (anche solo maiuscole/minuscole); comportamento del client e regole del server sulle radici condivise | §2.6.4, §3.4.7, §3.5.3, §3.8.5 |
| ADR-0041 | Control plane | Ruolo autorevole dopo un cambio dalla console (`role_changed_at`), conflitto di identità senza ricollegamento per e-mail, provisioning in lettura, ultimo amministratore sotto lock, eliminazione unificata con riattribuzione dei grant concessi (modifica ADR-0021), rubrica con e-mail esatta, `/me.config_version`, `POST /shares` da manager dentro l'ambito, ruolo `manager` dei gruppi riservato in v1, hub delle notifiche | §1.3, §2.6.4, §2.6.5, §2.8.1, §3.1, §3.2.2, §3.3.2, §3.5.1, §3.5.4, §3.5.5, §3.6, §3.7 |
| ADR-0042 | E2EE dei path | Token di path `enc2` legati al file (AAD con `file_id`), `enc1` accettato in lettura, server che accetta entrambi i prefissi, migrazione in due rilasci con `features.path_v2` e pinning; rilascio N+1 (flag acceso per default) in vigore dalla v1.3 | §2.6.6, §3.2.2, §3.4.3, §3.8.3, §3.8.5, §3.8.7 |
| ADR-0043 | UI condivisa | `@memobrain/ui` come pacchetto di primitive senza stile globale per console, `@memobrain/cloud-features` e workbench: focus dei modali, menu da tastiera, `Dialog`, token di stile, namespace i18n `common` | §4.1, §4.2, §4.4 |
| ADR-0044 | Watcher | FSEvents su macOS via `purego` con ripiego su `fsnotify`; modalità degradata ai limiti di sistema su Linux/Windows; nessuna riconciliazione periodica nel browser | §1.4, §2.4, §2.5, §3.4.4, §4.2, C.2 |
