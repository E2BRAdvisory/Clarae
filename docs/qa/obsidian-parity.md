# Checklist manuale — parità con Obsidian (M1)

Da eseguire sul webview reale (macOS, Windows, Linux) con un vault Obsidian esistente, senza conversioni. Gli e2e automatici (`yarn workspace @nodus/desktop-frontend e2e`) coprono i flussi principali sul mock dei binding; qui si verifica ciò che solo il webview reale mostra.

Segnare `[x]` con data e sistema operativo.

## Apertura vault

- [ ] "Apri cartella come vault" su un vault Obsidian reale: albero completo, `.obsidian/` non mostrato, nessuna modifica ai file all'apertura.
- [ ] Indice iniziale con barra di avanzamento in basso; dopo il termine la ricerca restituisce risultati.
- [ ] Chiusura e riapertura: tab, split e barre laterali ripristinati (`.nodus/workspace.json`); un file cancellato nel frattempo non lascia tab vuote.

## Link

- [ ] `[[Nota]]`, `[[Nota|alias]]`, `[[Nota#Heading]]`, `[[Nota#^blocco]]`, `[[#Heading]]` si risolvono come in Obsidian (percorso più breve, alias del frontmatter).
- [ ] Link non risolto: stile "fantasma"; clic con ⌘/Ctrl crea la nota.
- [ ] Rinomina di un file dall'explorer: anteprima "N link in M note", i link sono riscritti, le tab seguono il nuovo nome.
- [ ] Spostamento via drag&drop in una cartella: stesso comportamento.
- [ ] Backlink e menzioni non collegate coerenti con Obsidian.

## Editor

- [ ] Live Preview: heading, grassetto/corsivo/barrato/evidenziato, codice inline e blocchi, citazioni, liste, task (checkbox cliccabile), tabelle, footnote, tag, commenti `%%`.
- [ ] La sintassi riappare sulla riga del cursore; frontmatter nascosto e mostrato in Properties.
- [ ] Callout (tutti i tipi, titolo personalizzato, `+`/`-` ripiegabili).
- [ ] Math `$…$` e `$$…$$`; diagramma mermaid; errori di sintassi mostrati senza rompere la nota.
- [ ] Embed: nota intera, `#heading`, `#^blocco`, immagine con `|300` e `|300x200`, PDF `#page=2`, audio, video; embed circolare → avviso.
- [ ] Autocompletamento `[[` (note, alias, `#heading`, `#^blocco`), `#tag`, nomi proprietà.
- [ ] Hotkey: ⌘B/I, ⌘K, ⌘⇧K, ⌘1…6, ⌘⏎ (task), ⌘E (reading), ⌘O, ⌘P, ⌘N, ⌘\ (split), ⌘W.
- [ ] Incolla: URL su selezione → link; HTML → Markdown; immagine → allegato + `![[…]]`.
- [ ] Modifica esterna mentre la nota è aperta: senza modifiche locali si aggiorna; con modifiche locali compare il banner Ricarica/Sovrascrivi.
- [ ] Digitazione fluida (nessun lag percepibile) su una nota da ~1 MB in Live Preview.

## Reading view

- [ ] Resa equivalente alla Live Preview; wikilink e tag cliccabili; callout, task con stati personalizzati; HTML pericoloso (`<script>`, `onerror`) non eseguito.

## Properties, tag, outline

- [ ] Properties tipizzate (testo, lista, numero, casella, data, data/ora): modifica riscrive il frontmatter preservando ordine e commenti.
- [ ] Vista Tags gerarchica con conteggi; clic filtra la ricerca. Outline segue i titoli e porta alla riga.
- [ ] Barra di stato: righe/colonna, parole, caratteri, selezione.

## Workspace e impostazioni

- [ ] Split orizzontale/verticale, trascinamento tab tra pannelli, pannelli collegati, ridimensionamento.
- [ ] Palette comandi, selettore rapido (⌘⏎ nuova tab, crea se manca).
- [ ] Impostazioni: editor, file e link, aspetto, hotkey (registrazione, conflitti, ripristino), cloud, informazioni; `nodus://open?vault=&file=` apre la nota.

## Limiti noti

- Ricerca su vault da 50k note: l'estrapolazione dei benchmark indica ≈ 0,9 s contro l'obiettivo di 200 ms; richiede una cache dei candidati (da pianificare, non bloccante per M1 su vault reali di migliaia di note).
- Embed `.canvas`, `.excalidraw` e `.base`: segnaposto fino a M3/M6.
- Page preview (hover) rinviato a M6.
