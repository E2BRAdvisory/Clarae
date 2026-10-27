# Cronologia e recupero

Nodus non perde silenziosamente i vostri dati: ogni versione scartata resta recuperabile, in due modi.

## Versioni locali (snapshot)

Mentre scrivete, l'app crea **snapshot** automatici sul vostro dispositivo, nella cartella `.nodus/snapshots` del vault, senza duplicare contenuti identici. Si fanno anche **prima di un ripristino** e **prima che la sincronizzazione sovrascriva** una nota. In _Impostazioni → Recupero file_ regolate l'intervallo tra gli snapshot, per quanti giorni conservarli, la dimensione massima del singolo file e il limite totale di spazio.

## Versioni del cloud

Se il vault è sincronizzato, il server conserva le **revisioni** di ogni file (tutte per un certo numero di giorni, poi una al giorno, poi nulla: lo decide l'amministratore). Lo storico non conta nella quota.

## Ripristinare una versione

1. Aprite la nota → _Recupero file per questa nota_ (o _Cronologia versioni della nota_).
2. L'elenco unisce le versioni del dispositivo e del cloud, con data e origine. Selezionandone una vedete il **confronto** con il testo attuale.
3. _Ripristina questa versione_: la nota viene sostituita, ma **il testo attuale viene salvato prima**, quindi potete sempre tornare indietro.

Nei vault condivisi in sola lettura potete vedere le versioni ma non ripristinarle.

## File eliminati

_Recupera file eliminati_ elenca i file cancellati di cui esiste una versione salvata, con l'ultima versione disponibile; _Ripristina file_ lo ricrea. Le note eliminate vanno anche nel **cestino** (di sistema o del vault, a scelta in _Impostazioni → File e link_).

## Conflitti di sincronizzazione

Le copie di conflitto e le versioni scartate dal merge restano nella cronologia: vedi [Sincronizzazione e cloud](sync-cloud.md).
