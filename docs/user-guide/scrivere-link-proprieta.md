# Scrivere, link e proprietà

## Le tre modalità

Ogni nota si apre in una di tre modalità (`Mod+E` alterna lettura/modifica, `Mod+Maiusc+E` sorgente/anteprima, o dalla palette: _Modalità Live Preview / sorgente / lettura_):

- **Live:** è la modalità predefinita (nei comandi e nella palette: _Modalità Live Preview_). È un editor WYSIWYG: scrivete e vedete subito il risultato, senza simboli Markdown. I `[[wikilink]]` e gli embed mostrano il sorgente quando il cursore è dentro. Il file resta Markdown e non viene riscritto: i blocchi che non toccate restano com'erano. Accanto al blocco sotto il puntatore compare una maniglia: il «+» aggiunge un blocco e apre il menu `/`, la presa lo trascina (da tastiera: `/` e `Alt+↑/↓`). Selezionando del testo compare una barra con grassetto, corsivo, barrato, evidenziato, codice, formula e link. Alcuni costrutti (commenti `%%`, note a piè di pagina, HTML, link a riferimento, formule `$$` in linea) sono blocchi non modificabili in Live: si modificano in Sorgente. Numeri di riga, cursori multipli e selezione rettangolare ci sono solo in Sorgente. Una nota molto grande (oltre 250.000 caratteri, 3.000 blocchi o 150 blocchi di codice) si apre in Sorgente, con un avviso.
- **Sorgente:** Markdown puro, con colorazione. È l'unica modalità in cui si vede il frontmatter YAML della nota.
- **Lettura:** vista di sola lettura, con embed e blocchi renderizzati.

## Formattazione

Supportati: titoli, elenchi, attività (`- [ ]`, con stati personalizzati), citazioni, tabelle, codice, note a piè di pagina, formule `$...$` e `$$...$$`, diagrammi Mermaid, callout (`> [!note]`), evidenziato `==testo==`, commenti `%%testo%%`. Scorciatoie: grassetto `Mod+B`, corsivo `Mod+I`, evidenzia `Mod+Maiusc+H`, barrato `Mod+Maiusc+X`, codice `Mod+Maiusc+C`, link `Mod+K`, wikilink `Mod+Maiusc+K`, attività `Mod+Invio`. Digitando `/` si apre il menu dei comandi di inserimento (in Live a gruppi e con icone). In Live `:smile:` scrive direttamente il carattere (😄), mostrato con una grafica Twemoji locale; in Sorgente resta `:smile:`. Invio in un paragrafo ne crea uno nuovo, `Maiusc+Invio` va a capo.

## Link e backlink

- **Wikilink:** `[[Nota]]`, con alias `[[Nota|testo]]`, titoli `[[Nota#Titolo]]` e blocchi `[[Nota#^id]]`. Scrivendo `[[` compare il completamento.
- **Embed:** `![[Nota]]`, `![[immagine.png|300]]`, `![[documento.pdf#page=2]]` incorporano contenuto.
- **Link Markdown** normali sono supportati; il formato dei nuovi link (wikilink o Markdown, percorso più breve/relativo) si sceglie in _Impostazioni → File e link_.
- **Backlink:** il pannello destro mostra chi punta alla nota corrente, anche come menzioni non collegate.
- Passando il mouse su un link compare l'**anteprima** della pagina, di un titolo o di un blocco.
- Rinominare o spostare una nota aggiorna i link.

## Tag e proprietà

- **Tag:** `#idea`, `#progetto/memobrain` (gerarchici). La scheda _Tag_ elenca i tag con i conteggi. In Live, `Mod+clic` su un tag apre la ricerca di quel tag; in Sorgente il tag resta testo e il clic non fa nulla.
- **Proprietà (frontmatter YAML):** in cima alla nota, tra `---`. In Live il frontmatter è nascosto: il pannello _Proprietà_ permette di aggiungere e modificare le proprietà con il tipo corretto (testo, numero, data, elenco, casella). In Sorgente lo scrivete come testo. Le proprietà `tags` e `aliases` hanno un significato speciale: gli alias diventano nomi alternativi per i link.

## Blocchi di ricerca incorporati

Un blocco di codice di tipo `query` mostra il risultato di una ricerca direttamente nella nota (si aggiorna da solo). Vedi [Ricerca](ricerca.md).

## Segnalibri e workspace

_Aggiungi la nota ai segnalibri_ (anche titoli, blocchi, ricerche, grafi) dalla palette; i segnalibri si sincronizzano. I **workspace** salvano e ripristinano la disposizione di pannelli e schede (restano sul dispositivo).
