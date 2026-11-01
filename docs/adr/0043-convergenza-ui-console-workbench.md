# ADR-0043 — Convergenza degli stack UI di console e workbench

|                       |                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| **Stato**             | proposta                                                                                             |
| **Data**              | 2026-11-01                                                                                           |
| **Riferimenti spec**  | §3.7 (Web UI), §2.x (client desktop); D-01, V-02 (architettura chiusa); ADR-0025, ADR-0029, ADR-0037 |
| **Devia dallo spec?** | no                                                                                                   |

## Contesto

La revisione W8 (finding `duplicate-ui-systems`) ha rilevato che la Web UI ha due stack di interfaccia separati:

| Aspetto                | Console (`web/src`, `packages/cloud-features`)                                                                                                                                                                           | Workbench (`packages/workbench`, desktop e browser)                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Componenti             | `@memobrain/ui` (`components.tsx`): `Button`, `Badge`, `TextField`, `SelectField`, `Table`, `Card`, `Dialog`, `ToastProvider`, `QuotaBar`…                                                                               | `ui/dialogs.tsx` (API imperativa `dialog.prompt/confirm/alert/pick` con `DialogHost` e coda), `ui/ContextMenu.tsx`, componenti propri di ogni area                                  |
| Focus dei modali       | `Dialog` intrappola il Tab e gestisce Escape nel proprio `onKeyDown`                                                                                                                                                     | `ui/modalFocus.ts`: un solo gestore installato sul documento per ogni `[aria-modal="true"]` (Tab ciclico sul modale in cima, ritorno del focus all'opener tramite MutationObserver) |
| Stile                  | `@memobrain/ui/styles.css` e `components.css` (classi `nd-…`), CSP senza stili inline                                                                                                                                    | `style.css` e `styles/*` globali dell'app desktop; la CSP del workbench ammette stili inline (CodeMirror, KaTeX, Excalidraw)                                                        |
| i18n                   | `web/src/i18n/{en,it}.json`; `packages/cloud-features/src/i18n.ts` (risorse proprie, unite dall'host); `web/src/workbench/strings.ts` (tabella EN/IT della pagina di avvio del workbench, fuori dal test di consistenza) | `packages/workbench/src/i18n/{en,it}.json`                                                                                                                                          |
| Controllo delle chiavi | `packages/ui/src/i18nCheck.ts`, importato con percorsi relativi da tre test (web, workbench, cloud-features)                                                                                                             | idem                                                                                                                                                                                |

Le due metà non sono più isolate come all'inizio: con ADR-0037 i pannelli di `@memobrain/cloud-features` (che usano `@memobrain/ui`) girano anche **dentro** il workbench, sul desktop e nel browser. Nel workbench convivono quindi due gestioni del focus dei modali (quella del `Dialog` di `@memobrain/ui` e quella globale di `modalFocus.ts`) e due insiemi di classi e token di stile. Una correzione di accessibilità, di focus o di tema fatta da una parte non arriva all'altra, e la parità desktop/web (ADR-0029) ne risente.

Vincoli che restano:

- la console mantiene la CSP stretta (`style-src 'self'`, nessuno stile inline) e il suo budget (700 kB iniziali, ADR-0020/0025);
- lo stile globale del workbench non deve toccare la console (ADR-0029: pagine separate);
- architettura chiusa (D-01, V-02): niente temi di terze parti o librerie di componenti esterne con CSS proprio;
- il workbench è lo stesso codice sul desktop (Wails) e nel browser.

## Decisione

Si propone di far convergere i due stack sulle **primitive** (comportamento e accessibilità), non sull'aspetto né sull'intera libreria di componenti. `@memobrain/ui` diventa il pacchetto delle primitive senza stile globale, consumato da console, cloud-features e workbench. I passi, in ordine di rischio crescente, ognuno rilasciabile da solo:

1. **`i18nCheck` come entry del pacchetto** — fatto: `@memobrain/ui/i18nCheck` (`exports` di `packages/ui/package.json`). I tre test di consistenza possono importarlo dal pacchetto invece che con `../../../ui/src/i18nCheck` (cambio meccanico, da fare dai rispettivi owner).
2. **Un solo meccanismo di focus dei modali.** `modalFocus.ts` si sposta in `packages/ui/src/focus.ts` (stessa API `installModalFocus`, già indipendente da React e dal workbench). Il `Dialog` di `@memobrain/ui` smette di intrappolare il Tab da sé quando l'host ha installato il gestore globale (o lo installa al primo montaggio), così nel workbench c'è un solo comportamento. Test: quelli di `modalFocus` e di `components.test.tsx` passano in `packages/ui`; gli e2e `keyboard`/`a11y` del desktop e della console restano invariati.
3. **Primitive di menu e di dialog imperativo.** Il comportamento da tastiera di `ContextMenu` (frecce, Home/End, Escape, chiusura al click esterno) diventa un hook `useMenuKeyboard` in `@memobrain/ui`; `dialog.prompt/confirm/alert/pick` restano l'API del workbench ma rendono attraverso il `Dialog` di `@memobrain/ui` (le classi del workbench restano come varianti). La console guadagna `confirm` imperativo senza duplicarlo.
4. **Token di stile condivisi.** Le custom property (colori, spaziature, raggi, focus ring) passano in un `tokens.css` di `@memobrain/ui`, importato sia da `styles.css` della console sia da `style.css` del workbench; i componenti di `@memobrain/ui` usano solo classi con prefisso (`nd-…`) e token, mai selettori globali e mai stili inline (la CSP della console non li ammette). Il tema scuro/chiaro si governa con gli stessi token.
5. **Un namespace i18n comune.** Le stringhe uguali nei due mondi (OK, Annulla, Chiudi, Riprova, i messaggi `errors.<code>` dell'API) vanno in `@memobrain/ui/i18n/{en,it}.json` (namespace `common`), aggiunte da ogni host alla propria istanza di i18next. `web/src/workbench/strings.ts` passa nei JSON della Web UI sotto `workbench.*`, coperto dal test di consistenza (è anche il passo 3 del finding `duplicated-console-workbench-logic`).

Non si propone di spostare in `@memobrain/ui` i componenti specifici del workbench (editor, albero, pannelli) né di adottare una libreria esterna (Radix, Headless UI…): porterebbe dipendenze e CSS di terze parti contro V-02 e non risolve la differenza di CSP tra le due pagine.

## Alternative considerate

- **Lasciare i due stack separati** — costo nullo oggi, ma il workbench contiene già componenti di entrambi (cloud-features) e i fix di accessibilità vanno fatti due volte. Scartata.
- **Workbench su `@memobrain/ui` per intero** (tutti i componenti, un solo CSS) — il CSS globale del workbench entrerebbe nella console o andrebbe riscritto per intero; rischio alto su desktop e web, beneficio non proporzionato. Scartata.
- **Console sui componenti del workbench** — porterebbe nella console dipendenze pesanti (zustand, i18n del workbench) e stili globali, contro il budget e l'isolamento di ADR-0029. Scartata.

## Conseguenze

- Un solo punto per focus trap, menu da tastiera e dialoghi: le regressioni di accessibilità si correggono una volta e si verificano con i test di `packages/ui` più gli e2e esistenti.
- Il bundle della console non cresce in modo apprezzabile (le primitive sono poche centinaia di righe senza dipendenze); va controllato con `checkBudget` a ogni passo.
- I passi 2–5 toccano codice di più owner (workbench, cloud-features, console): vanno pianificati come work package con gli e2e desktop (`task e2e`), console (`task e2e-web`) e workbench web (`e2e:workbench-ui`) verdi a ogni passo.
- Da rivedere dopo il passo 4: se i token bastano a uniformare l'aspetto, o se serve una guida di stile scritta in `docs/`.
