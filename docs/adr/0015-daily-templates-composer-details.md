# ADR-0015 — Note giornaliere, template, composer: dettagli (M6-WP3a)

- Stato: accettata
- Recepito in: `Specifications.md` v1.4 (2026-11-02): §2.2.1, §2.6.6, §3.4.6 (Appendice C.4)
- Contesto: M6-WP3 (prima metà: daily/unique note, template, composer, slash commands, nota casuale).

## Decisioni

1. **Formati data.** Sottoinsieme dei token Moment usati da Obsidian: `YYYY YY Q MMMM MMM MM M DD D Do dddd ddd d HH H hh h mm m ss s A a X x Z ZZ` e `[letterale]`; ogni altro carattere è copiato. Nomi in inglese e italiano (lingua della UI), altro → inglese. Un formato che contiene `/` annida le note in sottocartelle. La navigazione giorno precedente/successivo interpreta il nome del file con lo stesso formato (`ParseDate`): formati con token orari non sono interpretabili e la navigazione risponde "non è una nota giornaliera".
2. **Variabili template.** `{{date}}`, `{{date:FMT}}`, `{{time}}`, `{{time:FMT}}`, `{{title}}`; le variabili sconosciute restano letterali. Per le daily note `{{date}}` è il giorno della nota, `{{time}}` l'ora corrente. Un template mancante non blocca la creazione (nota vuota, warning nel log).
3. **Impostazioni.** `.memobrain/daily.json` per vault (solo chiavi impostate dall'utente), risolte come le altre: default → config gestita (`daily_notes.{folder,format,template}`) → utente → chiavi `locked`. Non c'è nuova voce nella whitelist di `ReadConfig`: i binding `TemplatesAPI.ReadSettings/WriteSettings` accedono solo a quel file.
4. **Libreria di gruppo.** Se `templates.library_share_id` è nella config e `<data>/mounts/<id>/` esiste, tutte le note `.md` del mount sono elencate come sorgente `library` (riferimento `library:<path>`), in sola lettura, etichettate col nome del mount. Mount assente → nessun effetto. L'id è validato (solo esadecimali e `-`) e i path passano da `vault.FS` (no traversal). Non si controlla lo stato `revoked`: la copia locale resta usabile finché esiste.
5. **Composer — unione.** Ordine: (1) scrittura del target (con hash atteso); (2) riscrittura dei link verso la sorgente (`links.PlanRedirect`/`ApplyEdits`, stessa logica dei rename, tutto-o-niente); (3) sorgente nel cestino. Fallimento al passo 1: nulla cambia. Al passo 2: le note già riscritte sono ripristinate e il target torna al contenuto originale. Al passo 3: il contenuto è già unito e i link già reindirizzati, nulla va perso; la sorgente resta accanto al target e l'errore lo segnala. Il frontmatter della sorgente non viene unito. Separatore configurabile (titolo `##`, linea, nessuno). Anteprima "N link in M note" come per il rename.
6. **Composer — estrazione.** Il backend crea la nuova nota (mai sovrascrive, suffisso numerico) e restituisce il testo sostitutivo (`[[nota]]` o `![[nota]]`, percorso completo se il nome è ambiguo); è l'editor a sostituire la selezione, così le modifiche non salvate non vengono mai sovrascritte da disco. Frontmatter copiabile come opzione.
7. **Slash commands.** Sorgente di completamento CodeMirror con sottoinsieme fisso di voci; usa gli id del registro (`editor:bullet`, `editor:task`, `template:insert`, …) caricato in modo lazy. Non si attiva in code block, codice inline, frontmatter, math, URL, né dentro una parola; disattivabile in impostazioni; mai in editor di sola lettura.
8. **Sola lettura.** Comandi di creazione disabilitati e binding che rifiutano la scrittura (`writable`) sui mount `viewer`.

## Conseguenze / note

- Impostazione "Template di ogni nuova nota" (`newNoteTemplate` in `.memobrain/daily.json`, vuota per default): `createNote` espande il template scelto con il titolo della nota (variabili come negli altri template) per ogni nota nuova, anche quelle create da un link a una nota mancante. Un template sparito lascia la nota vuota invece di bloccarne la creazione. Restano a parte il comando "Nuova nota da template", le note giornaliere e le note uniche, che hanno i propri template.
- `frontend/wailsjs/go/models.ts` rigenerato: in fase di merge va rigenerato di nuovo (`make gen-wails`).
