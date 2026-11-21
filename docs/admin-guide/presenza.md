# Presenza in tempo reale

Dalla 1.8.2 il cloud ha un canale WebSocket, `GET /api/v1/presence`, che porta gli avatar e i cursori degli altri utenti sullo stesso file dei vault **condivisi** (ADR-0065). È la prima connessione client→cloud in tempo reale: va tenuta in conto nel proxy. Per l'utente: [Presenza](../user-guide/presenza.md).

## Il flag `features.presence`

- Chiave del Config Profile, **acceso di default**, nessun blocco (`locked_keys` non ha effetto). Tabella delle chiavi: [Profili, quote, audit](profili-quote-audit.md).
- Spento, il client non apre la connessione e il cloud, se la riceve, risponde `presence-disabled` e la chiude (close code 4403). Vale **a caldo**: le connessioni aperte si chiudono entro pochi istanti dalla modifica del profilo (e comunque entro 60 s, il ricontrollo periodico) e gli avatar spariscono dai client.
- I vault privati non hanno presenza in nessun caso.
- Nessuna variabile d'ambiente nuova: non c'è nulla da configurare oltre al proxy.

## Proxy e Ingress

La rotta `/api/v1/presence` non richiede header `Authorization` (il browser non può inviarli su un WebSocket): il primo frame porta il token e il cloud lo verifica come per le altre API. Il proxy deve:

1. lasciar passare l'**upgrade WebSocket** (`Connection: Upgrade`, `Upgrade: websocket`);
2. **non chiudere le connessioni inattive** prima del ping del server (ogni 30 s); per prudenza almeno **un'ora** di timeout di lettura e scrittura;
3. non applicare alla rotta limiti di durata della richiesta.

**Helm.** Il chart crea un Ingress dedicato, `<release>-presence`, con path esatto `/api/v1/presence` sull'host principale (`ingress.host`), che vince su `/`. I timeout di nginx (`proxy-read-timeout`, `proxy-send-timeout`) vengono da `ingress.presence.timeoutSeconds` (predefinito **3600**: tenetelo a 3600 o più). Con un altro controller mettete l'equivalente in `ingress.presence.annotations`, che si applicano solo a questo Ingress (le `ingress.annotations` comuni si applicano a tutti). Se `ingress.enabled` è `false`, il chart non crea nulla e la configurazione è del vostro proxy.

```yaml
ingress:
  presence:
    timeoutSeconds: 3600
    annotations: {}
```

**Docker Compose.** Il `Caddyfile` di `deploy/compose` non richiede modifiche: Caddy aggiorna la connessione da solo e non ha un timeout di inattività. Se Caddy è dietro un altro proxy, valgono i punti sopra per quest'ultimo.

**Origine.** Un browser può aprire la connessione solo dalla stessa origine del cloud (la Web UI incorporata); in sviluppo è ammessa anche l'origine di `WEB_UI_ORIGIN`. Il desktop non invia `Origin` ed è sempre accettato. Un proxy che riscrive l'`Host` può far fallire il controllo dell'origine: inoltrate l'`Host` originale.

**CSP.** La Web UI usa `connect-src 'self'`: nei browser attuali `'self'` copre `wss:` sulla stessa origine. Per Safari la corrispondenza è storicamente diversa: da Safari 15.4 va verificata sul campo (runbook [`docs/qa/m25-presenza.md`](../qa/m25-presenza.md)); se la console segnala un blocco CSP, la `connect-src` della Web UI dovrebbe nominare `wss://<host>` in modo esplicito (modifica del servizio, non una configurazione).

## Scala e limiti

- **Solo memoria.** Le stanze vivono nella RAM della replica che tiene le connessioni; non c'è tabella, cache esterna né Redis. Ogni membro costa poche centinaia di byte (identità e ultima posizione, al più 256 B). Un riavvio della replica azzera le sue stanze: i client si riconnettono da soli con attesa crescente.
- **Limiti per connessione.** 16 stanze, 40 movimenti al secondo (oltre, l'ultima posizione è trattenuta e inviata appena possibile), frame fino a 1 KiB (8 KiB per il frame `auth`).
- **Limite per utente e per replica.** Al più **32 connessioni per utente su ogni replica**; oltre, il server chiude con 1013 e il client riprova più tardi. Con N repliche il tetto effettivo è 32·N: il limite non è condiviso.
- **Più repliche.** Si parlano sul canale PostgreSQL `presence` (`LISTEN/NOTIFY`, lo stesso database del servizio, **senza pooler in modalità transaction**). Gli ingressi e le uscite dalle stanze arrivano a tutte le repliche; i movimenti solo se la stanza ha membri altrove, al più circa 15 al secondo. Ogni replica ripete i propri membri ogni **20 s** (mai scartato: coda fino a 100000 messaggi) e un membro che nessuno rinnova scade dopo **70 s**: se una replica muore, i suoi avatar spariscono dagli altri entro 70 s. Quando una replica riprende ad ascoltare chiede alle altre di annunciarsi.
- **Heartbeat.** Il server manda un ping ogni 30 s e chiude la connessione se il pong non arriva entro 20 s.
- **Permessi.** Si ricontrollano a ogni modifica delle condivisioni, sospensione o cambio di profilo, e ogni 60 s; i commit su un vault (per esempio uno spostamento di file fuori dallo scope di una share) fanno ricontrollare le sue stanze al più ogni 5 s per sessione, quindi chi esce dallo scope è espulso in circa 5 s. Una revoca toglie l'utente dalla stanza di quel file senza chiudere la connessione; una sospensione la chiude (4403).
- **Spegnimento ordinato.** Con il drain del servizio le connessioni si chiudono con «going away» e i client si riconnettono su un'altra replica.
- **Monitoraggio.** Per decisione dell'owner la 1.8.2 non ha metriche Prometheus dedicate alla presenza. I log in `debug` contano aperture e chiusure; non c'è un log per ogni frame né per le posizioni.

## Problemi comuni

| Sintomo                                                      | Causa probabile                                                    | Rimedio                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------- |
| Gli avatar compaiono e spariscono ogni minuto circa          | Il proxy chiude le connessioni inattive (60 s di default)          | Alzare i timeout (`ingress.presence.timeoutSeconds`)    |
| Nessuno vede nessuno                                         | Upgrade WebSocket bloccato dal proxy, o `features.presence` spento | Verificare l'upgrade e il profilo effettivo dell'utente |
| Gli avatar di un utente restano fino a 70 s dopo la chiusura | La replica che lo serviva è caduta                                 | Atteso: scadono con il TTL                              |
| Il browser non si collega, il desktop sì                     | Origine non ammessa o CSP                                          | Vedere «Origine» e «CSP» sopra                          |
