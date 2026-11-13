# Installazione

L'app desktop è distribuita per macOS, Windows e Linux. Le modalità di distribuzione (installer firmati, aggiornamenti automatici) sono definite da `docs/release/README.md`: qui i requisiti e i passi generali.

| Sistema | Requisiti                                       | Note                                                                                          |
| ------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| macOS   | Versione recente supportata da WebKit/WKWebView | Trascinare l'app in _Applicazioni_. Al primo avvio confermare l'apertura se richiesto.        |
| Windows | Windows 10/11 con **WebView2 Runtime**          | L'installer registra anche lo schema `clarae://` (necessario per aprire link e per il login). |
| Linux   | `webkit2gtk-4.1` installato                     | Il pacchetto registra `x-scheme-handler/clarae` nel file `.desktop`.                          |

## Primo avvio

1. Avviate l'app: compare la schermata **Apri un vault**.
2. Scegliete una cartella esistente (anche un vault di Obsidian) oppure una cartella vuota: diventerà il vostro vault.
3. Il cloud non serve per iniziare: tutto funziona offline.

## Dove l'app salva i dati

- **Le note** restano nella cartella del vault, come file normali: potete aprirle con altri editor e includerle nei vostri backup.
- Nella cartella nascosta `.clarae/` del vault: impostazioni dell'editor, aspetto, scorciatoie, layout dei pannelli, segnalibri, snapshot locali. Non modificatela a mano mentre l'app è aperta.
- Nella cartella dati dell'applicazione (fuori dal vault): indice di ricerca (ricostruibile), stato di sincronizzazione, log, e il token di accesso al cloud nel **portachiavi** del sistema.

## Aggiornare e disinstallare

Seguite le istruzioni del canale di distribuzione in uso: le build pubblicate non hanno l'aggiornamento automatico, quindi ogni nuova versione si installa a mano sopra la precedente. Se arrivate dalla versione 1.x, leggete [Aggiornare dalla 1.x](#aggiornare-dalla-1x). Disinstallare l'app **non** cancella i vault. Per rimuovere anche i dati locali eliminate la cartella dati dell'applicazione; il portachiavi del sistema contiene la voce del token (rimuovibile da lì).

## Aggiornare dalla 1.x

La 1.5 cambia il nome del prodotto: prima si chiamava MemoBrain Notes. Le funzioni non cambiano e i vault restano come sono. Le build della 1.x non hanno l'aggiornamento automatico, quindi la 1.5 si installa a mano.

1. **Chiudete la vecchia app** prima di avviare la nuova. Se è ancora aperta, la nuova mostra un messaggio che chiede di chiuderla e non parte: due istanze sulla stessa cartella dati non sono sicure.
2. **Installate la nuova app** e togliete la vecchia, dove l'installer non lo fa da solo:
   - **macOS:** trascinate _Clarae notanda_ in _Applicazioni_. È un'app diversa: _MemoBrain Notes_ resta dov'è e va spostata nel Cestino a mano.
   - **Windows:** l'installer rimuove da solo l'installazione precedente. Se la vecchia app è aperta vi chiede di chiuderla e di riprovare.
   - **Linux:** il pacchetto `.deb` sostituisce quello precedente. Un **AppImage** della 1.x non viene rimosso: eliminate il vecchio file.
3. **Al primo avvio** la nuova app prende da sola la cartella dati (vault recenti, impostazioni dell'app), la sessione e le chiavi dei vault privati dal portachiavi del sistema: non dovete accedere di nuovo né reinserire passphrase. I link `memobrain://` già scritti nelle note continuano ad aprirsi.
4. **Nei vault** la cartella nascosta si chiama ora `.clarae/` (prima `.memobrain/`). Un vault non collegato al cloud sposta lì le impostazioni quando lo aprite. Un vault **collegato** tiene le impostazioni sincronizzate in `.memobrain/` finché l'amministratore non attiva lo spostamento (nel Config Profile, e solo quando ogni dispositivo è aggiornato), perché un dispositivo con la 1.4 le legge ancora lì: vedere entrambe le cartelle è normale. Non cancellatene nessuna a mano. Indice, stato di sincronizzazione, snapshot e layout dei pannelli passano subito a `.clarae/`.
5. **Disegni e presentazioni** della 1.x si aprono come prima. I nomi nuovi si scrivono solo quando li modificate; un dispositivo che ha ancora la 1.4 non riconosce le impostazioni salvate dalla 1.5 (formule modificabili e ordine delle diapositive in un disegno; slide escluse, «ricomincia alla fine» e note del relatore in una presentazione). Aggiornate tutti i dispositivi.
6. **Nel browser** il profilo del workbench si porta da solo ai nuovi nomi alla prima apertura. Chiudete prima le schede del workbench aperte con la versione precedente: finché una è aperta il workbench nuovo non parte.
7. **Su macOS e Linux** ciò che il motore web dell'app tiene per conto suo (per esempio l'elenco degli strumenti recenti dei disegni) può ripartire vuoto. Tornare alla 1.4.0 sullo stesso dispositivo non è previsto.

Se l'amministratore ha un'installazione della 1.x del cloud, non cambia nulla per voi: la 1.5 e il cloud della 1.x si parlano. Per gli amministratori c'è una [guida di migrazione](../admin-guide/migrazione-clarae.md).
