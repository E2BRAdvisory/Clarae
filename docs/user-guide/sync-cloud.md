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
