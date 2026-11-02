# ADR-0036 — Verifiche locali al posto di un servizio di CI

|                       |                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | accettata                                                                                                                                   |
| **Recepito in**       | `Specifications.md` v1.2 (2026-11-02): §2.3.3, §2.7.3, §3.7, §3.8.7, §4.1, §4.3, §4.5, Appendice A, C.2 (Appendice C.4)                     |
| **Data**              | 2026-11-01                                                                                                                                  |
| **Riferimenti spec**  | §6 (qualità, CI); ADR-0029/0030 (parità web), ADR-0031 (pipeline di rilascio), ADR-0032 (Task)                                              |
| **Devia dallo spec?** | sì: lo spec e la roadmap presuppongono una CI bloccante su ogni push (conformance, parità) → la parte su CI va riscritta come in questo ADR |

## Contesto

Con M10-WP3/WP4 sono stati rimossi `ci.yml`, `security.yml` e `verify.yml` (commit `9c773e1`, `4631447`). L'unico workflow rimasto, `.github/workflows/release.yml`, parte sui tag e costruisce e pubblica immagine, chart e installer senza eseguire nessun controllo.

Molti documenti (README, `docs/dev-setup.md`, `docs/web-workbench-parity.md`, roadmap, ADR-0030/0031, documenti di sicurezza) descrivono però ancora una CI bloccante. L'analisi del 2026-11-01 ha trovato le conseguenze concrete:

- `scripts/parity.mjs --check` non era richiamato da nessuna parte e, senza i binding generati, usciva con successo;
- `TestDispatcherMatchesTheGeneratedBindings` cercava i binding in `apps/desktop/frontend/wailsjs` (spostati in `packages/workbench/wailsjs`) e veniva quindi sempre saltato;
- `task ci` eseguiva solo lint, govulncheck e test: niente typecheck TypeScript, niente test del core in WASM, niente controllo del codice generato, e su Linux o su un clone pulito falliva per motivi d'ambiente (tag `webkit2_41`, `frontend/dist` mancante).

Il proprietario del progetto ha scelto di non ripristinare un servizio di CI e di rendere ufficiali le verifiche locali.

## Decisione

1. **Nessun servizio di CI.** `release.yml` resta l'unico workflow e non esegue controlli. Le verifiche si fanno in locale.
2. **`task ci` è il cancello ufficiale.** Va eseguito, con esito verde, prima di ogni merge su `main` e prima di creare un tag di rilascio. Comprende:
   - `lint` (golangci-lint, ESLint, Prettier);
   - `typecheck` (tutti i pacchetti TypeScript);
   - `vuln` (govulncheck);
   - `test-go` (con `-race`, il tag `webkit2_41` dove serve, e `MEMOBRAIN_REQUIRE_BINDINGS=1`, per cui il test dispatcher/binding fallisce invece di essere saltato);
   - `test-ts`, `conformance`, `test-wasm` (core Go in WebAssembly);
   - `parity` (`scripts/parity.mjs --check`, che ora fallisce se i binding mancano);
   - `check-gen` (fallisce se `task gen` modifica l'albero).
3. **Suite lente, da eseguire quando si tocca l'area relativa e comunque prima di un rilascio:** `task test-integration` (cloud, Docker), `task test-desktop-e2e` (sync a due dispositivi), `task e2e` e `yarn workspace @memobrain/web e2e:workbench-ui` (Playwright), `e2e:cloud` ed `e2e:security` (stack di sviluppo). L'elenco è in `docs/dev-setup.md`.
4. **Documentazione:** README, `dev-setup.md`, `web-workbench-parity.md`, roadmap, documenti di rilascio e di sicurezza vanno corretti: non si promette più una CI, si rimanda a questo ADR e a `task ci`.

## Alternative considerate

- **Ripristinare GitHub Actions (`ci.yml` su push/PR, job notturno per gli e2e):** è la protezione più forte, ma è stata scartata dal proprietario per costo e manutenzione dei runner. Resta un'opzione se il progetto cresce a più contributori: basterebbe un workflow che esegue `task ci`.
- **Controlli dentro `release.yml`:** avrebbe bloccato solo i rilasci, non i merge, e allungato una pipeline già lenta (build multi-piattaforma). Scartata per ora.

## Conseguenze

- **Positive:** nessun runner da mantenere. `task ci` diventa ermetico e completo: copre anche typecheck, core WASM, parità e codice generato, che prima non verificava nessuno.
- **Negative:** la protezione dipende dalla disciplina di chi fa merge e rilasci. Una regressione può arrivare su `main` se `task ci` non viene eseguito.
- **Da rivedere:** quando ci saranno più contributori, o dopo una regressione arrivata in release, valutare un `ci.yml` minimo che esegua `task ci`.
