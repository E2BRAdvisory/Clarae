# Corpus di round-trip dell'editor Live

Input dei criteri del cancello A (C1-C4) dello strato di conservazione del sorgente
(`packages/workbench/src/editor/live/`). Sono file letti **byte per byte** (spazi finali, CRLF, indentazioni
strane contano): per questo la cartella è esclusa da Prettier (`.prettierignore`).

```
roundtrip/
├── demo/          # i file scritti da seed_demo_vault (scripts/lib.sh), come sono nel vault demo
├── cases/         # casi GFM e OFM scritti a mano (gfm-*.md, ofm-*.md)
└── commonmark/    # i 652 esempi di CommonMark 0.31.2 (0.31.2.json: n, sezione, markdown)
```

Il corpus completo, in `packages/workbench/src/editor/live/testing/corpus.ts`, è:

- le fixture di `shared/conformance/markdown` (le stesse dei parser Go e TS dell'indice);
- `demo/` e `cases/`;
- le varianti CRLF e BOM di tutto ciò che sta nei tre punti sopra;
- gli esempi di `commonmark/`.

Il corpus «non avversario» esclude solo gli esempi CommonMark elencati, con criterio e motivo, in
`testing/adversarial.ts`. Tutto il resto vale per ogni criterio.

Gli esempi di CommonMark sono © John MacFarlane e altri, licenza CC BY-SA 4.0
(<https://spec.commonmark.org/0.31.2/>).

## Criteri

| # | Criterio |
|---|---|
| C1 | Con tutti i blocchi riscritti, `extract()` e l'HTML di Reading (`reading/render.ts`) non cambiano (100% sul corpus non avversario) |
| C2 | Un carattere digitato in un nodo testo cambia al più una riga (almeno il 95% dei casi); la spunta di un task in una lista annidata da 200 voci cambia una riga |
| C3 | Dieci giri di round-trip sono idempotenti |
| C4 | Nessun blocco è sporco senza input: caricamento, selezione, passaggio del mouse |

I criteri sono asserzioni bloccanti in `packages/workbench/src/test/conformance.test.ts` (eseguito da
`task conformance`), insieme all'invariante di escape (B2).

## Rieseguire la misura

```sh
yarn workspace @memobrain/workbench run live:metrics     # stampa i numeri e i casi che falliscono, per causa
yarn workspace @memobrain/workbench exec vitest run src/test/conformance.test.ts   # le asserzioni
LIVE_PROPERTY_RUNS=60000 LIVE_PROPERTY_SEED=3 yarn workspace @memobrain/workbench exec vitest run src/test/conformance.test.ts   # invariante di escape, altre sequenze
```

Aggiungere un caso = aggiungere un file in `cases/` (o in `demo/`); le varianti CRLF/BOM si generano da sole.
