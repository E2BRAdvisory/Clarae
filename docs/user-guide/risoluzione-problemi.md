# Risoluzione dei problemi

| Sintomo                                                     | Cosa controllare / cosa fare                                                                                                                                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| La ricerca non trova note che esistono                      | Palette comandi → _Ricostruisci indice_. L'indice è locale e ricostruibile senza perdere nulla. La ricerca per sottostringa richiede almeno 3 caratteri.                                                    |
| Il login nel browser non torna all'app                      | Verificate che l'app sia ancora aperta; su Windows/Linux lo schema `nodus://` deve essere registrato (reinstallate se necessario). Potete forzare il ripiego con la variabile `NODUS_AUTH_REDIRECT=scheme`. |
| "Account sospeso" o la sincronizzazione si ferma            | Il vostro account è stato sospeso dall'amministratore: i dati locali sono intatti. Contattate l'amministratore; riprenderà da solo dopo la riattivazione.                                                   |
| "Quota esaurita"                                            | Le modifiche restano sul dispositivo. Liberate spazio (la quota conta solo i file correnti, non lo storico) o chiedete un aumento.                                                                          |
| Un file è troppo grande per sincronizzarsi                  | C'è un limite di dimensione per file stabilito dall'amministratore; riducete il file o tenetelo fuori dal vault sincronizzato.                                                                              |
| Compare una copia "(conflitto …)"                           | Due dispositivi hanno modificato lo stesso file. Aprite _Risolvi conflitti di sincronizzazione_, confrontate e tenete la versione giusta; nulla è andato perso.                                             |
| La nota è cambiata su disco mentre la modificavo            | Un altro programma ha modificato il file: scegliete _Ricarica_ (vedete il nuovo contenuto) o _Sovrascrivi_ (tenete il vostro). L'app non sovrascrive da sola.                                               |
| Ho cancellato una nota per errore                           | _Recupera file eliminati_, oppure il cestino del sistema/del vault. Vedi [Cronologia e recupero](cronologia-recupero.md).                                                                                   |
| Ho sbagliato a modificare una nota                          | _Recupero file per questa nota_ → scegliete una versione precedente → _Ripristina_.                                                                                                                         |
| Ho dimenticato la passphrase del vault privato              | Sbloccate con la **chiave di recupero** e scegliete una nuova passphrase. Senza passphrase né chiave i dati non sono recuperabili da nessuno.                                                               |
| Il vault privato risulta "Bloccato" su un nuovo dispositivo | È normale: inserite la passphrase (o la chiave di recupero) con _Sblocca vault cifrato_.                                                                                                                    |
| Non posso condividere questo vault                          | I vault **privati** non sono condivisibili (per scelta, per la cifratura). Serve un vault condiviso.                                                                                                        |
| Il download ZIP di un vault privato non parte               | Si costruisce nel browser: serve la passphrase/chiave e una scheda aperta fino alla fine; vault molto grandi richiedono memoria e tempo.                                                                    |
| Un disegno non si apre / appare vuoto offline               | Gli asset sono inclusi nell'app; se il problema persiste riavviate l'app e segnalatelo con il file di log.                                                                                                  |
| L'app è lenta con un vault enorme                           | Chiudete il grafo globale (usate il grafo locale), evitate schede con basi molto grandi; l'indice iniziale può richiedere tempo.                                                                            |
| Un link non si risolve                                      | Controllate maiuscole/spazi e il formato dei link in _Impostazioni → File e link_; i link non attraversano vault diversi.                                                                                   |

## Dove trovare i log e i dati

I log dell'app sono in `logs/nodus.log` nella cartella dati (_Impostazioni → Informazioni_ mostra il percorso; il file ruota a 10 MB). Contengono eventi tecnici e **non** il testo delle note. L'invio automatico di crash report non è previsto in questa versione.

## Segnalare un problema

Indicate: versione (_Informazioni_), sistema operativo, cosa stavate facendo, e se possibile un estratto del log. Per i problemi del server, l'amministratore consulta il [runbook](../admin-guide/runbook.md).
