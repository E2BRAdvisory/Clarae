# Vault privati e condivisi

Quando collegate un vault al cloud scegliete uno di due tipi. **La scelta è definitiva**: non si può cambiare in seguito (per cambiare tipo si crea un nuovo vault e si spostano le note).

|                               | Vault **condiviso**                                             | Vault **privato**                                               |
| ----------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| Cifratura end-to-end (E2EE)   | No: le note sono salvate in chiaro sul server                   | **Sì**: cifrate sul vostro dispositivo prima di uscire          |
| Chi può leggere il contenuto  | Voi, le persone con cui condividete, e chi amministra il server | **Solo voi** (chi conosce passphrase o chiave di recupero)      |
| Nomi di file e cartelle       | Visibili al server                                              | Cifrati: il server non li vede                                  |
| Condivisione con altri        | Sì, con utenti e gruppi                                         | **No**                                                          |
| Esportazione ZIP dalla Web UI | Sì                                                              | Sì, ma decifrata **nel vostro browser** con passphrase o chiave |
| Se perdete l'accesso          | L'amministratore può aiutarvi con l'account                     | **I dati sono irrecuperabili**                                  |

## Che cosa significa "E2EE"

_End-to-end encryption_: la cifratura avviene sul vostro computer, con una chiave che il server non possiede mai. Il server conserva solo dati illeggibili e non può né leggerli né consegnarli a terzi, neppure su richiesta dell'amministratore. Dettagli utili:

- Il contenuto è protetto da una chiave casuale a 256 bit del vault. Questa chiave è a sua volta protetta dalla vostra **passphrase** (trasformata con una funzione lenta, Argon2id, per rendere costoso indovinarla) e da una **chiave di recupero**.
- La passphrase del vault è **diversa dalla password dell'account** e **non viene mai inviata** al server.
- Poiché il server non vede il contenuto, per i vault privati **non** funzionano le funzioni che richiedono di leggerlo lato server (condivisione, esportazione dal server). La ricerca e il grafo funzionano normalmente perché sono calcolati sul vostro dispositivo.
- I metadati inevitabili (dimensione dei blocchi cifrati, momenti di sincronizzazione) restano visibili al server.

## Passphrase e chiave di recupero

Creando un vault privato scegliete una **passphrase** (almeno 12 caratteri; alcune parole casuali sono meglio di una parola con simboli). L'app mostra la **chiave di recupero** **una sola volta**: copiatela, salvatela come file o stampatela e conservatela in un posto sicuro (gestore di password, cassaforte). Per confermare vi chiede di digitarla di nuovo.

- **Dimenticata la passphrase:** sbloccate con la chiave di recupero; l'app vi fa scegliere subito una nuova passphrase e vi propone di generare una nuova chiave di recupero (la vecchia smette di funzionare).
- **Persa la chiave ma ricordate la passphrase:** continuate a usare il vault e, appena possibile, generate una nuova chiave di recupero.
- **Persi entrambi:** **nessuno può recuperare i dati**, nemmeno gli amministratori. Se esiste una copia locale decifrata del vault su un dispositivo già sbloccato, copiatela subito altrove.
- Su ogni nuovo dispositivo il vault si **sblocca** con la passphrase (o la chiave di recupero); _Sblocca vault cifrato_ nella palette comandi riapre la finestra se l'avete chiusa.

## Quale scegliere?

Scegliete **privato** per diari, dati personali o sensibili e quando non serve condividere. Scegliete **condiviso** quando volete collaborare con colleghi o gruppi, o quando l'organizzazione vuole poter assistere nel recupero. Se avete dubbi: un vault privato è più sicuro, ma la sicurezza ha il prezzo dell'irrecuperabilità.
