# ADR-0067 — Sito della documentazione su GitHub Pages, pubblicato da un workflow dedicato

|                       |                                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | proposta                                                                                                                                                                                |
| **Data**              | 2026-11-23                                                                                                                                                                              |
| **Riferimenti spec**  | §6 (Branching/verifiche); ADR-0036 (verifiche locali senza CI), ADR-0031 (pipeline di rilascio), ADR-0032 (Task)                                                                        |
| **Devia dallo spec?** | sì: la riga «Branching/verifiche» e la voce ADR-0031 dell'Appendice C dicono che `release.yml` è l'unico workflow → richiede l'aggiornamento di `Specifications.md` da parte dell'owner |
| **Superfici**         | nessuna superficie del prodotto: solo documentazione e repository                                                                                                                       |

## Contesto

`docs/` contiene circa 140 documenti in Markdown (guide utente e admin, architettura, ADR, QA, rilascio, sicurezza), leggibili solo nel repository. Il proprietario vuole un sito statico pubblicato su GitHub Pages, generato da `docs/` in `docs_html/`, e aggiornato automaticamente.

GitHub Pages, quando pubblica da un branch, serve solo la radice o la cartella `/docs`: una cartella `docs_html/` si pubblica caricandola su un branch dedicato oppure con un workflow. ADR-0036 ha stabilito che non c'è un servizio di CI e che `release.yml` è l'unico workflow.

## Decisione

1. **Generatore: VitePress 1.6** (dipendenza di sviluppo della radice del workspace Yarn), configurazione in `docs/.vitepress/config.mjs`, output in `docs_html/` (ignorata da git, Prettier ed ESLint), base path `/Clarae/` (sito di progetto; `DOCS_BASE` la cambia). La barra laterale segue le sezioni di `docs/index.md`; `README.md` diventa l'indice della sua cartella; i link relativi a file che non sono pagine (`Specifications.md`, sorgenti, `api/`) puntano al file su GitHub; il codice inline è protetto dall'interpolazione di Vue; `.nojekyll` nell'output.
2. **Pubblicazione sul branch `gh-pages`** con `scripts/docs-publish.sh`: un commit costruito con un indice temporaneo (niente checkout, worktree o branch locale) sopra la punta remota di `gh-pages`, che conserva la storia; push in fast-forward; nessun commit se il sito non è cambiato. `task docs-publish` costruisce e pubblica in locale (`DOCS_REMOTE`, `DOCS_BRANCH`, `DOCS_DRY_RUN=1`).
3. **Workflow `.github/workflows/docs.yml`**, eccezione dichiarata ad ADR-0036: su ogni push su `main` che tocca `docs/`, gli asset del marchio, le dipendenze o lo script stesso (e a mano con `workflow_dispatch`) esegue `yarn install --immutable`, `yarn docs:build` e lo script di pubblicazione, come `github-actions[bot]`. Permesso `contents: write` solo per il job, azioni fissate a uno SHA come in `release.yml` (`deploy/PINS.md`), una pubblicazione alla volta senza cancellazioni. **Non esegue controlli**: `task ci` resta il cancello prima di un merge.
4. **Configurazione una tantum del repository** (a cura dell'owner): Settings → Pages → _Deploy from a branch_ → `gh-pages`, `/ (root)`.

## Alternative considerate

- **`actions/upload-pages-artifact` + `actions/deploy-pages`** (Pages da workflow, senza branch): niente branch con file generati, ma il sito si può pubblicare solo dal workflow, mentre il proprietario vuole anche la pubblicazione locale su `gh-pages`. Scartata per ora; resta un passaggio semplice (stesso build, cambia solo l'ultimo step).
- **Solo pubblicazione locale, senza workflow:** rispetta alla lettera ADR-0036, ma il sito resterebbe indietro rispetto a `main`. Scartata su richiesta del proprietario.
- **MkDocs Material:** buon supporto al Markdown puro, ma porta Python e pip nella toolchain (Go + Node). Scartata.
- **Committare `docs_html/` su `main`:** GitHub Pages non la servirebbe (solo radice o `/docs`) e gonfierebbe la storia di `main`. Scartata.

## Conseguenze

- **Positive:** documentazione navigabile e cercabile, aggiornata a ogni push su `main` senza passi manuali; nessun segreto (basta il `GITHUB_TOKEN`).
- **Negative:** un secondo workflow da mantenere (pin delle azioni insieme a quelli di `release.yml`); un branch `gh-pages` con soli file generati, che cresce di un commit per pubblicazione. Le pagine sono template Vue: un tag HTML non chiuso nel testo di un documento (fuori dal codice) rompe il build del sito, che va quindi provato con `task docs-build` quando si scrivono documenti.
- **Da fare:** l'owner aggiorna `Specifications.md` (§6 e Appendice C) e abilita Pages sul branch `gh-pages`. Se il repository è privato, GitHub Pages richiede un piano a pagamento.
