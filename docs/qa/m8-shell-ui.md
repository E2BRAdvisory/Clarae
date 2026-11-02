# Checklist manuale — revisione della shell desktop (M8)

Da eseguire sull'app reale (`task run-desktop`, e `scripts/run-desktop-with-cloud.sh` per le voci cloud). Gli automatismi (vitest, Playwright su mock Wails, conformance Go e TS) coprono layout, comandi, tab, statistiche e presentazioni; qui si verifica ciò che solo una webview vera mostra. Riferimenti: ADR-0026 (shell) e ADR-0027 (slide).

Segnare `[x]` con data e sistema operativo.

## Layout e tema

- [ ] Intestazione, azioni rapide, barra sinistra, area editor e barra destra corrispondono al mockup; con la barra sinistra chiusa restano visibili le azioni rapide (con impostazioni e account in fondo).
- [ ] Sui semafori di macOS l'intestazione non copre i pulsanti e si può trascinare la finestra dalla sua parte vuota; i pulsanti non avviano il trascinamento.
- [ ] Il pulsante chiaro/scuro cambia tema subito e il valore resta dopo un riavvio; «Sistema» nelle impostazioni segue ancora il tema del sistema.
- [ ] Ridimensionando la finestra al minimo nulla si sovrappone e nessun pulsante esce dallo schermo; zoom dell'interfaccia al 200 % utilizzabile.
- [ ] Un `workspace.json` creato prima di M8 (schede _Tag_ o _Segnalibri_ a sinistra, _Struttura_ a destra) si apre senza errori e senza perdere le schede aperte.

## Azioni rapide

- [ ] Esplora file: niente pulsanti «nuova nota/cartella» sopra l'albero (restano nel menu contestuale e nelle azioni rapide); le cartelle hanno l'icona chiusa/aperta.
- [ ] Nuova cartella, nota, lavagna, disegno e base creano il file dove ci si aspetta (cartella configurata o cartella della nota aperta) e lo aprono.
- [ ] _Separatore_ inserisce `---` sotto la riga corrente con una riga vuota prima, e non trasforma il testo sopra in titolo; è disabilitato in vista lettura e su un vault di sola lettura.
- [ ] _Esporta in PDF_ apre il dialogo di stampa; _Esporta come immagine_ salva un PNG leggibile (formule, immagini, diagrammi inclusi). **Verifica in WKWebView, WebView2 e WebKitGTK**: se il canvas risulta «tainted» il comando mostra un errore invece del file.

## Schede

- [ ] Blocca/Sblocca dal menu della scheda: la scheda bloccata mostra la puntina, non si chiude con ✕, clic centrale, `Canc`, `Mod+W` né con le chiusure di massa; aprendo un'altra nota dall'albero questa va in una scheda nuova.
- [ ] Chiudi a destra, a sinistra, altre, tutte: le voci che non chiuderebbero nulla sono disabilitate; le schede bloccate restano.
- [ ] Eliminando il file di una scheda bloccata, la scheda si chiude.
- [ ] Dopo un riavvio le schede bloccate sono ancora bloccate.

## Barre laterali

- [ ] Sinistra: _File_ e _Struttura_; la lente in alto apre la ricerca come terza scheda (`Mod+Maiusc+F`); un tag cliccato filtra la ricerca.
- [ ] Destra (icone con suggerimento): _Proprietà_, _Tag_, _Link_ (link in uscita, backlink, segnalibri), _Slide_, _Statistiche_; i segnalibri aggiunti dal menu del file compaiono nella scheda _Link_.
- [ ] _Statistiche_: date, versioni locali, dimensione e conteggi sono plausibili; la data di creazione senza ora (`created: 2025-05-04`) non scivola di giorno in nessun fuso orario; il segno «≈» compare solo quando manca `created`.
- [ ] _Statistiche_ su un vault condiviso collegato: versioni cloud, autore dell'ultima revisione, elenco di utenti e gruppi con il livello; su un mount: «Condiviso da…»; su un vault privato: «non condivisibile».
- [ ] Lo stato del vault (indicizzazione, sync, permesso, aggiornamento, inviti) è in fondo alla barra destra e passa nell'intestazione quando la barra si chiude; l'indicatore di sincronizzazione continua a essere annunciato dallo screen reader.

## Vault e account

- [ ] In fondo alla barra sinistra: nome e numero di note; il menu elenca i vault recenti (senza quello aperto); sceglierne uno lo apre, salva prima il workspace del vecchio e il vecchio si chiude (nessuna modifica persa, anche con una modifica fatta meno di un secondo prima).
- [ ] «Apri un'altra cartella…» apre il selettore di sistema; «Chiudi vault» torna alla schermata iniziale. Il comando _Cambia vault_ apre il menu anche a barra sinistra chiusa.
- [ ] Con un vault collegato compare «Privato» o «Condiviso» accanto al nome.
- [ ] Senza accesso: _Accedi_ in fondo alle azioni rapide apre il browser di sistema; dopo il login compaiono le iniziali; il menu offre _Account e dispositivi…_ ed _Esci_.
- [ ] Senza server noto, _Accedi_ apre le impostazioni cloud; con il server noto non chiede nulla.
- [ ] Spegnendo il server o la rete dopo l'accesso: l'avatar ha il bordo di avviso, il suggerimento dice «disconnesso» e il menu offre _Riconnetti_.

## Presentazioni (ADR-0027)

- [ ] Una nota con `---`, note `Note:` e opzioni nel frontmatter: la scheda _Slide_ mostra una miniatura per slide, con titolo corretto; cambiare transizione/tema/opzioni riscrive il frontmatter senza perdere altre proprietà né il cursore.
- [ ] _Avvia la presentazione_ e _Dalla slide corrente_ partono dalla slide giusta; frecce, `Spazio`, `Home`/`Fine`, clic, `P`, `Esc` funzionano; le slide con immagini, formule, Mermaid e callout si vedono come in vista lettura.
- [ ] Schermo intero in WKWebView, WebView2 e WebKitGTK: se il sistema lo nega la presentazione occupa comunque tutta la finestra; uscendo dallo schermo intero con `Esc` del sistema la presentazione termina.
- [ ] Le transizioni sono disattivate con «riduci movimento» attivo nel sistema; il tema chiaro/scuro/automatico delle slide è corretto con entrambi i temi dell'app.
- [ ] Con la rete scollegata la presentazione funziona uguale (nessuna richiesta esterna).
- [ ] Su un vault condiviso in sola lettura: si può presentare, le opzioni sono disabilitate.
- [ ] Un vault Obsidian con plugin di slide: le note con `---` si aprono normalmente in Obsidian e le chiavi `slide-*` e `Note:` non rompono nulla.

## Barra di stato (ADR-0035)

- [ ] Per default non c'è: nessuna riga sotto l'editor. _Impostazioni → Aspetto → Barra di stato_ e il comando _Mostra/nascondi barra di stato_ la accendono e la spengono; la scelta resta in `.memobrain/appearance.json` alla riapertura del vault.
- [ ] Su una nota: parole e caratteri come nella scheda _Statistiche_ (senza il frontmatter), con una selezione i conteggi della selezione al loro posto; riga:colonna segue il cursore ed è giusta appena si apre una scheda o si passa a un altro pannello; in vista Lettura niente riga:colonna.
- [ ] Il clic sulla modalità passa Live → Sorgente → Lettura → Live; su disegno, lavagna, base e grafo compare solo il tipo; senza schede la barra è vuota.
- [ ] Altezza dell'area editor corretta con barra e slot della chat accesi insieme (la barra sta sopra la chat); la barra non attraversa le barre laterali; sparisce durante una presentazione _Slide_ e del disegno.
- [ ] Con `appearance.statusBar` bloccato in un profilo di configurazione il controllo è disabilitato con «gestito dall'amministratore» e il comando non la cambia.

## Chat (slot)

- [ ] Per default non si vede nulla sotto l'editor. Con `features.chat=true` in un profilo di configurazione compare un campo disabilitato con la spiegazione «non ancora disponibile»; con `false` sparisce.

## Accessibilità

- [ ] Con VoiceOver/NVDA: le azioni rapide, l'intestazione e le schede a icona della barra destra hanno un nome parlante; una scheda bloccata è letta come «… (bloccata)»; il menu del vault e quello dell'account si usano con le frecce e `Esc` rimette il focus sul pulsante.
- [ ] La presentazione annuncia «Slide n di m» a ogni cambio e il focus resta dentro finché non si esce.
- [ ] Contrasto elevato e tema scuro: avatar, puntina delle schede bloccate e bordo di avviso sono distinguibili.
