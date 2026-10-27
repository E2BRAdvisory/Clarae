# Installazione

L'app desktop è distribuita per macOS, Windows e Linux. Le modalità di distribuzione (installer firmati, aggiornamenti automatici) sono definite da `docs/release/README.md`: qui i requisiti e i passi generali.

| Sistema | Requisiti                                       | Note                                                                                             |
| ------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| macOS   | Versione recente supportata da WebKit/WKWebView | Trascinare l'app in _Applicazioni_. Al primo avvio confermare l'apertura se richiesto.           |
| Windows | Windows 10/11 con **WebView2 Runtime**          | L'installer registra anche lo schema `memobrain://` (necessario per aprire link e per il login). |
| Linux   | `webkit2gtk-4.1` installato                     | Il pacchetto registra `x-scheme-handler/memobrain` nel file `.desktop`.                          |

## Primo avvio

1. Avviate l'app: compare la schermata **Apri un vault**.
2. Scegliete una cartella esistente (anche un vault di Obsidian) oppure una cartella vuota: diventerà il vostro vault.
3. Il cloud non serve per iniziare: tutto funziona offline.

## Dove l'app salva i dati

- **Le note** restano nella cartella del vault, come file normali: potete aprirle con altri editor e includerle nei vostri backup.
- Nella cartella nascosta `.memobrain/` del vault: impostazioni dell'editor, aspetto, scorciatoie, layout dei pannelli, segnalibri, snapshot locali. Non modificatela a mano mentre l'app è aperta.
- Nella cartella dati dell'applicazione (fuori dal vault): indice di ricerca (ricostruibile), stato di sincronizzazione, log, e il token di accesso al cloud nel **portachiavi** del sistema.

## Aggiornare e disinstallare

Seguite le istruzioni del canale di distribuzione in uso. Disinstallare l'app **non** cancella i vault. Per rimuovere anche i dati locali eliminate la cartella dati dell'applicazione; il portachiavi del sistema contiene la voce del token (rimuovibile da lì).
