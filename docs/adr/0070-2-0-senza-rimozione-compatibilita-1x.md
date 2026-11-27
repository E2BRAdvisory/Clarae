# ADR-0070 — La 2.0.0 non toglie la compatibilità con la 1.x

|                       |                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stato**             | accettata (2026-11-27, decisione dell'owner); recepita in `Specifications.md` v1.13 (2026-11-27)                                                                                                 |
| **Data**              | 2026-11-27                                                                                                                                                                                       |
| **Riferimenti spec**  | §1.3 (schema `memobrain://` e redirect della 1.x), §2.2.1 (URI scheme), §2.1 (cartella di configurazione), §3.4.6 (doppio nome della cartella), §3.6 (proto `memobrain.v1`), C.4 (riga ADR-0052) |
| **Devia dallo spec?** | sì: lo spec dice in più punti che i nomi della 1.x restano «fino alla 2.0» → richiede l'aggiornamento di `Specifications.md` da parte dell'owner                                                 |
| **Superfici**         | desktop, workbench web, console, cloud: nessun cambiamento del codice; cambiano commenti, documenti, la colonna «rimozione» di `scripts/rebrand/allowlist.tsv` e la guida di migrazione          |

## Contesto

[ADR-0052](0052-rebrand-clarae-notanda.md) (rebrand a _Clarae notanda_) e [ADR-0059](0059-pulizia-cartella-configurazione-legacy-e-zip-coerente.md) fissano un periodo di compatibilità con i nomi della 1.x (_MemoBrain Notes_, `memobrain`) che si chiude «nella 2.0»: voci del portachiavi, cartella dei dati, schema `memobrain://` e redirect URI dei realm, pacchetto `.deb` e installazione Windows della 1.x, chiavi del browser, variabili `MEMOBRAIN_*`, default del realm `memobrain`, ruolo `memobrain-admin`, servizio gRPC `memobrain.v1`, `nameOverride: memobrain` del chart. Lo dicono i commenti del codice, le 68 righe di classe `legacy` di `scripts/rebrand/allowlist.tsv`, le guide dell'amministratore e lo spec.

Il 2026-11-27 l'owner decide di pubblicare la **2.0.0** come sola numerazione, sul codice della 1.8.8 più la documentazione.

## Decisione

1. La 2.0.0 **non toglie** nessuna delle compatibilità con la 1.x: il codice non cambia.
2. La rimozione passa a **una release major successiva alla 2.0**, non ancora numerata; la deciderà un ADR quando si farà, con le note di migrazione.
3. Commenti del codice, configurazioni (Compose, Helm, installer, file `.desktop`, proto), `scripts/rebrand/allowlist.tsv` e guide dicono «dropped in a major release after 2.0 (ADR-0070)» o «in una release major successiva alla 2.0». Il testo storico (CHANGELOG, proposte di spec, registro delle revisioni, il corpo di ADR-0052) resta com'era, con una nota di emendamento in ADR-0052.

## Alternative considerate

- **Togliere la compatibilità prima della 2.0.0** — scartata dall'owner: richiede una milestone e fa perdere ai client 1.x ancora installati portachiavi, dati e link `memobrain://`.
- **Tag 2.0.0 senza toccare i documenti** — scartata: le promesse «tolta nella 2.0» diventerebbero false.

## Conseguenze

- Nessun rischio per gli utenti: la 2.0.0 si comporta come la 1.8.8.
- Il debito della compatibilità 1.x resta, senza una data.
- `Specifications.md` è aggiornato nella v1.13 (§1.3, §2.1, §2.2.1, §3.4.6, §3.6, C.4).
