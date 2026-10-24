# Checklist manuale — embedded search, export, impostazioni (M6-WP6)

Da eseguire con `make run-desktop` su macOS, Windows e Linux. Segnare `[x]` con data e sistema operativo. Gli automatismi (vitest, `go test`) coprono rendering, sanificazione e scrittura; qui si verifica ciò che solo la GUI reale mostra.

## Embedded search

- [ ] Una nota con un blocco `query` (es. `tag:#todo`, `sort: modified`, `limit: 5`) mostra in Live Preview l'elenco con conteggio e riga di contesto evidenziata; col cursore dentro il blocco compare il sorgente.
- [ ] Lo stesso blocco in Reading view. `view: cards` mostra la griglia.
- [ ] Modificare/creare una nota che corrisponde aggiorna l'elenco senza riaprire la nota.
- [ ] Query errata (es. `a )`): messaggio inline, il resto della nota è intatto.
- [ ] Clic sul titolo apre la nota; clic sulla riga di contesto apre alla riga; "Apri nella ricerca" riempie il pannello.
- [ ] Oltre 100 risultati: "Mostra altri". La nota ospitante non compare, salvo `self: include` o impostazione attiva.

## Export HTML

- [ ] "Esporta in HTML": dialogo nativo, file creato; aprirlo in un browser offline: immagini, callout, codice, math (MathML), Mermaid visibili; tema chiaro/scuro segue il sistema.
- [ ] Nessuna richiesta di rete né script (pannello rete del browser); `view-source` senza `<script>`.
- [ ] Immagine > 8 MB: assente dal file e segnalata nel messaggio finale.
- [ ] Scegliere una cartella dentro il vault: rifiutato. Vault condiviso in sola lettura: l'export funziona.

## Export PDF

- [ ] "Esporta in PDF" apre il dialogo di stampa di sistema; "Salva come PDF" produce un PDF in tema chiaro anche con l'app in tema scuro, senza barre o pannelli, con interruzioni di pagina ragionevoli.
- [ ] macOS: orientamento orizzontale predefinito (limite di `WindowPrint`), modificabile nel pannello; margini leggibili.
- [ ] Windows (WebView2) e Linux (WebKitGTK): il dialogo si apre e il layer di stampa è corretto; annotare eventuali differenze.
- [ ] Dopo la stampa l'app torna normale (nessun contenuto residuo a schermo).

## Impostazioni (File e link)

- [ ] "Nuove note": "accanto alla nota corrente" crea nella cartella della nota attiva.
- [ ] "Allegati": le tre modalità (cartella / accanto / sottocartella) con incolla di un'immagine.
- [ ] "Conferma prima del cestino" disattivata: nessun dialogo.
- [ ] Chiave bloccata da un profilo: la riga è disabilitata con 🔒.
