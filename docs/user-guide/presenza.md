# Presenza: chi altro è nel documento

Nei **vault condivisi** vedete chi altro ha aperto lo stesso documento e dove tiene il puntatore. Non è la modifica simultanea: le modifiche si uniscono come sempre alla sincronizzazione (vedi [Condivisione e gruppi](condivisione-gruppi.md)).

## Cosa si vede

- **Gli avatar** nella barra dell'Esplora file (dove prima c'era il pulsante «Nuova applicazione», che resta nella ribbon, nei menu contestuali, nella palette e nello stato vuoto): un cerchio con le iniziali per ogni altro utente che ha aperto il file in primo piano. Se non c'è nessuno, la barra non mostra nulla. Passando sopra un avatar si legge il nome.
- **Quattro avatar al massimo.** Gli altri diventano un badge `+N` (per esempio `+2`), con i nomi nel suggerimento.
- **I cursori**, sopra il documento: un puntatore con l'etichetta del nome, che segue il mouse di quell'utente. Ci sono per **note, disegni e canvas**; per lettura, basi, PDF, immagini e applicazioni si vedono solo gli avatar.
- **Nelle note** il cursore indica la riga e la colonna del testo sotto il **puntatore del mouse**, non il punto in cui si sta scrivendo. In Live Preview la riga è esatta e la colonna è approssimata dentro un blocco. Nei **disegni** e nei **canvas** il cursore sta nello stesso punto della scena anche se zoom e scroll sono diversi dai vostri.
- **Il colore** di una persona è sempre lo stesso: avatar, puntatore ed etichetta, in ogni file e ogni sessione, su tutti i dispositivi. Il colore non dipende da chi guarda.
- Con la riduzione del movimento del sistema attiva, il puntatore non scivola: salta nella nuova posizione.

## Chi vedete

- **Solo altri utenti.** Non vedete voi stessi, né un vostro secondo dispositivo con lo stesso account.
- **Solo nei vault condivisi** (e nei mount). I vault privati non hanno presenza: nessun altro utente li apre e il server non conosce i percorsi.
- **Solo chi può leggere quel file.** Se condividete una cartella, vedete gli altri solo sui file di quella cartella. Se il vostro accesso viene revocato, gli avatar e i cursori di quel file spariscono.
- **Solo i file già sincronizzati.** Una nota appena creata e non ancora sincronizzata non ha presenza finché il cloud non la conosce.
- Serve il collegamento al cloud: da offline non si vede nulla e al ritorno online la presenza riparte da sola.

## Privacy: chi vede cosa

Gli altri utenti dello stesso file vedono **il vostro nome visualizzato** e **la posizione del puntatore** finché il file è aperto in primo piano. Quando lo chiudete, cambiate scheda o vi disconnettete, spariscono. **Niente viene salvato**: la presenza vive solo in memoria del server, non è nel registro di audit né nei log (vedi [conservazione dei dati](../security/data-retention.md)). Gli amministratori non la vedono in nessuna schermata.

## Come si spegne

Si spegne per tutti gli utenti di un profilo: l'amministratore imposta `features.presence` a `false` nel Config Profile ([guida dell'amministratore](../admin-guide/profili-quote-audit.md)). Vale anche a caldo, senza riavviare l'app: gli avatar e i cursori spariscono e il client chiude la connessione. Non c'è un'impostazione personale per spegnerla.

## Se non vedete nessuno

Controllate che il vault sia condiviso e collegato, che l'altro utente abbia lo stesso file aperto in primo piano (non solo in una scheda in secondo piano), che sia online e che la presenza non sia spenta dal profilo. Altri sintomi: [risoluzione dei problemi](risoluzione-problemi.md).
