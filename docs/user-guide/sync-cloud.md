# Sincronizzazione e cloud

La sincronizzazione è **facoltativa**. Serve un server MemoBrain Notes (fornito dalla vostra organizzazione) e un account.

## Collegarsi al server

1. _Impostazioni → Cloud_: inserite l'**URL del server** (il resto della configurazione si scarica da lì) e scegliete _Accedi_.
2. Il login si completa nel **browser di sistema** (non nell'app): se il collegamento locale non è possibile, l'app ripiega sullo schema `memobrain://`. Il token di rinnovo è custodito nel **portachiavi** del sistema.
3. Sotto _Cloud_ vedete il profilo, lo spazio usato e i **dispositivi** collegati (si possono revocare).

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

## Conflitti

Il merge avviene **sul vostro dispositivo**. Per le note Markdown le modifiche concorrenti in punti diversi si **uniscono automaticamente** (merge a tre vie); se le stesse righe cambiano da due parti, o per file di altro tipo, si crea una **copia di conflitto** (`nome (conflitto <dispositivo> <data ora>).ext`) e nessuna versione viene persa: _Risolvi conflitti di sincronizzazione_ mostra le due versioni affiancate (diff) e permette di tenere una, l'altra o unirle a mano. Le versioni scartate restano nella cronologia ([Cronologia e recupero](cronologia-recupero.md)).

## Più dispositivi

Accedete con lo stesso account sull'altro dispositivo e collegate lo stesso vault. Per un vault **privato** serve la passphrase (o la chiave di recupero) su ogni dispositivo. Un dispositivo smarrito si revoca da _Cloud_ (o dalla Web UI, pagina _Dispositivi_).

## Sospeso, quota, offline

- **Quota esaurita:** le modifiche locali restano al sicuro sul dispositivo; liberate spazio o chiedete all'amministratore di aumentare la quota; la sincronizzazione riprende da sola.
- **Account sospeso:** la sincronizzazione si ferma, i dati locali restano intatti.
- **Offline:** l'app funziona normalmente, le modifiche si inviano al ritorno della rete.
