# Proposta di aggiornamento di `Specifications.md` alla v1.9

> **Applicata il 2026-11-20, con i punti facoltativi** (sezioni 8, 9 e la riga di ADR-0060 in C.4), su istruzione esplicita dell'owner: `Specifications.md` è alla v1.9 e recepisce ADR-0065 (data 20 novembre 2026). **Il testo qui sotto è la storia della proposta**: dove dice «da applicare» o «proposta» descrive lo stato prima dell'applicazione.

|                 |                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**       | proposta, **da applicare** a cura dell'owner (`Specifications.md` resta alla v1.8)                                                                                                                                                                                                                                                                  |
| **Data**        | 2026-11-20                                                                                                                                                                                                                                                                                                                                          |
| **Base**        | `Specifications.md` v1.8 (20 novembre 2026), 2059 righe; i numeri di riga sono quelli di questa versione                                                                                                                                                                                                                                            |
| **Fonte**       | [ADR-0065](adr/0065-presenza-in-tempo-reale.md), **accettato dall'owner il 2026-11-20**: presenza in tempo reale sui vault condivisi (avatar degli altri utenti sullo stesso file e cursori live). **In implementazione in M25** (versione di prodotto prevista 1.8.2), non rilasciato                                                              |
| **Come usarla** | ogni voce indica la sezione e la riga, il **testo attuale** (citato alla lettera, in un blocco `text`) e il **testo proposto**. Dove il testo proposto sostituisce un frammento, si sostituisce solo quel frammento; dove si aggiunge, la voce dice dopo quale riga. Metodo e forma sono quelli di [`spec-v1.8-proposta.md`](spec-v1.8-proposta.md) |

**Stato dell'implementazione al 2026-11-20 (verificato sul working tree).** C'è già: il modulo cloud `services/cloud/internal/presence` (hub, bus, outbox, protocollo, servizio), il client Go del core in `apps/desktop/internal/presence`, il flag `presence` in `api/config-profile.schema.json` (default `true`, con la copia in `shared/go/features`) e il codice d'errore `presence-disabled`. **Non c'è ancora:** la rotta `GET /api/v1/presence` registrata e dichiarata in `x-clarae-external-routes` di `api/openapi.yaml`, i binding e gli eventi `presence:*`, la voce `presence` del registro di parità, i componenti `Avatar`/`AvatarGroup` e la rimozione del pulsante «Nuova applicazione» dalla barra dell'esploratore (`packages/workbench/src/sidebar/FileExplorer.tsx` lo ha ancora). Il testo sotto scrive quindi la presenza **come decisione**, con la versione di prodotto «in implementazione in M25»; alla consegna il registro dice la versione (`1.8.2`).

**Presenza non è co-editing.** La presenza mostra **chi** ha aperto il file e **dove** ha il puntatore; nessuno scrive nello stesso documento in tempo reale. Non c'è CRDT, il seam Yjs resta spento ([ADR-0050](adr/0050-ai-inattiva-e-collab-spento.md), che resta in vigore), il merge resta sul client (D-04) e il server non interpreta il contenuto. Per questo il testo proposto **non toglie** l'esclusione dell'editing simultaneo: la restringe alla sola parte che resta vera.

---

## 1. Riepilogo

| Punto                   | Cosa cambia nello spec                                                                            | Sezione           |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ----------------- |
| Intestazione e registro | Versione 1.9, ADR 0051–0065 recepiti, riga 1.9                                                    | sezione 2         |
| V-01                    | Cloud: REST e gRPC, più un canale WebSocket per la sola presenza                                  | §0.3              |
| A-05                    | La presenza (avatar e cursori) è prevista nei vault condivisi; resta escluso l'editing simultaneo | §0.3              |
| §2.6.4                  | «non c'è editing simultaneo né presenza» diventa «non c'è editing simultaneo; c'è la presenza»    | §2.6.4            |
| D-04                    | «Asincrona» più «presenza in tempo reale, senza persistenza»                                      | C.1               |
| §3.7                    | `connect-src` del workbench: il WebSocket sulla stessa origine                                    | riga «Web UI»     |
| §2.6.6                  | Riga nuova `features.presence`                                                                    | §2.6.6            |
| §2.2.1 (facoltativo)    | Il pulsante «Nuova applicazione» non sta più nella barra dell'esploratore (emenda ADR-0060)       | riga «Web viewer» |
| C.2 (facoltativo)       | Riga di rischio: WebSocket dietro proxy e ingress, carico di `NOTIFY`, privacy                    | C.2               |
| C.4                     | Introduzione, riga di ADR-0060 (facoltativa), riga nuova di ADR-0065                              | C.4               |

---

## 2. Intestazione e registro delle revisioni

**Versione e data (righe 7-8).** Testo attuale:

```text
| **Versione documento** | 1.8 — Decisioni D-01…D-08 e ADR 0009–0022, 0024, 0026–0044 e 0051–0064 recepiti (vedi Appendice C) |
```

Testo proposto (la riga `| **Data** |` si aggiorna alla data di applicazione):

```text
| **Versione documento** | 1.9 — Decisioni D-01…D-08 e ADR 0009–0022, 0024, 0026–0044 e 0051–0065 recepiti (vedi Appendice C) |
```

**Registro delle revisioni.** Aggiungere in testa, prima della riga 1.8 (riga 17). Riga di ancoraggio, testo attuale:

```text
| 1.8 | 20 novembre 2026 | Recepiti gli ADR accettati dall'owner il 20 novembre 2026 (Appendice C.4): **ADR-0062**
```

Riga da inserire prima di quella (`[data]` è la data di applicazione):

```text
| 1.9 | [data] | Recepito l'ADR accettato dall'owner il 20 novembre 2026 (Appendice C.4): **ADR-0065** presenza in tempo reale sui vault condivisi: avatar degli altri utenti che hanno aperto lo stesso file e loro cursori live (nelle note il puntatore ancorato al testo, in riga e colonna; nei disegni e nei canvas coordinate di scena), tramite un canale WebSocket `GET /api/v1/presence` del cloud (primo canale client→cloud in tempo reale) e PostgreSQL `LISTEN/NOTIFY` tra le repliche; flag `features.presence` acceso di default e spegnibile dal Config Profile; nessuna persistenza, nessun audit; **non è co-editing**: l'editing simultaneo (CRDT) resta escluso (ADR-0050) e il merge resta sul client; i vault privati sono esclusi; emenda ADR-0060 (il pulsante «Nuova applicazione» esce dalla barra dell'esploratore) e integra ADR-0050 (**in implementazione in M25, versione di prodotto prevista 1.8.2, non rilasciato; nessuna prova reale con più utenti**). Sezioni modificate: §0.3 (V-01, A-05), §2.2.1, §2.6.4, §2.6.6, §3.7, C.1 (D-04), C.2, C.4. **Non** sono recepiti ADR-0023 e ADR-0050 (in stato proposta) e gli ADR 0045–0049 (accettati, non recepiti). |
```

---

## 3. §0.3 — V-01 e A-05

**V-01 (riga 56).** Testo attuale:

```text
| V-01 | Client: Wails (Go + React/TS). Cloud: Go, API REST e gRPC. |
```

Testo proposto:

```text
| V-01 | Client: Wails (Go + React/TS). Cloud: Go, API REST e gRPC, più un canale WebSocket per la sola presenza in tempo reale (§2.6.4, ADR-0065). |
```

**A-05 (riga 73).** Testo attuale:

```text
- **A-05** — La collaborazione è **asincrona** (sync + merge) e il merge multi-utente è garantito per i soli file `.md` condivisi (D-04). L'editing simultaneo in tempo reale (CRDT, presenza) non è previsto.
```

Testo proposto:

```text
- **A-05** — La collaborazione è **asincrona** (sync + merge) e il merge multi-utente è garantito per i soli file `.md` condivisi (D-04). L'editing simultaneo in tempo reale (CRDT) non è previsto. È prevista la **presenza** nei vault condivisi (§2.6.4, ADR-0065): avatar e cursori degli altri utenti che hanno aperto lo stesso file, senza che nessuno scriva in tempo reale nello stesso documento.
```

---

## 4. §2.6.4 «Condivisione» (riga 568)

Testo attuale (frammento):

```text
non c'è editing simultaneo né presenza. Il merge automatico tra utenti diversi
```

Testo proposto (sostituisce il frammento):

```text
non c'è editing simultaneo: ciascuno scrive la propria copia e il merge avviene sul client alla sincronizzazione. C'è invece la **presenza** (ADR-0065): sui soli vault **condivisi**, chi ha aperto un file vede gli avatar degli **altri** utenti che hanno aperto lo stesso file e, sopra il documento, il loro cursore con il nome (nelle note il puntatore, in riga e colonna; nei disegni e nei canvas, in coordinate di scena; per lettura, basi, PDF e applicazioni solo l'avatar). Colore deterministico per utente. Il file deve essere già sincronizzato e l'utente deve avere almeno il ruolo _viewer_ su quel file; perso l'accesso (revoca, sospensione, scadenza del token) la presenza cessa. La presenza non si scrive su disco, non entra nell'audit e non lascia log per movimento; si spegne con `features.presence` (§2.6.6). I vault privati non hanno presenza (nessun altro utente; il server non conosce i percorsi, D-02). Il merge automatico tra utenti diversi
```

---

## 5. §2.6.6, riga nuova `features.presence`

Dopo la riga `features.config_dir_v2` (riga 600). Riga di ancoraggio, testo attuale:

```text
| `features.config_dir_v2` | **acceso dalla 1.7.0** |
```

Riga da inserire dopo di essa (verificata su `api/config-profile.schema.json`: default `true`, descrizione di `features.presence`; codice `presence-disabled` in `services/cloud/internal/presence/protocol.go`):

```text
| `features.presence` | **acceso** | Presenza in tempo reale sui vault **condivisi** (§2.6.4, ADR-0065): avatar degli altri utenti che hanno aperto lo stesso file e loro cursori. Non è co-editing. Spento, il client non apre la connessione e non mostra nulla, e il cloud rifiuta l'ingresso con `presence-disabled` e chiude. Non ha effetto sui vault privati (non hanno presenza). La presenza non è salvata né sottoposta ad audit: spegnerlo non cancella nulla. Chi non la vuole la spegne dal profilo, globale o di gruppo (`{"features": {"presence": false}}`). Capability `presence` (desktop e workbench web) |
```

---

## 6. §3.7, riga «Web UI» (riga 1545)

Testo attuale (frammento):

```text
`connect-src 'self' blob:` più l'issuer
```

Testo proposto (sostituisce il frammento):

```text
`connect-src 'self' blob:` più l'issuer (`'self'` copre anche il WebSocket della presenza, `wss:` sulla stessa origine, ADR-0065; dove un browser non lo copre, si aggiunge `wss://<origine>` esplicito: da provare su Safari)
```

Altre misure di sicurezza del canale (ADR-0065), che lo spec non ha altrove e che si possono riassumere nella stessa riga o in C.2: autenticazione con il token bearer nel **primo frame** (il browser non invia header), identità (`user_id`, nome, id di sessione) timbrata dal server, autorizzazione per file al `join` e ricontrollata, frame ≤ 1 KiB, ≤ 40 `move`/s per connessione, ≤ 32 connessioni per utente, ≤ 16 stanze per connessione.

---

## 7. D-04 (riga 1957, Appendice C.1)

Testo attuale:

```text
| D-04 | Collaborazione | Asincrona; merge multi-utente garantito per i soli `.md` condivisi | §0.3, §2.6.4, §3.4.5 |
```

Testo proposto:

```text
| D-04 | Collaborazione | Asincrona; merge multi-utente garantito per i soli `.md` condivisi; presenza in tempo reale (avatar e cursori) sui vault condivisi, senza persistenza (ADR-0065) | §0.3, §2.6.4, §2.6.6, §3.4.5 |
```

---

## 8. §2.2.1, riga «Web viewer» (facoltativo, emenda ADR-0060)

Il pulsante «Nuova applicazione» esce dalla barra dell'esploratore. Il comando `app:new` resta in ribbon, nei menu contestuali, nella palette e nello stato vuoto (`packages/workbench/src/shell/Ribbon.tsx`, `workspace/EmptyPane.tsx`, `commands/registry.ts`). Testo attuale (frammento della riga 374):

```text
**Esploratore dei file:** un pulsante «Nuova applicazione» nella barra degli strumenti e la stessa voce nei due menu contestuali (su un elemento e sulla zona vuota) creano
```

Testo proposto (sostituisce il frammento; la barra dell'esploratore mostra al suo posto gli avatar degli altri utenti sullo stesso file, §2.6.4):

```text
**Esploratore dei file:** la voce «Nuova applicazione» nei due menu contestuali (su un elemento e sulla zona vuota) e il comando `app:new` (ribbon, palette, stato vuoto) creano
```

---

## 9. C.2, riga nuova (facoltativa)

Dopo la riga «Terminale integrato: una shell dell'utente fuori dalle regole dell'app…» (riga 1985). Riga di ancoraggio, testo attuale:

```text
| Terminale integrato: una shell dell'utente fuori dalle regole dell'app | Medio |
```

Riga da inserire dopo di essa:

```text
| Presenza in tempo reale: WebSocket dietro proxy e ingress, carico di PostgreSQL `NOTIFY`, privacy | Basso | Nessuna persistenza, nessun audit, nessun log per frame; limiti per frame, frequenza e connessioni; `NOTIFY` solo se la stanza ha membri su altre repliche, con coalescenza a ~15 Hz; spegnibile con `features.presence` (ADR-0065). **Da provare:** timeout e upgrade su un ingress vero (Caddy, Helm), il carico con più repliche, la CSP su Safari; nessuna prova reale con più utenti. Gli altri utenti del file vedono nome visualizzato e posizione del puntatore finché il file è aperto |
```

---

## 10. Appendice C.4 «ADR recepiti»

**Introduzione (riga 2008).** Tre frammenti.

Primo, testo attuale:

```text
0064 è implementato in M23 (1.8.0))
```

Testo proposto:

```text
0064 è implementato in M23 (1.8.0); 0065 nella v1.9: è in implementazione in M25, versione di prodotto prevista 1.8.2, non rilasciato)
```

Secondo, testo attuale:

```text
non toccati dalle revisioni 1.6, 1.7 e 1.8 (0045
```

Testo proposto:

```text
non toccati dalle revisioni 1.6, 1.7, 1.8 e 1.9 (0045
```

Terzo, testo attuale (fine della riga):

```text
ADR-0064 emenda ADR-0051 (il punto «niente pop-out», solo per il terminale): valgono i più recenti.
```

Testo proposto (sostituisce il frammento):

```text
ADR-0064 emenda ADR-0051 (il punto «niente pop-out», solo per il terminale); ADR-0065 emenda ADR-0060 (il pulsante «Nuova applicazione» nell'esploratore) e integra ADR-0050 (la presenza non accende il co-editing: resta in vigore): valgono i più recenti.
```

**Riga di ADR-0060 (riga 2054), facoltativa.** Testo attuale (frammento):

```text
pulsante e voce di menu «Nuova applicazione» nell'esploratore dei file, e nomi senza `.webapp`
```

Testo proposto (sostituisce il frammento):

```text
voce di menu «Nuova applicazione» nell'esploratore dei file (il pulsante nella barra è tolto da ADR-0065), e nomi senza `.webapp`
```

**Riga nuova.** In fondo alla tabella, dopo la riga di ADR-0064 (ultima riga dello spec). Riga di ancoraggio, testo attuale:

```text
| ADR-0064 | Terminale integrato | Terminale multi-tab
```

Riga da inserire dopo la riga di ADR-0064 (colonne: ADR, Tema, Decisione, Recepito in):

```text
| ADR-0065 | Presenza in tempo reale | Avatar e cursori degli **altri** utenti sullo stesso file, solo nei vault condivisi (esclusi i privati); **non** è co-editing (nessun CRDT, ADR-0050 resta, merge sul client). Stanza = `(vault cloud, file_id)`; WebSocket `GET /api/v1/presence`, rotta fuori dal router generato (in `x-clarae-external-routes`, come `/events`), stessa autenticazione bearer con il token nel primo frame; messaggi JSON `join`, `leave`, `move`, `auth`, `ping` e `ready`, `members`, `joined`, `left`, `move`, `error`; identità timbrata dal server; autorizzazione per file (almeno _viewer_) al `join` e ricontrollata su revoca, sospensione e scadenza; limiti (frame ≤ 1 KiB, ≤ 40 `move`/s, ≤ 32 connessioni per utente, ≤ 16 stanze per connessione, `ping` entro 50 s); fan-out in memoria e, tra repliche, PostgreSQL `NOTIFY` (canale `presence`) solo se servono, coalescenza a ~15 Hz; nessuna persistenza, nessun audit, nessun log per frame. Client WebSocket nel core Go condiviso (desktop e `GOOS=js`), binding `PresenceAPI` (`Watch`, `Unwatch`, `Move`) ed eventi `presence:members`, `presence:move`, `presence:cleared`; cursore nelle note ancorato al testo (riga e colonna), nei disegni e nei canvas in coordinate di scena; `Avatar` e `AvatarGroup` propri in `@clarae/ui` (niente MUI), colore `getUserColor(userId)`. Flag `features.presence` acceso di default, spegnibile; capability `presence`, voce di parità con la prova sul core WASM. Emenda ADR-0060, integra ADR-0050. **In implementazione in M25 (1.8.2 prevista), non rilasciato; nessuna prova reale con più utenti; ingress, carico di `NOTIFY` e CSP su Safari da verificare** (v1.9) | V-01, A-05, §2.2.1, §2.6.4, §2.6.6, §3.7, D-04, C.2, C.4 |
```

---

## 11. Verifiche e decisioni che spettano all'owner

1. **Citazioni alla lettera.** I blocchi «testo attuale» sono verificati contro `Specifications.md` v1.8 (2059 righe) con uno script: ognuno compare **esattamente una volta**. Se lo spec cambia prima dell'applicazione, vanno riestratti.
2. **Numeri di riga dell'ADR-0065.** L'ADR cita le righe della v1.7 (`:73`, `:568`, `:1957`, `:56`, `:1545`, `:599`): nella v1.8 sono le stesse per V-01 (56), A-05 (73), §2.6.4 (568), D-04 (1957), §3.7 (1545) e §2.6.6 (599-600).
3. **Punti facoltativi:** sezione 8 (§2.2.1, pulsante), sezione 9 (C.2) e la riga di ADR-0060 in C.4. Senza la sezione 8 lo spec dice ancora che il pulsante sta nella barra dell'esploratore.
4. **Versione del documento e data.** La v1.9 è una versione del **documento**: non coincide con la versione di prodotto (1.8.1 rilasciata, la presenza è prevista nella 1.8.2). La data della riga 1.9 e di `| **Data** |` è quella dell'applicazione.
5. **Applicare ora o alla consegna di M25.** Il testo descrive un comportamento che il prodotto non ha ancora (rotta, binding, componenti e rimozione del pulsante mancanti). L'owner può applicarla subito (come per ADR-0064 nella v1.8) o alla consegna di M25, quando il registro dice «rilasciato nella 1.8.2».
6. **Cosa non è nello spec.** `docs/security/data-retention.md` (riga «presenza: solo in memoria, nessuna persistenza, nessun audit») non è nello spec: è un aggiornamento del documento, previsto nell'Onda D di M25. Il tracciato di §4.2 (`internal/presence` nel cloud e nel core) non è proposto: lo spec non elenca i moduli per intero.
7. **`CLAUDE.md`** dice «`Specifications.md` (v1.7…)»: è dell'owner e non l'ho toccato (nemmeno il paragrafo su ADR-0065, quando sarà recepito).

---

## 12. Dopo il recepimento

- ADR-0065 passa a «accettata (recepita nello spec v1.9)» in [`docs/adr/README.md`](adr/README.md) e nell'ADR; la riga **Recepito in** dice oggi «proposta `docs/spec-v1.9-proposta.md`, da applicare».
- Controllo del nome: `task lint-brand` non deve segnalare nuove occorrenze (la proposta non ne aggiunge).
- Questo documento resta come storia, con una nota in testa come `spec-v1.8-proposta.md`.
- `CHANGELOG.md` e roadmap §13-octodecies: «spec v1.9 applicato».
