# Sincronizzazione e cloud

La sincronizzazione è **facoltativa**. Serve un server Clarae notanda (fornito dalla vostra organizzazione) e un account.

## Collegarsi al server

1. _Impostazioni → Cloud_: inserite l'**URL del server** (il resto della configurazione si scarica da lì) e scegliete _Accedi_.
2. Il login si completa nel **browser di sistema** (non nell'app): se il collegamento locale non è possibile, l'app ripiega sullo schema `clarae://` (se il realm del server è stato creato per la 1.x e non ha il redirect nuovo, ricade da sola su quello precedente). Il token di rinnovo è custodito nel **portachiavi** del sistema.
3. Sotto _Cloud_ vedete il profilo, lo spazio usato e i **dispositivi** collegati (si possono revocare). Nell'elenco dello spazio, ogni vault mostra la **percentuale rispetto al vostro limite** (non rispetto alla somma dei vault); con spazio illimitato mostra «—». Un suggerimento sulla cella dice il limite.

### Uscire

_Esci_ (nel menu dell'account) ferma la sincronizzazione, **revoca questo dispositivo** sul cloud, chiude la vostra sessione sul servizio di accesso e cancella la sessione locale; i vault e le modifiche non ancora inviate restano sul computer. Se manca la rete l'uscita avviene comunque: il dispositivo resta registrato e al prossimo accesso viene ripreso. **Il successivo _Accedi_ chiede di nuovo la password**, anche se il browser di sistema ricorda ancora l'accesso.

Un computer è identificato dal **nome** con cui il sistema lo conosce (e dalla piattaforma): dopo _Esci_ e un nuovo accesso compare **la stessa riga** nell'elenco dei dispositivi, non una nuova. Due computer con lo stesso nome diventano un solo dispositivo: rinominatene uno. Un dispositivo che avete revocato dalla Web UI e che poi si ricollega **con lo stesso nome** viene riattivato.

## Collegare un vault

_Collega il vault al cloud_ (palette comandi) avvia una procedura guidata. Dovete scegliere il **tipo di vault**, e la scelta è **definitiva**:

- **Condiviso** (non cifrato end-to-end): condivisibile con altri utenti e gruppi;
- **Privato** (cifrato end-to-end): solo vostro, non condivisibile.

Leggete [Vault privati e condivisi](vault-privati-condivisi.md) prima di scegliere. Si può anche collegare un vault già presente sul server (altro dispositivo): i file vengono scaricati nella cartella scelta.

## Gestire i vault nel cloud

_Impostazioni → Cloud_ (sul desktop e nel workbench del browser) e la pagina _I miei vault_ della Web UI elencano i vostri vault nel cloud con dimensione, numero di file e data di creazione. Da lì:

- **Creare:** sul desktop _Nuovo vault_ apre la procedura _Collega il vault al cloud_ per il vault aperto (se non è già collegato). Nella Web UI _Nuovo vault_ chiede nome e tipo: un vault **condiviso** si crea subito; per un vault **privato** si apre il workbench del browser, che chiede la passphrase (due volte, almeno 12 caratteri) e mostra la chiave di recupero una sola volta, poi apre il vault appena creato. Le chiavi di un vault privato si creano sempre sul vostro dispositivo, mai sul server. Annullando si torna alla Web UI e non resta nulla.
- **Rinominare:** il nuovo nome vale per tutti i dispositivi e per la Web UI. Le cartelle sul computer **non** cambiano nome: cambia solo il nome mostrato in _Impostazioni → Sincronizzazione_.
- **Eliminare:** l'eliminazione è **logica**. Il server conserva il vault per il periodo di conservazione stabilito dall'amministratore (30 giorni se non diversamente configurato); in quel periodo il vault compare in _Vault eliminati_ e si può **ripristinare**, poi viene rimosso definitivamente. Sul dispositivo da cui lo eliminate, la copia locale **resta con tutti i suoi file** e viene **scollegata** dal cloud; per un vault privato il dispositivo dimentica anche la chiave. Gli altri dispositivi collegati smettono di sincronizzarlo (la loro copia locale resta dov'è: scollegatela da _Impostazioni → Sincronizzazione_) e chi lo riceveva in condivisione perde l'accesso. Nel workbench del browser il vault aperto nella pagina non si elimina da lì: tornate alla Web UI.
- **Ripristinare:** il vault torna nell'elenco con il suo contenuto e la sua cronologia. Non si ricollega da solo: sul dispositivo collegatelo di nuovo come _vault già presente sul server_ (per un vault privato servono passphrase o chiave di recupero). Se nel frattempo avete creato un altro vault con lo stesso nome, rinominate prima quello.

## Come funziona

Il client elenca le modifiche del server, scarica quelle nuove, poi invia le proprie. L'indicatore in fondo alla barra laterale destra (nell'intestazione se la barra è chiusa) mostra: sincronizzato, in corso, offline, errore, conflitti, account sospeso, vault bloccato. _Sincronizza ora_ (`Mod+Maiusc+S`) forza un ciclo. Le notifiche dal server rendono la sincronizzazione quasi immediata; in assenza il client controlla periodicamente (intervallo configurabile in _Impostazioni → Sincronizzazione_, salvo diversa indicazione dell'amministratore).

Si sincronizzano le note, gli allegati e i file di tipo `.canvas`, `.base`, `.excalidraw`, più alcune impostazioni (segnalibri, scorciatoie…). **Non** si sincronizzano l'indice di ricerca, i workspace e le impostazioni specifiche del dispositivo.

### File non inviati

_Impostazioni → Sincronizzazione_ ha un blocco **File non inviati**: elenca i file di questo dispositivo che non arrivano al cloud, raggruppati per motivo, con il numero di file di ogni gruppo e, accanto al percorso, il codice o il dettaglio dell'errore. Se non c'è nulla da segnalare compare «Tutti i file sono stati inviati.». L'elenco si aggiorna da solo a ogni ciclo di sincronizzazione.

| Motivo mostrato                                    | Che cosa significa e che cosa fare                                                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Troppo grandi                                      | Il file supera il limite di dimensione per file stabilito dall'amministratore. Riducetelo o tenetelo fuori dal vault, poi _Riprova_.                |
| Cifratura non riuscita                             | Il percorso o il contenuto non si è potuto cifrare (vault privato). _Riprova_; se si ripete, controllate il log.                                    |
| Spostamento che svuoterebbe una cartella condivisa | Lo spostamento lascerebbe vuota una cartella condivisa con voi. Rimettete il file al suo posto, oppure _Riprova_ dopo aver cambiato lo spostamento. |
| Rifiutati dal server                               | Il server ha rifiutato il file; il codice è accanto al percorso. Dopo aver rimosso la causa, _Riprova_.                                             |
| In errore, si riprova                              | L'invio è fallito e l'app ritenta da sola: di solito non serve fare nulla. Se il file passa a un altro gruppo, agite secondo quel motivo.           |
| Troppe modifiche concorrenti: risolvi i conflitti  | Altri dispositivi continuano a modificare il file. Usate _Risolvi conflitti di sincronizzazione_ (vedi [Conflitti](#conflitti)).                    |
| In attesa di unire una modifica del server         | Il file sarà inviato dopo l'unione di una modifica arrivata dal server: lo risolve il ciclo successivo.                                             |
| Nome non valido: rinomina il file                  | Il nome non è ammesso dalle regole del vault (per esempio caratteri o formato non rappresentabili): rinominate il file.                             |
| Collegamenti simbolici (mai seguiti)               | I collegamenti simbolici non si sincronizzano mai. Se serve il contenuto, copiatelo nel vault come file.                                            |

Gli ultimi due motivi dell'elenco non sono errori: sotto **Cartelle escluse** (voce richiudibile, con il numero) compaiono, come informazione, le cartelle dei sistemi di versione («Repository di un sistema di versione») e il cestino del vault («Cestino del vault»). Non richiedono azioni e non sono contate tra i file non inviati.

**Riprova** compare accanto ai file che l'app ha smesso di ritentare e che possono essere reinviati (troppo grandi, cifratura non riuscita, spostamento che svuoterebbe una cartella condivisa, rifiutati dal server): rimette in coda quel file. **Riprova tutti** rimette in coda tutti questi file insieme. I pulsanti non ci sono per gli altri motivi, perché il file si sblocca in un altro modo (conflitti, rinomina) o da solo. Il file viene reinviato al ciclo successivo e, se il problema persiste, torna nell'elenco.

**Che cosa non è elencato.** Non si sincronizzano mai, e non compaiono nel blocco: i file di sistema come `.DS_Store` e `Thumbs.db`, i file temporanei e i dati locali del dispositivo in `.clarae`.

**Cartelle dei sistemi di versione.** Le cartelle `.git`, `.hg`, `.svn`, `.bzr` e `.jj` (anche come file, a qualunque profondità, senza distinzione di maiuscole) non si sincronizzano mai, nemmeno se il vault è un repository: per portare il repository su un altro dispositivo usate il sistema di versione stesso. Le note del vault continuano a sincronizzarsi. Se copie di quei file sono già nel cloud (inviate da una versione precedente) **restano lì e contano nella quota**; i dispositivi aggiornati non le toccano né le cancellano.

## Conflitti

Il merge avviene **sul vostro dispositivo**. Per le note Markdown le modifiche concorrenti in punti diversi si **uniscono automaticamente** (merge a tre vie); se le stesse righe cambiano da due parti, o per file di altro tipo, si crea una **copia di conflitto** (`nome (conflitto <dispositivo> <data ora>).ext`) e nessuna versione viene persa: _Risolvi conflitti di sincronizzazione_ mostra le due versioni affiancate (diff) e permette di tenere una, l'altra o unirle a mano. Le versioni scartate restano nella cronologia ([Cronologia e recupero](cronologia-recupero.md)). Tra i file di altro tipo, i disegni si fondono per elemento quando i dispositivi sono dello stesso utente, e la **libreria di forme** dei disegni si fonde sempre forma per forma: se due dispositivi ne aggiungono di diverse restano entrambe.

## Più dispositivi

Accedete con lo stesso account sull'altro dispositivo e collegate lo stesso vault. Per un vault **privato** serve la passphrase (o la chiave di recupero) su ogni dispositivo. Un dispositivo smarrito si revoca da _Cloud_ (o dalla Web UI, pagina _Dispositivi_). Se un dispositivo risulta revocato, la sincronizzazione si ferma e compare «Registra di nuovo questo dispositivo»: riattiva la stessa riga.

## Sospeso, quota, offline

- **Quota esaurita:** le modifiche locali restano al sicuro sul dispositivo; liberate spazio o chiedete all'amministratore di aumentare la quota; la sincronizzazione riprende da sola.
- **Account sospeso:** la sincronizzazione si ferma, i dati locali restano intatti.
- **Offline:** l'app funziona normalmente, le modifiche si inviano al ritorno della rete.
