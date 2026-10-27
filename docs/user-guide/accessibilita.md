# Accessibilità

Lo stato dei controlli e le procedure di verifica sono in `docs/qa/a11y-desktop.md` e `docs/qa/a11y-web.md`. Non dichiariamo conformità WCAG: i controlli automatici (axe) non rilevano problemi gravi nelle schermate coperte, e restano da completare le verifiche manuali con screen reader reali.

## Tastiera

- Tutta l'interfaccia dell'app si può usare da tastiera; `Mod+P` apre la palette con ogni comando.
- **Schede della barra laterale e dei documenti:** una sola sosta con `Tab`, poi frecce sinistra/destra, `Home`/`Fine`; `Canc` chiude una scheda del documento.
- **Albero dei file:** frecce, `Invio`, `F2`, `Canc`, tasto Menu / `Maiusc+F10` (vedi [Impostazioni e scorciatoie](impostazioni-scorciatoie.md)).
- **Finestre di dialogo e menu:** il focus resta dentro la finestra, `Esc` chiude e il focus torna all'elemento di partenza.
- **Web UI:** primo `Tab` = "Vai al contenuto"; ogni tabella ha didascalia e intestazioni; gli errori dei moduli sono collegati ai campi.

## Schermo e movimento

- **Contrasto:** i colori del testo rispettano il rapporto 4,5:1 in tema chiaro e scuro. Con la modalità **contrasto elevato di Windows** (colori forzati) l'app usa i colori di sistema e mantiene visibili focus e scheda attiva.
- **Movimento ridotto:** se il sistema chiede di ridurre il movimento, animazioni e transizioni sono disattivate.
- **Zoom:** _Impostazioni → Aspetto_ permette di ingrandire interfaccia e carattere; la Web UI si adatta (reflow) fino a 320 px di larghezza.

## Screen reader

L'editor di testo espone un campo di testo multiriga etichettato ("Editor della nota"); la barra di stato annuncia lo stato di salvataggio e sincronizzazione. Le superfici grafiche (grafo, lavagna, disegni) **non** hanno ancora un equivalente testuale completo: per il grafo usate backlink e struttura, per le lavagne le note incorporate. Segnalateci i problemi che incontrate.
