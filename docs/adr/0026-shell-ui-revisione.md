# ADR-0026 — Revisione della shell UI desktop (M8)

|                       |                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | proposta                                                                                                                                                                      |
| **Data**              | 2026-10-28                                                                                                                                                                    |
| **Riferimenti spec**  | §2.2.1 (`workspace`, `sidebar`, `statusbar`, `appearance`, `bookmarks`, `outline`), §4.2 (frontend); V-02/D-01, V-07/D-07, V-08/D-02, V-09/D-06; ADR-0004, ADR-0009, ADR-0016 |
| **Devia dallo spec?** | sì (§2.2.1 riga `statusbar`; §4.2 elenco di `sidebar/`) → richiede aggiornamento di `Specifications.md` da parte dell'owner                                                   |

## Contesto

La shell attuale (`app/App.tsx`) ha una titlebar minimale, una sidebar sinistra con quattro tab (File, Ricerca, Tag, Segnalibri), una destra con tre (Struttura, Backlink, Proprietà) e una status bar che accumula toggle delle sidebar, statistiche dell'editor, sync, permessi, aggiornamenti e inviti. Non esistono ribbon di comandi rapidi, selettore vault in-app, avatar o login nella shell, pannelli Tag/Statistiche/Slide, menu tab completo (blocco, chiudi a destra/sinistra/tutto) né un toggle tema rapido. Il mockup di progetto (28/10/2026) ridisegna la shell attorno a questi elementi.

Vincoli che restano validi: finestra singola Wails v2 (V-07), architettura chiusa senza temi o CSS personalizzati (V-02), nessuna funzione cross-vault (D-06), CSP `default-src 'self'` (ADR-0005), niente accesso diretto a disco/rete dal frontend.

## Decisione

**Disposizione.** Header (toggle sidebar sinistra, pulsante ricerca, palette, switch chiaro/scuro, impostazioni, toggle sidebar destra; le tab restano nella barra di ciascun pane, sotto l'header, perché con gli split ogni pane ha le sue) · ribbon verticale sempre visibile · sidebar sinistra · area editor con slot chat in basso · sidebar destra con footer di sync · footer sinistro con selettore vault, impostazioni e avatar/login.

**Ribbon.** Nuova cartella, nuova nota, nuova lavagna, nuovo disegno, nuova base, separatore, esporta PDF, esporta come immagine. Ogni voce è un comando del registro (`commands/registry.ts`), quindi raggiungibile anche da palette e hotkey. «Separatore» inserisce `---` nella nota attiva (coerente con il delimitatore di ADR-0027).

**Sidebar sinistra:** tab _File_ e _Struttura_ (outline). La ricerca diventa un pulsante in header che apre la vista di ricerca esistente; Tag e Segnalibri passano a destra.

**Sidebar destra:** tab _Proprietà_, _Tag_, _Segnalibri_ (link in uscita, backlink e bookmark del vault, ADR-0016), _ShowSlide_ (ADR-0027), _Statistiche_ (versioni, creazione, ultima modifica, autore, condivisione, parole, capitoli). Il footer mostra lo stato di sync del vault (§2.9), i permessi, l'indicatore di aggiornamento e gli inviti.

**Status bar eliminata.** Riga/colonna e conteggi dell'editor confluiscono in _Statistiche_; lo stato di indicizzazione, i permessi, gli aggiornamenti, la sync e gli inviti nel footer della sidebar destra e, a sidebar chiusa, nell'header (nessun indicatore sparisce con la sidebar). Le tab _Backlink_ e _Segnalibri_ diventano la tab _Link_ (link in uscita, backlink, bookmark). Il requisito «Word count» (P0, `statusbar`) resta soddisfatto dal pannello.

**Tab.** Campo opzionale `pinned` (blocco) in `workspace.json`; menu contestuale con Blocca/Sblocca, Chiudi, Chiudi a destra, Chiudi a sinistra, Chiudi altre, Chiudi tutto. Le chiusure di massa non toccano i tab bloccati. Il campo è retrocompatibile: i file senza `pinned` si leggono invariati.

**Footer sinistro.** Nome del vault e numero di note; il click apre l'elenco dei vault recenti e «Apri cartella…» (cambio vault senza passare dalla Welcome). Pulsante impostazioni; con sessione cloud attiva l'avatar dell'utente (menu account/dispositivi/esci), altrimenti un pulsante «Accedi» (OIDC come da D-08, nessuna credenziale nell'app).

**Tema.** Il pulsante in header alterna chiaro/scuro; `system` resta selezionabile nelle impostazioni. Restano solo i temi integrati (V-02).

**Chat ACP.** Solo uno slot UI disabilitato sotto l'editor, dietro la feature `chat` del Config Profile, spenta per default (a differenza delle altre feature, un flag mancante vale «spento»). Nessun codice di protocollo: l'integrazione ACP richiede un ADR dedicato (client Go, sicurezza, perimetro di rete V-01).

**Persistenza.** I valori legacy di `left.tab`/`right.tab` in `workspace.json` vengono mappati ai nuovi tab (`search`, `tags`, `bookmarks` → `files`; `outline` a destra → `properties`), senza perdere layout né tab aperti.

**Implementazione.** Prima una scomposizione senza cambi funzionali di `App.tsx` in componenti in `src/shell/` (M8-WP1), con i test esistenti come rete di sicurezza; poi le modifiche visive e funzionali per work package.

## Alternative considerate

- **Mantenere status bar e aggiungere solo il ribbon** — scartata: lascia lo stato di sync e le statistiche in una barra affollata e non offre lo spazio per i nuovi pannelli.
- **Ricerca come tab permanente della sidebar** — scartata: il mockup la porta in header, e la ricerca di vault resta comunque un comando (`search:vault`).
- **Selettore vault con apertura di una seconda finestra** — scartata: Wails v2 supporta una sola finestra per processo (V-07).

## Conseguenze

- La shell guadagna punti d'accesso rapidi senza nuove dipendenze; ogni azione resta un comando del registro.
- Cambiano posizione e chiavi dei tab: le scorciatoie `sidebar:*` e le chiavi i18n vanno riviste; gli e2e `a11y` e `keyboard` vanno aggiornati.
- Il cambio vault in-app richiede di salvare il layout e azzerare lo store prima dell'apertura.
- Proposte di modifica allo spec: aggiornare la riga `statusbar` di §2.2.1 (il word count vive nel pannello Statistiche) e l'elenco di `sidebar/` in §4.2.
