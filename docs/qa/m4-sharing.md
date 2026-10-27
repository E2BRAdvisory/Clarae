# Checklist manuale — condivisione, gruppi e configurazione (M4)

Da eseguire con due account (A proprietario, B destinatario) su due dispositivi o due istanze con directory dati distinte, contro `yarn dev:cloud:k3d`. Gli automatismi (`go test -tags integration`, vitest, Playwright) coprono i flussi sul mock e sul cloud reale; qui si verifica ciò che solo l'app reale mostra.

Segnare `[x]` con data e sistema operativo.

## Condivisione di una cartella

- [ ] A collega un vault condiviso, tasto destro su una cartella → "Condividi…": cerca B (e un gruppo di cui B è membro), livello Editor, "Condividi".
- [ ] B vede "✉ 1 invito" nella barra di stato e in Impostazioni → Condivisione: accetta; il mount compare in "Condivisi con me" e si apre con "Apri" (nome = nome dello share).
- [ ] Il mount contiene solo la cartella condivisa, alla radice; B modifica una nota e ne crea un'altra: A le riceve entro pochi secondi nella cartella originale.
- [ ] Modifiche a righe diverse della stessa nota (A e B) si fondono; sulla stessa riga nasce una copia di conflitto. Un `.canvas` modificato da entrambi produce sempre una copia di conflitto.
- [ ] A sposta un file fuori dalla cartella condivisa: sparisce dal mount di B (nel cestino); lo rimette dentro: ricompare.
- [ ] A rinomina la cartella condivisa: B continua a sincronizzare senza interventi.

## Permessi

- [ ] Con livello **Viewer**: nella barra di stato "Lettore · sola lettura"; l'editor non accetta digitazione, Excalidraw e canvas sono in sola lettura, l'explorer non offre nuovo/rinomina/elimina, le proprietà sono disabilitate.
- [ ] A porta B da Viewer a Editor (e viceversa): il livello cambia nel mount aperto senza riavviare.
- [ ] Un grant a un gruppo: un membro accetta per tutti; un altro membro vede il mount senza un secondo invito; "Rifiuta" da un invito di gruppo mostra l'errore.
- [ ] Documento singolo condiviso: B lo vede come mount con quel solo file; non può aggiungere altri file.
- [ ] Vault privato (cifrato): "Condividi…" non compare; l'API risponde `VAULT_ENCRYPTED`.

## Revoca e scadenza

- [ ] A revoca lo share: B vede "Condivisione terminata" e sceglie tra "Conserva una copia" (cartella in `<dati>/kept/`, apribile come vault) ed "Elimina la copia".
- [ ] Uno share con scadenza passata si comporta come revocato.
- [ ] A rimuove B dai destinatari: stesso effetto per B.

## Configurazione dell'amministratore

- [ ] Un profilo globale con `editor.fontSize` bloccato: nelle Impostazioni la voce è disabilitata, con "Gestito dall'amministratore", e mostra il valore del profilo.
- [ ] Un valore non bloccato (es. `editor.lineWrap`) è un default: l'utente lo cambia e la scelta resta dopo un riavvio.
- [ ] `features.drawings=false`: spariscono "Nuovo disegno" e "Inserisci disegno"; `features.sharing=false` nasconde Condividi e gli inviti.
- [ ] Offline (rete scollegata) la configurazione dell'ultimo accesso resta in vigore.
- [ ] `sync.interval_seconds` del profilo cambia l'intervallo di polling.

## Web UI utente

- [ ] `http://localhost:18081/` (stesso host dei redirect URI del realm): login Keycloak, Spazio utilizzato, I miei vault, Dispositivi, Condivisioni (accetta/rifiuta, revoca, gestione destinatari).
- [ ] `/admin` non è visibile all'utente normale; con ruolo `memobrain-admin` mostra il segnaposto.
