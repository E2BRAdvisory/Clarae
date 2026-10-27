# Accessibilità Web UI: copertura automatica e checklist manuale

Obiettivo dichiarato: **WCAG 2.1 livello AA**. Questo documento **non** afferma la conformità: riporta ciò che è misurato in modo automatico, cosa resta da verificare a mano e i limiti noti.

## Copertura automatica (Playwright + axe-core)

`yarn workspace @nodus/web e2e a11y` (file `web/e2e/a11y.spec.ts`, libreria `@axe-core/playwright` 4.10.2). Tag axe: `wcag2a, wcag2aa, wcag21a, wcag21aa`. Il test **fallisce** con violazioni di impatto `serious` o `critical`; quelle `moderate`/`minor` non bloccano ma il test non le nasconde: si vedono rilanciando axe a mano.

| Cosa                          | Dettaglio                                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rotte                         | usage, vaults, devices, shares, admin: storage, limits, users, dettaglio utente, groups, dettaglio gruppo, config, dettaglio config, audit, 404                                                                                            |
| Dialog aperti                 | ZIP vault condiviso, sblocco vault privato, revoca condivisione, creazione utente, revoca dispositivo, quota utente                                                                                                                        |
| Temi                          | chiaro **e** scuro (`localStorage` + `prefers-color-scheme`), con `prefers-reduced-motion: reduce`                                                                                                                                         |
| Reflow                        | a 320 px di larghezza nessuno scroll orizzontale della pagina su tutte le rotte (le tabelle scorrono nel proprio contenitore)                                                                                                              |
| Lingua                        | `<html lang>` è valorizzato e segue la lingua (anche test unitario)                                                                                                                                                                        |
| Tastiera (`keyboard.spec.ts`) | "Vai al contenuto" come primo stop, navigazione con Tab/Invio, focus visibile, dialog con focus trap, `Esc` e ripristino del focus, modulo compilabile solo da tastiera, tabelle con didascalia e intestazioni, link di riga raggiungibili |

**Esito misurato (Chromium, axe 4.10.2):** 0 violazioni `serious`/`critical` su 14 rotte × 2 temi e 6 dialog × 2 temi. Prima delle correzioni: 1 problema bloccante, non di axe ma del test di reflow — il testo nascosto delle intestazioni di tabella (`position:absolute`) usciva dal contenitore scorrevole e allargava la pagina a 320 px (259 px di overflow su `/vaults`); corretto rendendo `.nd-table-wrap` un blocco di contenimento (`position: relative`). I token di colore e il focus trap dei dialog erano già conformi alla misura.

Cosa axe **non** può dire (resta nella checklist manuale): ordine di lettura sensato, qualità delle etichette, adeguatezza dei testi alternativi, comprensibilità dei messaggi di errore, annunci dinamici reali, comportamento con zoom al 200 % in un browser reale, dimensione dei bersagli (2.5.8 è WCAG 2.2, non 2.1).

## Cosa resta / limiti noti

- I controlli sono su Chromium con API simulate (`page.route`): non sostituiscono la prova con dati reali e altri browser.
- Il grafico di tendenza (admin → Archiviazione) è un SVG: verificare a mano che esista l'alternativa testuale (tabella o descrizione) per gli utenti di screen reader.
- Nessuna verifica con screen reader reale è stata eseguita in questo ciclo.

## Checklist manuale (screen reader) — da eseguire prima del rilascio

Ambienti: macOS + Safari + **VoiceOver**; Windows + Firefox/Chrome + **NVDA**. Per ciascuno annotare versione e data.

- [ ] Al caricamento ogni pagina annuncia un titolo di documento sensato e il `h1` della pagina.
- [ ] Il link "Vai al contenuto" è annunciato e porta al contenuto principale.
- [ ] I landmark (header, nav "principale", nav "Sezioni di amministrazione", main) sono elencati e nominati.
- [ ] La navigazione principale e quella admin annunciano la pagina corrente (`aria-current`).
- [ ] Le tabelle: didascalia letta, intestazioni di colonna associate alle celle, intestazioni di riga (`th scope=row`).
- [ ] Barra di utilizzo: annuncia nome, valore e massimo; il livello (ok/attenzione/critico) è comprensibile senza il colore.
- [ ] Dialog: all'apertura il titolo è annunciato e il focus è dentro; `Esc` chiude e il focus torna al pulsante che l'aveva aperto.
- [ ] Moduli (creazione utente, quota, limiti, config): ogni campo ha etichetta; un errore di validazione è annunciato e associato al campo (`aria-describedby`/`aria-invalid`).
- [ ] Notifiche (toast "Utente creato", "Invito accettato…") sono annunciate senza spostare il focus.
- [ ] Esportazione ZIP: lo stato "in coda / in preparazione / pronto" è annunciato; la richiesta di passphrase è comprensibile.
- [ ] Cambio lingua e tema: il controllo è etichettato; dopo il cambio `lang` e l'annuncio sono coerenti.
- [ ] Zoom al 200 % e finestra stretta (320 px): nessuna perdita di contenuto o funzione.
- [ ] Sistema in modalità contrasto elevato/colori forzati: testi, bordi e focus restano visibili.
- [ ] Con "riduci movimento" attivo non restano animazioni.
