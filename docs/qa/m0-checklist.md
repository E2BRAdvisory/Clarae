# Checklist manuale M0 — "Hello vault" con login

Da eseguire su macOS (sviluppo) e, prima di chiudere M0, almeno una volta su Windows e Linux con gli artefatti della CI. Spuntare con data e OS.

## Stack e cloud

- [ ] `make stack-up` porta a healthy PostgreSQL (5433), RustFS (9000/9001), Keycloak (8080); `make stack-reset` re-importa il realm.
- [ ] `make dev-cloud`: log "database migrated", "oidc issuer ready", "http listening" su 18081, "grpc listening" su 18082.
- [ ] `curl localhost:18081/api/v1/healthz` → 200; `/readyz` → `database: ok`; `/me` senza token → 401 problem+json con `request_id`.
- [ ] `make test-integration` verde (testcontainers).

## Desktop

- [ ] `make dev-desktop` apre la finestra "MemoBrain Notes" con la schermata di benvenuto nella lingua di sistema (it/en).
- [ ] "Apri cartella come vault" → picker nativo → l'albero mostra file e cartelle; `.DS_Store`, `.memobrain/cache` non compaiono.
- [ ] Nuova nota → appare nell'albero e si apre nell'editor; digitare → "Salvato" entro ~1 s; il file su disco contiene il testo; nessun file `.memobrain-tmp-*` residuo.
- [ ] Modificare la nota aperta con un editor esterno → banner di conflitto; "Ricarica" mostra il contenuto esterno; "Sovrascrivi" lo sostituisce.
- [ ] Creare/rinominare/eliminare file dall'esterno → l'albero si aggiorna entro ~2 s (watcher).
- [ ] Ricerca: 3+ caratteri trovano sottostringhe nel corpo e nel titolo, con snippet evidenziato; < 3 caratteri nessun risultato.
- [ ] Impostazioni: cambio lingua e tema applicati subito e persistenti al riavvio; "Informazioni" mostra versione e cartella dati.
- [ ] Riavvio: il vault compare tra i recenti e si riapre.
- [ ] Seconda istanza (`memobrain --data-dir <altra>`) coesiste; seconda istanza con la **stessa** data dir porta in primo piano la prima.
- [ ] URL scheme: `open "memobrain://open?vault=X&file=Y"` (macOS) con app aperta → evento `app:open-request` nel log; con app chiusa → l'app parte (richiede build installata in /Applications per la registrazione dello scheme).
- [ ] Build di produzione (`make build-desktop`): l'app si avvia, nessun errore CSP nella console del webview (Safari → Sviluppo → MemoBrain Notes).

## Login (M0-WP6)

- [ ] "Accedi al cloud" apre il browser di sistema su Keycloak; login `user1` / `memobrain-dev-password` → ritorno all'app, profilo visibile; refresh token nel keychain (Accesso Portachiavi: voce "MemoBrain Notes").
- [ ] Con listener loopback bloccato (es. `MEMOBRAIN_AUTH_REDIRECT=scheme`) il login usa `memobrain://auth/callback`.
- [ ] Sospendere l'utente da Keycloak → entro 30 s le chiamate falliscono con `USER_SUSPENDED`; il lavoro locale continua.
