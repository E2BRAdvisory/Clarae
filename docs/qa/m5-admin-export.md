# Checklist manuale — console admin ed export (M5)

Da eseguire contro `yarn dev:cloud:k3d` (o `make stack-up` + `make dev-cloud`) con l'utente `admin` del realm di sviluppo (password `memobrain-dev-password`) e un secondo utente. Gli automatismi (`go test -tags integration`, test live Keycloak, vitest, Playwright) coprono API e flussi sul mock; qui si verifica ciò che solo l'ambiente reale mostra.

Segnare `[x]` con data e sistema operativo.

## Utenti e Keycloak

- [ ] Web UI → Amministrazione → Utenti → "Nuovo utente" (senza password): l'utente compare in Keycloak (console `http://localhost:8080`, realm `memobrain`) con azioni richieste "Update Password" e "Verify Email".
- [ ] Con password temporanea: al primo login Keycloak chiede di cambiarla; dopo il login la riga dell'utente è la stessa creata dall'admin (nessun duplicato).
- [ ] "Sospendi": l'account Keycloak risulta disabilitato e le sue sessioni chiuse; l'utente sospeso con un token ancora valido ottiene `403 USER_SUSPENDED` entro 30 s (subito sulla stessa replica); il desktop connesso mostra la sospensione e smette di sincronizzare.
- [ ] "Riattiva": può rientrare.
- [ ] "Reimposta password": al login successivo deve cambiarla; senza SMTP il messaggio dice che l'e-mail non è stata inviata.
- [ ] Ruolo → amministratore: il nuovo admin vede la voce "Amministrazione" dopo un nuovo login; ruolo → utente la fa sparire. L'ultimo admin non si può degradare, sospendere o eliminare.
- [ ] "Elimina utente": i suoi vault compaiono come eliminati nel dettaglio e il login non è più possibile.

## Quota e limiti

- [ ] Quota utente = poche decine di MB: il cruscotto mostra l'utente oltre le soglie; una scrittura del desktop a 100 % viene rifiutata con "quota esaurita". Ripristino a "predefinita" riabilita le scritture.
- [ ] Azione in blocco su più utenti; "illimitata" (-1).
- [ ] Limiti di archiviazione: valori non validi (warn ≥ critical) sono rifiutati con messaggio chiaro; i nuovi valori cambiano la quota effettiva degli utenti senza override.

## Gruppi e profili

- [ ] Crea gruppo, aggiungi membri (member/manager), rinomina, elimina.
- [ ] Crea un profilo con `features.drawings=false` e `editor.fontSize` in `locked_keys`, assegnalo al gruppo con priorità: il desktop dei membri riceve la config (evento `ConfigChanged`), nasconde "Nuovo disegno" e blocca il campo. Anteprima "configurazione effettiva" dell'utente coincide.
- [ ] Modifica il profilo → la versione cresce; dalla cronologia ripristina la versione 1 (nuova versione 3).
- [ ] JSON non valido o chiave sconosciuta nel profilo: errore leggibile, nessun salvataggio.

## Audit

- [ ] Le azioni precedenti compaiono con attore e target; filtro per azione (`user.`), per attore, per intervallo; "Carica altro" scorre le pagine.
- [ ] "Esporta CSV" scarica un file che si apre in un foglio di calcolo senza formule inattese.

## Export ZIP

- [ ] Vault **condiviso** (Web UI → I miei vault → "Scarica ZIP"): lo ZIP contiene gli stessi file del vault locale (confronto con `diff -r`, escluso `.memobrain/` device-specific).
- [ ] Vault condiviso oltre 512 MB (o `DirectLimit` ridotto in dev): la UI passa al job, mostra "in coda/in corso/pronto" e scarica; dopo 24 h il link non funziona più.
- [ ] Vault **privato**: dialogo passphrase → ZIP decifrato nel browser identico al vault locale; passphrase errata → errore chiaro; con recovery key funziona; nessuna richiesta all'API contiene la passphrase o file in chiaro (pannello Rete del browser).
- [ ] Desktop: comando "Esporta vault come ZIP" (palette): dialogo "Salva con nome", messaggio con numero di file; lo ZIP si apre in Obsidian come vault; la destinazione dentro il vault è rifiutata; annullando il dialogo non succede nulla.
- [ ] Un vault privato non si esporta dal server: `GET /vaults/{id}/export.zip` risponde `409 VAULT_ENCRYPTED`.
