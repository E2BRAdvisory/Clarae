# Condivisione e gruppi

La condivisione è disponibile solo per i **vault condivisi** (non cifrati), mai per quelli privati. Si può condividere l'**intero vault**, una **cartella** o un singolo **documento** (le note, gli allegati e i file di lavagna/disegno).

## Condividere

1. Clic destro su una cartella o nota nell'albero → _Condividi…_ (oppure _Condividi la nota corrente…_ dalla palette; per tutto il vault: _Condividi l'intero vault…_).
2. Cercate **persone e gruppi** e aggiungeteli come destinatari.
3. Scegliete il **livello** per ciascuno: **Lettore** (sola lettura), **Editor** (modifica), **Gestore** (modifica e gestione della condivisione).
4. _Condividi_: i destinatari ricevono un **invito**.

Le _Condivisioni esistenti_ si vedono e si modificano nella stessa finestra (cambiare livello, aggiungere o rimuovere destinatari, **revocare**). Revocare interrompe subito l'accesso.

## Ricevere un invito

Gli inviti compaiono nella barra di stato ("1 invito") e in _Impostazioni → Condivisione_, e nella Web UI alla pagina _Condivisioni_. **Accettate** o **rifiutate**. Un invito accettato diventa un **mount**: un vault separato, intitolato come la condivisione, che si apre con _Apri_. Il mount è a tutti gli effetti un altro vault: i link, i backlink, la ricerca e il grafo **non attraversano** il vostro vault personale e il mount.

La barra di stato mostra il vostro permesso (es. "Lettore · sola lettura"); con il permesso di lettore l'editor non accetta modifiche e l'albero non offre di creare nulla.

## Quando la condivisione termina

Se il proprietario revoca la condivisione, l'app chiede cosa fare della vostra copia: **eliminarla** oppure **conservarla** come vault normale, scollegato (in una cartella indicata). Potete anche _Rimuovere dal dispositivo_ un mount, con la stessa scelta; il proprietario mantiene i suoi file.

## Consigli sulla collaborazione

La collaborazione è **asincrona**: ciascuno lavora sulla propria copia e le modifiche si uniscono alla sincronizzazione. L'unione automatica è garantita per le note Markdown; per lavagne, disegni e basi, se due persone modificano lo stesso file nello stesso intervallo, si crea una **copia di conflitto** (nessuna versione si perde). Lo spazio usato conta sulla **quota del proprietario** della condivisione.

## Gruppi

I **gruppi** li crea e li gestisce l'amministratore (console web). Servono per condividere con molte persone in una volta e per distribuire configurazioni. Non sono importati da altri sistemi. Se non trovate un gruppo nella ricerca dei destinatari, chiedete all'amministratore.
