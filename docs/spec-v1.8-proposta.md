# Proposta di aggiornamento di `Specifications.md` alla v1.8

> **Applicata il 2026-11-20 con l'opzione A**, su istruzione esplicita dell'owner: `Specifications.md` è alla v1.8 e recepisce ADR-0051, 0062, 0063 e 0064 (il registro delle revisioni ha la riga 1.8 con data 20 novembre 2026, al posto di `[data]`). **Il testo qui sotto è la storia della proposta**: dove dice «in proposta», «non applicata» o «da decidere» (sezioni 0, 8 e 9 in particolare) descrive lo stato prima dell'applicazione. **Rifiniture rispetto alla proposta, decise all'applicazione:** tutti i frammenti facoltativi sono stati applicati (§4.2 sulla rinomina, 3.5(b) sui webview per OS, la riga di rischio del terminale in C.2, e le voci «Da verificare» della sezione 6); la priorità del terminale è **P2**; M23 è dichiarato nello spec «implementato in M23 e rilasciato nella 1.8.0» (la riga di §2.2.1 dice «M23 (1.8.0, ADR-0064)») perché il tag 1.8.0 seguirà a breve, invece di «M23, non ancora rilasciato»; ADR-0064 vi è detto «non provato su una finestra reale» (ConPTY e Job Object non provati su Windows). La riga `1.8` e la riga di C.4 di ADR-0051 usano la data 20 novembre 2026. Deriva nota, non corretta: `Specifications.md:1903` cita ancora il tag di build `webkit2_41` (di Wails v2), mentre la build Linux usa `gtk3` (`scripts/build-desktop-bin.sh`).

|                 |                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**       | **applicata il 2026-11-20 con l'opzione A** (ADR-0051 accettato lo stesso giorno e recepito): `Specifications.md` è alla **v1.8**; resta come storia del recepimento                                                                                                                                                                                                                                                                  |
| **Data**        | 2026-11-20                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Base**        | `Specifications.md` v1.7 (16 novembre 2026), 2049 righe; i numeri di riga sono quelli di questa versione                                                                                                                                                                                                                                                                                                                              |
| **Fonti**       | [ADR-0062](adr/0062-vista-integrata-windows-linux.md), [0063](adr/0063-nomi-file-senza-estensione.md) e [0064](adr/0064-terminale-integrato-e-finestra-separata.md), **accettati dall'owner il 2026-11-20**. 0062 e 0063 sono implementati e rilasciati (1.7.3). **0064 è in implementazione in M23 e non è rilasciato.** In più [ADR-0051](adr/0051-wails-v3.md) (Wails v3), **ancora in proposta**: vedi il punto critico qui sotto |
| **Come usarla** | ogni voce indica la sezione e la riga, il **testo attuale** (citato alla lettera, in un blocco `text`) e il **testo proposto**. Dove il testo proposto sostituisce un frammento, si sostituisce solo quel frammento; dove si aggiunge, la voce dice dopo quale riga. Metodo e forma sono quelli di [`spec-v1.7-proposta.md`](spec-v1.7-proposta.md)                                                                                   |

---

## 0. Punto critico: ADR-0064 e ADR-0062 presuppongono Wails v3 (ADR-0051)

**I fatti.**

- Lo spec v1.7 dice **Wails v2** in V-07 (`:61`), A-03 (`:70`), §1.3 (`:211`), §2.2.1 (`:357`), §2.3.2 (`:434`), §2.5 (`:495`), §4.2 (`:1760`), §4.5 (`:1892`), D-07 (`:1955`) e C.2 (`:1979`).
- Il client desktop è su **Wails v3.1.0** dal **1.4.0** (12 novembre 2026): `apps/desktop/go.mod:20` (`github.com/wailsapp/wails/v3 v3.1.0`), CHANGELOG `[1.4.0]`. Lo spec descrive quindi un prodotto che non esiste più; [ADR-0051](adr/0051-wails-v3.md) è ancora in stato _proposta_ (la matrice manuale B-W8 su Windows e Linux non è eseguita; la decisione dell'owner dell'11 novembre è «nessun rollback a v2»).
- **ADR-0064** emenda A-03 e la riga «Finestre separate (pop-out)» (`:357`), che oggi si fondano proprio su «Wails v2 gestisce una sola finestra per processo»: una seconda finestra nello stesso processo (`Window.NewWithOptions`) esiste solo con Wails v3. La motivazione «processo secondario con IPC locale» decade solo se il client è su v3.
- **ADR-0062** dipende da Wails v3.1.0: il driver Linux innesta un `GtkOverlay` al posto della `WebKitWebView` che Wails crea in `windowNew` (`NativeWindow()`, gerarchia `webview-box`), e il driver Windows è una copia ridotta del binding WebView2 di Wails v3.1.0.

**Le opzioni** (la decisione è dell'owner):

|                  | **A. Accettare anche ADR-0051 e recepirlo nella v1.8** (_raccomandata_)                                                                                                                                                                                                                                                                                                                   | **B. Scrivere la v1.8 con «Wails v3 (ADR-0051, in proposta)»**                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cosa si fa**   | L'owner accetta ADR-0051 (istruzione esplicita) e la v1.8 lo recepisce: V-07, D-07, A-03 e le righe collegate (sezione 6), più la riga di C.4                                                                                                                                                                                                                                             | V-07, D-07 e il resto restano «Wails v2»; il testo nuovo di ADR-0062 e ADR-0064 dice «Wails v3 (ADR-0051, in proposta)». Si salta la sezione 6                                                                                                            |
| **Pro**          | Lo spec torna a descrivere il prodotto (v3 è rilasciata dal 1.4.0). La deroga a A-03 di ADR-0064 ha senso solo se A-03 dice v3. Il testo di 0062 e 0064 non ha condizionali. Nessun rollback è previsto                                                                                                                                                                                   | Non accetta nulla che l'owner non abbia già deciso. Si può rinviare ADR-0051 a quando la matrice B-W8 è eseguita                                                                                                                                          |
| **Contro**       | Accettare ADR-0051 **non** esegue la matrice manuale B-W8 (Windows e Linux): il rischio resta, solo dichiarato. Sono alcune righe in più da cambiare (sezione 6), e ADR-0051 elenca altri ADR e file da riallineare (`ADR-0001`, `0005`, `0023`, `0025`, `0029`, `0030`, `0031`, `0045`, `0048`, `CONTRIBUTING.md`, `docs/release/README.md`, `CLAUDE.md`), che questa proposta non tocca | Lo spec si contraddirebbe: V-07 e D-07 «v2» accanto a righe che dicono «v3». A-03 e C.2 vanno scritti con una frase di raccordo. Si rinvia un recepimento già in ritardo dal 1.4.0, e a ogni ADR nuovo che tocca la shell si ripropone lo stesso problema |
| **Raccomandata** | **Sì.** Il prodotto è su v3 da 1.4.0, ADR-0051 dichiara «nessun rollback a v2», e due ADR accettati oggi lo presuppongono. Resta all'owner la decisione di merito, che è sua                                                                                                                                                                                                              | Solo se l'owner vuole tenere aperta la possibilità di non accettare ADR-0051                                                                                                                                                                              |

**Come cambia il testo proposto con l'opzione B.** Ogni «Wails v3» del testo proposto sotto diventa «Wails v3 (ADR-0051, in proposta)» e la sezione 6 non si applica. Due voci cambiano di più:

```text
A-03 (sezione 5.2) con B:
— Wails (**v2** secondo D-07; il client desktop è già su Wails v3 per ADR-0051, in proposta) è desktop-only: **le app mobile non sono nel perimetro**. Il client ha una finestra principale e, **solo per il terminale integrato** (ADR-0064, che presuppone Wails v3), una seconda finestra dello stesso processo; le altre viste non si separano in finestre proprie (pop-out, §2.2.1).
```

```text
C.2, riga «Limiti di Wails v2» (sezione 5.11) con B: il titolo resta «Limiti di Wails v2 (finestra singola, API di piattaforma)» e la mitigazione diventa
Pop-out delle altre viste rinviate (P2); il terminale ha una seconda finestra (ADR-0064, su Wails v3, ADR-0051 in proposta): chiusure, fuoco ed eventi doppi si limitano con `mode` e `seq` e si provano a mano (`docs/qa/m23-terminale.md`); test di single-instance lock e handler URL su ciascun OS
```

Il testo delle sezioni 2, 3, 4, 5 e 7 è scritto **per l'opzione A**.

---

## 1. Riepilogo

| ADR    | Cosa cambia nello spec                                                                                                                                                                                                                  | Sezioni                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 0062   | La vista incorporata delle applicazioni c'è anche su Windows (WebView2) e Linux (WebKitGTK, GTK3), accesa di default, con ripiego automatico, `CLARAE_WEBVIEW=off` e sandbox di WebKit obbligatoria; i driver non sono provati dal vivo | §2.2.1 (riga «Web viewer»), §2.6.6, §3.7, §4.2 (due righe), C.2, C.4       |
| 0063   | Nomi senza estensione per tutto ciò che si apre in una scheda; la rinomina conserva l'estensione                                                                                                                                        | §2.2.1 (riga «Web viewer» e, facoltativa, «Creare note, rinominare…»)      |
| 0064   | Terminale integrato del client desktop (shell dell'utente, tab, pannello ancorabile, finestra separata del solo terminale); deroga a A-03 e a «Finestre separate»; eccezione di parità                                                  | V-02, A-03, §2.2.1 (tre righe), §2.5, §2.8.3, §3.7, §4.2, App. B, C.2, C.4 |
| (0051) | **Solo con l'opzione A:** client desktop su Wails v3.1.0                                                                                                                                                                                | V-07, A-03, §1.3, §2.3.2, §2.5, §2.2.1, §4.2, §4.5, C.1 (D-07), C.2, C.4   |

Più, per tutti: intestazione e registro delle revisioni (sezione 2) e Appendice C.4 (sezione 7).

---

## 2. Intestazione e registro delle revisioni

**Versione e data (righe 7-8).** Testo attuale:

```text
| **Versione documento** | 1.7 — Decisioni D-01…D-08 e ADR 0009–0022, 0024, 0026–0044 e 0052–0061 recepiti (vedi Appendice C) |
```

```text
| **Data** | 16 novembre 2026 |
```

Testo proposto (opzione A; con B, «0052–0064»):

```text
| **Versione documento** | 1.8 — Decisioni D-01…D-08 e ADR 0009–0022, 0024, 0026–0044 e 0051–0064 recepiti (vedi Appendice C) |
| **Data** | 20 novembre 2026 |
```

**Registro delle revisioni.** Aggiungere in testa, prima della riga 1.7 (riga 17), la riga (opzione A; con B si toglie «**ADR-0051** …» e le sezioni che sono solo di ADR-0051, e «già implementati» vale per 0062 e 0063; `[data]` è la data in cui l'owner accetta ADR-0051):

```text
| 1.8 | 20 novembre 2026 | Recepiti gli ADR accettati dall'owner il 20 novembre 2026 (Appendice C.4): **ADR-0062** vista integrata delle applicazioni anche su Windows (WebView2) e su Linux (WebKitGTK, build GTK3), accesa di default insieme a `features.web_viewer`, con ripiego automatico a «Apri nel browser» (driver o runtime mancanti, sandbox di WebKit non disponibile) e interruttore locale `CLARAE_WEBVIEW=off` (emenda ADR-0056 e ADR-0060; implementata nella 1.7.3, **i driver di Windows e di Linux non sono provati su una finestra reale**); **ADR-0063** nomi dei file senza estensione per tutto ciò che si apre in una scheda, e rinomina che conserva l'estensione (integra ADR-0047; implementata nella 1.7.3); **ADR-0064** terminale integrato del client desktop: shell dell'utente in uno pseudo-terminale, più tab, pannello ancorabile e finestra separata del solo terminale (una seconda finestra dello stesso processo), nessun flag del Config Profile, non aperto nei vault in sola lettura, non nel workbench web (eccezione di parità); emenda ADR-0051 per i pop-out (**in implementazione in M23, non ancora rilasciato**); **ADR-0051** client desktop su Wails v3.1.0, solo parità (rilasciato dalla 1.4.0; accettato dall'owner il [data]). Sezioni modificate: §0.3 (V-02, V-07, A-03), §1.3, §2.2.1, §2.3.2, §2.5, §2.6.6, §2.8.3, §3.7, §4.2, §4.5, App. B, C.1 (D-07), C.2, C.4. **Non** sono recepiti ADR-0023 e ADR-0050 (in stato proposta) e gli ADR 0045–0049 (accettati, non recepiti). |
```

La riga 1.7 e le precedenti sono cronologia e **non** si riscrivono: la 1.7 dice che lo spec «continua a dire Wails v2» finché ADR-0051 non è recepito, e resta vera per la v1.7.

---

## 3. ADR-0062 — vista integrata delle applicazioni su Windows e Linux

Il testo è quello di [ADR-0062](adr/0062-vista-integrata-windows-linux.md), verificato sul codice (`apps/desktop/internal/app/capabilities.go:114`, `internal/shell/nativeview/` e `internal/webview/`).

### 3.1 §2.2.1 «Matrice di parità», riga «Web viewer» (riga 372)

Frammenti della stessa riga (l'ultimo, sul ripiego e sui nomi, è nella sezione 4.1).

**(a)** Testo attuale:

```text
**Realizzato in M18 (1.7.0) come «applicazioni» (ADR-0056).**
```

Testo proposto (sostituisce il frammento):

```text
**Realizzato in M18 (1.7.0) come «applicazioni» (ADR-0056); esteso a Windows e Linux in M22 (1.7.3, ADR-0062).**
```

**(b)** Testo attuale (frammento):

```text
**Client desktop su macOS:** una vista nativa (`WKWebView`) figlia della stessa finestra, sovrapposta alla scheda (nessuna finestra in più, quindi «una sola finestra» non cambia), senza alcun ponte verso l'app (§3.7), con una barra (indietro, avanti, ricarica, indirizzo come solo testo, «Cambia indirizzo», «Apri nel browser»). **Windows:** un driver scritto e compilato ma **spento** (si accende solo con una variabile d'ambiente di sviluppo e non è mai stato eseguito su Windows): la capability `embeddedBrowser` resta falsa e la pagina si apre nel browser di sistema. **Linux:** nessun driver, browser di sistema. **Workbench web:**
```

Testo proposto (sostituisce il frammento):

```text
**Client desktop (macOS, Windows e Linux):** una vista nativa figlia della stessa finestra, sovrapposta alla scheda (nessuna finestra in più per le applicazioni), senza alcun ponte verso l'app (§3.7), con una barra (indietro, avanti, ricarica, indirizzo come solo testo, «Cambia indirizzo», «Apri nel browser»). **macOS:** `WKWebView`. **Windows:** WebView2 (runtime dalla versione 1.0.2210.55), con una cartella dati per vault. **Linux:** WebKitGTK dalla 2.40 (`webkit2gtk-4.1`), solo nella build GTK3 con cgo, con la **sandbox di WebKit (bubblewrap) obbligatoria**. **Ripiego automatico (ADR-0062):** se il driver non c'è, il runtime manca o è troppo vecchio, la sandbox non si può avere o l'innesto nella finestra fallisce, l'utente non vede un errore: la scheda mostra il riquadro «Apri nel browser» e, se in quella sessione non si era ancora aperta nessuna pagina, la capability `embeddedBrowser` si spegne per tutta la sessione. Su un singolo computer Windows o Linux la vista incorporata si spegne con la variabile d'ambiente `CLARAE_WEBVIEW=off` (vale solo il valore `off`, letta all'avvio; macOS non la legge). **I driver di Windows e di Linux non sono provati su una finestra reale** (§2.6.6). **Workbench web:**
```

**(c)** L'ultima frase della riga («Fuori da macOS, e nel workbench web, la scheda è un riquadro…») cambia anch'essa, ma nello stesso punto di una frase di ADR-0063: la sostituzione unica è nella sezione 4.1.

### 3.2 §2.6.6, riga `features.web_viewer` (riga 596)

Due frammenti. Il primo, testo attuale:

```text
Acceso, la pagina sta dentro la scheda solo dove c'è il browser incorporato (client desktop su macOS, capability `embeddedBrowser`): altrove si apre nel browser di sistema o in una scheda del browser.
```

Testo proposto (sostituisce il frammento):

```text
Acceso, la pagina sta dentro la scheda solo dove c'è il browser incorporato (client desktop su macOS, Windows e Linux, capability `embeddedBrowser`, ADR-0062): dove il driver o il runtime mancano, o con `CLARAE_WEBVIEW=off` su Windows e Linux, si apre nel browser di sistema; nel workbench web in una scheda del browser.
```

Il secondo, testo attuale:

```text
La matrice manuale di prove sulla finestra reale (`docs/qa/m18-webview-matrice.md`) **non è ancora eseguita**:
```

Testo proposto (sostituisce il frammento):

```text
La matrice manuale di prove sulla finestra reale (`docs/qa/m18-webview-matrice.md`, che dalla 1.7.3 comprende i driver di Windows e di Linux) **non è ancora eseguita**:
```

Fonte: `api/config-profile.schema.json` (descrizione di `features.web_viewer`: «since 1.7.3 also Windows with WebView2 and Linux with WebKitGTK, unless `CLARAE_WEBVIEW=off` or the runtime is missing»).

### 3.3 §3.7, riga «Pagina ospite» (riga 1543)

Due frammenti. Il primo, testo attuale:

```text
gira in una vista nativa **separata** dall'app (driver macOS), **senza alcun ponte verso l'app**
```

Testo proposto (sostituisce il frammento):

```text
gira in una vista nativa **separata** dall'app (driver macOS, Windows e Linux; su Linux la sandbox di WebKit è obbligatoria e, dove non si può avere, vale il ripiego sul browser di sistema, ADR-0062), **senza alcun ponte verso l'app**
```

Il secondo, testo attuale:

```text
nei frame dentro la pagina anche `about`, `blob` e `data`.
```

Testo proposto (sostituisce il frammento):

```text
nei frame dentro la pagina anche `about`, `blob` e `data`. Su Linux WebKitGTK non dice a quale frame appartiene una navigazione: per ciò che non si riconosce valgono le regole del frame principale, che sono le più severe, quindi si sbaglia dalla parte del rifiuto (ADR-0062).
```

### 3.4 §4.2

**(a) Riga 1748.** Testo attuale:

```text
│   ├── shell/nativeview/           # driver delle viste native: macOS (WKWebView); Windows scritto e spento; altrove nessuno (ADR-0056)
```

Testo proposto:

```text
│   ├── shell/nativeview/           # driver delle viste native: macOS (WKWebView), Windows (WebView2), Linux (WebKitGTK, solo build GTK3 con cgo); altrove nessuno (ADR-0056, ADR-0062)
```

**(b) Riga 1769**, frammento (qui è anche la voce di ADR-0064, sezione 5.8). Testo attuale:

```text
browser incorporato `embeddedBrowser` — solo desktop su macOS con driver, ADR-0056…)
```

Testo proposto (sostituisce il frammento):

```text
browser incorporato `embeddedBrowser` — solo desktop (macOS, Windows, Linux) con driver, ADR-0056, ADR-0062; terminale `terminal` — solo desktop, ADR-0064…)
```

### 3.5 C.2

**(a) Riga «Web viewer in iframe…» (riga 1970).** Testo attuale (due frammenti):

```text
ma in una vista nativa sovrapposta alla scheda, solo su macOS; altrove si apre nel browser di sistema o in una scheda del browser.
```

```text
la matrice manuale di prove sulla finestra reale non è ancora eseguita, e il flag si spegne dal profilo |
```

Testo proposto (sostituiscono i due frammenti):

```text
ma in una vista nativa sovrapposta alla scheda, su macOS, Windows e Linux (ADR-0062); altrove, o se il driver o il runtime mancano, si apre nel browser di sistema o in una scheda del browser.
```

```text
la matrice manuale di prove sulla finestra reale non è ancora eseguita, e il flag si spegne dal profilo. **I driver di Windows e di Linux (1.7.3) non sono mai stati eseguiti su una finestra reale:** un difetto che non fa fallire la creazione della vista (posizione, fuoco, sfarfallio) non è coperto dal ripiego automatico; si spegne con il flag o, sul singolo computer, con `CLARAE_WEBVIEW=off`. Su Linux il processo web parte sotto la sandbox di WebKit (bubblewrap): se si avvia male dopo una sonda riuscita, WebKit termina l'app; Flatpak e Snap non sono provati |
```

**(b) Riga «Webview diversi per OS» (riga 1969), facoltativa.** Testo attuale:

```text
Matrice di test e2e per OS; polyfill/limiti documentati (es. Audio recorder) |
```

Testo proposto:

```text
Matrice di test e2e per OS; polyfill/limiti documentati (es. Audio recorder); per le viste delle applicazioni su Windows e Linux, ripiego automatico e `CLARAE_WEBVIEW=off` (ADR-0062) |
```

---

## 4. ADR-0063 — nomi dei file senza estensione

[ADR-0063](adr/0063-nomi-file-senza-estensione.md) non devia dallo spec: l'unica riga che lo contraddice è il «nome senza `.webapp`» di §2.2.1, che diventa un caso della regola generale. Per non lasciare la regola fuori dallo spec si propone anche (a scelta dell'owner) una frase nella riga delle operazioni sui file.

### 4.1 §2.2.1, riga «Web viewer» (riga 372)

Testo attuale (frammento; la parte finale è la stessa del frammento (c) della sezione 3.1, e le due sostituzioni si fondono):

```text
L'esploratore e le schede mostrano il nome senza `.webapp`. Fuori da macOS, e nel workbench web, la scheda è un riquadro con «Apri nel browser» |
```

Testo proposto (sostituisce il frammento; comprende la parte di ADR-0062 indicata al punto (c) di 3.1):

```text
Il nome di un'applicazione non mostra l'estensione `.webapp`, come ogni file che si apre in una scheda (riga «Creare note, rinominare…», ADR-0063). Dove la vista incorporata non c'è (ripiego, `CLARAE_WEBVIEW=off`, flag spento) e nel workbench web, la scheda è un riquadro con «Apri nel browser» |
```

### 4.2 §2.2.1, riga «Creare note, rinominare, spostare, eliminare (cestino)» (riga 336), facoltativa

Testo attuale:

```text
| Creare note, rinominare, spostare, eliminare (cestino) | `vault` | P0 | Cestino di sistema o `.trash/` per vault (impostazione) |
```

Testo proposto:

```text
| Creare note, rinominare, spostare, eliminare (cestino) | `vault` | P0 | Cestino di sistema o `.trash/` per vault (impostazione). **Nomi senza estensione (ADR-0063):** ciò che si apre in una scheda (note, presentazioni, disegni, lavagne, basi, applicazioni, immagini, PDF, audio e video) si mostra senza estensione in esploratore, schede, intestazioni, pannelli e selettori; l'estensione resta visibile solo per i file che si aprono con l'applicazione del sistema (`.docx`, `.zip`, `LICENSE`, `.gitignore`), e le cartelle non nascondono nulla. **La rinomina conserva l'estensione originale**: il campo mostra il nome senza estensione e la ricolloca; digitare la stessa estensione non la raddoppia, un'altra estensione resta parte del nome (`Foo.txt` su una nota diventa `Foo.txt.md`), e l'estensione di un file supportato non si cambia dall'app. Il testo che i collegamenti inseriscono non cambia (i collegamenti si risolvono anche per estensione). Stesso codice su desktop e workbench web |
```

---

## 5. ADR-0064 — terminale integrato e finestra separata

[ADR-0064](adr/0064-terminale-integrato-e-finestra-separata.md) è una decisione **non ancora realizzata nel prodotto**: il testo qui sotto la scrive come decisione, con la versione di prodotto «M23, non ancora rilasciata». Se l'owner applica la v1.8 prima del rilascio, alla consegna di M23 il registro dice la versione (`1.8.0` o la prima che lo contiene).

### 5.1 §0.3, V-02 (riga 56)

Testo attuale (fine della riga):

```text
Ogni funzione è compilata nell'eseguibile. |
```

Testo proposto (il testo del vincolo resta; si aggiunge la nota):

```text
Ogni funzione è compilata nell'eseguibile. Il terminale integrato del client desktop (§2.2.1, ADR-0064) esegue **i comandi che l'utente digita**, con i suoi privilegi, in una shell del sistema operativo: non carica né esegue codice di terzi dentro l'app e non è un meccanismo di estensione. |
```

### 5.2 §0.3, A-03 (riga 70)

Il frammento contiene anche la versione di Wails (ADR-0051): con l'opzione B vale il testo della sezione 0. Testo attuale:

```text
— Wails **v2** (D-07) è desktop-only e gestisce una sola finestra per processo: **le app mobile non sono nel perimetro** e le finestre separate (pop-out) non sono nativamente disponibili (§2.2.1).
```

Testo proposto (opzione A, sostituisce il frammento):

```text
— Il client desktop (Wails **v3**, D-07, ADR-0051) è desktop-only: **le app mobile non sono nel perimetro**. Ha una finestra principale e, **solo per il terminale integrato** (ADR-0064), una seconda finestra dello stesso processo; le altre viste non si separano in finestre proprie (pop-out, §2.2.1).
```

### 5.3 §2.2.1, riga «Pannelli, tab, split…» (riga 356)

Due frammenti. Testo attuale:

```text
Tab e split all'interno della finestra unica.
```

```text
ribbon (nuova cartella, nota, lavagna, disegno, base, separatore, export PDF e immagine)
```

Testo proposto (sostituiscono i due frammenti):

```text
Tab e split all'interno della finestra principale (a parte il terminale, che può stare in una finestra propria, ADR-0064).
```

```text
ribbon (nuova cartella, nota, lavagna, disegno, base, separatore, export PDF e immagine; sul desktop, il terminale, subito sopra le Impostazioni)
```

### 5.4 §2.2.1, righe «Finestre separate (pop-out)» (riga 357) e «Terminale integrato» (nuova)

Riga 357, testo attuale:

```text
| Finestre separate (pop-out) | `workspace` | P2 | Wails v2 gestisce una sola finestra per processo: realizzabile solo come processo secondario con IPC locale (D-07) |
```

Testo proposto (la motivazione «processo secondario con IPC locale» decade):

```text
| Finestre separate (pop-out) | `workspace` | P2 | **Non realizzate per le viste dell'app**: la finestra del client è una (A-03). L'unica finestra separata è quella del terminale integrato (riga seguente, ADR-0064), una seconda finestra Wails v3 dello stesso processo: non servono un processo secondario né un'IPC locale |
```

**Riga nuova**, dopo la riga 357 (la priorità, qui P2 come per le applicazioni realizzate dopo la 1.0, è da confermare):

```text
| Terminale integrato | `terminal` | P2 | **Client desktop, M23 (ADR-0064; non ancora rilasciato).** Un pulsante nella ribbon, subito sopra le Impostazioni (comando `terminal:toggle`, scorciatoia ``Ctrl+` ``, uguale su tutti i sistemi anche su macOS dove `Cmd+`` resta al sistema; nuova scheda ``Ctrl+Maiusc+` ``), apre un pannello con più tab; ogni tab è una **shell dell'utente** in uno pseudo-terminale (`creack/pty` su macOS e Linux, ConPTY su Windows; interfaccia xterm.js, caricata solo all'uso), con la cartella di lavoro nella radice del vault aperto (la cartella home se non c'è un vault). Il pannello si ancora in basso (default), a sinistra o a destra ed è ridimensionabile; posizione e dimensione sono preferenze del dispositivo (non nel vault, non sincronizzate). Un pulsante all'estremità della barra dei tab lo **separa in una finestra del sistema** e lo riaggancia **senza riavviare le shell**: le sessioni stanno nel core e non nella finestra che le mostra. Chiudere un tab, la finestra separata o l'app termina i processi, senza orfani. Una shell parte **solo da un gesto dell'utente** (mai da un file del vault, da un link o da `clarae://`). **Non si apre nei vault in sola lettura** (lettore di un mount o condivisione revocata): il pulsante e «+» sono disabilitati, il core rifiuta l'apertura con l'errore `terminal-read-only` e chiude, con il motivo `read-only`, le sessioni già aperte in un vault che lo diventa. **Nessun flag** del Config Profile: un amministratore non può spegnerlo. Al massimo 16 sessioni, 2 MiB di output conservato per sessione. **Non è una sandbox:** una shell di un vault scrivibile può leggere e scrivere ovunque l'utente possa, anche fuori dalle regole dell'app (altri vault, `.clarae/`, il contenuto di un mount in sola lettura aperto come cartella), §3.7. Non c'è nel workbench web (il browser non può avviare processi: eccezione di parità, §2.8.3). **Limite noto della scorciatoia:** con il layout italiano su Windows e Linux il tasto a sinistra del `1` scrive `\` e ``Ctrl+\`` resta _Dividi a destra_ (il carattere ha la precedenza sulla posizione fisica del tasto) |
```

### 5.5 §2.5, riga `platform` (riga 495) e riga nuova `terminal`

Testo attuale:

```text
| `platform` | URI scheme, single-instance lock, menu nativo, dialoghi | Finestra singola (Wails v2) |
```

Testo proposto:

```text
| `platform` | URI scheme, single-instance lock, menu nativo, dialoghi | Finestra principale (Wails v3) e, solo per il terminale, una seconda finestra dello stesso processo (ADR-0064) |
| `terminal` | Terminale integrato (§2.2.1, ADR-0064) | Sessioni di shell in uno pseudo-terminale (`creack/pty`; ConPTY e Job Object su Windows) possedute dal `Manager` del core e non dalla finestra: output coalescente (circa 16 ms o 32 KiB) con un buffer di 2 MiB e un numero di sequenza per ridisegnare dopo lo sgancio; al più 16 sessioni; `cwd` risolto dal core a partire da un `vaultId` (mai da un percorso del frontend); apertura rifiutata con `terminal-read-only` sui vault in sola lettura (`sync.Manager.ReadOnly`, anche come `CanOpen` per disabilitare il pulsante) e sessioni chiuse quando un vault lo diventa (`terminal:exit` con `reason`); tutte le sessioni chiuse in `App.Shutdown` entro il watchdog di 3 s. Escluso dal core WASM |
```

### 5.6 §2.8.3, eccezioni di parità (riga 691)

Testo attuale (frammento):

```text
cestino di sistema (si usa `.trash/` del vault); più vault aperti insieme (uno per browser).
```

Testo proposto (sostituisce il frammento):

```text
cestino di sistema (si usa `.trash/` del vault); più vault aperti insieme (uno per browser); terminale integrato (il browser non può avviare processi sul computer, ADR-0064).
```

### 5.7 §3.7, riga nuova dopo «Pagina ospite» (riga 1543)

```text
| Terminale integrato (ADR-0064) | Una shell parte **solo da un gesto dell'utente** (pulsante, comando, «+»): mai al caricamento del vault, da un file, da un link o da un deep link `clarae://`; il frontend non passa comandi né percorsi all'apertura (il core risolve `cwd` da un `vaultId`). L'I/O passa dai binding e dagli eventi dell'app, **senza un servizio locale in ascolto** (la CSP non cambia: `connect-src 'self'`). **Non è una sandbox:** la shell è dell'utente, con i suoi privilegi e il suo ambiente (comprese le variabili d'ambiente con eventuali segreti) e può modificare ciò che l'utente può modificare, anche fuori dalle regole dell'app. La sola lettura vale per l'apertura nel vault della sessione: **i vault in sola lettura non lo aprono** (`terminal-read-only`) e le sessioni aperte in un vault che lo diventa si chiudono, ma il terminale non fa rispettare i permessi di condivisione, che restano imposti dal cloud e dall'app. I link riconosciuti nel terminale si aprono nel browser di sistema solo dopo un gesto dell'utente. Nessun flag del Config Profile: un amministratore non può spegnerlo |
```

### 5.8 §4.2

**(a) Riga 1760.** Testo attuale:

```text
│   ├── platform/                   # URI scheme + single-instance lock, menu, notifiche (finestra singola, Wails v2)
```

Testo proposto (e riga nuova subito dopo):

```text
│   ├── platform/                   # URI scheme + single-instance lock, menu, notifiche (finestra principale, Wails v3)
│   ├── terminal/                   # terminale integrato (ADR-0064): sessioni di shell in pseudo-terminale (creack/pty; ConPTY e Job Object su Windows), buffer di output, stato del pannello; non compilato per js
```

**(b) Riga 1769**: l'aggiunta di `terminal` all'elenco delle capability è nella sezione 3.4(b), insieme a quella di `embeddedBrowser`.

### 5.9 App. B, riga «Post-1.0 (P2)» (riga 1939)

Testo attuale (frammento):

```text
finestre pop-out (processo secondario)
```

Testo proposto (sostituisce il frammento):

```text
finestre pop-out per le viste diverse dal terminale (il terminale ha la sua finestra separata, ADR-0064)
```

### 5.10 C.2, riga «Limiti di Wails v2…» (riga 1979)

Il titolo della riga è di ADR-0051 (opzione A; con B vale il testo della sezione 0). Testo attuale:

```text
| Limiti di Wails v2 (finestra singola, API di piattaforma) | Basso | Pop-out rinviate (P2); test di single-instance lock e handler URL su ciascun OS |
```

Testo proposto (opzione A):

```text
| Limiti di Wails v3 (una finestra principale, API di piattaforma, minor frequenti con API instabili) | Basso | Versione fissata (3.1.0, ADR-0051); pop-out delle altre viste rinviate (P2); la seconda finestra del terminale (ADR-0064) è la prima del prodotto: chiusure, fuoco ed eventi doppi si limitano con `mode` e `seq` e si provano a mano (`docs/qa/m23-terminale.md`); test di single-instance lock e handler URL su ciascun OS |
```

**Riga nuova (facoltativa)**, dopo la precedente:

```text
| Terminale integrato: una shell dell'utente fuori dalle regole dell'app | Medio | Nessuna esecuzione automatica (solo da un gesto dell'utente); `cwd` risolto dal core; non si apre nei vault in sola lettura (ADR-0064). **Limite dichiarato:** non è un confine di sicurezza, non rispetta la sola lettura fuori dal vault della sessione e un amministratore non può spegnerlo (nessun flag; un eventuale `features.terminal` sarebbe un nuovo ADR). ConPTY e Job Object su Windows non sono provati su una macchina vera |
```

---

## 6. ADR-0051 — client desktop su Wails v3 (solo opzione A)

[ADR-0051](adr/0051-wails-v3.md) elenca le righe da cambiare, ma con i numeri della v1.3: qui sono riportate sulla v1.7 e verificate sul codice (`apps/desktop/go.mod:20`, `internal/platform/datadir.go:243`, `scripts/build-desktop-bin.sh`, `apps/desktop/build/project.json`). **Non è un recepimento completo**: se l'owner sceglie A, la proposta si rifinisce su ciò che ADR-0051 dice e sulla matrice B-W8.

**V-07** (riga 61). Testo attuale:

```text
| V-07 | Wails **v2** (D-07). |
```

Testo proposto:

```text
| V-07 | Wails **v3** (D-07, ADR-0051). |
```

**§1.3** (riga 211), frammento. Testo attuale:

```text
tramite il single-instance lock di Wails v2 (argomenti della seconda istanza; su macOS tramite l'handler di apertura URL, da verificare sulla versione v2 adottata)
```

Testo proposto (sostituisce il frammento):

```text
tramite il single-instance lock di Wails v3 (argomenti della seconda istanza; su macOS tramite l'evento `ApplicationLaunchedWithUrl`, ADR-0051)
```

Fonte: `apps/desktop/internal/shell/url.go:12-21`.

**§2.3.2** (riga 434), frammento. Testo attuale:

```text
(Wails v2 non stampa in PDF senza dialogo)
```

Testo proposto (sostituisce il frammento):

```text
(il client non genera il PDF da solo: si passa dal dialogo di stampa del sistema)
```

**§4.2** (riga 1714). Testo attuale:

```text
├── wails.json
```

Testo proposto:

```text
├── build/project.json              # nome, identificatori, schemi URL e metadati del prodotto; build/config.yml: watcher di sviluppo
```

Fonte: `apps/desktop/build/project.json`, `apps/desktop/build/config.yml`.

**§4.2** (riga 1773). Testo attuale:

```text
├── wailsjs/                        # binding generati da Wails (non modificare a mano), usati da entrambi gli host
```

Testo proposto:

```text
├── wailsjs/                        # binding generati da `internal/app/gen/bindings` (non modificare a mano; `task gen`), usati da entrambi gli host
```

**§4.5** (riga 1892), frammento. Testo attuale:

```text
Wails v2 (versione fissata)
```

Testo proposto (sostituisce il frammento):

```text
Wails v3.1.0 (versione fissata, ADR-0051)
```

**D-07** (riga 1955). Testo attuale:

```text
| D-07 | Versione Wails | v2 | §0.3, §2.2.1, §4.5 |
```

Testo proposto:

```text
| D-07 | Versione Wails | v3.1.0 (ADR-0051; v2 fino alla 1.3.4) | §0.3, §2.2.1, §4.5 |
```

**A-03** (riga 70), **§2.2.1** (riga 357), **§2.5** (riga 495), **§4.2** (riga 1760) e **C.2** (riga 1979): già scritte per l'opzione A nelle sezioni 5.2, 5.4, 5.5, 5.8 e 5.10. La riga di C.4 è nella sezione 7.3.

**Da verificare, se l'owner sceglie A.** (1) La riga `:434`: la frase attuale è un limite di Wails v2; la matrice B-W8 (`docs/qa/m15-wails3-matrice.md`, voce «stampa») dice se v3 lo supera. (2) La riga `:1714`: `wails.json` non esiste più (lo sostituiscono `build/project.json` e `build/config.yml`). (3) §4.2 non elenca `internal/shell/` né `bridge.go` (`CoreBridge`): si può aggiungere, non è richiesto da ADR-0051. (4) `Piattaforme` di §4.5 (`:1920`, «macOS (versioni supportate da Wails)») resta vera; il minimo di macOS è 13 (ADR-0051, «Cambiamenti visibili all'utente»).

---

## 7. Appendice C.4 «ADR recepiti»

### 7.1 Introduzione (riga 2002)

Primo frammento, testo attuale:

```text
0052 e 0057–0061 nella v1.7, già implementati, in 1.5.0 e 1.7.2)
```

Testo proposto (sostituisce il frammento; con B senza «0051»):

```text
0052 e 0057–0061 nella v1.7, già implementati, in 1.5.0 e 1.7.2; 0051 e 0062–0064 nella v1.8: 0051 è su Wails v3 dalla 1.4.0, 0062 e 0063 sono implementati nella 1.7.3, 0064 è in implementazione in M23 e non è rilasciato)
```

Secondo frammento, testo attuale:

```text
e gli ADR 0045–0051, posteriori alla v1.5 e non toccati dalle revisioni 1.6 e 1.7 (0045, 0046, 0047, 0048 e 0049 accettati; 0050 e 0051 in stato *proposta*). Per questo lo spec dice ancora Wails v2 (ADR-0051 non è recepito).
```

Testo proposto (opzione A; sostituisce il frammento):

```text
e gli ADR 0045–0050, posteriori alla v1.5 e non toccati dalle revisioni 1.6, 1.7 e 1.8 (0045, 0046, 0047, 0048 e 0049 accettati; 0050 in stato *proposta*). Lo spec dice Wails v3 (ADR-0051, recepito nella v1.8).
```

Con B: «… 0050 e 0051 in stato _proposta_). Lo spec dice ancora Wails v2 (ADR-0051 non è recepito); ADR-0062 e ADR-0064 lo presuppongono e lo nominano come «Wails v3 (ADR-0051, in proposta)».»

Frammento finale (in fondo alla riga 2002, dopo «…: valgono i più recenti.»), da aggiungere:

```text
ADR-0062 emenda ADR-0056 (punti 2, 17 e 34-36: la vista incorporata anche su Windows e Linux) e ADR-0060 (decisione 3: la vista incorporata non resta solo su macOS); ADR-0063 integra ADR-0047 (il predicato «si apre in una scheda» decide quali nomi mostrano l'estensione; ADR-0047 non è recepito nello spec) e generalizza la decisione 5 di ADR-0060 (nomi senza `.webapp`); ADR-0064 emenda ADR-0051 (il punto «niente pop-out», solo per il terminale): valgono i più recenti.
```

### 7.2 Righe da modificare

**ADR-0056 (riga 2043).** Testo attuale (frammento):

```text
**solo su macOS** (`internal/webview`, `internal/shell/nativeview`, capability `embeddedBrowser`); su Windows un driver scritto e compilato ma **spento**, mai eseguito; su Linux nessun driver; altrove il browser di sistema, e nel workbench web una scheda del browser.
```

Testo proposto (sostituisce il frammento):

```text
**su macOS nella 1.7.0 e nella 1.7.1** (`internal/webview`, `internal/shell/nativeview`, capability `embeddedBrowser`); su Windows un driver scritto e compilato ma **spento**, mai eseguito, e su Linux nessun driver, fino alla 1.7.1; **dalla 1.7.3 anche su Windows e su Linux** (ADR-0062); altrove il browser di sistema, e nel workbench web una scheda del browser.
```

**ADR-0060 (riga 2048).** Testo attuale (due frammenti):

```text
nomi senza `.webapp` in esploratore e schede; la vista incorporata resta solo su macOS.
```

Testo proposto (sostituisce il frammento):

```text
nomi senza `.webapp` in esploratore e schede (generalizzati a ogni file che si apre in una scheda da ADR-0063); la vista incorporata resta solo su macOS fino alla 1.7.2 (dalla 1.7.3 anche su Windows e Linux, ADR-0062).
```

### 7.3 Righe nuove

In fondo alla tabella, dopo la riga di ADR-0061 (ultima riga dello spec). Le colonne sono: ADR, Tema, Decisione, Recepito in. La riga di ADR-0051 è solo dell'opzione A.

```text
| ADR-0051 | Wails v3 | Il client desktop passa a Wails v3.1.0, «solo parità»: nessuna funzione cambia. Un solo servizio Wails (`CoreBridge`) davanti al dispatcher di `App.Services()`, ABI del frontend invariata (`window.go.app.*`), binding TS generati da `internal/app/gen/bindings` senza la CLI di Wails, Wails confinato in `internal/shell`, `Shutdown` idempotente con watchdog di 3 s, identificativo di single-instance `dev.clarae.desktop.i<16 hex>`, menu solo su macOS, build con `go build -tags production[,gtk3]` (`scripts/build-desktop-bin.sh`), Linux con `-tags gtk3` (WebKit2GTK 4.1). Nessun rollback a v2; restano esclusi l'updater integrato di v3 e i pop-out, salvo il terminale (ADR-0064). Rilasciato dalla 1.4.0; la matrice manuale su Windows e Linux (B-W8) non è eseguita (v1.8) | V-07, §1.3, A-03, D-07, §2.3.2, §2.5, §4.2, §4.5, C.2 |
| ADR-0062 | Vista integrata su Windows e Linux | `embeddedBrowser` vale per macOS, Windows e Linux (`DesktopOS`): WebView2 (runtime ≥ 1.0.2210.55) e WebKitGTK (≥ 2.40, `webkit2gtk-4.1`, solo build GTK3 con cgo, sandbox di WebKit obbligatoria con bubblewrap), accesi insieme a `features.web_viewer`; ripiego automatico a «Apri nel browser» (`webview.ErrPlatformUnavailable`, indisponibilità per la sessione se nessuna vista è stata creata); interruttore `CLARAE_WEBVIEW=off` (solo Windows e Linux, sostituisce `CLARAE_WEBVIEW2_EXPERIMENTAL`); su Linux il frame di una navigazione è in parte sconosciuto e valgono le regole del frame principale. **Non provati su una finestra reale** (test live Linux solo su X11 sotto Xvfb, arm64; Windows nessuna prova a runtime). Emenda ADR-0056 e ADR-0060 (v1.8) | §2.2.1, §2.6.6, §3.7, §4.2, C.2, C.4 |
| ADR-0063 | Nomi dei file senza estensione | «Supportato» è `openTarget(path) === 'in-app'`: l'estensione si nasconde per ciò che si apre in una scheda (note, presentazioni, disegni, lavagne, basi, applicazioni, immagini, PDF, audio e video) e resta per i file che si aprono fuori dall'app; un solo helper (`splitName`, `displayName`, `displayPath`, `pickItems`); l'esploratore ordina sul nome visualizzato; la rinomina (`promptRename`, `renameTarget`) mostra il nome senza estensione e conserva quella originale, senza raddoppiarla e senza che un'altra estensione digitata la sostituisca. Stesso codice su desktop e workbench web; nessuna modifica Go né di protocollo. Integra ADR-0047 e generalizza ADR-0060 (v1.8) | §2.2.1, C.4 |
| ADR-0064 | Terminale integrato | Terminale multi-tab del client desktop: shell dell'utente in uno pseudo-terminale (`creack/pty`, ConPTY e Job Object su Windows), xterm.js caricato solo all'uso, `cwd` nella radice del vault aperto, pannello ancorabile (basso, sinistra, destra; preferenza per dispositivo) e **finestra separata del solo terminale** (seconda finestra Wails v3 dello stesso processo) con le sessioni possedute dal core, snapshot e numero di sequenza allo sgancio. Chiusura senza orfani; binding `TerminalAPI` ed eventi `terminal:*`; capability `terminal`, eccezione di parità per il workbench web; **nessun flag** del Config Profile; **non si apre nei vault in sola lettura** (`terminal-read-only`); una shell parte solo da un gesto dell'utente; **non è una sandbox**. In implementazione in M23, non rilasciato; ConPTY e Job Object non provati su Windows. Emenda ADR-0051 per i pop-out (v1.8) | V-02, A-03, §2.2.1, §2.5, §2.8.3, §3.7, §4.2, App. B, C.2 |
```

---

## 8. Verifiche che spettano all'owner

1. **Opzione A o B su ADR-0051** (sezione 0). Con A serve l'istruzione esplicita di accettare ADR-0051 e la data da scrivere nel registro e in C.4. Resta aperto il problema della matrice B-W8.
2. **Citazioni alla lettera.** I blocchi «testo attuale» sono verificati contro `Specifications.md` v1.7 (2049 righe): se lo spec cambia prima dell'applicazione, vanno riestratti.
3. **ADR-0062, riga `:596`.** L'ADR parla della nota «serve anche il browser incorporato (macOS)»: il testo di §2.6.6 non ha quella frase, ha «Acceso, la pagina sta dentro la scheda solo dove c'è il browser incorporato (client desktop su macOS…)»: la proposta cambia quest'ultima.
4. **ADR-0047 non è nello spec.** ADR-0047 (accettato) dice di avere aggiunto in §2.2.1 le righe «Apertura file per tipo» e «Presentazioni Marp», ma lo spec v1.7 non nomina `.marp`. La proposta per ADR-0063 non cita Marp (scrive «presentazioni»); se l'owner vuole una regola completa sull'apertura per tipo, serve prima recepire ADR-0047 (e gli ADR 0045–0049).
5. **ADR-0064, priorità.** L'ADR lascia la priorità da decidere: la proposta scrive **P2**, come per le applicazioni realizzate dopo la 1.0. Da confermare.
6. **ADR-0064, licenze.** Controllate il 2026-11-20 (Onda C implementata): `@xterm/*` 6.0.0, 0.11.0 e 0.12.0 e `creack/pty` v1.1.24 sono MIT. Fatti dopo la revisione: versioni `@xterm/*` esatte in `package.json` e attribuzione in _Impostazioni → Informazioni → Licenze_.
7. **ADR-0064 non è rilasciato.** Le righe 5.x descrivono un comportamento che il prodotto non ha ancora. Se l'owner preferisce, può applicare la v1.8 con 0062 e 0063 (e 0051) e rinviare 0064 alla v1.9 alla consegna di M23: le righe dell'ADR-0064 sono tutte nella sezione 5 e nell'ultima riga di 7.3.
8. **Versioni.** La v1.8 dello spec è una versione del **documento**: non coincide con la versione del prodotto (1.7.3 rilasciata, M23 non rilasciata).
9. **Deriva dello spec non legata a questi ADR.** (a) §2.8.3 non elenca tra le eccezioni la vista incorporata delle applicazioni (voce `webapp.embedded` del registro: `docs/web-workbench-parity.md`): la proposta non la aggiunge. (b) §4.2 non elenca `internal/shell/`, `internal/events` né `internal/app/gen/`. (c) Gli ADR 0045–0050 non sono recepiti.
10. **`CLAUDE.md`** dice «`Specifications.md` (v1.7…)» e che ADR-0051 è «in proposta»: è dell'owner e non l'ho toccato.
11. **Sezioni che gli ADR citano, controllate sullo spec v1.7:** ADR-0062 → `:372`, `:596`, `:1543`, `:1748`, `:1769`, `:1970`, `:2043`, `:2048` (corrette, con la riserva del punto 3); ADR-0063 → `:372` (corretta); ADR-0064 → `:56`, `:70`, `:356`, `:357`, `:495`, `:691`, `:1532` (è il titolo di §3.7: la riga della tabella da cui si inserisce è `:1543`), `:1760`, `:1769`, `:1939`, `:1955`, `:1979` (corrette). D-07 (`:1955`) cambia solo con l'opzione A.

---

## 9. Dopo il recepimento

- Gli ADR 0062, 0063 e 0064 (e 0051, con A) passano a «accettata (recepita nello spec v1.8)» nell'indice [`docs/adr/README.md`](adr/README.md): la riga **Recepito in** dice oggi «proposta `docs/spec-v1.8-proposta.md`, da applicare» e diventa «`Specifications.md` v1.8 (data), sezioni…».
- Controllo del nome: la ricerca del vecchio nome in `Specifications.md` (comando in [`spec-v1.7-proposta.md`](spec-v1.7-proposta.md) §6) deve dare solo le eccezioni di §3.1 di quel documento: questa proposta non aggiunge occorrenze.
- Questo documento resta come storia, con una nota in testa come `spec-v1.7-proposta.md`.
- `CHANGELOG.md`: la voce _Documentazione_ di _Unreleased_ si aggiorna («`Specifications.md` v1.8»); roadmap §13-quindecies e §13-sedecies: «spec v1.8 applicato».
- ADR-0051 elenca altri ADR e file da riallineare quando sarà accettato (punto «Da aggiornare quando l'ADR sarà accettato»): non fanno parte di questa proposta.
