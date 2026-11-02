# ADR-0045 — Parità per costruzione tra desktop, workbench web e console

|                       |                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| **Stato**             | accettata                                                                                         |
| **Data**              | 2026-11-02                                                                                        |
| **Riferimenti spec**  | §1.7 e §2.8.3 (workbench web), §2.5 (core); A-03; estende ADR-0029, ADR-0030, ADR-0037 e ADR-0043 |
| **Devia dallo spec?** | no (cambia come si garantisce la parità, non le funzioni)                                         |

## Contesto

Oggi la parità è già in buona parte strutturale: una sola UI (`packages/workbench`, montata da `mountWorkbench` su Wails e nel browser), una sola logica Go (`App.Services()` servita da Wails e dal dispatcher RPC del core WASM, con `TestDispatcherMatchesTheGeneratedBindings`), capability della UI (`platform/index.ts`, `Command.requires`), la porta `CloudPort` con due adattatori (`@memobrain/cloud-features`), contratti generati dall'OpenAPI e il registro `shared/parity/features.yaml` controllato da `task parity`.

La revisione del 2026-11-02 ha trovato 13 divergenze, tutte nei punti ancora manuali:

- lo stato `yes` del workbench si eredita dal desktop senza prove: `tests.web` mescola console e workbench, e i pannelli cloud non hanno test sul core WebAssembly;
- le azioni dei pannelli che non sono comandi («Apri» un mount, «Mantieni una copia», «Rimuovi da questo browser», «Nuovo vault») non hanno `requires` e il controllo non le vede; da lì vengono due difetti dei mount sul web;
- controlli `kind === 'web'` fuori da `platform/` e una capability dichiarata ma mai usata (`directoryPicker`);
- l'host web chiama i binding con stringhe e DTO scritti a mano; i nomi e i payload degli eventi sono copiati in più file Go e TS;
- i DTO dei binding cloud sono diversi da quelli dell'OpenAPI e `CoreCloudPort` li rimappa a mano;
- politiche duplicate tra React e DOM (forza della passphrase nel gate di sblocco del web) e l'elenco dei mount in tre implementazioni.

## Decisione

1. **Capability con una sola fonte, nel core Go.** `apps/desktop/internal/app/capabilities.go` (con varianti `_web`/`_native` per build tag) espone le capability tramite i binding; `Host` le dichiara accanto ai metodi che non supporta. `platform/index.ts` smette di tenere tabelle scritte a mano: `mountWorkbench` le legge dal core, le capability proprie del browser restano override dell'host. Un test Go verifica che ogni metodo di `Host` che sul web non è disponibile abbia la sua capability `false`.
2. **Azioni dichiarative oltre ai comandi.** `defineAction({ id, feature, requires, run })` e un componente `<ActionButton id=… />` che nasconde o disabilita da solo l'azione; il controllo di parità tratta le azioni come i comandi.
3. **`FeatureId` generato.** `task gen` genera da `features.yaml` il tipo `FeatureId` (TS) e le costanti Go; `Command`, `Action` e `skipOnWeb` ricevono `feature: FeatureId` obbligatorio: un'azione senza voce nel registro non compila.
4. **Prove per superficie.** Nel registro `tests` si divide in `desktop`, `workbench`, `console` e `cloud`. `workbench: yes` richiede almeno una prova sul core WebAssembly, altrimenti lo stato è `partial` con la motivazione; ogni rotta e azione della console è citata; una capability senza consumatori è un errore. Un mock REST condiviso permette di eseguire i pannelli cloud sul core vero.
5. **Client dell'host web ed eventi generati.** `task wailsjs` genera un client tipizzato dei binding per l'host web (`web/src/workbench/core.gen.ts`, con limite di tempo); un generatore Go produce i nomi e i payload degli eventi Go→TS (`events.gen.ts`). Regole ESLint vietano nomi di binding o di eventi scritti a mano e `.kind ===` fuori da `platform/`.
6. **DTO dei binding cloud uguali all'OpenAPI.** I binding di gestione cloud restituiscono i tipi di `shared/go/apiclient`; `CoreCloudPort` diventa un passaggio senza mappature, e un test di tipo blocca la deriva.
7. **Ciclo di vita del cloud in `@memobrain/cloud-features`.** Un solo componente `MountsList` per pannello del workbench, console e inviti; ESLint vieta le chiamate dirette alle API di gestione fuori dalla porta; la suite condivisa gira anche su `CoreCloudPort` sopra il core WASM.
8. **Politiche nel core.** Forza della passphrase (§3.8.2), vault eliminato fuori dall'app e regole di permanenza delle copie stanno in Go; React e il gate DOM mostrano soltanto errori tipizzati.
9. **Processo.** Checklist di una funzione nuova: voce nel registro → `task gen` (`FeatureId`) → comando o azione con `feature` e `requires` → binding con DTO OpenAPI → prove per superficie → `task parity`. Il template degli ADR aggiunge la riga «Superfici».

## Alternative considerate

- **Solo correzioni puntuali dei gap** — chiude i difetti di oggi ma non impedisce i prossimi: sono nati tutti nei punti dove la parità dipende dalla disciplina.
- **Due UI separate per desktop e web** — contraddice ADR-0029 e raddoppia il lavoro.
- **Generare tutto dall'OpenAPI** — i binding locali (vault, editor, indice) non sono operazioni REST; il registro resta la fonte delle funzioni, l'OpenAPI quella dei contratti cloud.

## Conseguenze

- Implementazione in M12: punti 4–5 nell'onda W4, punti 1–3 e 6–8 nell'onda W5, punto 9 con la documentazione (W7).
- Più codice generato (client dell'host, eventi, `FeatureId`) e quindi più controlli in `task check-gen`.
- La migrazione dei DTO procede un servizio alla volta; finché non è completa `CoreCloudPort` conserva le mappature residue, coperte dal test di tipo.
