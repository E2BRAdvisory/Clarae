# Suite di conformità condivisa

Fixture eseguite **sia dal parser Go** (`apps/desktop/internal/parser`, usato dall'indicizzatore) **sia dai parser TypeScript** (Lezer per l'editor, remark per la reading view) a ogni CI. Evitano che un link, un tag o un heading siano visti da un lato e non dall'altro (spec §2.3.3). Nessuna release con fixture non verdi.

```
shared/conformance/
├── markdown/        # <caso>.md + <caso>.expected.json   (parser OFM)
├── merge/           # <caso>/{base,ours,theirs,expected}.md (+ meta.json)  — da M2
├── crypto/          # vectors.json                        — da M2 (§3.8.7)
└── ts/              # pacchetto @nodus/conformance: tipi e loader per i test TS
```

I loader Go stanno in `shared/go/conformance`.

## Fixture Markdown

`<caso>.md` è il documento di input, letto come byte grezzi (nessuna normalizzazione di newline: le fixture usano LF). `<caso>.expected.json` descrive ciò che **ogni** parser deve estrarre. Tutti i campi sono obbligatori; una lista vuota vale `[]`. Le posizioni sono **righe 1-based** del file `.md` (il frontmatter conta).

```jsonc
{
  "title": "nome-del-caso", // sempre il nome del file senza estensione (vedi sotto)
  "aliases": ["alias1"], // da frontmatter `aliases`
  "properties": { "key": "value" }, // frontmatter tipizzato, senza `tags`/`aliases`
  "headings": [{ "level": 1, "text": "Titolo", "line": 3 }],
  "links": [
    {
      "line": 5,
      "kind": "wikilink", // wikilink | markdown | external
      "target": "Nota", // path/nome come scritto, senza heading/block; "" per [[#heading]]
      "heading": "Sezione", // "" se assente
      "block": "id", // "" se assente
      "alias": "testo", // "" se assente (per markdown: il testo del link)
      "embed": false,
    },
  ],
  "tags": [{ "line": 7, "name": "a/b" }], // senza '#', anche quelli in frontmatter (line = riga del frontmatter)
  "blockIds": [{ "line": 9, "id": "abc123" }],
  "tasks": [{ "line": 11, "state": " ", "text": "chiamare" }], // state = carattere tra le parentesi
  "footnotes": ["1"], // definizioni presenti
  "wordCount": 42, // parole del corpo (escluso frontmatter), split su spazi Unicode
}
```

Regole di estrazione condivise:

- `title` è sempre il nome del file senza estensione (come Obsidian); le fixture usano il nome del caso.
- Link, tag e block-id dentro code span, code fence, commenti `%%…%%` e URL **non** vengono estratti.
- I tag seguono le regole Obsidian: `#` seguito da lettere/numeri/`-`/`_`/`/`, almeno un carattere non numerico, terminato da spazio o fine riga.
- I link sono elencati in **ordine di apparizione** (riga, poi colonna), wikilink e link Markdown mescolati.
- Il contenuto dei blocchi di matematica `$$ … $$` non produce link né tag.
- Il conteggio parole considera i token separati da spazi del corpo (frontmatter escluso) che contengono almeno una lettera o una cifra: la punteggiatura Markdown isolata (`#`, `---`, `*`) non è una parola.

Aggiungere un caso = aggiungere i due file. Nome del caso: `kebab-case` che descrive l'elemento (`wikilink-alias`, `callout-nested`, `tag-in-code-fence`).

## Esecuzione

```sh
make conformance   # Go (desktop parser) + TS (@nodus/conformance e frontend)
```
