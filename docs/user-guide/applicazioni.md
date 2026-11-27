# Applicazioni

Un'**applicazione** è una pagina web registrata nel vault, per esempio uno strumento che usate ogni giorno (una chat, un calendario, una dashboard, un servizio interno). Si apre in una scheda, accanto alle vostre note, senza uscire da Clarae notanda.

> **La funzione è accesa di default.** Chi amministra il cloud può spegnerla, con il flag `features.web_viewer` nel vostro profilo di configurazione: se nel ribbon, nel pannello vuoto e nell'esploratore dei file non c'è _Nuova applicazione_, è spenta per voi. Senza un cloud (un vault solo locale) non c'è un profilo e la funzione resta accesa. Fino alla 1.7.1 era spenta di default. Il responsabile del progetto l'ha provata su finestre vere di Windows e di Linux il 27 novembre 2026, con esito positivo: vedi [Limiti](#limiti).

## Dove funziona

| Dove                          | Che cosa succede                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Client desktop su macOS**   | La pagina si apre **dentro la scheda**, in un browser incorporato (quello del sistema, WebKit).                                                                                                                                                                                                                                                                                                                                      |
| **Client desktop su Windows** | Come su macOS, con **WebView2** (il motore di Microsoft Edge). Serve il _WebView2 Runtime_ dalla versione **1.0.2210.55**; senza, o con uno più vecchio, vale il ripiego descritto sotto.                                                                                                                                                                                                                                            |
| **Client desktop su Linux**   | Come su macOS, con **WebKitGTK**. Serve `webkit2gtk-4.1` dalla versione **2.40**, il pacchetto ufficiale (costruito per GTK 3) e **bubblewrap (`bwrap`)** installato e funzionante: WebKit mette la pagina in una sandbox e l'app non la apre senza. Senza questi requisiti, o in un ambiente che non permette la sandbox (un container, un sistema con i namespace utente spenti, Flatpak o Snap), vale il ripiego descritto sotto. |
| **Workbench web**             | La pagina non può stare dentro un'altra pagina web (molti siti lo vietano): la scheda mostra il riquadro con **«Apri nel browser»**, che apre una nuova scheda del browser.                                                                                                                                                                                                                                                          |

**Il ripiego.** Se il computer non può mostrare la pagina nella scheda (manca il runtime o è troppo vecchio, su Linux manca `bwrap` o la sandbox non si può creare, la finestra non ha la struttura che il driver si aspetta, oppure la vista integrata è stata spenta), la scheda mostra il riquadro con il pulsante **«Apri nel browser»**, che apre la pagina nel browser predefinito del sistema. Non compaiono errori: se la prima apertura trova il sistema incapace, per il resto della sessione le applicazioni mostrano direttamente il riquadro.

**Spegnere la vista integrata su un computer.** Su Windows e su Linux si può avviare l'app con la variabile d'ambiente `CLARAE_WEBVIEW=off` (vale solo il valore `off`): le applicazioni si aprono allora nel browser di sistema. Serve a chi ha un computer dove la vista si comporta male. Su macOS la variabile non esiste.

Nei casi senza browser incorporato (workbench web, o ripiego) tutto il resto della guida vale ugualmente (creare, rinominare, cambiare indirizzo, aprire dal browser), tranne le sezioni che parlano della barra, delle scorciatoie e dei dati di sessione.

## Creare un'applicazione

_Nuova applicazione_ dall'**esploratore dei file** (il pulsante nella sua barra, o la voce del menu che si apre con il tasto destro su una cartella, su un file o sullo spazio vuoto), dal ribbon, dal pannello vuoto o dalla palette comandi (`Mod+P`). Dall'esploratore il file nasce **nella cartella della riga selezionata** (o accanto al file selezionato; in cima al vault se non c'è una selezione). Il dialogo chiede:

- **Indirizzo:** un indirizzo `http` o `https`, per esempio `https://example.com`. Se scrivete `example.com` o `localhost:3000` senza schema, aggiunge `https://`. Non sono accettati altri schemi (`file:`, `javascript:`, `mailto:`…), indirizzi con nome utente e password, spazi o caratteri di controllo.
- **Nome** (facoltativo): il nome del file. Se manca, quello del sito (senza `www.`).

Il comando scrive un file `Nome.webapp` (dal ribbon, dal pannello vuoto e dalla palette: accanto al file attivo; dall'esploratore: nella cartella scelta) e lo apre in una nuova scheda. L'esploratore e le schede mostrano il **nome senza `.webapp`**: `Mio sito.webapp` compare come «Mio sito». Su un vault in sola lettura _Nuova applicazione_ e _Cambia indirizzo_ sono disabilitati.

Il file è un piccolo JSON, che potete anche scrivere a mano:

```json
{ "version": 1, "url": "https://example.com" }
```

Un `.webapp` è **un file come gli altri**: si rinomina, si sposta, si elimina, si segnala con i segnalibri e **si sincronizza** con il vault. Se due dispositivi lo cambiano insieme vale l'ultima scrittura (stesso utente) oppure nasce una copia di conflitto (utenti diversi, come per ogni file che non è una nota).

## Aprire un'applicazione

- Dall'esploratore dei file, con un clic sul file `.webapp`.
- Dal **selettore rapido** (`Mod+O`): digitate parte del nome dell'applicazione; la trova insieme alle note, alle lavagne, alle basi e ai disegni (dalla 1.7.1). Il tipo è scritto accanto al nome e letto dai lettori di schermo.
- Dalla palette: **_Apri applicazione…_** elenca le sole applicazioni del vault.
- Un `.webapp` incorporato in una nota (`![[Nome.webapp]]`) non carica nulla: mostra solo un avviso.

### La conferma alla prima apertura

La prima volta che un indirizzo si apre **su questo dispositivo** (per ogni vault) compare «Aprire https://… qui?». Compare anche per chi ha appena creato l'applicazione: un file `.webapp` può arrivare da un altro dispositivo o, in un vault condiviso, da un'altra persona, e non deve caricare una pagina solo perché esiste. Scegliete **«Apri qui»** se vi fidate dell'indirizzo, oppure **«Apri nel browser»**. La conferma riguarda l'indirizzo registrato nel file: dentro la pagina potete seguire i suoi link. Cambiando l'indirizzo con un sito diverso, la conferma è richiesta di nuovo.

## La barra della scheda

Sopra la pagina, nei client con il browser incorporato (macOS, Windows, Linux; dove nel testo compare `Mod`, è `Cmd` su macOS e `Ctrl` sugli altri sistemi):

| Elemento         | Che cosa fa                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Indietro, Avanti | La cronologia della pagina (`Mod+[`, `Mod+]`).                                                                                           |
| Ricarica         | Carica di nuovo la pagina, o la riapre se la vista era stata chiusa (`Mod+R`).                                                           |
| Indirizzo        | Dove si trova la pagina adesso, **solo come testo**: non si digita. Per cambiare l'indirizzo dell'applicazione usate «Cambia indirizzo». |
| Cambia indirizzo | Scrive un nuovo indirizzo nel file (anche dalla palette: _Cambia l'indirizzo dell'applicazione_).                                        |
| Apri nel browser | Apre la pagina in cui siete adesso nel browser di sistema (anche dalla palette: _Apri l'applicazione nel browser_).                      |

Sotto la barra compaiono, in un elenco chiudibile, gli avvisi sulla pagina: una navigazione bloccata, una nuova finestra rifiutata o aperta nel browser, un download rifiutato, un permesso negato.

Se la pagina non si carica compaiono riquadri chiari: errore di caricamento, **certificato del sito non valido** (non c'è modo di proseguire comunque: si può solo aprire l'indirizzo nel browser se ci si fida), pagina che ha smesso di funzionare, troppe applicazioni aperte, vista chiusa. Ognuno ha «Riprova» e «Apri nel browser».

### Che cosa succede alla pagina quando cambiate scheda

- **Cambiare scheda** nasconde la pagina e la conserva: tornando la ritrovate com'era. Una pagina nascosta ha però i **timer rallentati dal motore web**: una chat o un video in una scheda non attiva possono rallentare o fermarsi. È una scelta: le schede in secondo piano non si tengono «vive».
- **Chiudere la scheda** chiude la pagina.
- **Due pannelli sulla stessa applicazione** sono due pagine separate.
- Alla riapertura dell'app le schede delle applicazioni **non caricano nulla** finché non le mostrate.
- Una pagina sta sempre sopra l'interfaccia: per questo si nasconde da sola quando trascinate una scheda, uno splitter o un file, e quando aprite la palette, un menu, un dialogo o le impostazioni; poi torna.
- Chiudere il vault, bloccare un vault privato (anche per inattività), togliere una condivisione ricevuta o uscire dall'app chiude le pagine. **Lavorare dentro un'applicazione conta come attività** per il blocco automatico dei vault privati.
- Se un amministratore spegne la funzione nel profilo, le pagine aperte si chiudono e le schede passano al riquadro con «Apri nel browser».

## Scorciatoie

Le scorciatoie dell'app (chiudere la scheda, palette, selettore, indietro, avanti, ricarica…) funzionano anche con il fuoco dentro la pagina: eseguono il comando dell'app, non quello della pagina. Fanno eccezione quelle dell'editor di testo (per esempio il grassetto), che restano alla pagina. I comandi dell'applicazione hanno queste scorciatoie predefinite, che potete cambiare in _Impostazioni → Scorciatoie_:

| Comando                  | Scorciatoia |
| ------------------------ | ----------- |
| _Applicazione: indietro_ | `Mod+[`     |
| _Applicazione: avanti_   | `Mod+]`     |
| _Applicazione: ricarica_ | `Mod+R`     |

_Nuova applicazione_, _Apri applicazione…_, _Cambia l'indirizzo dell'applicazione_, _Apri l'applicazione nel browser_ ed _Elimina i dati delle applicazioni_ non ne hanno. I comandi di navigazione e _Elimina i dati_ ci sono solo dove c'è il browser incorporato.

## Che cosa può fare una pagina, e che cosa no

La pagina gira in una vista **separata** dall'app, come una scheda di un browser. **Non ha alcun collegamento con Clarae notanda**: non può leggere né scrivere le vostre note, non vede il vault, non può usare i comandi o le funzioni dell'app. In particolare:

- Si aprono solo indirizzi `http` e `https`; ogni spostamento della pagina (anche un reindirizzamento) è controllato.
- **Non può scaricare file** (il download è rifiutato e ve lo dice) né chiedere **camera, microfono, posizione, notifiche** o l'accesso ai vostri file: il permesso è negato.
- **Non apre finestre nuove nell'app.** Se chiede una nuova finestra (`window.open`, un link che si apre altrove), l'indirizzo va al browser di sistema solo se avete appena lavorato nella pagina, mai da una scheda nascosta e al massimo una volta al secondo.
- Un sito con un **certificato non valido** non si apre e non c'è modo di forzarlo.
- **Rete locale.** Potete registrare un indirizzo privato (`localhost`, un NAS, uno strumento self-hosted). Ma una pagina arrivata da un sito pubblico **non può portarvi** su un indirizzo locale: ci sono servizi del vostro computer (compreso l'accesso al cloud) che non devono essere raggiungibili da un sito. La regola riguarda la pagina nel suo insieme, non ciò che incorpora o richiede dietro le quinte; non protegge da un nome che, risolto, punta a un indirizzo locale.
- Gli avvisi `alert`, `confirm` e `prompt` della pagina non compaiono: `alert` è confermato da solo, gli altri rispondono «no» e nulla. L'audio e il video partono solo dopo un vostro gesto e il pieno schermo di un elemento della pagina è disattivato.
- L'aspetto e il tema dell'app non si applicano alla pagina. La pagina si presenta come Safari su macOS e su Linux (con il nome del motore, WebKitGTK) e come Edge su Windows.

## Dati di sessione

Cookie, accessi e archivio locale delle pagine restano **su questo dispositivo**: non sono nel vault, non si sincronizzano e non sono visibili ad altri dispositivi. Sono **separati per vault**: lo stesso sito aperto da due vault ha due sessioni diverse. Su macOS i dati stanno nel contenitore di WebKit (non in una cartella del vault). Su Windows e su Linux stanno nella cartella dei dati dell'app, sotto `webapps/`, **una cartella per vault**, e **restano anche dopo il riavvio** (cookie compresi).

- **Su Windows e su Linux** la sessione dura nel tempo, su ogni versione.
- **Su macOS 14 o successivo** la sessione dura nel tempo: chiudendo e riaprendo l'app siete ancora connessi. **Su macOS 13** dura finché l'app è aperta, e **l'app non vi avvisa**.
- **_Elimina i dati delle applicazioni_** (palette) chiude le pagine del vault e cancella cookie, sessioni e cache delle sue applicazioni su questo dispositivo; ogni applicazione chiederà di nuovo la conferma dell'indirizzo. I file `.webapp` restano. Non tocca gli altri vault né gli altri dispositivi.
- Se una condivisione ricevuta viene rimossa dall'app, i suoi dati di sessione vengono cancellati. Se invece cancellate la cartella di un vault fuori dall'app, l'app non lo sa subito: se ne accorge da sola, **all'avvio e in background**, e cancella i dati di quel vault solo quando è sicura che non esiste più. Cioè quando il vault non è aperto, non è una condivisione ricevuta e non è tra i vault recenti, oppure vi è ma non lo aprite da più di 30 giorni e la sua cartella non esiste più mentre quella che la conteneva c'è e **non è vuota** (una cartella madre vuota è tipica di un punto di mount, per esempio di rclone, sshfs o Cryptomator, non montato: il vault si tiene). Se il vault era l'unica cosa nella sua cartella, i suoi dati restano (qualche megabyte): eliminateli con _Elimina i dati_. **Un vault solo chiuso, su un disco esterno scollegato o su un disco di rete non montato non perde mai i dati.** Fino ad allora, o se volete cancellarli subito, eseguite _Elimina i dati_ da un vault aperto allo stesso percorso.

## Limiti

- **L'autenticazione HTTP di base** (la finestra del browser che chiede nome utente e password) **non è supportata**: la richiesta è annullata e la pagina non si carica. Idem per il certificato client, e per NTLM su macOS e su Linux (su Windows NTLM e Kerberos li gestisce il runtime WebView2). Usate un sito con un accesso in una pagina web.
- **I login che si aprono in un popup** e comunicano con la pagina che li ha aperti (`window.opener`) **non funzionano**: i popup non si aprono nell'app, vanno al browser di sistema.
- Il browser incorporato c'è su **macOS, Windows e Linux**. Il workbench web, e un computer senza il runtime richiesto, aprono la pagina nel browser di sistema. **I driver di Windows e di Linux sono stati provati su una finestra vera il 27 novembre 2026**, con esito positivo, seguendo una matrice di prove manuali ([`docs/qa/m18-webview-matrice.md`](../qa/m18-webview-matrice.md)). Se la vista si comporta male, spegnetela con `CLARAE_WEBVIEW=off` e segnalate ciò che vedete.
- **Su Linux** il selettore di file della pagina è annullato (come su macOS) e, per sicurezza, una pagina pubblica che incorpora un frame verso un indirizzo locale lo vede rifiutato, come un reindirizzamento verso un indirizzo locale dopo una pagina pubblica. **La sandbox di WebKit è obbligatoria:** se per qualche motivo il processo che disegna la pagina non riesce a partire dopo che il controllo iniziale è riuscito, l'app può chiudersi senza altri avvisi; Flatpak e Snap non sono provati. Se aprite un'applicazione mentre eliminate i dati delle applicazioni dello stesso vault, la scheda mostra un errore con «Riprova».
- **Su Windows** lavorare dentro la pagina conta, per il blocco automatico dei vault privati, solo per i tasti e il fuoco: chi legge e scorre soltanto è considerato inattivo. Il selettore di file della pagina non si può negare.
- **Prove sulla finestra reale:** il posizionamento della pagina con lo zoom dell'app diverso da 100%, lo sfarfallio nel nascondere e mostrare la pagina, il fuoco da tastiera e il trascinamento di una scheda sopra la pagina fanno parte della matrice di prove manuali ([`docs/qa/m18-webview-matrice.md`](../qa/m18-webview-matrice.md)), eseguita il 27 novembre 2026 con esito positivo (dichiarato, senza esito per riga). Segnalate ciò che vedete.
- Al massimo **32 applicazioni aperte** per vault (64 in tutto). Oltre, la scheda lo dice e propone «Apri nel browser».

## Se qualcosa non va

- **Non vedo _Nuova applicazione_.** La funzione è spenta nel vostro profilo di configurazione (o il vault è in sola lettura): chiedete a chi amministra il cloud ([guida per chi amministra](../admin-guide/profili-quote-audit.md#chiavi-del-profilo)).
- **La scheda mostra un riquadro invece della pagina.** Senza browser incorporato (workbench web, oppure un computer Windows o Linux senza il runtime richiesto, o con `CLARAE_WEBVIEW=off`) è normale: usate «Apri nel browser». Dove il browser incorporato c'è potrebbe esserci un errore: leggete il messaggio, poi «Riprova».
- **Il file non si apre («Impossibile aprire questa applicazione»).** Il JSON non è valido, l'indirizzo non è `http` o `https`, ha credenziali, o il file è stato scritto da una versione più recente: correggete l'indirizzo con «Cambia indirizzo» (o a mano nel file).
- **Una pagina chiede un accesso e non funziona.** Vedi [Limiti](#limiti): autenticazione di base e login con popup non sono supportati.
- **Troppe applicazioni aperte.** Chiudete qualche scheda e usate «Riprova».
