# Checklist manuale — disegni e canvas (M3)

Da eseguire sul webview reale (macOS, Windows, Linux). Gli e2e automatici (`yarn workspace @nodus/desktop-frontend e2e`) coprono apertura, modifica, salvataggio, embed e l'assenza di richieste di rete sul mock dei binding; qui si verifica ciò che solo il webview reale mostra. **Eseguire con la rete scollegata.**

Segnare `[x]` con data e sistema operativo.

## Disegni (Excalidraw)

- [ ] Palette → "Nuovo disegno": il file `Drawing …excalidraw` compare nell'explorer e si apre in una tab; se invocato da una nota in modifica, la nota riceve `![[Drawing ….excalidraw]]`.
- [ ] Il testo dei disegni usa i font di Excalidraw (Excalifont, Virgil…) anche offline: nessun quadratino o font di ripiego.
- [ ] Disegno con forme, frecce, testo e un'immagine incollata: dopo ~2 s "Salvato"; chiudi e riapri: identico.
- [ ] Tema chiaro/scuro: l'editor segue il tema dell'app; lingua italiana/inglese.
- [ ] Esporta → PNG 1×, 2×, 3× con e senza sfondo, SVG: i file compaiono accanto al disegno; "Copia negli appunti" incolla l'immagine in un'altra app.
- [ ] Zen e Presenta (schermo intero in sola lettura; Esc per uscire).
- [ ] Libreria: aggiungi un elemento, riapri il vault: presente; il file `.nodus/excalidraw-library.json` si sincronizza.
- [ ] Disegno > 10 MB: banner di avviso, il salvataggio funziona.
- [ ] Vault privato bloccato: il disegno è in sola lettura.
- [ ] Modifica del file dall'esterno con la tab aperta e nessuna modifica locale: la tab mostra la nuova versione; con modifiche locali: banner di conflitto.

## Embed e ricerca

- [ ] `![[disegno.excalidraw]]` e `![[disegno.excalidraw|400]]` in Live Preview e in Lettura: immagine con la larghezza richiesta; doppio clic apre il disegno.
- [ ] Modifica il disegno e torna alla nota: l'anteprima è aggiornata (nuova cache per hash).
- [ ] Un elemento con link `[[Nota]]` compare nei Backlink della nota come "Disegno: …".
- [ ] La ricerca trova il testo scritto dentro il disegno.

## Canvas

- [ ] Palette → "Nuova lavagna": file `Canvas ….canvas`, tab con barra degli strumenti.
- [ ] Doppio clic sulla lavagna aggiunge una scheda di testo; Markdown, math ed embed (`![[…]]`) si vedono a riposo.
- [ ] Aggiungi nota, media (immagine, PDF, audio), link web, gruppo; ridimensiona dall'angolo; trascina un gruppo: i nodi interni lo seguono.
- [ ] Trascina da una maniglia di una scheda su un'altra: nasce il collegamento; doppio clic sul collegamento per l'etichetta.
- [ ] Colori preset 1–6 su nodi e collegamenti; Annulla/Ripristina (⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z); Elimina.
- [ ] Zoom con pizzico/⌘+rotella, pan con trascinamento o rotella; "Adatta al contenuto".
- [ ] Un `.canvas` creato in Obsidian si apre e, riscritto da Nodus, si riapre in Obsidian senza perdite.
- [ ] `![[mappa.canvas]]` in una nota: immagine statica; doppio clic apre la lavagna.

## Due dispositivi

- [ ] Disegno modificato in punti diversi sui due dispositivi: convergono senza copie di conflitto.
- [ ] Stesso nodo di un canvas modificato su entrambi: una versione resta, l'altra diventa una copia di conflitto; nulla va perso.
