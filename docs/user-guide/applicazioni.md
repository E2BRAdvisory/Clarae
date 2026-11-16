# Applicazioni

Un'**applicazione** è una pagina web registrata nel vault, per esempio uno strumento che usate ogni giorno (una chat, un calendario, una dashboard, un servizio interno). Si apre in una scheda, accanto alle vostre note, senza uscire da Clarae notanda.

> **La funzione è accesa di default.** Chi amministra il cloud può spegnerla, con il flag `features.web_viewer` nel vostro profilo di configurazione: se nel ribbon, nel pannello vuoto e nell'esploratore dei file non c'è _Nuova applicazione_, è spenta per voi. Senza un cloud (un vault solo locale) non c'è un profilo e la funzione resta accesa. Fino alla 1.7.1 era spenta di default. È una funzione ancora poco provata sulla finestra reale: vedi [Limiti](#limiti).

## Dove funziona

| Dove                          | Che cosa succede                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Client desktop su macOS**   | La pagina si apre **dentro la scheda**, in un browser incorporato (quello del sistema, WebKit).                                                                             |
| **Client desktop su Windows** | Per ora non c'è un browser incorporato: la scheda mostra un riquadro con il pulsante **«Apri nel browser»**, che apre la pagina nel browser predefinito del sistema.        |
| **Client desktop su Linux**   | Come su Windows.                                                                                                                                                            |
| **Workbench web**             | La pagina non può stare dentro un'altra pagina web (molti siti lo vietano): la scheda mostra il riquadro con **«Apri nel browser»**, che apre una nuova scheda del browser. |

Nei casi senza browser incorporato tutto il resto della guida vale ugualmente (creare, rinominare, cambiare indirizzo, aprire dal browser), tranne le sezioni che parlano della barra, delle scorciatoie e dei dati di sessione.

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

Sopra la pagina, nei client con il browser incorporato (macOS):

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
- L'aspetto e il tema dell'app non si applicano alla pagina, e la pagina si presenta come Safari.

## Dati di sessione

Cookie, accessi e archivio locale delle pagine restano **su questo dispositivo**: non sono nel vault, non si sincronizzano e non sono visibili ad altri dispositivi. Sono **separati per vault**: lo stesso sito aperto da due vault ha due sessioni diverse. Su macOS i dati stanno nel contenitore di WebKit (non in una cartella del vault).

- **Su macOS 14 o successivo** la sessione dura nel tempo: chiudendo e riaprendo l'app siete ancora connessi. **Su macOS 13** dura finché l'app è aperta, e **l'app non vi avvisa**.
- **_Elimina i dati delle applicazioni_** (palette) chiude le pagine del vault e cancella cookie, sessioni e cache delle sue applicazioni su questo dispositivo; ogni applicazione chiederà di nuovo la conferma dell'indirizzo. I file `.webapp` restano. Non tocca gli altri vault né gli altri dispositivi.
- Se una condivisione ricevuta viene rimossa dall'app, i suoi dati di sessione vengono cancellati. Se invece cancellate la cartella di un vault fuori dall'app, l'app non lo sa subito: se ne accorge da sola, **all'avvio e in background**, e cancella i dati di quel vault solo quando è sicura che non esiste più. Cioè quando il vault non è aperto, non è una condivisione ricevuta e non è tra i vault recenti, oppure vi è ma non lo aprite da più di 30 giorni e la sua cartella non esiste più mentre quella che la conteneva c'è e **non è vuota** (una cartella madre vuota è tipica di un punto di mount, per esempio di rclone, sshfs o Cryptomator, non montato: il vault si tiene). Se il vault era l'unica cosa nella sua cartella, i suoi dati restano (qualche megabyte): eliminateli con _Elimina i dati_. **Un vault solo chiuso, su un disco esterno scollegato o su un disco di rete non montato non perde mai i dati.** Fino ad allora, o se volete cancellarli subito, eseguite _Elimina i dati_ da un vault aperto allo stesso percorso.

## Limiti

- **L'autenticazione HTTP di base** (la finestra del browser che chiede nome utente e password) **non è supportata**: la richiesta è annullata e la pagina non si carica. Idem per NTLM e certificato client. Usate un sito con un accesso in una pagina web.
- **I login che si aprono in un popup** e comunicano con la pagina che li ha aperti (`window.opener`) **non funzionano**: i popup non si aprono nell'app, vanno al browser di sistema.
- Il browser incorporato c'è **solo su macOS**. Windows e Linux aprono la pagina nel browser di sistema. Per Windows esiste un driver in preparazione, **spento e mai provato su un computer Windows**: non cambia ciò che vedete.
- **Non provato sulla finestra reale** per alcune cose: il posizionamento della pagina con lo zoom dell'app diverso da 100%, lo sfarfallio nel nascondere e mostrare la pagina, il fuoco da tastiera, il trascinamento di una scheda sopra la pagina. Una matrice di prove manuali ([`docs/qa/m18-webview-matrice.md`](../qa/m18-webview-matrice.md)) non è ancora stata eseguita, anche se dalla versione che ha il pulsante nell'esploratore la funzione è accesa di default. Segnalate ciò che vedete.
- Al massimo **32 applicazioni aperte** per vault (64 in tutto). Oltre, la scheda lo dice e propone «Apri nel browser».

## Se qualcosa non va

- **Non vedo _Nuova applicazione_.** La funzione è spenta nel vostro profilo di configurazione (o il vault è in sola lettura): chiedete a chi amministra il cloud ([guida per chi amministra](../admin-guide/profili-quote-audit.md#chiavi-del-profilo)).
- **La scheda mostra un riquadro invece della pagina.** Senza browser incorporato (Windows, Linux, workbench web) è normale: usate «Apri nel browser». Su macOS potrebbe esserci un errore: leggete il messaggio, poi «Riprova».
- **Il file non si apre («Impossibile aprire questa applicazione»).** Il JSON non è valido, l'indirizzo non è `http` o `https`, ha credenziali, o il file è stato scritto da una versione più recente: correggete l'indirizzo con «Cambia indirizzo» (o a mano nel file).
- **Una pagina chiede un accesso e non funziona.** Vedi [Limiti](#limiti): autenticazione di base e login con popup non sono supportati.
- **Troppe applicazioni aperte.** Chiudete qualche scheda e usate «Riprova».
