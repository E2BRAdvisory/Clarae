# Verifica manuale della 1.7: runbook per le prove sulla finestra reale

Un solo documento per le prove che nessuna suite automatica può fare e che esegue chi possiede il Mac: le voci 2, 3 e 11 del piano della 1.7.1 (`.claude/roadmap/m20-versione-1-7-1.md`). Il runbook **non ripete** le checklist: dice come preparare l'ambiente, in che ordine eseguirle, che cosa misurare nel grafo 3D e dove scrivere gli esiti.

**Stato al 2026-11-15: nessuna prova di questo runbook è stata eseguita.** I comandi sono stati letti su `Taskfile.yml`, su `scripts/` e sul codice, ma nessun passaggio che apre una finestra è stato provato per scriverlo: ciò che non si è potuto controllare è segnato **(non verificato)**. Le novità della 1.7.1 che toccano le prove sono descritte dove servono: il selettore rapido con i file `.webapp` (blocco C), il livello intermedio del grafo 3D (sezioni 2.1, 2.4 e 2.5) e il driver Windows sperimentale (sezione 5.1).

**Che cosa si prova**

| Voce del piano | Che cosa                                                                        | Dove sta la checklist                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2              | Prove a mano con `task run-desktop` e checklist manuali di M18                  | [`m18-webview-matrice.md`](m18-webview-matrice.md), [`m8-shell-ui.md`](m8-shell-ui.md), [`m3-drawings-canvas.md`](m3-drawings-canvas.md)                                                       |
| 3              | Matrice delle applicazioni su macOS, Windows, Linux e workbench web             | [`m18-webview-matrice.md`](m18-webview-matrice.md)                                                                                                                                             |
| 11             | Misure del grafo 3D sulla finestra reale, con vault da qualche migliaio di nodi | [`graph-3d-benchmark.md`](graph-3d-benchmark.md), sezioni «Il livello intermedio (1.7.1)» e «Cosa NON è stato verificato», e la [sezione 2](#2-vault-grande-per-il-grafo-3d) di questo runbook |

## 1. Preparazione dell'ambiente

Tutti i comandi si danno dalla radice del repository (`/Users/eropelato/Sviluppo/Personal/Clarae`). Gli script tengono lo stato in `.dev/` (ignorato da git).

### 1.1 Una volta sola

1. **Docker acceso** (serve allo stack con cloud): `docker info` risponde.
2. **Strumenti:** `task tools` (tool Go e `yarn install`) e `task wails-cli` (la CLI `wails3` alla versione di `apps/desktop/go.mod`: il watcher di `task run-desktop` la richiede e rifiuta una versione diversa).
3. **Albero pulito e build annotata.** Prima di cominciare: `git status --short` senza modifiche e `git rev-parse --short HEAD`. L'hash va in ogni riga del registro: un esito senza hash non dice su quale codice è stato ottenuto. Il sistema operativo: `sw_vers -productVersion`.
4. **Rete:** `yarn install` e le build vogliono la rete. Una volta avviata l'app, per le checklist dei disegni la rete va staccata (vedi [sezione 3](#3-ordine-consigliato-delle-prove)).

### 1.2 App standalone con vault demo (senza cloud)

```sh
task run-desktop
```

Fa `scripts/run-desktop.sh --demo`: modalità sviluppo con ricarica (`wails3 tool watcher`, esbuild su `127.0.0.1:5173`), senza Docker e senza cloud. Crea il vault demo in `.dev/standalone/vaults/Demo` **ma non lo apre**: dall'app, _Apri cartella come vault_ e scegliere quella cartella.

Opzioni (si danno allo script, non al task): `scripts/run-desktop.sh --demo --fresh` azzera `.dev/standalone`; `--data-dir DIR` usa un'altra cartella dei dati; `--build` fa una **build di produzione** (CSP stretta, ispezione spenta) e la avvia. `task run-desktop` è la modalità sviluppo: serve a leggere la console della pagina (sezione 2); `--build` è ciò che si vede nel prodotto vero, e per le prove sull'aspetto è il riferimento.

Dati e log: `.dev/standalone/app.db`, `.dev/standalone/logs/clarae.log`, `.dev/standalone/vaults/`.

### 1.3 App con cloud

Il cloud serve per le applicazioni (il flag `features.web_viewer` sta in un profilo di configurazione, e senza cloud non c'è un profilo), per i casi con due utenti e per il workbench web.

**Percorso consigliato: uno script, due terminali.**

```sh
# terminale 1: stack Docker + cloud in background + desktop in sviluppo
scripts/run-desktop-with-cloud.sh --demo --keep
```

Lo script avvia PostgreSQL (`:5433`), S3 (`:9000`, console `:9001`) e Keycloak (`:8080`), costruisce e avvia il cloud su `http://127.0.0.1:18081`, poi apre il desktop con l'URL del server già scritto in _Impostazioni → Cloud_. Il vault demo è in `.dev/with-cloud/vaults/Demo`. Con `--keep` cloud e stack restano accesi quando si chiude il desktop. `--reset-stack` azzera i volumi prima (reimporta il realm Keycloak).

```sh
# terminale 2: la Web UI (console di amministrazione e workbench) su http://localhost:5174
task wasm-core     # una volta: il core Go in WebAssembly, che serve al workbench
task dev-web
```

Accessi, password `clarae-dev-password` per tutti: `admin` (console di amministrazione), `user1` e `user2`. Il login del desktop si completa nel browser di sistema.

**Due dispositivi** (casi di sincronizzazione, applicazione arrivata dalla sincronizzazione, libreria di forme):

```sh
scripts/run-desktop-with-cloud.sh --two-devices --demo   # oppure: task run-desktop-2devices
```

Costruisce il desktop in modalità produzione e ne avvia due istanze, con dati in `.dev/with-cloud-1` e `.dev/with-cloud-2`. Accedere con `user1` su entrambe (con `user2` su una per i casi con due utenti). Qui non c'è la ricarica e l'ispezione è spenta; il log di debug è in `.dev/with-cloud-N/logs/clarae.log`.

**Alternativa a più terminali:** `task stack-up`, poi `task dev-cloud` (cloud su `:18081` **e** Web UI su `:5174`, `WEB=0` per non avviarla) e, in un altro terminale, `scripts/run-desktop.sh --data-dir .dev/with-cloud --demo`, scrivendo a mano l'URL `http://127.0.0.1:18081` in _Impostazioni → Cloud_ (questo script non lo precompila). I due percorsi **non si mescolano**: `scripts/run-desktop-with-cloud.sh` si ferma se qualcosa risponde già sulla porta del cloud.

### 1.4 Accendere `features.web_viewer` per le applicazioni

> **Dalla versione di M21 il flag è acceso di default** ([ADR-0060](../adr/0060-web-viewer-acceso-di-default.md), accettata il 2026-11-16): questa sezione serve ancora per **spegnerlo** (`false`) e per provare i profili di gruppo; con una build precedente alla M21 va acceso come descritto.

Il flag è spento di default e resta spento di default nella 1.7.1 (decisione dell'owner). Per la prova si accende in un profilo, dalla console di amministrazione.

1. Aprire `http://localhost:5174` e accedere come `admin` (ruolo amministratore).
2. _Amministrazione → Configurazione_ (rotta `/admin/config`) → _Nuovo profilo_.
3. _Nome_: per esempio `QA applicazioni`. Spuntare _Profilo globale (vale per tutti gli utenti)_: sulla macchina di sviluppo vale per `user1`, `user2` e `admin`. Se esiste già un profilo globale, la console chiede di confermare la sostituzione: non toglierlo senza averlo annotato.
4. In _Configurazione (JSON)_ scrivere:

   ```json
   {
     "features": { "web_viewer": true }
   }
   ```

   La console segnala «JSON valido»; per il caso M20 della matrice (blocco automatico del vault privato a 1 minuto) si aggiunge, nello stesso profilo:

   ```json
   {
     "features": { "web_viewer": true },
     "security": { "vault_lock_minutes": 1 }
   }
   ```

5. _Salva il profilo_: compare «Profilo salvato (versione N)». Ogni salvataggio crea una versione nuova (storico con ripristino, nella stessa pagina).

**Variante prudente** (come consiglia la guida per gli amministratori, [profili-quote-audit.md](../admin-guide/profili-quote-audit.md#applicazioni-note-per-chi-amministra)): non marcare il profilo come globale; creare un gruppo in _Amministrazione → Gruppi_ → _Crea gruppo_, aggiungere `user1` (_Aggiungi un membro_), e nella pagina del gruppo, sotto _Profili di configurazione_, _Aggiungi un profilo_ con una priorità, poi _Salva le assegnazioni_. Così il flag vale solo per `user1` e si prova anche che gli altri utenti non lo ricevono.

**Da API.** `POST /api/v1/admin/config-profiles` (corpo: `name`, `config`, `is_global`; vedi `api/openapi.yaml`, schema `ConfigProfileInput`) fa la stessa cosa, ma serve un token di `admin` e il realm di sviluppo non abilita il flusso con password (`directAccessGrantsEnabled` è falso nei client): per la prova usare la console.

### 1.5 Verificare che il client abbia ricevuto il profilo

Tre controlli, dal più alto al più basso:

1. **Console:** _Amministrazione → Utenti_ → `user1` → _Configurazione effettiva_ mostra ciò che il server dà a quell'utente: deve contenere `features.web_viewer: true` (con il numero di versione del profilo).
2. **Client desktop:** accedere con `user1` (_Impostazioni → Cloud_ → _Accedi_). Aprire un vault: nel ribbon e nel pannello senza schede compare _Nuova applicazione_. Il profilo arriva all'accesso e a ogni cambiamento (il server manda la notifica `config_changed`), senza riavviare l'app: se dopo qualche secondo la voce non compare, annotarlo come difetto (P1) e riavviare l'app per proseguire.
3. **Cache locale** (per capire cosa ha il client anche offline): `sqlite3 -readonly .dev/with-cloud/app.db "select value from app_settings where key like 'cloud_config:%'"` stampa il profilo effettivo salvato, con `"web_viewer":true`. Con due dispositivi il file è in `.dev/with-cloud-1/app.db` e `.dev/with-cloud-2/app.db`. **(non verificato)** il formato esatto del valore: il codice è `apps/desktop/internal/config/config.go` (`cacheKey`, `Refresh`).

Per spegnere a metà prova (caso M33): salvare `{"features": {"web_viewer": false}}` e attendere l'aggiornamento; per riaccendere, di nuovo `true`.

### 1.6 Spegnere tutto

| Cosa                                             | Come                                                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Desktop avviato dallo script                     | `Ctrl-C` nel terminale (senza `--keep` ferma anche il cloud, e lo stack resta acceso)                                             |
| Cloud lasciato acceso con `--keep`               | `scripts/dev-stop.sh` (oppure `task dev-stop`)                                                                                    |
| Cloud **e** stack Docker                         | `scripts/dev-stop.sh --stack` (i dati dei contenitori restano)                                                                    |
| Web UI avviata con `task dev-web`                | `Ctrl-C` nel terminale 2                                                                                                          |
| Cloud e Web UI avviati con `task dev-cloud`      | `Ctrl-C` nel suo terminale, poi `task stack-down` per lo stack                                                                    |
| Ripartire da zero (volumi dello stack e `.dev/`) | `scripts/dev-stop.sh --purge`. **Attenzione:** cancella tutta la cartella `.dev/`, compresi i log e gli artefatti di altro lavoro |

Per azzerare solo i dati di un'istanza senza toccare il resto: chiudere l'app e `rm -rf .dev/with-cloud` (o `.dev/standalone`, `.dev/with-cloud-1`, `.dev/with-cloud-2`).

### 1.7 Dove finiscono i dati

| Dato                                                  | Percorso                                                                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dati dell'app standalone                              | `.dev/standalone/` (`app.db`, `logs/clarae.log`, `vaults/`)                                                                                                                                            |
| Dati dell'app con cloud                               | `.dev/with-cloud/`, oppure `.dev/with-cloud-1/` e `.dev/with-cloud-2/` con due dispositivi                                                                                                             |
| Log del cloud, della Web UI                           | `.dev/logs/cloud.log`, `.dev/logs/web.log`                                                                                                                                                             |
| Binario del cloud e `pid`                             | `.dev/bin/clarae-cloud`, `.dev/cloud.pid`                                                                                                                                                              |
| Vault sintetici per il 3D                             | `.perf/vault-N/` (ignorato da git, vedi sezione 2)                                                                                                                                                     |
| Dati di un'app installata (non lanciata dagli script) | `~/Library/Application Support/Clarae notanda` su macOS, `%AppData%\Clarae notanda` su Windows, `~/.config/Clarae notanda` su Linux; con `CLARAE_DATA_DIR` o `--data-dir` si sceglie un'altra cartella |
| Sessioni delle pagine delle applicazioni              | nell'archivio dati di WebKit del sistema (uno per vault), non nella cartella del vault né in `.dev/`; si cancellano con il comando _Elimina i dati delle applicazioni_                                 |

## 2. Vault grande per il grafo 3D

### 2.1 Come generarlo

```sh
task perf-data PERF_NOTES=1000
task perf-data PERF_NOTES=3000
task perf-data PERF_NOTES=5000
```

Ogni comando scrive `.perf/vault-<N>/` (con `PERF_DIR` si sceglie un'altra cartella) con `go run ./internal/perf/cmd/perfdata -notes <N>`: il generatore è deterministico (seed 1: stessi file a ogni esecuzione) e si ferma se il vault della stessa dimensione c'è già (manifest `.perfdata.json`). Misurato oggi su questa macchina:

| `PERF_NOTES` | Dimensione | Link scritti | Tempo di generazione |
| ------------ | ---------- | ------------ | -------------------- |
| 1.000        | 3,1 MB     | 7.624        | 0,7 s                |
| 3.000        | 9,7 MB     | 23.454       | 2,7 s                |
| 5.000        | 16,7 MB    | 39.594       | 4,8 s                |

**Che cosa produce:** solo note `.md` in `area-NN/sub-NN/`, con proprietà, circa 300 tag, un gran numero di `[[link]]` con distribuzione a coda pesante (pochi hub molto collegati, una lunga coda), qualche link a note che non esistono («fantasmi») e riferimenti ad allegati (esistono solo 5, 15 o 25 file `.png`). **È un grafo significativo:** circa 7-8 link per nota (nel benchmark sintetico di `graph-3d-benchmark.md` erano circa 3,5). Il conteggio comprende i link ai fantasmi, che il grafo non mostra finché non si accende _Link non risolti_.

**Che cosa non produce:** altri tipi di documento. Tutti i nodi sono «nota», quindi un solo aspetto e, nel livello a punti, due draw call: è lo stesso limite del benchmark e non misura il caso reale (disegni, lavagne, basi, presentazioni, allegati). Per avvicinarsi a un vault vero si possono aggiungere documenti con comandi esistenti. Dopo aver **copiato** il vault da 3.000 note (passo 2.2), dalla radice del repository:

```sh
V=.dev/standalone/vaults/Perf-3000-misto
mkdir -p "$V/Documenti"
find "$V" -name '*.md' -not -path "$V/Documenti/*" | head -300 | while IFS= read -r f; do
  i=$((i+1)); t=$(basename "$f" .md)
  printf '{"type":"excalidraw","elements":[{"id":"t","type":"text","text":"see [[%s]]"}]}\n' "$t" > "$V/Documenti/Disegno $i.excalidraw"
  printf '{"nodes":[{"id":"f","type":"file","x":0,"y":0,"width":10,"height":10,"file":"%s"}],"edges":[]}\n' "${f#$V/}" > "$V/Documenti/Lavagna $i.canvas"
  printf 'views: []\n' > "$V/Documenti/Base $i.base"
done
```

Crea 300 disegni, 300 lavagne e 300 basi, con la forma minima che usa il test `TestBuildDocuments` (`apps/desktop/internal/graph/graph_test.go`); disegni e lavagne puntano a una nota ciascuno. Si possono accendere anche, dalle impostazioni del grafo, _Tag come nodi_, _Link non risolti_ e _Allegati_ per avere più tipi di nodo. Il vault misto ha 3.900 nodi: sotto il tetto di 5.000, quindi senza troncamento, e sopra i 2.000 dei solidi istanziati, quindi nel livello a punti con più aspetti, che è il caso che il benchmark non ha misurato.

**Per il livello intermedio** (da 1.001 a 2.000 nodi) serve un vault di quella dimensione, e misto per vedere forme diverse: `task perf-data PERF_NOTES=1500`, una copia in `.dev/standalone/vaults/Perf-1500-misto` (`cp -R .perf/vault-1500 …`) e lo stesso script con `head -100` al posto di `head -300` (100 disegni, 100 lavagne e 100 basi: circa 1.800 nodi, a seconda dei link non risolti, che il grafo non mostra finché non si accende _Link non risolti_).

### 2.2 Come aprirlo

Il generatore scrive in `.perf/` (cache); aprire una **copia**, perché l'app crea `.clarae/` e gli indici dentro la cartella del vault:

```sh
cp -R .perf/vault-5000 .dev/standalone/vaults/Perf-5000
```

Poi nell'app (avviata con `task run-desktop`): _Apri cartella come vault_ → `.dev/standalone/vaults/Perf-5000`. Ripetere con 1.000 e 3.000 note (`Perf-1000`, `Perf-3000`), e con la copia del vault misto (`Perf-3000-misto`, partendo da `cp -R .perf/vault-3000 .dev/standalone/vaults/Perf-3000-misto`).

**Attendere l'indicizzazione.** La prima apertura indicizza tutte le note e può richiedere minuti (per 10.000 note la misura di M6 parla di minuti). Il grafo è pronto quando la riga in basso dice «N nodi, E link» con N pari alle note (più i documenti aggiunti). Annotare quanto ci è voluto.

**Le dimensioni.** Si può usare un vault per dimensione (come nelle righe di `graph-3d-benchmark.md`) o, più in fretta, il vault da 5.000 note con _Nodi mostrati (massimo)_ a 1.000 (sprite), 1.500 e 2.000 (solidi), 3.000 e 5.000 (punti) (_Impostazioni del grafo → Vista 3D_, da 500 a 5.000 a passi di 500, quindi anche 2.500 per stare appena sopra la soglia dei solidi; il valore è salvato in `.clarae/graph.json` del vault). Con il tetto il 3D mostra solo i più collegati: un sottografo più denso di un vault che ha davvero 1.000 note, quindi per i numeri da confrontare con la tabella del benchmark conviene un vault per dimensione.

### 2.3 Come si apre il 3D e che cosa si fa

Il pulsante a forma di cubo nella barra del grafo, il comando _Apri vista grafo in 3D_ (ribbon e palette comandi), o _Grafo: passa tra 2D e 3D_. Il grafo globale si apre con `Mod+Maiusc+G`. Per ogni vault:

1. Aprire il 3D e lasciare assestare il layout. Ruotare (trascinamento), zoom, trascinare un nodo, selezionarne uno con la tastiera (`[` e `]`), `0` per adattare.
2. **Chiudere e riaprire il grafo dieci volte** (chiudere la scheda, riaprire il 3D). Alla chiusura la scena rilascia il contesto WebGL di proposito: se qualcosa non lo rilascia compare un avviso o il 3D torna in 2D.
3. **Quattro grafi alla volta:** aprire il 3D in cinque schede diverse (anche in split). Dal quinto atteso: il grafo è mostrato in 2D con l'avviso «Ci sono già 4 grafi aperti in 3D» (`MAX_3D_SURFACES` in `packages/workbench/src/graph/webgl.ts`).
4. Cambiare tema (chiaro, scuro) con il grafo aperto.

### 2.4 Che cosa annotare

| Misura                                              | Come                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nodi e link mostrati**                            | La riga di stato del grafo («N nodi, E link» o «Mostrati N nodi su M»).                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Livello di dettaglio**                            | A vista: fino a 1.000 nodi uno sprite per nodo (si vedono le icone); da 1.001 a 2.000 solidi, una forma per tipo di documento (sfera note e presentazioni, cubo disegni, ottaedro lavagne, cilindro basi, cono allegati, toro tag, icosaedro note non create) e la legenda mostra la forma al posto dell'icona; oltre 2.000 punti (`SPRITE_NODES` e `INSTANCED_NODES` in `graph/lod.ts`). In sviluppo: `document.querySelector('[data-testid="graph-3d"]').dataset.graphLod` risponde `sprite`, `instanced` o `points`. |
| **Tempo di assestamento** (apertura → layout fermo) | Con la console (sotto): l'attributo `data-graph-settled` della scena passa a `1`. In alternativa un cronometro, dal clic al momento in cui i nodi smettono di muoversi.                                                                                                                                                                                                                                                                                                                                                 |
| **Tempo di layout nel worker**                      | `window.__graphStats.layoutMs` (sotto): è la stessa grandezza della colonna «layout nel worker» del benchmark.                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Fps in orbita**                                   | Per 4 secondi trascinare il puntatore in modo continuo e leggere il contatore dei frame (sotto). Annotare la frequenza dello schermo.                                                                                                                                                                                                                                                                                                                                                                                   |
| **Fps durante il layout**                           | Lo stesso contatore, dall'apertura fino all'assestamento.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Memoria**                                         | Monitoraggio Attività, prima di aprire il 3D, a layout assestato e dopo le dieci aperture e chiusure: i processi della pagina web e della GPU di WebKit (nomi che contengono «WebKit» e «Clarae notanda»; se non si distinguono, confrontare quelli che salgono aprendo il grafo). Il valore dopo le dieci chiusure non deve restare molto sopra quello del primo giro.                                                                                                                                                 |
| **Avvisi WebGL**                                    | Nella console della pagina (sotto), qualunque messaggio che nomini contesti WebGL, contesto perso o troppi contesti. Annotare il testo.                                                                                                                                                                                                                                                                                                                                                                                 |
| **Esito soggettivo**                                | Fluido, a scatti, inutilizzabile; e se il 3D è tornato al 2D da solo con quale avviso.                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**La console della pagina, solo in sviluppo.** Con `task run-desktop` (modalità sviluppo) la pagina dell'app si può ispezionare con Safari: _Safari → Impostazioni → Avanzate_ → _Mostra funzionalità per sviluppatori web_, poi, con l'app aperta, il menu _Sviluppo_ → nome del Mac → _Clarae notanda_ → la pagina. Le build senza il tag `production` abilitano l'ispezione di WebKit su macOS 13.3 e successivi (`webview_window_darwin_dev.go` in Wails v3.1.0); il menu del tasto destro dell'app è disattivato (`DefaultContextMenuDisabled` in `apps/desktop/main.go`), quindi non c'è «Ispeziona elemento». **(non verificato su questo sistema)** il percorso esatto dei menu di Safari.

**In produzione l'ispezione è spenta** (`scripts/run-desktop.sh --build`, `task build-desktop` e le build di rilascio; una build di produzione che contenga il tag `devtools` non parte, `internal/shell/buildtags.go`). Su una build di produzione si possono fare solo le misure a vista e con Monitoraggio Attività.

Frammenti da incollare nella console, **prima** di aprire il 3D:

```js
// Layout nel worker e dimensione del grafo (lo legge Graph3D.tsx se esiste)
window.__graphStats = { frames: [], layoutMs: 0, nodes: 0, edges: 0, ticks: 0 };
// ...dopo l'assestamento: window.__graphStats

// Tempo di assestamento: dal momento in cui si incolla al layout fermo
(() => {
  const t0 = performance.now();
  new MutationObserver((_, o) => {
    if (document.querySelector('[data-testid="graph-3d"][data-graph-settled="1"]')) {
      console.log('assestato in', Math.round(performance.now() - t0), 'ms');
      o.disconnect();
    }
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-graph-settled'],
  });
})();

// Frame al secondo della pagina: leggere il valore durante l'orbita (a riposo la scena smette di disegnare)
(() => {
  let n = 0;
  let t0 = performance.now();
  const tick = (t) => {
    n++;
    if (t - t0 >= 1000) {
      console.log('fps', Math.round((n * 1000) / (t - t0)));
      n = 0;
      t0 = t;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
```

I frammenti dipendono dal codice: `window.__graphStats` e l'attributo `data-graph-settled` sono in `packages/workbench/src/graph/three/Graph3D.tsx` (righe 189-209), mentre `data-graph-lod` è scritto da `packages/workbench/src/graph/three/scene.ts`; se un frammento non risponde, rileggere quei file. Il contatore dei frame misura quanto spesso la pagina riesce a disegnare, non quanto lavora la GPU: è un indizio, il giudizio finale è a vista.

**Il livello intermedio (1.7.1).** Dalla 1.7.1 i livelli sono tre: sprite fino a 1.000 nodi, solidi istanziati da 1.001 a 2.000, punti oltre ([ADR-0055](../adr/0055-grafo-3d.md), punto 7). Sul Chromium del benchmark, con un grafo misto, il livello istanziato fa 8 draw call a qualunque dimensione e 0,1 ms di CPU di render per frame contro 0,9 ms degli sprite a 1.000 nodi e 1,8 ms a 2.000 (60 fps con Metal, limitati dal vsync); su un rasterizzatore software a 2.000 nodi 11,3 / 27,3 fps contro 9,3 / 18,0 degli sprite. Una o due serie su una macchina carica: ordini di grandezza ([`graph-3d-benchmark.md`](graph-3d-benchmark.md)). Sulla finestra reale **nessuno di questi livelli è stato visto**. Che cosa annotare, oltre ai numeri sopra:

- **In quale livello sta ogni dimensione**, a vista e con `dataset.graphLod` in sviluppo: a 1.000 nodi sprite, a 1.001 e 2.000 solidi, a 2.001 punti. Le soglie sono costanti del codice, non da fissare.
- **Le forme**: che le sette forme si distinguano a vista (sulla finestra reale di un Mac, nei due temi), che il colore segua il gruppo o il tipo come per gli sprite e che la **legenda** mostri la stessa forma di ciò che si vede.
- **Il trascinamento**: un solido si trascina e resta fissato fino a _Sblocca i nodi fissati_, come uno sprite; un punto (oltre 2.000) no.
- **Il confronto sulla finestra reale** (fps in orbita e fluidità) tra 1.000 (sprite), 1.500 e 2.000 (solidi) e 2.500 (punti), con lo stesso vault e _Nodi mostrati (massimo)_ (sezione 2.2). **Proposta, da confermare dall'owner:** se sulla WebView reale il livello a solidi è meno fluido degli sprite alla stessa dimensione, annotarlo come difetto: riaprirebbe la scelta di ADR-0055 (soglia `INSTANCED_NODES` o livello da togliere).
- Nel «Registro delle misure del 3D» (in fondo) la colonna **Livello** va compilata con `sprite`, `solidi` o `punti`.

### 2.5 Soglie proposte (da confermare)

Nessun documento fissa una soglia per il 3D sulla finestra reale: il 3D non eredita il «≥ 30 fps a 10.000 nodi» del 2D (`graph-3d-benchmark.md`, ADR-0055 punto 20). **Le soglie di questa sezione sono proposte di chi ha scritto il runbook: l'owner non le ha ancora fissate.** Per decidere il tetto di 5.000 nodi si propone, **da confermare dall'owner**:

- **Mantenere 5.000** se, sulla WebView reale, a 5.000 nodi l'orbita sta a **30 fps o più**, il layout si assesta in tempi dello stesso ordine del benchmark (qualche secondo), **non compaiono avvisi** sui contesti WebGL dopo le dieci aperture e chiusure e la memoria non cresce a ogni giro.
- **Abbassare il tetto predefinito** alla dimensione più grande che rispetta quelle condizioni, se 5.000 non le rispetta ma 3.000 sì (il valore per vault `maxNodes3d` resta regolabile).
- **Riaprire la scelta del 3D** (ripiego al 2D, o riduzione dei livelli) se già a 1.000-3.000 nodi la WebView non regge o l'avviso sui contesti compare.

I numeri finiscono nel registro di fondo e poi in `graph-3d-benchmark.md` (sezione «Cosa NON è stato verificato»).

## 3. Ordine consigliato delle prove

Il criterio: prima ciò che non vuole né cloud né rete, poi ciò che vuole il cloud, poi le altre macchine. I tempi sono **stime** per un Mac solo e un esecutore, senza ripetere un caso già fallito; si possono fare in più sessioni.

| Blocco | Prove                                                                                                                              | Con che cosa                                                                | Tempo stimato                                |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| A      | Shell: angoli e raccordi, stato vuoto. Disegni: navigazione, mini-mappa, fusione, tema, ricerca, libreria, esportazione automatica | `task run-desktop`, **rete staccata** per i disegni                         | 1 h 15                                       |
| B      | Grafo 3D su vault grandi: 1.000, 3.000, 5.000 nodi (e il vault misto)                                                              | `task run-desktop` (sviluppo, per la console), poi una passata su `--build` | 1 h 15                                       |
| C      | Applicazioni su macOS 14 o successivo (matrice §1, M1…M42); le voci di A e B che vogliono il cloud                                 | cloud acceso, flag acceso (sezione 1.3 e 1.4)                               | 2 h 30 (+ 30 min di preparazione)            |
| C2     | Workbench web (matrice §4, B1…B5)                                                                                                  | cloud + `task dev-web`, un browser                                          | 20 min                                       |
| D      | Windows (matrice §2), Linux (matrice §3), macOS 13 (M23, M38), schermo non retina (M15), shell e disegni su WebView2 e WebKitGTK   | altre macchine, [sezione 5](#5-cosa-non-si-può-provare-su-un-solo-mac)      | 1 h 30 in tutto, più il tempo per procurarle |

In totale circa 7 ore su un Mac.

### Blocco A: shell e disegni (1 h 15)

Avviare con la rete accesa (la prima volta `yarn install` la vuole), aprire il vault demo e **poi staccare la rete** per le checklist dei disegni, che lo chiedono («Eseguire con la rete scollegata»: Excalidraw deve funzionare offline). La modalità sviluppo serve la pagina da `127.0.0.1`, quindi funziona senza rete.

| Passo | Checklist e voce                                                                                                                                                                                                                                                                                        | Note                                                                                                                                                                                  | Tempo  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A1    | [`m8-shell-ui.md`](m8-shell-ui.md), «Layout e tema»: voce **Angoli e raccordi (M18, 1.6)**                                                                                                                                                                                                              | Nei due temi (_Impostazioni → Aspetto_), con molte schede, schede bloccate, trascinamento di una scheda, split a due pannelli. Fare schermate (sezione 4): non esiste un test visivo. | 10 min |
| A2    | [`m8-shell-ui.md`](m8-shell-ui.md), «Layout e tema»: voce **Stato vuoto (M18, 1.6)**                                                                                                                                                                                                                    | Chiudere tutte le schede, anche con due pannelli vuoti (split). Le sotto-prove «funzione spenta dal profilo» e «vault in sola lettura» vogliono il cloud: rimandarle al blocco C.     | 10 min |
| A3    | [`m3-drawings-canvas.md`](m3-drawings-canvas.md), sezione **«Navigazione, fusione e libreria (M18, 1.6; ADR-0053, ADR-0054)»** (dieci voci)                                                                                                                                                             | Serve un **disegno grande** (sotto). Da rimandare al blocco C: la voce «Vault condiviso, una modifica di un altro utente» e, della voce sulla libreria, i «due dispositivi».          | 30 min |
| A4    | Le tre voci di [`m3-drawings-canvas.md`](m3-drawings-canvas.md) marcate «dalla 1.6» fuori da quella sezione: **Libreria** (sezione «Disegni (Excalidraw)»), **Modifica del file dall'esterno** (stessa sezione) ed **Esportazione automatica** (sezione «Azioni sulla scena, esportazione e strumenti») | Per la fusione: modificare il file `.excalidraw` da fuori dall'app con una modifica non salvata dentro.                                                                               | 15 min |

**Disegno grande** (per la mini-mappa, lo zoom sulla selezione e il footer): dalla radice, con Node, in un vault aperto (qui il demo):

```sh
node -e '
const els = [];
for (let i = 0; i < 2000; i++) {
  const id = "r" + String(i).padStart(4, "0");
  els.push({ id, type: "rectangle", x: (i % 50) * 240, y: Math.floor(i / 50) * 160, width: 200, height: 120, angle: 0, strokeColor: "#1e1e1e", backgroundColor: i % 7 === 0 ? "#a5d8ff" : "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: i + 1, version: 1, versionNonce: i + 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, index: "a" + id.length + id });
}
require("fs").writeFileSync(".dev/standalone/vaults/Demo/Disegno grande.excalidraw", JSON.stringify({ type: "excalidraw", version: 2, source: "clarae", elements: els, appState: { viewBackgroundColor: "#ffffff" }, files: {} }));
'
```

Scrive un disegno di 2.000 rettangoli (circa 0,8 MB, sotto le soglie di 8 e 10 MB) con gli stessi campi della scena di prova degli e2e (`apps/desktop/frontend/e2e/drawingHelpers.ts`). **(non verificato)** che Excalidraw lo apra senza correzioni nell'app vera; se fallisce, selezionare tutto in un disegno, copiare e incollare più volte.

### Blocco B: grafo 3D (1 h 15)

Procedura e misure nella [sezione 2](#2-vault-grande-per-il-grafo-3d). Ordine: 1.000, 3.000, 5.000 nodi in sviluppo (con la console, per i numeri); il vault misto da circa 1.800 nodi (livello intermedio) e quello da 3.900; poi **una passata a vista** su una build di produzione (`scripts/run-desktop.sh --build --demo`, chiusa l'app di sviluppo) con il vault da 5.000, per vedere se il prodotto vero si comporta come lo sviluppo: orbita, dieci aperture e chiusure, avvisi (qui nessuna console: l'avviso è quello che l'app mostra, per esempio il ritorno al 2D).

Il tempo di indicizzazione dei tre vault può essere il grosso del blocco: aprirli uno dopo l'altro e lasciarli indicizzare mentre si fa altro.

### Blocco C: applicazioni con il cloud (2 h 30 + preparazione)

Preparare l'ambiente come in 1.3, 1.4 e 1.5, poi la [matrice delle applicazioni](m18-webview-matrice.md), **sezione 1 (macOS)**, nell'ordine dei numeri, con le «Applicazioni da registrare» della sua sezione «Preparazione» (GitHub, un secondo sito con login, un server locale con `python3 -m http.server 8000`, un sito con certificato autofirmato, un vault privato con il blocco a 1 minuto, un secondo dispositivo).

Le prove a mano che il piano di M18 (`.claude/roadmap/analizza-immagine-e-progetta-happy-shore.md`, sezione «Verifica») elenca per le applicazioni, e dove sono:

| Prova a mano del piano di M18                                                                       | Dove                                                                                                                               |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Schede e raccordi nei due temi                                                                      | A1                                                                                                                                 |
| Stato vuoto in split                                                                                | A2                                                                                                                                 |
| Footer e mini-mappa su un disegno grande                                                            | A3 (voci della mini-mappa e del gruppo di zoom accanto al controllo dello zoom)                                                    |
| Grafo 3D su un vault reale                                                                          | Blocco B                                                                                                                           |
| Un'applicazione che vieta l'incorniciamento (GitHub) aperta in una scheda, con palette e menu sopra | Matrice, **M1** (apertura di `https://github.com`), **M3** (palette), **M5** (menu della scheda), M6 (dialoghi), M7 (impostazioni) |

Voci dei blocchi A che qui trovano il cloud: stato vuoto con una funzione spenta dal profilo (A2: salvare nel profilo `{"features": {"web_viewer": true, "drawings": false}}` e vedere sparire _Nuovo disegno_) e con un vault condiviso in sola lettura; la modifica di un altro utente a un disegno aperto, e la libreria con due dispositivi (A3, con `--two-devices`).

Avvertenze sulla matrice, da sapere prima di cominciare:

- **Il selettore rapido trova i file `.webapp`** (1.7.1; nella 1.7.0 cercava solo le note). Cerca per nome, senza estensione, applicazioni, lavagne, basi e disegni oltre alle note, con l'icona del tipo e il tipo letto dai lettori di schermo; i suggerimenti dei wikilink sono invariati; un file di un altro tipo con lo stesso nome non nasconde più «Crea nota». Il caso **M4** della matrice è aggiornato di conseguenza e il caso **M42** (nuovo) copre il tipo letto da VoiceOver e la voce «Crea…»; per l'origine non ancora confermata vale la conferma di **M1** e **M37** (aprendo l'applicazione dal selettore compare «Aprire … qui?» prima di caricare qualcosa). I file in `.trash/` e nelle cartelle nascoste non compaiono (né nel selettore né nei suggerimenti dei wikilink), e una presentazione `.marp` o un alias omonimi tolgono «Crea nota» (M42). **Non è stato visto sulla finestra reale**: gli e2e girano su Chromium con i binding simulati.

- **M20 e M21** vogliono l'attesa di un minuto di blocco e l'uscita con viste aperte: sono P0 se falliscono (una pagina di un vault bloccato che resta visibile, o processi orfani).
- **M23 e M38** distinguono macOS 14 e 13: con un solo Mac eseguire quello che il sistema permette e segnare `n/d` per l'altro ([sezione 5](#5-cosa-non-si-può-provare-su-un-solo-mac)).
- **M37** (applicazione arrivata dalla sincronizzazione) vuole due dispositivi: `--two-devices` e un `.webapp` con un'origine mai usata.
- La **prova del driver** da sola, senza cloud né interfaccia, è `task test-nativeview` (a mano, apre una finestra, usa la rete per due controlli): serve per distinguere un difetto del driver da uno dell'interfaccia.

### Blocco C2: workbench web (20 min)

Matrice, sezione 4 (B1…B5), con `task dev-web` acceso e il profilo con il flag. Aprire il vault dalla console (`http://localhost:5174`, pagina _I miei vault_, _Apri_): serve un vault cloud, per esempio uno condiviso creato dalla console o collegato dal desktop. Per B3 aprire gli strumenti del browser e guardare il pannello _Rete_.

### Blocco D: altre macchine

Windows, Linux, macOS 13 e lo schermo non retina: vedi la [sezione 5](#5-cosa-non-si-può-provare-su-un-solo-mac). Su Windows e Linux eseguire anche le voci M18 di [`m8-shell-ui.md`](m8-shell-ui.md) e [`m3-drawings-canvas.md`](m3-drawings-canvas.md) (la seconda dice «Da eseguire sul webview reale (macOS, Windows, Linux)»: in particolare il posizionamento del gruppo di zoom e della mini-mappa dipende dalle classi del fork di Excalidraw) e le misure del 3D, se la macchina ha una GPU diversa.

## 4. Come registrare gli esiti

### 4.1 Dove

| Prova                                                                                         | Dove si scrive l'esito                                                                                                                                             |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Matrice delle applicazioni, compresi i casi del driver Windows sperimentale (WE1…WE25)        | Colonna **«Esito»** di ogni riga di [`m18-webview-matrice.md`](m18-webview-matrice.md), più una riga nel **«Registro delle esecuzioni»** in fondo allo stesso file |
| Voci di [`m8-shell-ui.md`](m8-shell-ui.md) e [`m3-drawings-canvas.md`](m3-drawings-canvas.md) | Si spunta `[x]` accanto alla voce con data e sistema operativo; un `ko` lascia `[ ]` e aggiunge una riga sotto la voce con il difetto                              |
| Misure del grafo 3D                                                                           | La tabella «Registro delle misure del 3D» in fondo a questo runbook; i valori che contano passano poi in `graph-3d-benchmark.md`                                   |
| Ogni sessione                                                                                 | Una riga del «Registro delle sessioni» in fondo a questo runbook                                                                                                   |

### 4.2 Formato

Una riga per esito: **data** (AAAA-MM-GG), **sistema e versione** (`sw_vers -productVersion`, la versione di Windows, `lsb_release -d`), **build** (hash di `git rev-parse --short HEAD`; «sviluppo» per `task run-desktop`, «produzione» per `--build` o per un installer; versione di `--version` se c'è) ed esito: `ok`, `ko` con il livello, oppure `n/d` (non eseguibile, con il motivo). Per esempio:

- `ok 2026-11-16, macOS 27.2.1 arm64, 3e1f2a0 sviluppo`
- `ko P1 2026-11-16, macOS 27.2.1 arm64, 3e1f2a0 produzione: il tooltip è coperto dalla pagina (schermata M8-tooltip.png)`
- `n/d 2026-11-16: serve macOS 13`

**Livelli** (convenzione di questo runbook; la matrice di Wails v3 definisce solo i P0, [`m15-wails3-matrice.md`](m15-wails3-matrice.md)): **P0** perdita di dati, crash o blocco dell'app, una pagina di un'applicazione che esce dal suo isolamento (legge o scrive l'app) o resta visibile dopo il blocco di un vault privato; **P1** la funzione non fa ciò che promette e non c'è un ripiego ragionevole; **P2** difetto minore o estetico, con ripiego.

### 4.3 Che cosa fare di un `ko`

1. **Annotare subito**, sotto la voce o la riga, che cosa si è visto e che cosa era atteso, con i passi per rifarlo.
2. **Una schermata** (macOS: `Maiusc+Cmd+4`, poi la barra spaziatrice per la finestra) per ogni difetto visivo, con il tema e lo zoom dell'app; salvarla fuori dal repository o in una cartella ignorata e citarne il nome nella riga.
3. **Il log**: `.dev/<istanza>/logs/clarae.log` (e `.dev/logs/cloud.log` per i problemi di profilo o di sincronizzazione), con l'ora del difetto.
4. **Un'issue** per ogni P0 e P1 sul repository (`E2BRAdvisory/Clarae`) **(non verificato che le issue siano attive)**, altrimenti la sola riga di registro; i P2 possono restare nel registro. Citare nell'issue la voce (`M24`, `A3`…), il livello, l'hash della build e la schermata.
5. **Un P0 o un P1 sulle applicazioni** va riportato anche in [`docs/roadmap.md`](../roadmap.md) §13-undecies, come dice il registro della matrice.

### 4.4 Quali esiti decidono che cosa

| Esito                                                                                                                                                                                                                      | Che cosa decide                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Matrice delle applicazioni verde** (proposta, **non ancora fissata dall'owner**: nessun P0 e nessun P1 sulla sezione macOS 14 o successivo; i casi di Windows, Linux e web confermano il ripiego sul browser di sistema) | Se **proporre `features.web_viewer` acceso di default**. Oggi resta spento, e nella 1.7.1 resta spento comunque (decisione dell'owner). Un esito verde non cambia il default da solo: è la base per una decisione ([ADR-0056](../adr/0056-applicazioni-in-vista-nativa.md), accettato il 2026-11-15, non accende il flag: lo lascia spento finché la matrice non è eseguita) |
| **P0 nelle applicazioni** (M20, M21, M27, M28, M29, una pagina che esce dal suo isolamento)                                                                                                                                | Il flag resta spento e il difetto si corregge prima di riproporre la matrice                                                                                                                                                                                                                                                                                                 |
| **M23 e M38** (sessione su macOS 14 e 13)                                                                                                                                                                                  | Se la guida e la nota per chi amministra devono dire di più su macOS 13 o se serve un avviso nell'app                                                                                                                                                                                                                                                                        |
| **Esiti dei casi WE del driver Windows sperimentale**                                                                                                                                                                      | Se proporre di accendere il driver (`windows` in `DesktopOS` e le altre tappe di [ADR-0056](../adr/0056-applicazioni-in-vista-nativa.md), punto 35); finché nessun caso è eseguito resta spento                                                                                                                                                                              |
| **Misure del 3D sulla WebView reale**                                                                                                                                                                                      | Il tetto di 5.000 nodi ([sezione 2.5](#25-soglie-proposte-da-confermare)): mantenerlo, abbassare il predefinito o riaprire la scelta; le righe di «Cosa NON è stato verificato» di `graph-3d-benchmark.md`                                                                                                                                                                   |
| **Voci di M18 di `m8-shell-ui.md` e `m3-drawings-canvas.md`**                                                                                                                                                              | Quali righe «Non provato» di [`docs/roadmap.md`](../roadmap.md) §13-undecies si chiudono                                                                                                                                                                                                                                                                                     |

## 5. Cosa non si può provare su un solo Mac

| Che cosa                                         | Perché                                                                                                                                            | Come procurarselo                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows 11** (matrice §2, shell e disegni, 3D) | Il browser incorporato è spento e la capability `embeddedBrowser` è falsa (il driver sperimentale si prova come in 5.1); WebView2 non è WKWebView | Costruire l'installer sul Mac (sotto) e provarlo su un PC o su una macchina virtuale                                                  |
| **Linux** (matrice §3, shell e disegni, 3D)      | Come Windows; WebKitGTK ha un suo comportamento di WebGL                                                                                          | Ubuntu 22.04 o 24.04 su un PC o una macchina virtuale; la build di Linux richiede un host Linux (WebKitGTK è CGO)                     |
| **macOS 13** (M23 parziale, M38)                 | Dati non persistenti prima di macOS 14                                                                                                            | Un secondo Mac o una partizione con macOS 13. Una macchina virtuale può non avere l'accelerazione grafica: non serve a misurare il 3D |
| **Schermo non retina** (M15)                     | Servono due schermi di densità diversa                                                                                                            | Un monitor esterno a bassa densità collegato al Mac                                                                                   |
| **Hardware meno recente** (3D)                   | Il layout scala con la CPU, il rendering con la GPU                                                                                               | Un Mac più vecchio, o un portatile senza GPU dedicata; non ci sono misure                                                             |
| **Due utenti reali su un vault condiviso**       | Le prove con altro utente vogliono due account                                                                                                    | `user1` e `user2` di sviluppo, su due istanze (`--two-devices`)                                                                       |

### 5.1 Windows

**L'installer si costruisce sul Mac** (la build di Windows è con CGO spento, perché il binding WebView2 non ne ha bisogno, e si compila da qualunque sistema):

```sh
ALLOW_UNSIGNED_UPDATES=1 task release-desktop OS=windows ARCH=amd64 V=1.7.1-rc.1
```

Servono `makensis` (NSIS) e la CLI `wails3` (`task wails-cli`) sul Mac; risultano entrambi installati su questa macchina (`which makensis wails3`). `ALLOW_UNSIGNED_UPDATES=1` compila l'aggiornamento automatico fuori dal binario (nessuna chiave di firma): è la build delle prove, non di rilascio. Il risultato è `apps/desktop/build/bin/clarae-amd64-installer.exe` e `clarae.exe` nella stessa cartella; **non sono firmati**, quindi Windows mostra gli avvisi di SmartScreen. Con `ARCH=arm64` si ottiene l'installer arm64 (non è più un artefatto di rilascio, `docs/release/README.md`). Il comando passa per `scripts/release/build-desktop.sh` e `scripts/build-desktop-bin.sh` (`CGO_ENABLED=0`, `-tags production`). **(non provato su Windows)**: l'installer non è mai stato eseguito su un Windows vero (`docs/release/README.md`).

Su Windows: eseguire l'installer, avviare l'app con una cartella dei dati propria per non toccare quelle di un'installazione precedente (`clarae.exe --data-dir C:\Prove\Clarae`, oppure la variabile `CLARAE_DATA_DIR`). Su una macchina virtuale con Windows 11 su un Mac Apple Silicon l'installer amd64 gira in emulazione: **(non verificato)**.

**Il cloud di sviluppo è raggiungibile solo da `localhost`:** il realm di Keycloak e `OIDC_ISSUER` dicono `http://localhost:8080`, quindi un'altra macchina deve vedere quelle porte come proprie. Un modo, dalla macchina Windows (o Linux): `ssh -L 18081:127.0.0.1:18081 -L 8080:127.0.0.1:8080 -L 9000:127.0.0.1:9000 <utente>@<indirizzo del Mac>` (serve _Accesso remoto_ acceso sul Mac), poi in _Impostazioni → Cloud_ l'URL `http://127.0.0.1:18081`. **(non verificato)** che basti. Per le sole prove W1…W6 serve il login e quindi il profilo; W7 anche la sincronizzazione.

> **Nota (M22, 2026-11-19).** Questo paragrafo e i quattro elenchi che seguono descrivono la 1.7.1. Dalla M22 ([ADR-0062](../adr/0062-vista-integrata-windows-linux.md), in proposta) il driver di Windows è **acceso di default**: `CLARAE_WEBVIEW2_EXPERIMENTAL` non è più letta, la capability `embeddedBrowser` elenca `windows` e `linux`, e per spegnere la vista si usa `CLARAE_WEBVIEW=off`. La matrice ([`m18-webview-matrice.md`](m18-webview-matrice.md), sezione 2, sottosezione «Driver acceso (senza interruttore)») e il runbook [`m22-nomi-file-e-applicazioni.md`](m22-nomi-file-e-applicazioni.md) sono quelli aggiornati.

**Driver Windows sperimentale.** Nella 1.7.1 il driver Windows è compilato (amd64 e arm64, CGO spento) ma **spento**, finché non è provato su Windows, e **non è mai stato eseguito**. È una copia ridotta e corretta del binding WebView2 interno di Wails v3.1.0 (`apps/desktop/internal/shell/nativeview/webview2/`, con `LICENSE` e `NOTICE`).

- **Interruttore:** la variabile d'ambiente `CLARAE_WEBVIEW2_EXPERIMENTAL`; **solo il valore `1`** accende il driver (`""`, `0` e `true` no). In PowerShell: `$env:CLARAE_WEBVIEW2_EXPERIMENTAL = "1"` e poi `clarae.exe --data-dir C:\Prove\Clarae`.
- **La capability `embeddedBrowser` resta solo macOS** (`DesktopOS` in `apps/desktop/internal/app/capabilities.go`): anche con l'interruttore l'interfaccia apre le applicazioni nel browser di sistema, cioè i casi W1…W7 della matrice restano quelli di prima. Per vedere la pagina dentro la scheda serve una build di prova con `windows` in `DesktopOS` (si costruisce come in questa sezione, dopo la modifica), avviata con la variabile. **(non verificato)** che basti: è ciò che si deduce dal codice.
- **Casi da eseguire:** la sottosezione «Driver sperimentale (interruttore)» della sezione 2 della matrice ([`m18-webview-matrice.md`](m18-webview-matrice.md), casi WE1…WE25): primo avvio con e senza runtime e con runtime vecchio, indirizzo e titolo, bounds a 100/125/150/200% di DPI, sovrapposizione, politica di navigazione, nessun canale verso l'app, `window.open`, download, permessi, certificati e credenziali, scorciatoie, fuoco, blocco automatico con la sola rotella, persistenza, pulizia, 200 cicli e processi orfani, crash, seconda istanza, valori della variabile, Windows 10 e 11 su amd64 e arm64.
- **Differenze dichiarate rispetto a macOS**, da non segnare come difetti: user agent di Edge; il selettore di file non si può negare; per il blocco automatico di un vault privato contano solo tasti e fuoco, non mouse e rotella; l'autenticazione integrata (NTLM, Kerberos) è del runtime; runtime minimo 1.0.2210.55 (con uno più vecchio la pagina si apre nel browser).
- **Dove annotare gli esiti:** la colonna «Esito» dei casi WE della matrice e una riga del «Registro delle esecuzioni» di quel file, con l'architettura (amd64 o arm64) e la versione del runtime WebView2.
- **`task ci` compila il codice Windows** (passo `vet-windows`: `go vet`, compilazione dei test senza eseguirli e golangci-lint, amd64 e arm64, CGO spento): garantisce che compili, non che funzioni.
- **Per accenderlo davvero**, a prova eseguita: `windows` in `DesktopOS`, `task gen`, registro di parità e guide ([ADR-0056](../adr/0056-applicazioni-in-vista-nativa.md), punto 35).

### 5.2 Linux

Nessun driver, nella 1.7.1 come nella 1.7.0: la capability è spenta e l'applicazione si apre nel browser di sistema. Su Ubuntu 22.04 o 24.04 con `libgtk-3-dev` e `libwebkit2gtk-4.1-dev` (come richiede [`m15-wails3-matrice.md`](m15-wails3-matrice.md), §0), nel repository clonato:

```sh
ALLOW_UNSIGNED_UPDATES=1 task release-desktop OS=linux V=1.7.1-rc.1
```

costruisce `apps/desktop/build/bin/clarae` (`-tags production,gtk3`) per l'architettura della macchina. Per provare senza passare dal task di rilascio: `scripts/run-desktop.sh --build --demo` costruisce e avvia l'app standalone (dati in `.dev/standalone`), e `scripts/run-desktop-with-cloud.sh --demo` avvia stack, cloud e desktop sulla stessa macchina, che così non ha bisogno del tunnel. **(non provato su Linux)**: al 2026-11-11 la build `gtk3` non risultava mai eseguita ([`m15-wails3-matrice.md`](m15-wails3-matrice.md)) e `scripts/release/package-linux.sh` dichiara di non essere stato eseguito. I pacchetti `.deb` e AppImage (`scripts/release/package-linux.sh`) non servono per queste prove.

### 5.3 macOS 13 e altri Mac

Un Mac con macOS 13 esegue la build universale costruita qui: `task build-desktop` (o `scripts/build-desktop-bin.sh`) produce `apps/desktop/build/bin/Clarae notanda.app`, da copiare sull'altra macchina; essendo firmata ad hoc, il Finder può chiedere di aprirla con il tasto destro. **(non verificato)**.

## Registro delle sessioni

Una riga per sessione di prova (anche interrotta).

| Data | Blocco | Sistema e versione | Build (hash, sviluppo o produzione) | Esecutore | Casi eseguiti (ok / ko / n/d) | Difetti e schermate |
| ---- | ------ | ------------------ | ----------------------------------- | --------- | ----------------------------- | ------------------- |
|      |        |                    |                                     |           |                               |                     |

## Registro delle misure del 3D

Una riga per vault e per esecuzione, sulla finestra reale. Valori di riferimento del benchmark in Chromium (`graph-3d-benchmark.md`): con GPU Metal 60 fps in orbita fino a 5.000 nodi; con il rasterizzatore software da 19 a 29 fps in orbita.

| Data | Sistema, Mac e schermo | Build | Vault (nodi mostrati / link) | Livello | Indicizzazione | Layout nel worker (ms) | Assestamento (ms) | Fps durante il layout | Fps in orbita | Memoria prima / assestato / dopo 10 cicli | Avvisi WebGL | Note |
| ---- | ---------------------- | ----- | ---------------------------- | ------- | -------------- | ---------------------- | ----------------- | --------------------- | ------------- | ----------------------------------------- | ------------ | ---- |
|      |                        |       |                              |         |                |                        |                   |                       |               |                                           |              |      |
