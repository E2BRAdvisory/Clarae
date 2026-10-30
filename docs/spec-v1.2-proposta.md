# Proposta di aggiornamento di `Specifications.md` alla v1.2

|                 |                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**       | proposta all'owner (lo spec non è stato modificato)                                                                                                     |
| **Data**        | 2026-10-30                                                                                                                                              |
| **Base**        | `Specifications.md` v1.1 (23/10/2026)                                                                                                                   |
| **Fonti**       | ADR 0009–0035 in stato _proposta_ (più 0025 e 0031), lavoro dei passi 1–5 dell'analisi dei gap del 2026-10-30                                           |
| **Come usarla** | ogni voce indica la sezione, cosa dice oggi lo spec, la modifica proposta e l'ADR di origine. Le decisioni che spettano all'owner sono raccolte nel §1. |

Lo spec v1.1 descrive il prodotto di M0–M5. Da allora sono arrivati 24 ADR in stato _proposta_ (M2–M10) e le correzioni dell'analisi dei gap, e il codice ne ha implementata la gran parte. Questa proposta raccoglie tutto in un solo posto, così la v1.2 torna a descrivere il prodotto reale. Le voci marcate **[nuovo]** vengono dai passi 1–5 dell'analisi del 2026-10-30 e non hanno un ADR dedicato: sono descritte nei rispettivi commit e test.

---

## 1. Decisioni che spettano all'owner

Prima di recepire le modifiche servono queste scelte. Senza una scelta esplicita vale la colonna «Proposta».

| #   | Decisione                                                                                                                     | Proposta                                                                                                   | ADR       |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------- |
| 1   | A-03: la Web UI diventa anche un editor (workbench del vault)                                                                 | Accettare, con le eccezioni di parità di ADR-0029 e il rischio E2EE dichiarato                             | 0029/0030 |
| 2   | Slides passa da P2 a P1 (già realizzata)                                                                                      | Accettare                                                                                                  | 0027      |
| 3   | Random note passa da P2 a P1 (già realizzata)                                                                                 | Accettare                                                                                                  | 0015      |
| 4   | Status bar: eliminata (ADR-0026) o barra compatta opzionale                                                                   | Barra opzionale spenta per default (ADR-0035); il word count resta nel pannello Statistiche                | 0026/0035 |
| 5   | Envelope della VMK con AAD (formato v2), prima o dopo l'audit esterno                                                         | Prima dell'audit, in due rilasci (lettura v2, poi scrittura v2)                                            | 0034      |
| 6   | Rilasci desktop non firmati finché mancano i certificati                                                                      | Ammessi come prerelease con avviso e senza auto-update; lo stabile richiede la firma                       | 0031      |
| 7   | Eccezioni alla regola «mai alle tabelle altrui»                                                                               | Accettare le eccezioni elencate (admin, privacy, jobs, notify, …) e ridurre in seguito quelle di scrittura | 0033      |
| 8   | Limite di dimensione dei file: Config Profile (`sync.max_file_size_bytes`) e impostazione di sistema (`files.max_size_bytes`) | Il default del profilo deriva dall'impostazione di sistema (oggi è fisso a 100 MB): da implementare        | [nuovo]   |
| 9   | Timeout di blocco dei vault privati: default                                                                                  | 0 = mai (la VMK resta nel keychain, come in §3.8.2); configurabile da utente e da profilo                  | [nuovo]   |
| 10  | Nome «Nodus» nell'intestazione dello spec                                                                                     | Rimuoverlo (rebrand completato, `docs/release/rebrand-inventory.md`)                                       | —         |

---

## 2. Intestazione e registro

- **Intestazione:** «Versione documento: 1.2 — ADR 0009–0035 recepiti (vedi Appendice C)», nuova data. Nome del prodotto senza «(già "Nodus" come nome in codice)».
- **Appendice C.1, nuove decisioni** (proposta di numerazione):

| ID   | Tema                    | Decisione                                                                                           | Sezioni                |
| ---- | ----------------------- | --------------------------------------------------------------------------------------------------- | ---------------------- |
| D-09 | Workbench web           | La Web UI include un workbench del vault con il core del desktop in WebAssembly (ADR-0029/0030)     | §0.1, §0.3, §2.8, §4.4 |
| D-10 | Shell desktop           | Header, ribbon, sidebar destra con footer di stato; barra di stato opzionale (ADR-0026/0035)        | §2.2.1, §4.2           |
| D-11 | Proprietà delle tabelle | Un pacchetto sqlc per modulo, eccezioni dichiarate e verificate (ADR-0033)                          | §1.1, §4.3             |
| D-12 | Excalidraw              | Fork `@zsviczian/excalidraw`, funzioni dei plugin Obsidian, nessun motore di script (ADR-0024/0028) | §2.7                   |

- **Appendice C.2, rischi:**
  - la riga «Web UI anello debole dell'E2EE» va estesa alla scrittura dei vault privati dal workbench, con le mitigazioni di ADR-0029 (CSP dedicata, SRI, blocco per inattività, cancellazione della copia OPFS, flag `web_workbench`);
  - nuova riga «Rilasci non firmati» (ADR-0031).

---

## 3. Modifiche per sezione

### §0 Introduzione

- **§0.1 punto 3 e §0.3 A-03** (D-09, ADR-0029). Oggi: «La Web UI del cloud non è un editor». Proposta, dal testo di ADR-0029: «La Web UI del cloud comprende console amministrativa, area utente e un workbench del vault con le stesse funzioni del client desktop, salvo le eccezioni di ADR-0029 (updater, vault su cartella locale, integrazioni native del sistema operativo). Il workbench web è un dispositivo di sync come gli altri: online-first, con cache locale nel browser.» Correzioni rispetto alla decisione originale:
  - il blocco per inattività del workbench è fisso a 15 minuti;
  - c'è un solo workbench per browser (Web Lock `memobrain-workbench`).

### §1 Architettura e flussi

- **§1.1 / §1.2** (ADR-0030):
  - il core Go del desktop gira anche come `memobrain-core.wasm` (`GOOS=js`) in un Web Worker;
  - interfaccia `Host`, dispatcher `internal/rpc`, `App.Services()` come elenco unico dei servizi;
  - «nessun accesso incrociato alle tabelle» rinvia alle eccezioni di §4.3 (ADR-0033).
- **§1.3 Redirect (D-08)** [nuovo]:
  - **regola (b):** Keycloak non fa redirect su un `redirect_uri` non registrato, mostra una pagina d'errore. In modalità `auto` il client fa quindi un controllo preliminare dell'endpoint di autorizzazione, senza seguire i redirect. Una risposta 400 che cita `redirect_uri` fa passare allo scheme `memobrain://` prima di aprire il browser (verificato su Keycloak 26).
  - **regola (c):** il valore del Config Profile è `auth.redirect_mode = auto|loopback|custom_scheme`. La variabile `MEMOBRAIN_AUTH_REDIRECT` ha la precedenza (uso di test).
- **§1.6 Topologia** (ADR-0022, [nuovo]):
  - allo shutdown `/readyz` risponde 503, poi drain di `SHUTDOWN_DRAIN` (default 5 s), chiusura degli stream e `Shutdown`; `terminationGracePeriodSeconds` > drain + `SHUTDOWN_TIMEOUT`; almeno 2 repliche;
  - dietro un reverse proxy va impostato `TRUSTED_PROXIES` (CIDR), altrimenti il limite di richieste per IP vede solo l'IP del proxy.

### §2.2.1 Matrice di parità

| Riga                         | Oggi                                | Proposta                                                                                                                                                                                                                                                  | ADR           |
| ---------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Word count (`statusbar`, P0) | «Parole, caratteri, selezione»      | Pannello _Statistiche_ (parole, caratteri, selezione, riga:colonna); barra di stato compatta opzionale, spenta per default                                                                                                                                | 0026, 0035    |
| Pannelli, tab, split         | —                                   | Header, ribbon (nuova cartella, nota, lavagna, disegno, base, export PDF/immagine), tab bloccabili (`pinned` in `workspace.json`) con «Chiudi a destra/sinistra/altre/tutte», selettore vault nel footer sinistro, avatar/login                           | 0026          |
| Appearance                   | —                                   | Toggle chiaro/scuro nell'header; `system` resta nelle impostazioni                                                                                                                                                                                        | 0026          |
| Slides (`slides`)            | P2, «Separatore `---`»              | **P1**; `---` preceduto da riga vuota, fuori da frontmatter, codice e `$$`; note del presentatore dopo `Note:`; chiavi `slide-transition`, `slide-theme`, `slide-progress`, `slide-numbers`, `slide-notes`; comandi `slides:start`, `slides:start-here`   | 0027          |
| Random note                  | P2                                  | **P1** (realizzata)                                                                                                                                                                                                                                       | 0015          |
| Graph view                   | «Canvas/WebGL»                      | Canvas 2D con `d3-force` in un Web Worker (WebGL come riserva); `maxNodes` 20.000 (oltre: `truncated`); timelapse su `created` del frontmatter, altrimenti `mtime`; impostazioni in `.memobrain/graph.json`                                               | 0013          |
| Bases                        | «File `.base` (YAML)»               | Viste `table`/`cards`; motore unico Go (`BasesAPI`); degrado non distruttivo; round-trip `yaml.v3` che preserva chiavi sconosciute e commenti; scrittura solo su azione esplicita con `expectedHash`                                                      | 0014          |
| Canvas                       | «nodi testo/nota/media/link/gruppo» | Testo modificabile in `<textarea>`, Markdown reso a riposo; `![[x.canvas]]` come SVG statico; doppio clic apre l'editor; salvataggio con debounce di 1 s                                                                                                  | 0010          |
| Templates / Daily notes      | `{{date}}`, `{{time}}`, `{{title}}` | Più `{{date:FMT}}`/`{{time:FMT}}` (sottoinsieme Moment), variabili sconosciute lasciate letterali, `/` nel formato crea sottocartelle; libreria di gruppo da `templates.library_share_id`; impostazione «Template di ogni nuova nota» (`newNoteTemplate`) | 0015          |
| Note composer                | —                                   | Unione in tre passi (destinazione, link, cestino) con rollback; il frontmatter della sorgente non viene unito                                                                                                                                             | 0015          |
| Bookmarks / Page preview     | —                                   | Bookmark in `.memobrain/bookmarks.json`; anteprima con Cmd/Ctrl + hover per 350 ms (`pagePreview`, `pagePreviewAlways`), nessuna anteprima annidata                                                                                                       | 0016          |
| File recovery                | —                                   | Snapshot locali guidati dal watcher (5 min), solo testo ≤ 5 MB, tetto 500 MB, retention 7 giorni; motivi `periodic`, `pre-restore`, `pre-sync-overwrite` (prima che un merge sostituisca contenuto non ancora sul server); dialogo unico locale + cloud   | 0018, [nuovo] |
| Embedded search              | —                                   | Blocco `query` con `sort:`, `limit:` (max 500), `view:`, `context:`, `self:`; nota ospitante esclusa (`queryIncludeHost`)                                                                                                                                 | 0019          |
| Importer (P1)                | elenco sorgenti                     | Destinazione `Imports/<sorgente>-<data>/` con `Import report.md`; mai sovrascrittura; anteprima identica all'import; tetti per gli zip; HTML convertito in Markdown puro; Google Keep da JSON **e da HTML** (quando manca il JSON)                        | 0017          |
| Drawing                      | —                                   | Flag `drawings` con sotto-flag `drawing_latex`, `drawing_mermaid`, `drawing_auto_export`, `drawing_actions` (accesi per default)                                                                                                                          | 0024          |

### §2.2.2 Obsidian Flavored Markdown

- **Footnote `^[inline]`** [nuovo]:
  - indicizzate dai due parser (Go e TS) come `^1`, `^2`, … in ordine di documento, accanto alle etichette `[^x]`; codice inline, escape `\^[` e parentesi non chiuse non contano;
  - rese nel reading view e nell'export HTML, numerate insieme alle footnote con etichetta;
  - fixture `footnote-inline-edge` in `shared/conformance/markdown/`.
  - Limite: in Live Preview restano testo.

### §2.3 Editor e rendering

- **§2.3.2 Export** (ADR-0019):
  - HTML con `ExportAPI.SaveHTML`, autonomo (data URI con tetti 8/48 MB, MathML, CSP `default-src 'none'`), wikilink come testo;
  - PDF solo dal dialogo di stampa di sistema (Wails v2 non stampa in PDF senza dialogo).
- **§2.3.3** (ADR-0027): fixture condivise anche per le slide (`shared/conformance/slides/`), con estrattore in `packages/markdown` e in `internal/parser`.

### §2.4 Indicizzazione e ricerca

- **Rilevanza** [nuovo]:
  - BM25 sui termini di testo della query, con frequenze dall'indice FTS e lunghezza in parole, più un peso per il termine presente nel titolo;
  - le query senza testo (`tag:`, `path:`, regex) ordinano per numero di corrispondenze.
- **Snippet evidenziati** [nuovo]: ogni risultato porta gli intervalli corrispondenti (UTF-16); lo snippet è centrato sulla prima corrispondenza nelle righe lunghe; i termini negati non sono evidenziati.
- **Prestazioni** (ADR-0020):
  - cache in RAM dei candidati con budget di 512 MB (circa 210 MB a 50.000 note), oltre il quale la ricerca passa allo streaming da SQLite;
  - indicizzazione a batch (250 note o 16 MB per transazione).
  - Limite dichiarato: regex su tutto il vault di 50.000 note circa 0,45 s, oltre i 200 ms.
- **Punto 4** (ADR-0010/0024): etichette «Disegno: X» / «Lavagna: X»; anche i nomi dei frame dei disegni sono indicizzati.

### §2.5 Moduli del client

- **`updater`** (ADR-0023):
  - manifest `manifest.json` (schema 1) con firma ed25519 separata, chiave distinta dai certificati di code signing, firma verificata prima del parse;
  - anti-rollback con `sequence` e `min_version`; canali `stable/` e `beta/`;
  - controllo dopo 45 s dall'avvio e ogni 24 h; opt-out con `MEMOBRAIN_UPDATES=off`;
  - due sole GET senza identificativi.
- **`store`** (ADR-0030): driver scelto per build tag; nel browser `internal/sqlitejs` su sqlite-wasm `opfs-sahpool`, file system tramite lo shim `fs` su OPFS.
- **`auth`** (ADR-0030): modalità `Hosted` nel browser (token dalla pagina, nessun keychain).
- **`sync`** [nuovo]:
  - un file oltre il limite viene messo da parte con `FILE_TOO_LARGE` prima di essere letto o cifrato;
  - un blob rifiutato dal server come troppo grande ferma solo quel file, non l'intero push.
- **`crypto`** [nuovo]: blocco per inattività attivo (controllo ogni 30 s), vedi §3.8.2.

### §2.6 Servizio cloud

- **§2.6.2 / §2.6.5, privacy** (ADR-0021):
  - la cancellazione dell'account anonimizza subito la riga `users` e fa il soft-delete dei vault;
  - dopo `privacy.account_purge_days` (default 30) il job li elimina definitivamente;
  - l'account Keycloak viene disabilitato, non eliminato (limite dichiarato).
- **§2.6.4 Condivisione** (ADR-0011):
  - ogni share, anche di un documento, è un mount a sé in `<data>/mounts/<share_id>/`; alla revoca l'utente sceglie se eliminare la copia o conservarla in `<data>/kept/`;
  - un grant a un gruppo è accettato da qualsiasi membro per tutto il gruppo; il rifiuto vale solo per i grant a utente (altrimenti `409 INVALID_STATE`).
  - Limiti: nessuna cessione di proprietà; un `manager` non crea né revoca share.
- **§2.6.6 Config Profile** (ADR-0011, [nuovo]):
  - `version` è una revisione globale (`settings['config.revision']`);
  - le chiavi `locked` sono unite tra profilo globale e gruppi;
  - contratto in `api/config-profile.schema.json`;
  - chiavi applicate dal client: `sync.interval_seconds`, `sync.max_file_size_bytes`, `auth.redirect_mode`, `security.vault_lock_minutes` (nuova sezione `security`), `editor.*`, `appearance.*` (più `appearance.statusBar` se si accetta ADR-0035), `daily_notes.*`, `templates.library_share_id`, `features.*` (`web_workbench`, `chat`, `drawings` e sotto-flag; `envelope_v2` con ADR-0034);
  - un flag assente vale «spento», salvo i default di prodotto.

### §2.7 Excalidraw

- **§2.7.1** (ADR-0024):
  - embed di parti con `#frame=`, `#clippedframe=`, `#group=`, `#area=` e allineamento `|left|right|center|left-wrap|right-wrap`;
  - metadati in `customData.memobrain`, impostazioni per vault in `.memobrain/drawing.json`, nessun `.excalidraw.md`;
  - soglia di 10 MB anche per singolo file inserito.
- **§2.7.2** (ADR-0010/0024):
  - export PNG/SVG/PDF/JSON salvato nel vault, auto-export `X.excalidraw[.light|.dark].png|svg`;
  - formule LaTeX (`mathjax-full` 3.2.2, lazy), Mermaid→Excalidraw (`securityLevel: 'strict'`), operazioni booleane, schede-nota, presentazione per frame;
  - azioni native `drawing:<id>`, senza motore di script;
  - import di `.excalidraw.md` e `.excalidrawlib`;
  - il rename riscrive i `[[link]]` dentro i `.excalidraw` (non nei canvas).
- **§2.7.3** (ADR-0028/0033):
  - dipendenza `npm:@zsviczian/excalidraw@0.18.145` (fork MIT del plugin Obsidian: lazo, secchiello, disegno per forma), caricata come script della stessa origine;
  - la versione 0.18.1 di ADR-0010 è superata;
  - gate offline in CI con `web/e2e-security/excalidraw-offline.spec.ts`: disegno con testo CJK, nessuna richiesta esterna;
  - il fallback `esm.sh` dei font è riscritto dalla build verso gli asset dell'app.
  - Limiti: script di 6,5 MB fuori dal budget del bundle; due copie di Mermaid.

### §2.8 Web UI

- **§2.8.2** (ADR-0029): schermata «Apri vault» (`/vaults/:id/open`); dispositivo `platform: "web"`; copia del vault in OPFS; flag `web_workbench`, acceso per default.
  - Limiti: nessuna PWA offline; Safari e Firefox non verificati.

### §2.9 Conflitti

- **«Nessuna perdita silenziosa»** [nuovo]: prima che un merge sostituisca contenuto locale non ancora sul server, il client ne prende uno snapshot nella history locale (`pre-sync-overwrite`).

### §3.1 Convenzioni generali

- **Codici d'errore** (ADR-0009/0011/0021): aggiungere `NAME_IN_USE` (409) e `INVALID_STATE` (409).
- **Limiti di richiesta** [nuovo]:
  - timeout di 60 s solo per le operazioni JSON; nessun timeout per SSE, tus, blob ed export;
  - corpo JSON al massimo 8 MiB (oltre: `413 FILE_TOO_LARGE`);
  - limite di richieste per IP calcolato sull'IP del client, dietro i proxy di `TRUSTED_PROXIES`; i probe di salute sono esenti.
- **Contratto:** tus e `GET /events` sono fuori da OpenAPI (handler dedicati, ADR-0009).

### §3.2.2 Schema del database

- **Aggiunte** (ADR-0009/0012/0021):
  - `file_revisions.op_id` con `UNIQUE (vault_id, op_id)`;
  - tabelle `vault_blobs`, `uploads`, `config_profile_versions`, `storage_snapshots`;
  - indici su `audit_log(actor_id, at)` e `(action, at)`;
  - `users.deleted_at`, `users.purged_at` (migrazione 0006).
- **Modifica:** `vaults` ha un indice univoco parziale sul nome, solo per i vault attivi (`deleted_at IS NULL`).
- **Chiavi di `settings`:** `privacy.account_purge_days` e la revisione della configurazione.

### §3.3 Autorizzazione

- **§3.3.2** (ADR-0011): `404` per uno share inesistente, revocato, scaduto o estraneo; `403 FORBIDDEN` per un livello insufficiente su una risorsa visibile.

### §3.4 Sincronizzazione

- **§3.4.2 Esclusi dal sync** (ADR-0022): aggiungere `.memobrain-tmp-*` (file temporanei di scrittura atomica, rimossi dopo più di 1 minuto).
- **§3.4.2 Dimensione massima** [nuovo]: il client controlla il limite (`sync.max_file_size_bytes`, default 100 MB) prima di leggere e cifrare. Vedi la decisione 8 del §1 sull'allineamento con `files.max_size_bytes`.
- **§3.4.3 `sync.db`** (ADR-0009): un `sync.db` per vault, quindi senza `vault_id`; `base_rev`, distinta da `server_rev`, come antenato del merge a tre vie; `outbox` per path; `conflicts` con `copy_path`, `strategy`, `detail`.
- **§3.4.4**:
  - **B** (ADR-0022): `410 CURSOR_EXPIRED` anche con un cursore oltre `last_seq` (dopo un PITR); nel bootstrap i file persi dal server vanno nel `.trash/` locale.
  - **C.3** (ADR-0009): l'esito resta per operazione; l'implementazione usa una transazione per batch, con fallback a una per operazione.
- **§3.4.6 Impostazioni sincronizzate** (ADR-0015/0016/0018/0024): aggiungere `bookmarks.json`, `daily.json`, `history.json`, `drawing.json`. Per `graph.json` serve una decisione: ADR-0013 non la prende.
- **§3.4.7 Scope** (ADR-0011):
  - `scope=share:{id}` vale per `tree`, `commit`, `blobs:check`, blob, tus e revisioni;
  - un'operazione fuori dallo share risponde `NOT_FOUND`;
  - uno share di documento ammette solo `modify` e `delete`.

### §3.5 API REST

- **§3.5.1**:
  - `GET /client-config` + `web_client_id` (ADR-0011);
  - `GET /me/export`, `DELETE /me` con `{confirm, acknowledge_data_loss?}` (ADR-0021).
- **§3.5.2 Export** (ADR-0012):
  - `GET /exports/{id}` diventa `GET /vaults/{vid}/exports/{eid}`, più `GET /vaults/{vid}/exports/{eid}/download`;
  - streaming oltre 512 MB → `409 INVALID_STATE`;
  - `download_url` presigned solo con `S3_PUBLIC_ENDPOINT`.
- **§3.5.3** (ADR-0009): `path_key` (`hmac1:`) in `CommitOp` per i vault privati; `GET /events?known=<vault:seq,...>` con eventi raggruppati per vault.
- **§3.5.5 Admin** (ADR-0012/0021):
  - nuove rotte: `/admin/users/{id}/devices`, `/admin/users/{id}/sessions`, `/admin/storage/bulk-quota` (max 500), `/admin/config-profiles/{id}/versions`, `…/versions/{v}:restore`, `/admin/audit-log.csv` (≤ 50.000 righe);
  - `409 INVALID_STATE` per auto-sospensione e per l'ultimo admin attivo;
  - `quota_bytes` assente o `null` vale il default.

### §3.6 gRPC

- **`AccountChanged`** (ADR-0012): `kind` può valere `suspended`, `activated` o `quota_changed`.
- **Canali NOTIFY:** `share_changed`, `config_changed`, `account_changed`.

### §3.7 Sicurezza

- **CSP Web UI** (ADR-0012/0029):
  - `'wasm-unsafe-eval'` per Argon2id e per il core; `unsafe-inline` e `unsafe-eval` restano vietati;
  - CSP dedicata al workbench (`blob:`, worker).
- **Supply chain** (ADR-0021):
  - workflow `security.yml`: govulncheck bloccante, `yarn npm audit` bloccante sulle severità alte, SBOM syft, gitleaks (da rendere bloccante), CSP/SRI, test vector;
  - esecuzione su PR, su `main` e ogni lunedì.

### §3.8 E2EE

- **§3.8.2, riga «Envelope»** (ADR-0034): `0x02 ‖ nonce ‖ AES-256-GCM(KEK, VMK; AAD = "memobrain/v2/envelope" ‖ vault_id ‖ kind) ‖ tag`; il v1 (60 byte, senza AAD) resta accettato in lettura; pinning per vault dopo il primo v2.
- **§3.8.2, riga «Cache locale»** [nuovo]:
  - timeout di blocco per inattività da impostazione per dispositivo e da Config Profile (`security.vault_lock_minutes`, 0–1440, default 0 = mai);
  - precedenza: chiave bloccata dall'admin > scelta dell'utente > default dell'admin;
  - «inattività» = nessun uso della chiave, sync compresa.
- **§3.8.7** (ADR-0034): nuovi vettori positivi e negativi per l'envelope v2.

### §4 Struttura del progetto

- **§4.1** (ADR-0032): `Makefile` diventa `Taskfile.yml` (Task v3, pinnato in `tools/go.mod`), e `make <target>` diventa `task <target>`.
- **§4.2** (ADR-0025/0026/0029/0035):
  - `vite.config.ts` diventa `scripts/esbuild.mjs` + `vitest.config.ts`;
  - il frontend vive in `packages/workbench` (condiviso con il web);
  - `sidebar/` contiene a sinistra File e Struttura; a destra Proprietà, Tag, Link, ShowSlide e Statistiche;
  - nuova cartella `src/shell/`, con `statusbar` se si accetta ADR-0035.
- **§4.3** (ADR-0033):
  - `db/queries/<modulo>.sql` genera `internal/<modulo>/<modulo>db`; wrapper in `internal/<modulo>/exported.go`;
  - nuovi moduli `settings` e `access`;
  - mappa di proprietà ed eccezioni in `internal/db/ownership_test.go`;
  - `depguard` al posto di `go-arch-lint`.
- **§4.4** (ADR-0025/0029): `web/scripts/esbuild.mjs` (SRI sha384); `src/workbench/` (bridge, worker, `opfs-fs.ts`).
- **§4.5** (ADR-0031/0032):
  - `task gen`;
  - CI: `ci.yml` senza build; build e pubblicazione solo dal tag (`release.yml`); e2e, integrazione e `test-wasm` lanciati a mano;
  - **Release:** testo di ADR-0031 sui rilasci non firmati.

### Appendice A — Requisiti non funzionali

- **Prestazioni** (ADR-0020):
  - verifica con dataset deterministici, `task perf` e baseline in `docs/perf/`, eseguita a mano (il nightly è stato rimosso);
  - budget del bundle: console ≤ 700/1000 kB, workbench ≤ 2500/23000 kB, WASM gzip con core ≤ 8 MB e sqlite ≤ 1,5 MB.
- **Grafo** (ADR-0013): «10.000 nodi a ≥ 30 fps» con Canvas 2D; WebGL come riserva.
- **Disponibilità** (ADR-0022): il chaos test verifica il 99,9 % solo nella finestra di prova; la prova di ripristino è `restore-drill.sh`. RTO reale non misurato.
- **Piattaforme** (ADR-0031): Windows amd64/arm64, Linux amd64/arm64, macOS universale.

### Appendice B — Roadmap

Da «Post-1.0» si tolgono Slides e Random note. Si aggiunge la riga M8–M10 (shell, workbench web, pipeline di rilascio).

---

## 4. Incoerenze da correggere negli ADR (non nello spec)

- **ADR-0010:** la versione `@excalidraw/excalidraw@0.18.1` è superata da ADR-0028 (fork 0.18.145). Va aggiunto un rinvio.
- **ADR-0024:** la sezione «Conseguenze» cita il sotto-flag `drawing_scripts`, mentre il codice e lo schema usano `drawing_actions` (decisione 26).
- **ADR-0026:** chiama la stessa tab sia «Segnalibri» sia «Link»; nel codice è _Link_.
- **ADR-0013:** non dice se `.memobrain/graph.json` è sincronizzato (§3.4.6).

## 5. Limiti da dichiarare nello spec (sintesi)

Ogni ADR elenca i propri; nello spec vanno almeno questi.

- **Ricerca e indice:**
  - regex su 50.000 note oltre i 200 ms;
  - `index.db` ≈ 5,3 volte il testo.
- **Collegamenti e sync:**
  - il rename non aggiorna i link dentro i canvas;
  - nessuna cessione di proprietà dei vault;
  - un file messo da parte per dimensione riprova solo quando cambia.
- **Cloud:**
  - account Keycloak disabilitato, non eliminato, con la cancellazione GDPR;
  - nessuna retention automatica di `audit_log`;
  - outage del database come `500 INTERNAL` (manca `UNAVAILABLE`).
- **Workbench web:**
  - Safari e Firefox non verificati;
  - nessuna PWA offline;
  - core WASM circa 4,5 volte più lento del nativo.
- **Editor e import:**
  - footnote inline non rese in Live Preview;
  - Keep HTML senza data di creazione;
  - Apple Notes P2.
- **Rilascio:** installer non firmati finché mancano i certificati.

## 6. Dopo il recepimento

Gli ADR recepiti passano a **accettata** nell'indice `docs/adr/README.md`: 0009–0024, 0026–0030 e 0032–0035, più la nota di 0031. La checklist di rilascio (`docs/release/v1.0.0-checklist.md` §1) segna come fatto «Recepire nello spec le deviazioni proposte negli ADR». Il `CLAUDE.md` rimanda alla v1.2.
