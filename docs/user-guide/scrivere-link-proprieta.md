# Scrivere, link e proprietà

## Le tre modalità

Ogni nota si apre in una di tre modalità (`Mod+E` alterna lettura/modifica, `Mod+Maiusc+E` sorgente/anteprima, o dalla palette: _Modalità Live Preview / sorgente / lettura_):

- **Live Preview:** scrivete in Markdown e vedete subito il risultato (i simboli compaiono solo sulla riga in cui siete).
- **Sorgente:** Markdown puro, con colorazione.
- **Lettura:** vista di sola lettura, con embed e blocchi renderizzati.

## Formattazione

Supportati: titoli, elenchi, attività (`- [ ]`, con stati personalizzati), citazioni, tabelle, codice, note a piè di pagina, formule `$...$` e `$$...$$`, diagrammi Mermaid, callout (`> [!note]`), evidenziato `==testo==`, commenti `%%testo%%`. Scorciatoie: grassetto `Mod+B`, corsivo `Mod+I`, evidenzia `Mod+Maiusc+H`, barrato `Mod+Maiusc+X`, codice `Mod+Maiusc+C`, link `Mod+K`, wikilink `Mod+Maiusc+K`, attività `Mod+Invio`. Digitando `/` si apre il menu dei comandi di inserimento.

## Link e backlink

- **Wikilink:** `[[Nota]]`, con alias `[[Nota|testo]]`, titoli `[[Nota#Titolo]]` e blocchi `[[Nota#^id]]`. Scrivendo `[[` compare il completamento.
- **Embed:** `![[Nota]]`, `![[immagine.png|300]]`, `![[documento.pdf#page=2]]` incorporano contenuto.
- **Link Markdown** normali sono supportati; il formato dei nuovi link (wikilink o Markdown, percorso più breve/relativo) si sceglie in _Impostazioni → File e link_.
- **Backlink:** il pannello destro mostra chi punta alla nota corrente, anche come menzioni non collegate.
- Passando il mouse su un link compare l'**anteprima** della pagina, di un titolo o di un blocco.
- Rinominare o spostare una nota aggiorna i link.

## Tag e proprietà

- **Tag:** `#idea`, `#progetto/memobrain` (gerarchici). La scheda _Tag_ elenca i tag con i conteggi.
- **Proprietà (frontmatter YAML):** in cima alla nota, tra `---`. Il pannello _Proprietà_ e l'editor in cima alla nota permettono di aggiungerle e modificarle con il tipo corretto (testo, numero, data, elenco, casella). Le proprietà `tags` e `aliases` hanno un significato speciale: gli alias diventano nomi alternativi per i link.

## Blocchi di ricerca incorporati

Un blocco di codice di tipo `query` mostra il risultato di una ricerca direttamente nella nota (si aggiorna da solo). Vedi [Ricerca](ricerca.md).

## Segnalibri e workspace

_Aggiungi la nota ai segnalibri_ (anche titoli, blocchi, ricerche, grafi) dalla palette; i segnalibri si sincronizzano. I **workspace** salvano e ripristinano la disposizione di pannelli e schede (restano sul dispositivo).
