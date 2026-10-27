# Config profile, quote, limiti e audit

Tutte le funzioni di questa pagina stanno nella **console di amministrazione** della Web UI (visibile agli utenti con ruolo `memobrain-admin`).

## Gruppi

Un gruppo è un insieme di utenti usato per **condividere** cartelle/vault e per **assegnare config profile**. Si gestiscono in _Amministrazione → Gruppi_ (crea, rinomina, aggiungi/rimuovi membri). Eliminare un gruppo elimina anche le sue condivisioni e le assegnazioni dei profili. I gruppi esistono solo nel database di MemoBrain Notes (non in Keycloak).

## Config profile

Un profilo è un JSON **versionato** che l'amministratore distribuisce ai client desktop; serve anche da feature flag. Ordine di risoluzione, dal meno al più prioritario:

1. valori predefiniti del prodotto;
2. profilo **globale**;
3. profili dei **gruppi** dell'utente, in ordine di priorità (si imposta nella pagina del gruppo);
4. impostazioni dell'utente, **tranne** le chiavi bloccate (`locked_keys`).

Le chiavi di primo livello ammesse sono quelle dello schema (`editor`, `appearance`, `hotkeys`, `features`, …); l'editor segnala chiavi sconosciute, JSON non valido e chiavi bloccate non valide. Sul client le impostazioni bloccate appaiono disabilitate con "gestito dall'amministratore". Ogni salvataggio crea una nuova versione (storico con possibilità di **ripristino**) e i client si aggiornano via notifica. Esempi di uso come feature flag: `features.sharing = false`, `features.drawings = false`.

La pagina di un utente mostra la **configurazione effettiva** risolta (con le chiavi bloccate), utile per capire perché un client si comporta in un certo modo.

## Quote e limiti

_Amministrazione → Limiti_ (impostazioni runtime, senza riavvio):

| Impostazione               | Significato                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Quota predefinita          | Spazio per utente se non c'è un override personale.                                          |
| Soglie di avviso / critica | Percentuali (`warn_percent` < `critical_percent`) che colorano le barre di utilizzo.         |
| Conservazione storico      | Giorni di tutte le revisioni (`history.retention_days`) e giorni di una revisione al giorno. |
| Dimensione massima file    | Oltre il limite il file non si sincronizza (errore chiaro al client).                        |

Regole da conoscere: la quota conta **solo i file correnti**, non lo storico (D-03); i vault **condivisi** consumano la quota del proprietario, anche se a scrivere è un altro utente; un valore `-1` significa "illimitato". Per cambiare la quota di un utente: _Utenti → utente → Cambia quota…_; per più utenti selezionarli nella lista e usare la quota in blocco. _Amministrazione → Archiviazione_ mostra l'utilizzo totale, la tendenza giornaliera e i principali consumatori.

## Sospensione, ruoli, eliminazione

Dalla pagina dell'utente: sospendi/riattiva (effetto entro 30 s), cambia ruolo, reimposta password (via Keycloak), elimina. Un utente eliminato entra nel periodo di conservazione dei suoi vault (`vaults.deleted_retention_days`, default 30 giorni) prima del purge definitivo. Non si può sospendere/eliminare l'ultimo amministratore né se stessi.

## Registro di audit

_Amministrazione → Audit_ elenca le azioni amministrative e di condivisione con data, attore, IP, bersaglio e dettagli; è filtrabile per attore, azione e periodo, paginato con cursore ed esportabile in **CSV**. Azioni registrate:

| Area         | Azioni                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Utenti       | `user.create`, `user.update`, `user.delete`, `user.suspend`, `user.activate`, `user.quota`, `user.role`, `user.reset_password` |
| Gruppi       | `group.create`, `group.update`, `group.delete`                                                                                 |
| Condivisioni | `share.create`, `share.update`, `share.revoke`, `share.accept`, `share.decline`                                                |
| Export       | `vault.export`, `vault.zip`                                                                                                    |

Il registro non contiene contenuti di note, nomi di file né segreti. Le voci non si modificano dall'interfaccia. Una politica di conservazione dell'audit non è configurabile in questa versione: pianificare l'archiviazione esterna (CSV periodico o dump della tabella) se richiesto da normative.
