# Terminale

Il **terminale** è una riga di comando dentro Clarae notanda: ogni scheda è una **shell** vostra, che parte nella cartella del vault aperto. Serve per lanciare uno script, usare `git` sul vault o controllare un file senza uscire dall'app. Esiste **solo nel client desktop** (macOS, Windows, Linux); il workbench web nel browser non ha il terminale, perché una pagina web non può avviare programmi sul vostro computer.

> **Attenzione: il terminale esegue qualunque comando che scrivete, con i vostri permessi.** Una shell può leggere, modificare e cancellare ogni file che potete toccare voi, anche **fuori dalle regole dell'app**: altri vault, la cartella `.clarae/`, i file di una condivisione aperta come cartella. **Il terminale non è un confine di sicurezza** e non fa rispettare i permessi di condivisione. Non incollate comandi di cui non conoscete l'effetto. **Non c'è un'opzione per spegnerlo** (né nel profilo di configurazione, né nelle impostazioni): chi amministra un computer gestito deve limitarlo con i mezzi del sistema operativo. Una shell parte **solo quando la chiedete voi** (pulsante, comando, `+`): mai da un file del vault, da un link o da un indirizzo `clarae://`.

## Aprire il terminale

- **Il pulsante nel ribbon**, subito sopra le _Impostazioni_ (risulta premuto finché un terminale è aperto).
- **``Ctrl+` ``** (il tasto a sinistra del `1`, con `Ctrl`) o il comando _Terminale: mostra o nascondi_ della palette (`Mod+P`). Al primo uso parte una shell.
- **``Ctrl+Maiusc+` ``** o _Terminale: nuova scheda_: una scheda nuova (apre il pannello, se è chiuso).

Le scorciatoie sono le stesse su **tutti i sistemi, anche macOS**: sul Mac si usa `Ctrl`, non `Cmd`, perché ``Cmd+` `` resta al sistema (cambia finestra). Si possono cambiare in _Impostazioni → Scorciatoie_.

> **Layout italiano su Windows e su Linux: conflitto noto.** Con la tastiera italiana il tasto a sinistra del `1` scrive `\`. L'app riconosce prima il **carattere** e poi la posizione fisica del tasto: `Ctrl+\` è già _Dividi a destra_ (`pane:split-right`). **Fuori dal terminale, con una nota aperta, vince questo comando** (divide l'editor) e non il terminale; **dentro il terminale `Ctrl+\` resta alla shell**. Per aprire il terminale usate il pulsante del ribbon o la palette, oppure assegnate al terminale un'altra scorciatoia da _Impostazioni → Scorciatoie_. Le _Impostazioni_ **non segnalano** questa sovrapposizione. Su macOS non c'è il conflitto (lì la divisione è `Cmd+\`) e nemmeno con il layout americano.
>
> **Mac con tastiera ISO (italiana, tedesca…).** Su questi Mac il tasto in alto a sinistra e il tasto `<>` accanto a Maiusc sinistro valgono entrambi come tasto del terminale: l'app li riconosce per la posizione fisica (su macOS `IntlBackslash` e `Backquote`). Fuori da macOS conta solo il tasto a sinistra del `1`.

## Il pannello

Il pannello sta **in basso** (predefinito), **a sinistra** o **a destra** della zona di lavoro. Si ridimensiona trascinando il divisore; la posizione si sceglie dal selettore nella barra del pannello. **Posizione e dimensione sono preferenze di questo dispositivo**: non stanno nel vault e non si sincronizzano.

La barra ha:

- le **schede** (una per shell), con il nome della cartella e, poi, il titolo che la shell stessa imposta; le frecce spostano tra le schede e `Canc` chiude quella selezionata;
- **`+`** per una scheda nuova e **`×`** su ogni scheda per chiuderla;
- il **selettore di posizione** (in basso, a sinistra, a destra);
- all'estrema destra **Sgancia terminale** (vedi sotto).

Nascondere il pannello (il pulsante del ribbon o ``Ctrl+` ``) **non chiude le shell**: i programmi in esecuzione continuano e le schede ritrovano il loro contenuto. Chiudere l'**ultima** scheda chiude il pannello.

## Dove parte la shell

- **Unix** (macOS, Linux): la shell di login dell'utente, `$SHELL -l`; se `$SHELL` non è utilizzabile, la prima tra `/bin/zsh`, `/bin/bash`, `/bin/sh`.
- **Windows:** `pwsh.exe` (PowerShell 7) se c'è, altrimenti `powershell.exe`, altrimenti il programma indicato da `%ComSpec%` (di solito `cmd.exe`).
- **Cartella di partenza:** la **radice del vault aperto**; senza vault, la cartella home. Se cambiate vault, le schede già aperte restano dove sono e le **nuove** partono nel nuovo vault.
- **Ambiente:** quello dell'app, più `TERM=xterm-256color`, `COLORTERM=truecolor` e `TERM_PROGRAM=Clarae`. La shell eredita quindi anche le variabili d'ambiente che avete impostato (compresi eventuali segreti).
- **Limite:** al massimo **16 terminali** aperti insieme.

## La finestra separata

**Sgancia terminale** (all'estrema destra della barra, o _Terminale: sgancia in una finestra separata_) sposta il terminale in una **finestra del sistema** tutta sua; **Aggancia a Clarae** lo riporta nell'app. Le shell **non ripartono**: un programma come `top` continua a girare e lo schermo conserva l'output e la cronologia. È l'unica seconda finestra di Clarae notanda: nient'altro si apre fuori dalla finestra principale.

- Nella finestra separata una scheda nuova parte nel vault della **scheda in primo piano**.
- Le scorciatoie del terminale valgono anche lì; in quella finestra ``Ctrl+` `` riaggancia. Valgono quelle del vault della scheda in primo piano (le predefinite se la scheda è nella home o le impostazioni di quel vault non si leggono).
- Il titolo della finestra segue la lingua dell'app («Clarae notanda — Terminale»).
- **Chiudere la finestra con il pulsante del sistema termina tutte le shell**, senza chiedere conferma. Per tenerle, usate **Aggancia a Clarae**.
- Chiudendo la finestra principale (o uscendo dall'app) si chiude anche quella del terminale, con tutte le shell.

## Quando una shell finisce

- Se la shell termina con codice **0** (`exit`), la scheda si chiude.
- Se termina con un codice **diverso da 0**, la scheda **resta** con l'ultimo output e l'avviso «La shell è terminata (codice di uscita N)», finché non la chiudete.
- Vale anche se la shell finisce prima che la scheda compaia (per esempio un `$SHELL` che esce subito): la scheda nasce già segnata come terminata, o sparisce se l'uscita è pulita.
- Chiudere una scheda, la finestra separata o l'app **termina la shell e i programmi che ha avviato**, anche quelli in background che ignorano il segnale di chiusura: non restano processi orfani. L'uscita dall'app aspetta al massimo 3 secondi.

## Tastiera nel terminale

Dentro il terminale quasi ogni tasto è della shell (`Ctrl+C`, `Ctrl+R`, `Ctrl+P`…). Passano all'app solo le scorciatoie del terminale, i comandi con `Maiusc` condivisi con l'app (come la palette `Mod+Maiusc+P`) e, su macOS, ogni combinazione con `Cmd`.

| Azione              | macOS   | Windows e Linux |
| ------------------- | ------- | --------------- |
| Copiare (selezione) | `Cmd+C` | `Ctrl+Maiusc+C` |
| Incollare           | `Cmd+V` | `Ctrl+Maiusc+V` |

I collegamenti nell'output si aprono nel browser di sistema con un clic, solo se sono indirizzi web, e-mail o telefono: questo vale anche per i collegamenti che un programma scrive con la sequenza OSC 8 (testo cliccabile con un indirizzo diverso dal testo mostrato). Altri schemi non si aprono.

## Vault in sola lettura

Per un vault che per voi è **solo in lettura** (siete lettori di una condivisione, o la condivisione è stata revocata) il terminale **non si apre**: il pulsante del ribbon e `+` sono disabilitati, con il motivo nel suggerimento, e il core rifiuta la richiesta con l'errore `terminal-read-only`. Se un vault diventa di sola lettura mentre ha dei terminali aperti, quelle shell vengono **chiuse** e la scheda lo dice («Il vault è diventato di sola lettura: sessione chiusa»).

Limiti da conoscere:

- Il divieto riguarda il vault **della scheda**, non il computer: una shell aperta in un vault scrivibile può comunque modificare i file di un altro vault, anche di una condivisione in sola lettura aperta come cartella (resterebbe una modifica locale non inviata).
- Un mount già **chiuso** che diventa di sola lettura **non chiude** le shell che erano state aperte in lui.

## Vault privati

Se il vault di una scheda è un **vault privato bloccato** (lo dice lo stato del vault, non la fase della sincronizzazione: resta coperta anche con la sincronizzazione in pausa), la scheda è **coperta** e non riceve tasti: non si vede l'output finché non lo sbloccate. **I programmi restano in esecuzione.** Premere tasti nel terminale conta come attività per il blocco automatico. Ricordate che i file locali di un vault privato sono file ordinari sul disco: una shell li legge come ogni altro programma.

## Licenze

Il terminale usa [xterm.js](https://github.com/xtermjs/xterm.js) (`@xterm/xterm`, `@xterm/addon-fit` e `@xterm/addon-web-links`) e, sul client desktop, [creack/pty](https://github.com/creack/pty), tutti con licenza MIT. L'attribuzione è in _Impostazioni → Informazioni → Licenze_ (nel workbench web compare solo quella di xterm.js, che è nel pacchetto anche se il terminale non c'è) e nel `README.md`.

## Se qualcosa non va

- **Il pulsante manca:** il terminale c'è solo nel client desktop, non nel workbench web.
- **Il pulsante è grigio:** il vault corrente è in sola lettura per voi.
- **«Troppi terminali aperti»:** chiudete una scheda (limite di 16).
- **Il tasto a sinistra del `1` divide l'editor invece di aprire il terminale:** è il conflitto noto del layout italiano su Windows e Linux (vedi sopra).
- **«Il terminale non è riuscito: guarda il log»:** la shell non è partita; il motivo è nel log dell'app. Controllate che `$SHELL` (Unix) o PowerShell (Windows) esistano.
- **Su Windows** il terminale usa ConPTY e un Job Object; il funzionamento reale non è ancora provato su un computer Windows (vedi [`docs/qa/m23-terminale.md`](../qa/m23-terminale.md)).
