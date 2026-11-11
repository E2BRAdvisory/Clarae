# Parità tra il workbench web e il client desktop

Obiettivo (ADR-0029): dal browser si fa tutto ciò che si fa dal client desktop, con la stessa interfaccia e lo stesso comportamento. Qui sta ciò che è **verificato**, ciò che **non lo è** e le **eccezioni**.

Dal 2026-11-01 la parità si misura per **funzione**, non solo per comando o binding (ADR-0037 §1). La fonte è il registro [`shared/parity/features.yaml`](../shared/parity/features.yaml): una voce per funzione utente, con lo stato su tre superfici (desktop, workbench web, console web), la motivazione di ciò che non è `yes` e i test che la coprono, divisi per superficie. Dal 2026-11-03 (ADR-0045 §4) un `yes` del workbench non si eredita dal desktop: vuole una prova sul core WebAssembly, altrimenti la funzione è `partial` con la motivazione «non verificata sul web». Le tabelle in fondo a questa pagina sono generate da quel registro. La pagina è nata con M9 (M9-WP7) ed è aggiornata a M12 (ADR-0045).

## Perché la parità è per costruzione, e dove no

- **Stessa UI:** il frontend desktop è il pacchetto `@memobrain/workbench`, montato così com'è dal desktop e dalla Web UI. Un comando o un pannello non esiste in due versioni.
- **Stessa logica:** i binding sono gli struct Go del desktop compilati in WebAssembly (`apps/desktop/cmd/memobrain-core`), esposti da un dispatcher che segue la semantica di Wails. L'elenco dei servizi è uno solo (`App.Services()`).
- **Stesse dichiarazioni** (ADR-0045): le capability dell'host le dichiara il core Go e `task gen` le porta nella UI; eventi, client dell'host del browser e `FeatureId` sono generati; comandi e azioni dei pannelli nominano la loro funzione e le capability che richiedono; i binding di gestione cloud usano i tipi dell'OpenAPI. Dettagli in [desktop-web-sync.md](desktop-web-sync.md).
- **Cosa cambia davvero:** il file system (OPFS dietro lo shim `fs`), SQLite (sqlite-wasm), la sessione (il token lo dà la pagina), la notifica delle modifiche (niente fsnotify) e le finestre di dialogo (download, selettore di file del browser). È lì che possono nascondersi le differenze: i bug veri trovati finora stanno tutti in quel livello (un `open` concorrente dello stesso file dava EBUSY; il mock di Wails copriva il bridge).

## Eccezioni dichiarate

| Funzione desktop                                                            | Sul web                           | Motivo                                                               |
| --------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------- |
| Aggiornamento automatico (`update:check`, `UpdaterAPI`)                     | assente                           | la Web UI la serve il cloud, è sempre aggiornata                     |
| Vault su una cartella del computer (`VaultAPI.PickFolder`, «Apri cartella») | assente                           | si aprono vault del cloud, copiati nel browser                       |
| Importer da cartella                                                        | assente                           | richiede una cartella locale (capability `localFolders`)             |
| Avviso sul disco non cifrato (`DiskEncryption`)                             | assente                           | non c'è un disco di cui parlare                                      |
| Link `memobrain://`                                                         | sostituito da `/vaults/:id/open`  | schema di URL del sistema operativo                                  |
| Schermo intero della finestra                                               | solo Fullscreen API dell'elemento | nessuna finestra nativa                                              |
| Cestino di sistema                                                          | `.trash/` del vault               | il browser non ha un cestino                                         |
| Più vault aperti insieme                                                    | uno per browser                   | gli handle sincroni di OPFS sono esclusivi                           |

Nel registro queste eccezioni sono le voci con stato `exception` sul workbench (`vault.local-folder`, `app.updater`, `crypto.disk-check`, `deeplink`, `window.native`, `vault.system-trash`, `vault.multi-open`); l'importer da cartella è la voce `import`, con stato `partial`.

## Cosa è verificato (2026-11-03)

| Livello                                 | Cosa                                                                                                                                                        | Dove                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Core Go sotto WASM                      | tutti i pacchetti di `apps/desktop/internal` e `cmd` con test, compreso il confronto tra i metodi dell'host del browser e le capability (`capabilities_web_test.go`) | `task test-wasm` (32 pacchetti)                                   |
| Pannelli cloud sul core in Node         | le suite dei componenti di `@memobrain/cloud-features` (vault, dispositivi, utilizzo, condivisioni, inviti, mount) su `CoreCloudPort` sopra il core WebAssembly, con un cloud finto validato su `api/openapi.yaml` | `task test-core` (`CoreCloudPort.core.test.tsx`)                  |
| Shim `fs` su OPFS                       | 13 test in un worker vero, tra cui rename atomico, cartelle, handle condivisi, file aperti rinominati e cancellati                                           | `web/e2e/opfs-fs.spec.ts`                                         |
| Workbench sul core vero                 | 13 test: scrittura, ricerca FTS5, link, rinomina, storia, ZIP, grafo, persistenza, blocco e cancellazione, «Dimentica questo browser», motore fermo, seconda scheda, indirizzo non valido | `web/e2e/workbench.spec.ts`                                       |
| **Gli stessi spec del desktop sul web** | matrice e2e: ogni spec di `apps/desktop/frontend/e2e` gira sui progetti `desktop-mock` e `web-core`; le esclusioni sul web sono dichiarate con `skipOnWeb` (tabella «Spec e2e per target» sotto) | `task e2e-matrix` (`yarn workspace @memobrain/web e2e:workbench-ui`) |
| Cloud vero                              | login Keycloak, dispositivo `web`, due browser: una nota arriva dall'uno all'altro e due modifiche concorrenti alla stessa nota `.md` si fondono sul client; vault privato creato e sbloccato nel browser | `web/e2e-cloud/web-sync.spec.ts`, `web-private.spec.ts`, `web-create-private.spec.ts` (`e2e:cloud`, richiede lo stack) |
| Pannelli cloud sul core                 | vault cloud (rinomina, eliminazione, ripristino, vault eliminato altrove), spazio e dispositivi, condivisioni (creazione, modifica, permessi, revoca, condivisione dentro una cartella gestita), invito accettato e mount aperto nella sua pagina, Config Profile con una chiave bloccata: gli spec del desktop sul core WebAssembly contro il mock REST, che valida richieste e risposte su `api/openapi.yaml` | `account-panels`, `cloud-vaults`, `sharing` della matrice e2e, con `web/e2e/cloudMock.ts` |
| Desktop e browser sullo stesso cloud    | dispositivo desktop headless (`apps/desktop/cmd/e2e-device`) e workbench: fusione di una nota `.md`, copia di conflitto di un `.canvas` e fusione per elemento di un disegno, vault privato creato sul desktop e sbloccato nel browser, condivisione accettata, aperta come mount e revocata, flag `web_workbench` spento da un Config Profile, dispositivo revocato | `web/e2e-mixed/mixed.spec.ts` (`task e2e-mixed`, richiede lo stack) |
| Sicurezza                               | build minificata con l'handler Go e la CSP di produzione, nessuna violazione né richiesta esterna, WASM in gzip                                             | `web/e2e-security/workbench-csp.spec.ts`                          |

Non c'è un servizio di CI (ADR-0036): `task test-wasm`, `task test-core` e il controllo del registro (`task parity`) sono in `task ci`; gli e2e web (`e2e:workbench-ui`, `e2e-mixed`, `e2e:cloud`, `e2e:security`) sono suite lente da eseguire a mano quando si tocca l'area e prima di un rilascio, con i prerequisiti elencati in [dev-setup](dev-setup.md#verifiche). Le cifre della tabella sono quelle del 2026-11-03; quale funzione è provata da quale test lo dicono le tabelle generate.

## Cosa NON è verificato

- **Le funzioni `partial` «non verificata sul web».** Nessun test le esercita sul core WebAssembly (tabella «Funzioni» sotto): storico delle revisioni, file eliminati, cambio della passphrase e nuova recovery key, scorciatoie, completamento dei link, struttura, proprietà, statistiche, tag, segnalibri, workspace, anteprima dei link, note giornaliere, modelli, unione ed estrazione, basi, esportazione dei disegni e delle note. La UI e il codice Go sono quelli del desktop, quindi il rischio sta nel livello del browser (file system, download, dialoghi); il controllo le riporta a `yes` solo con una prova.
- **I pannelli cloud contro un cloud vero.** Sul core li provano gli spec della matrice con il mock REST (`web/e2e/cloudMock.ts`), che segue il contratto ma non la logica del server (permessi, quote, conservazione); contro un cloud vero li provano solo i percorsi della suite mista (mount, revoca, flag).
- **«Scarica una copia» di un mount revocato** nel browser: test unitari (`packages/workbench/src/sharing/sharing.test.tsx`, `web/src/workbench/guard.test.ts`), nessuno spec e2e.
- **Specifici del desktop non portati:** gli spec che leggono i dati del mock di Wails (esportazioni catturate, banchi di prova) non girano sul web; gli altri sì, tutti o in parte (tabella «Spec e2e per target»).
- **Safari e Firefox:** solo Chromium.
- **Prestazioni:** indicizzazione di vault grandi nel browser (stimata > 5 minuti a 50k note, ADR-0030).

## Il registro delle funzioni

Ogni voce di `shared/parity/features.yaml` (schema: `shared/parity/features.schema.json`) dice:

- **desktop e workbench:** stato, comandi (`commands`), azioni dei pannelli (`actions`, dichiarate con `defineAction`, ADR-0045 §2), binding Go (`bindings`), operazioni REST chiamate dal core (`operationIds`) ed eventuale capability della piattaforma (`capability`). Il workbench eredita gli elenchi del desktop se non li ripete: è la stessa UI sullo stesso core. Ogni comando e ogni azione dichiara a sua volta la sua funzione (`feature`, un `FeatureId` generato dal registro con `task gen`), che deve essere una delle voci che lo elencano;
- **console:** stato, rotte (`routes`, da `web/src/App.tsx` più `/vaults/:id/open`), operazioni OpenAPI (`operationIds`) e azioni senza REST (`actions`, gli attributi `data-action` di `web/src`: «Esci», «Dimentica questo browser», lingua, tema). La sezione manca (n/a) per le funzioni sul contenuto di un vault aperto, che la console affida al workbench;
- **stato:** `yes`, `partial`, `exception` (eccezione dichiarata), `console-only` (solo desktop e workbench: la funzione sta nella console, per esempio l'amministrazione) o `missing`. Tutto ciò che non è `yes` ha una motivazione (`reason`); `note` aggiunge un'informazione anche a una voce `yes`;
- **test per superficie** (ADR-0045 §4): `desktop` (UI, e2e sul mock, core Go), `workbench` (host web `web/src/workbench`, spec nel browser `web/e2e*`, spec della matrice `apps/desktop/frontend/e2e`), `console` (`web/src`, `web/e2e`, l'adattatore REST di `packages/cloud-features`) e `cloud` (`services/cloud`). Un file fuori dal posto della sua superficie è un errore.

Una **prova sul core WebAssembly**, che un `yes` del workbench richiede in `tests.workbench`, è:

- uno spec del browser che apre il workbench (`page.goto` di `/vaults/<id>/open`, in `web/e2e` o `web/e2e-security`);
- uno spec di `web/e2e-cloud` o `web/e2e-mixed` (core vero contro un cloud vero);
- uno spec della matrice e2e che sul progetto `web-core` gira per quella funzione: non escluso per intero, non un benchmark opt-in e senza un `skipOnWeb` che nomini la funzione (uno spec con un test escluso per la funzione non conta per essa, anche se gli altri test girano);
- un test della UI sul core in Node (`*.core.test.tsx` di `packages/workbench`, `task test-core`).

Un test unitario dell'host web o della UI non è una prova: gira su un mock, non sul core.

Le operazioni che non sono una funzione utente (sonde, configurazione pubblica) stanno in `server_only`, con la motivazione.

## Come funziona il controllo

`node scripts/parity.mjs` legge:

- i **comandi e le azioni dei pannelli dal registro a runtime**, senza regex sul sorgente: esegue con Vitest `packages/workbench/src/commands/parity.test.ts`, che importa `commands/registry.ts` (comandi di daily, segnalibri, workspace, anteprima e disegno compresi) e `commands/actions.ts`, valuta `requires` (e `excludes` delle azioni) con `configurePlatform('desktop')` e `configurePlatform('web')` e scrive gli elenchi, con la `feature` di ciascuno, in JSON. `tsx` non è tra le dipendenze del repository; Vitest sì, e risolve già alias, JSX e mock dei binding;
- i **binding** generati (`packages/workbench/wailsjs/go/app/*.d.ts`, da `task wailsjs`);
- le **operazioni** di `api/openapi.yaml` e le **rotte** della console;
- i test web (`web/e2e`, `web/e2e-cloud`) e il codice della console (`web/src`, più l'adattatore REST `RestCloudPort` di `packages/cloud-features`), per dire quali binding e quali operazioni sono davvero chiamati;
- gli spec del browser (`web/e2e*`), per sapere quali aprono il workbench sul core, gli spec della matrice con i loro `skipOnWeb`, gli attributi `data-action` della console e le chiamate `can`/`useCan` della UI.

Con `--check` (in `task parity`, quindi in `task ci`) fallisce se:

- il registro non rispetta lo schema;
- un comando, un'azione, un binding o un'operazione non compare in nessuna voce (né in `server_only`);
- un comando o un'azione dichiara una funzione (`feature`) che non lo elenca, o un'azione ha l'id di un comando;
- una voce rimanda a un comando, azione, binding, operazione, rotta, capability o file di test che non esiste;
- uno stato diverso da `yes` non ha motivazione;
- desktop o workbench dicono `yes` ma la piattaforma non ha la capability richiesta (da `capability`), o non offre un loro comando o una loro azione (`requires`, `excludes`);
- un test sta nella superficie sbagliata (per esempio un test della console sotto `workbench`), o uno spec della matrice è in `tests.workbench` ma non in `tests.desktop` (è lo stesso test sui due target);
- il workbench dice `yes` senza una prova sul core WebAssembly; se uno spec della matrice è escluso per intero sul web per quella funzione, il messaggio chiede di indicare un test alternativo;
- il workbench dice `partial` «non verificata sul web» ma una prova esiste (lo stato va riportato a `yes`);
- una rotta della console, un'operazione chiamata dalla console o un `data-action` non è citato da nessuna voce, o una voce cita un'azione che non esiste;
- una capability non ha consumatori (`can`, `useCan`, `Command.requires` o `requires`/`excludes` di un'azione): non governa nulla;
- le tabelle qui sotto non sono aggiornate.

Il controllo riceve tutti gli ingressi obbligatoriamente (spec che girano il core, matrice, operazioni e azioni della console, capability lette dalla UI): una regola senza dati da guardare non può passare a vuoto. Le azioni del workbench sono strutturali (`defineAction`, lette dal registro); quelle della console senza REST si trovano ancora solo se marcate con `data-action`, finché la console non adotta le azioni dichiarative.

Le regole stanno in `scripts/parity/lib.mjs`, con i test in `scripts/parity/lib.test.mjs` (`node --test 'scripts/parity/*.test.mjs'`, eseguiti anche da `task parity`). Per aggiungere una voce: [dev-setup](dev-setup.md#registro-delle-funzioni).

## Tabelle generate

Le tabelle qui sotto si rigenerano con `node scripts/parity.mjs`: per funzione, per comando, per binding e per operazione REST.

<!-- parity:begin (generated by scripts/parity.mjs; do not edit) -->

### Funzioni (92)

Dal registro `shared/parity/features.yaml`. Desktop: yes 82, exception 2, console-only 7, missing 1. Workbench: yes 51, partial 21, exception 11, console-only 8, missing 1. Console: yes 28, n/a 64 (n/a = funzione sul contenuto del vault, che la console affida al workbench). Test per superficie: D = desktop (UI, e2e sul mock, core Go), W = workbench (host web, spec nel browser, spec della matrice e2e e test della UI sul core in Node, `*.core.test.tsx`), K = console, C = cloud; in grassetto le prove sul core WebAssembly. 56 funzioni hanno almeno una prova sul core; 19 sono `partial` soltanto per la mancanza di una prova (motivazione «non verificata sul web: …»).

| Funzione | Desktop | Workbench | Console | Motivazione e note | Test |
| --- | --- | --- | --- | --- | --- |
| `vault.local-folder` Vault su una cartella del computer | yes | exception | n/a | workbench: si aprono vault del cloud, copiati nel browser (OPFS); il browser non apre una cartella del computer come vault | D: `platform.test.tsx`, `fs_test.go` |
| `vault.open` Apertura, cambio e chiusura del vault | yes | yes | yes | workbench (nota): il vault si apre dalla console («Apri», rotta /vaults/:id/open) | D: `VaultSwitcher.test.tsx`, `teardown.test.tsx` · W: **`workbench.spec.ts`**, `guard.test.ts` · K: `Vaults.test.tsx` |
| `vault.multi-open` Più vault aperti insieme, vault recenti e cambio dal menu del vault | yes | exception | n/a | workbench: un vault per pagina, scelto nella console (gli handle sincroni di OPFS sono esclusivi); niente recenti né `vault:switch` | D: `VaultSwitcher.test.tsx`, `platform.test.tsx` · W: **`workbench.spec.ts`** |
| `vault.list` Elenco dei vault cloud | yes | yes | yes | desktop (nota): Impostazioni → Cloud, `CloudVaultsTable` di @memobrain/cloud-features (ADR-0037 §2) — console (nota): `CloudVaultsTable` con `RestCloudPort`; le condivisioni accettate si aprono come mount (`?share=`) — una sola UI (@memobrain/cloud-features) su due adattatori, binding e REST (ADR-0037 §2) | D: `sync.test.tsx`, `CoreCloudPort.test.tsx`, `cloud-vaults.spec.ts` · W: **`CoreCloudPort.core.test.tsx`**, **`cloud-vaults.spec.ts`** · K: `rest.test.tsx`, `Vaults.test.tsx` · C: `service_test.go`, `api_test.go` |
| `vault.create` Creazione di un vault cloud | yes | yes | yes | desktop (nota): dalla procedura di collegamento di un vault locale («Collega al cloud»), che anche «Nuovo vault» di Impostazioni → Cloud apre — workbench (nota): solo vault privati, sulla rotta di creazione /vaults/new/open?kind=private&name=… aperta dalla console; la procedura guidata del workbench chiede la passphrase e mostra la chiave di recupero (la crittografia resta nel core Go) — console (nota): «Nuovo vault»; un vault condiviso con la REST, uno privato aprendo il workbench sulla rotta di creazione | D: `sync.test.tsx`, `CoreCloudPort.test.tsx`, `manager_test.go` · W: `create.test.ts`, **`web-create-private.spec.ts`** · K: `rest.test.tsx`, `Vaults.test.tsx`, `vaults.spec.ts` · C: `service_test.go`, `workbench_test.go` |
| `vault.rename` Rinomina di un vault cloud | yes | yes | yes | desktop (nota): Impostazioni → Cloud; un vault locale collegato mostra il nuovo nome nel collegamento, le cartelle non cambiano nome | D: `CoreCloudPort.test.tsx`, `manager_vaults_test.go`, `e2e_vaults_test.go`, `cloud-vaults.spec.ts` · W: **`CoreCloudPort.core.test.tsx`**, **`cloud-vaults.spec.ts`** · K: `rest.test.tsx`, `vaults.spec.ts` · C: `service_test.go` |
| `vault.delete` Eliminazione logica di un vault cloud | yes | yes | yes | desktop (nota): dopo l'eliminazione sul server il vault locale collegato si scollega e conserva i file (D-04); se il vault è eliminato dalla console o da un altro dispositivo un avviso lo dice (evento vault:cloud-deleted) e Impostazioni › Sync lo ricorda — workbench (nota): il vault aperto nella pagina non si elimina da lì (si torna alla console); se è eliminato altrove la copia nel browser è segnata nel marcatore e l'avviso offre di rimuoverla (le modifiche mai caricate si elencano prima) | D: `CoreCloudPort.test.tsx`, `App.test.tsx`, `sync.test.tsx`, `manager_vaults_test.go`, `manager_mounts_test.go`, `e2e_vaults_test.go`, `cloud-vaults.spec.ts` · W: **`CoreCloudPort.core.test.tsx`**, `guard.test.ts`, **`cloud-vaults.spec.ts`** · K: `rest.test.tsx`, `Vaults.test.tsx`, `vaults.spec.ts` · C: `service_test.go` |
| `vault.restore` Ripristino di un vault cloud eliminato | yes | yes | yes | desktop (nota): sezione «Vault eliminati»; il vault ripristinato non si ricollega da solo — console (nota): la data di rimozione definitiva compare solo se il client conosce la conservazione (l'API non la espone) | D: `CoreCloudPort.test.tsx`, `manager_vaults_test.go`, `e2e_vaults_test.go`, `cloud-vaults.spec.ts` · W: **`CoreCloudPort.core.test.tsx`**, **`cloud-vaults.spec.ts`** · K: `rest.test.tsx`, `Vaults.test.tsx`, `vaults.spec.ts` · C: `service_test.go` |
| `vault.system-trash` Cestino di sistema per i file eliminati | yes | exception | n/a | workbench: i file eliminati vanno in `.trash/` del vault, perché il browser non ha un cestino | D: `fs_test.go` |
| `index.rebuild` Ricostruzione dell'indice del vault | yes | yes | n/a |  | D: `indexer_test.go` · W: **`workbench.spec.ts`** |
| `settings.vault` Configurazione del vault (.memobrain/) | yes | yes | n/a |  | D: `bindings_test.go`, `layout.test.ts`, `status-bar.spec.ts` · W: **`status-bar.spec.ts`** |
| `sync.link` Collegamento di un vault locale a un vault cloud | yes | yes | n/a | workbench (nota): sul web il collegamento avviene da solo all'apertura del vault (web/src/workbench/launch.ts) | D: `sync.test.tsx`, `manager_test.go` · W: **`web-sync.spec.ts`** |
| `sync.unlink` Scollegamento di un vault dal cloud | yes | exception | n/a | workbench: la copia nel browser appartiene al vault cloud e il lancio la ricollegherebbe; al posto di «Scollega» c'è «Rimuovi da questo browser», che carica le modifiche e cancella la copia quando il core la dice cancellabile (SyncAPI.CopyVerdict, web/src/workbench/guard.ts); uscire dal vault carica le modifiche e lascia nel marcatore ciò che resta, così «Esci» e «Dimentica questo browser» lo chiedono prima di cancellare | D: `sync.test.tsx`, `copies_test.go` · W: `guard.test.ts`, `forget.test.ts` · K: `ForgetBrowser.test.tsx` |
| `sync.engine` Sincronizzazione del vault (stato, pausa, sincronizza ora) | yes | yes | n/a | desktop (nota): Impostazioni › Sync mostra quanti file del cloud il dispositivo non riesce a leggere (quarantena, ADR-0039) — workbench (nota): le modifiche fatte offline restano in coda finché la scheda è aperta (ADR-0029) | D: `sync.test.tsx`, `e2e_test.go`, `push_test.go`, `scan_test.go` · W: **`web-sync.spec.ts`**, **`mixed.spec.ts`** · C: `sync_test.go`, `tus_test.go` |
| `conflicts` Conflitti di sincronizzazione | yes | yes | n/a | desktop (nota): se il file cambia dopo che le versioni sono state mostrate, «Tieni la mia» e la fusione non scrivono nulla, le versioni si ricaricano e un avviso chiede di scegliere di nuovo — workbench (nota): dal browser è provata solo la fusione di un `.md`, non la copia di conflitto di `.canvas` ed `.excalidraw` | D: `sync.test.tsx`, `diff.test.ts`, `e2e_drawings_test.go` · W: **`web-sync.spec.ts`** |
| `revisions` Storico delle revisioni nel cloud | yes | partial | n/a | workbench: non verificata sul web: nessun test apre lo storico delle revisioni dal browser; la UI e il codice Go sono quelli del desktop | D: `sync.test.tsx` · C: `history_test.go`, `retention_test.go` |
| `history.local` Storico locale delle note | yes | yes | n/a |  | D: `recovery.test.tsx`, `history_test.go`, `bindings_history_test.go` · W: **`workbench.spec.ts`** |
| `trash` File eliminati e loro ripristino | yes | partial | n/a | workbench: non verificata sul web: nessun test elenca o ripristina i file eliminati dal browser; la UI e il codice Go sono quelli del desktop | D: `recovery.test.tsx`, `history_test.go` |
| `crypto.unlock` Sblocco e blocco di un vault privato | yes | yes | n/a | workbench (nota): al blocco la copia in chiaro nel browser viene cancellata (ADR-0029); lo sblocco di una copia conservata (gate della pagina) chiede dopo la chiave di recupero una passphrase nuova con la stessa politica dei dialoghi (zxcvbn, §3.8.2) | D: `sync.test.tsx`, `strength.test.ts`, `crypto_test.go`, `lock_test.go` · W: `overlay.test.ts`, **`web-private.spec.ts`**, **`web-create-private.spec.ts`**, **`mixed.spec.ts`**, **`workbench.spec.ts`** |
| `crypto.change-passphrase` Cambio della passphrase di un vault privato | yes | partial | n/a | workbench: non verificata sul web: nessun test cambia la passphrase dal browser; la UI e il codice Go sono quelli del desktop | D: `crypto_test.go` |
| `crypto.recovery-key` Nuova recovery key di un vault privato | yes | partial | n/a | workbench: non verificata sul web: nessun test genera una nuova recovery key dal browser; la UI e il codice Go sono quelli del desktop | D: `crypto_test.go` |
| `crypto.disk-check` Avviso sul disco non cifrato | yes | exception | n/a | workbench: nel browser non c'è un disco di cui parlare (il binding non viene chiamato) | D: `sync.test.tsx` |
| `share.create` Creazione di una condivisione (vault, cartella o file) | yes | yes | yes | desktop (nota): da Impostazioni → Condivisione («Nuova condivisione», un vault condiviso intero o una sua cartella, con @memobrain/cloud-features; «Condividi una parte» su una condivisione che l'utente gestisce come manager, solo dentro il suo ambito, ADR-0041 §8) e dal menu «Condividi…» dell'esplorazione (anche un documento del vault aperto; non sui mount) — console (nota): «Nuova condivisione» di un vault condiviso intero o di una sua cartella (la console non conosce gli id dei documenti); i vault privati non sono proposti (D-02); «Condividi una parte» per chi è manager di una condivisione di vault o cartella (ADR-0041 §8) | D: `sharing.test.tsx`, `CoreCloudPort.test.tsx`, `manager_share_test.go`, `e2e_sharing_test.go`, `account-panels.spec.ts` · W: **`CoreCloudPort.core.test.tsx`**, **`account-panels.spec.ts`** · K: `rest.test.tsx`, `Shares.test.tsx`, `shares.spec.ts` · C: `sharing_test.go`, `sharing_manager_test.go`, `access_test.go`, `view_test.go` |
| `share.manage` Elenco e revoca delle condivisioni create | yes | yes | yes | desktop (nota): SharesManager di @memobrain/cloud-features, lo stesso componente della console; solo il proprietario revoca, un gestore no | D: `sharing.test.tsx`, `CoreCloudPort.test.tsx`, `manager_share_test.go`, `account-panels.spec.ts` · W: **`CoreCloudPort.core.test.tsx`**, **`account-panels.spec.ts`** · K: `rest.test.tsx`, `Shares.test.tsx`, `app.spec.ts`, `shares.spec.ts` · C: `sharing_test.go` |
| `share.update` Rinomina e scadenza di una condivisione | yes | yes | yes | desktop (nota): «Modifica» di una condivisione (nome, scadenza o nessuna scadenza), proprietario o gestore | D: `sharing.test.tsx`, `CoreCloudPort.test.tsx`, `manager_share_test.go`, `account-panels.spec.ts` · W: **`CoreCloudPort.core.test.tsx`**, **`account-panels.spec.ts`** · K: `rest.test.tsx`, `Shares.test.tsx`, `shares.spec.ts` · C: `sharing_test.go` |
| `share.grants` Permessi di utenti e gruppi su una condivisione | yes | yes | yes | desktop (nota): GrantEditor e ricerca nella directory di @memobrain/cloud-features, gli stessi della console; una richiesta per tipo (utenti o gruppi) con i campi dell'API, descrizione dei gruppi compresa | D: `sharing.test.tsx`, `CoreCloudPort.test.tsx`, `bindings_sharing_test.go`, `account-panels.spec.ts` · W: **`CoreCloudPort.core.test.tsx`**, **`account-panels.spec.ts`** · K: `rest.test.tsx`, `shares.spec.ts` · C: `sharing_test.go`, `access_test.go` |
| `invitations` Inviti ricevuti (accetta, rifiuta) | yes | yes | yes | desktop (nota): InvitationsList di @memobrain/cloud-features; una condivisione accettata diventa un mount (MountsList); il conteggio degli inviti nella barra di stato legge la stessa cache di InvitationsList | D: `sharing.test.tsx`, `CoreCloudPort.test.tsx`, `sharing.spec.ts` · W: **`CoreCloudPort.core.test.tsx`**, **`sharing.spec.ts`** · K: `rest.test.tsx`, `Shares.test.tsx`, `app.spec.ts` · C: `sharing_test.go` |
| `mounts` Mount delle condivisioni ricevute | yes | partial | yes | desktop (nota): MountsList di @memobrain/cloud-features (lo stesso elenco della console, ADR-0045 §7) con le azioni del workbench nel suo spazio; alla revoca la copia si elimina o si conserva come vault ordinario (capability detachedCopies) — workbench: un mount si apre nella sua pagina (/vaults/:id/open?share=, anche da Impostazioni › Condivisione, attraverso il guard e i marcatori dell'host); la copia di un mount revocato non si conserva come cartella (nel browser nessuno potrebbe riaprirla) ma si scarica come ZIP (capability detachedCopies) — console (nota): MountsList (GET /shared-with-me) su «I miei vault» e, come «Condivisioni accettate», in InvitationsList; «Apri» apre il workbench sul mount | D: `sharing.test.tsx`, `CoreCloudPort.test.tsx`, `ActionButton.test.tsx`, `sharing.spec.ts`, `e2e_sharing_test.go`, `bindings_sharing_test.go` · W: **`CoreCloudPort.core.test.tsx`**, `guard.test.ts`, **`mixed.spec.ts`**, **`sharing.spec.ts`** · K: `rest.test.tsx`, `Shares.test.tsx`, `Vaults.test.tsx`, `app.spec.ts` |
| `account.login` Accesso al cloud e sessione | yes | yes | yes | workbench (nota): sul web la sessione OIDC è quella della pagina, che passa il token al core | D: `CloudSection.test.tsx`, `AccountButton.test.tsx`, `auth_test.go` · W: **`web-sync.spec.ts`** · K: `oidc.test.ts`, `guards.test.tsx`, `app.spec.ts` · C: `verifier_test.go` |
| `account.session` Accesso dal client e uscita (browser di sistema, scelta del server) | yes | exception | yes | workbench: la sessione è quella OIDC della pagina, gestita dalla console (accesso e «Esci»); il workbench non offre login, logout né server — console (nota): accesso OIDC alla prima rotta protetta; «Esci» nell'intestazione carica e rimuove prima le copie dei vault nel browser e chiede conferma per quelle con modifiche non caricate (D-04) | D: `CloudSection.test.tsx`, `AccountButton.test.tsx`, `auth_test.go`, `hosted_test.go` · K: `guards.test.tsx`, `ForgetBrowser.test.tsx` |
| `account.forget-browser` «Dimentica questo browser» (copie dei vault nel browser) | exception | console-only | yes | desktop: il desktop non tiene copie nel browser; le cartelle dei vault restano dell'utente, e un dispositivo si revoca da Impostazioni › Cloud — workbench: azione della pagina Account della console; un workbench aperto in un'altra scheda carica le modifiche ed esce prima che le copie si cancellino — console (nota): le copie con modifiche non caricate si elencano e si cancellano solo con una conferma (marcatori, D-04); la registrazione del dispositivo resta in IndexedDB (ADR-0029) | W: `forget.test.ts`, **`workbench.spec.ts`** · K: `ForgetBrowser.test.tsx`, `Account.test.tsx`, `workbench.spec.ts` |
| `account.data` Esportazione dei dati personali ed eliminazione dell'account | console-only | console-only | yes | desktop: funzione dell'account, nella console (pagina Account) — workbench: funzione dell'account, nella console (pagina Account) | K: `Account.test.tsx`, `account.spec.ts` · C: `privacy_test.go` |
| `account.groups` I miei gruppi | console-only | console-only | yes | desktop: informazione dell'account, che spetta alla console (il componente MyGroups non è montato dove la porta non elenca i gruppi) — workbench: informazione dell'account, che spetta alla console — console (nota): pagina Account, sezione «I miei gruppi» (MyGroups di @memobrain/cloud-features); il ruolo `manager` nel gruppo è mostrato come riservato, senza effetti in v1 (ADR-0041 §9) | K: `rest.test.tsx`, `Account.test.tsx`, `account.spec.ts` |
| `devices` Dispositivi collegati e revoca | yes | yes | yes | desktop (nota): DevicesPanel di @memobrain/cloud-features; il dispositivo in uso è segnato e non si revoca da qui — workbench (nota): il browser si registra come dispositivo `web` (ADR-0029) — console (nota): lo stesso DevicesPanel; il browser in uso (registrazione del workbench in IndexedDB, ADR-0029) è segnato e non si revoca da qui | D: `CoreCloudPort.test.tsx`, `CloudSection.test.tsx`, `account-panels.spec.ts` · W: **`CoreCloudPort.core.test.tsx`**, **`account-panels.spec.ts`** · K: `rest.test.tsx`, `Devices.test.tsx`, `devices.spec.ts` · C: `api_test.go` |
| `devices.revoked` Dispositivo revocato mentre il client è aperto e nuova registrazione | yes | yes | n/a | desktop (nota): il cloud rifiuta il commit (FORBIDDEN, extra.reason device_revoked): la sync si ferma senza toccare file né outbox, la sessione passa a `device_revoked` (auth:state) e il banner offre «Registra di nuovo questo dispositivo», dopo la quale parte ciò che era in attesa — workbench (nota): stesso banner; la nuova registrazione del browser è salvata in IndexedDB (ADR-0029) | D: `DeviceRevokedBanner.test.tsx`, `hosted_test.go`, `manager_revoked_test.go`, `e2e_device_test.go`, `client_test.go` · W: **`mixed.spec.ts`** · C: `api_test.go` |
| `usage` Spazio occupato e quota | yes | yes | yes | desktop (nota): UsagePanel di @memobrain/cloud-features, con il livello calcolato dal server e lo spazio di ogni vault (§2.8.2) | D: `CoreCloudPort.test.tsx`, `account-panels.spec.ts` · W: **`CoreCloudPort.core.test.tsx`**, **`account-panels.spec.ts`** · K: `rest.test.tsx`, `Usage.test.tsx`, `app.spec.ts`, `devices.spec.ts` · C: `quota_test.go` |
| `config.flags` Configurazione distribuita e feature flag | yes | yes | yes | console (nota): la console applica `web_workbench` e `sharing` (gli altri flag riguardano il contenuto di un vault aperto, quindi il workbench); nomi e default dei flag vengono dallo schema del Config Profile, generati in `shared/go/features` e `@memobrain/api-client/features` (`task gen`) | D: `managed.test.ts`, `managed_test.go`, `config_test.go`, `features_test.go`, `sharing.spec.ts`, `features_test.go`, `doc_test.go` · W: **`mixed.spec.ts`**, **`sharing.spec.ts`** · K: `Vaults.test.tsx`, `Shares.test.tsx`, `rest.test.tsx` · C: `schema_test.go`, `config_test.go` |
| `settings` Impostazioni dell'applicazione | yes | yes | yes | console (nota): nella console solo la lingua dell'interfaccia (intestazione); le altre impostazioni riguardano un vault aperto e stanno nel workbench | D: `locations.test.ts`, `platform.test.tsx`, `bindings_test.go`, `capabilities_test.go`, `capabilities_web_test.go` · W: **`web-private.spec.ts`** · K: `i18n.test.tsx` |
| `appearance` Tema e aspetto | yes | yes | yes | console (nota): il tema della console (automatico, chiaro, scuro) nell'intestazione, senza un test; la barra di stato è del workbench | D: `App.test.tsx`, `StatusBar.test.tsx`, `status-bar.spec.ts` · W: **`status-bar.spec.ts`** |
| `hotkeys` Scorciatoie da tastiera personalizzabili | yes | partial | n/a | workbench: non verificata sul web: nessun test personalizza una scorciatoia sul core WebAssembly; la UI e il codice Go sono quelli del desktop | D: `hotkeys.test.ts`, `registry.test.ts` |
| `command-palette` Palette dei comandi | yes | yes | n/a |  | D: `registry.test.ts`, `keyboard.spec.ts`, `workflows.spec.ts` · W: **`keyboard.spec.ts`**, **`workflows.spec.ts`** |
| `app.updater` Aggiornamento automatico dell'applicazione | yes | exception | n/a | workbench: la Web UI la serve il cloud ed è sempre aggiornata (il core riporta gli aggiornamenti come disattivati) | D: `updater.test.tsx`, `parity.test.ts`, `service_test.go`, `apply_test.go` |
| `window.native` Finestra nativa (schermo intero, link esterni nel browser di sistema) | yes | exception | n/a | workbench: nessuna finestra nativa; solo la Fullscreen API dell'elemento, e i link esterni si aprono in una nuova scheda | D: `fullscreen.spec.ts`, `platform.test.tsx` · W: **`fullscreen.spec.ts`** |
| `deeplink` Link memobrain:// | yes | exception | n/a | workbench: schema di URL del sistema operativo, sostituito dalla rotta /vaults/:id/open | D: `urls_test.go` |
| `note.create` Creazione di note e cartelle | yes | yes | n/a |  | D: `workflows.spec.ts`, `App.test.tsx` · W: **`workbench.spec.ts`**, **`workflows.spec.ts`** |
| `note.edit` Lettura e salvataggio delle note | yes | yes | n/a |  | D: `useNoteDocument.test.tsx`, `fs_test.go`, `concurrency_test.go` · W: **`workbench.spec.ts`**, `opfs-fs.spec.ts` |
| `note.rename` Rinomina e spostamento con aggiornamento dei link | yes | yes | n/a |  | D: `workflows.spec.ts`, `keyboard.spec.ts`, `links_test.go` · W: **`workbench.spec.ts`**, **`workflows.spec.ts`**, **`keyboard.spec.ts`** |
| `note.delete` Eliminazione di note e file | yes | yes | n/a |  | D: `fs_test.go` · W: **`workbench.spec.ts`** |
| `files.explorer` Esplora file | yes | yes | n/a |  | D: `trees.test.ts`, `explorerCollapsed.test.tsx`, `keyboard.spec.ts` · W: **`keyboard.spec.ts`** |
| `attachments` Allegati e media | yes | yes | n/a |  | D: `media.test.ts`, `hydrate.test.ts`, `drawing-embed.spec.ts` · W: **`drawing-embed.spec.ts`** |
| `files.open-by-type` Apertura dei file per tipo (applicazione del sistema o download) | yes | exception | n/a | desktop (nota): note, lavagne, base, disegni, immagini, PDF, audio e video si aprono in una scheda; ogni altro file con l'applicazione del sistema, e un programma mai (si mostra nella cartella), ADR-0047 — workbench: il browser non ha applicazioni a cui passare un file né un file manager; dopo la conferma «Apertura File» il file si scarica (VaultAPI.DownloadFile), ADR-0047 | D: `openFile.test.tsx`, `bindings_files_test.go`, `pathrules_test.go`, `open-by-type.spec.ts` · W: **`open-by-type.spec.ts`** |
| `note.random` Apertura rapida e nota casuale | yes | yes | n/a |  | D: `registry.test.ts`, `workflows.spec.ts` · W: **`workflows.spec.ts`** |
| `search` Ricerca nel vault | yes | yes | n/a |  | D: `highlight.test.ts`, `search_test.go`, `workflows.spec.ts` · W: **`workbench.spec.ts`**, **`workflows.spec.ts`** |
| `editor.formatting` Formattazione nell'editor | yes | yes | n/a |  | D: `commands.test.ts`, `editor-toolbar.spec.ts` · W: **`editor-toolbar.spec.ts`** |
| `editor.modes` Live Preview, sorgente e lettura | yes | yes | n/a |  | D: `livePreview.test.ts`, `render.test.ts`, `workflows.spec.ts` · W: **`workflows.spec.ts`** |
| `editor.links` Link e completamento automatico | yes | partial | n/a | workbench: non verificata sul web: nessun test usa il completamento dei link sul core WebAssembly; la UI e il codice Go sono quelli del desktop | D: `completions.test.ts`, `links_test.go` |
| `editor.find` Cerca e sostituisci nella nota, vai a riga | yes | yes | n/a |  | D: `frame.test.ts`, `editor-find.spec.ts` · W: **`editor-find.spec.ts`** |
| `editor.ai` Assistente di scrittura AI dell'editor (inattivo) | exception | exception | n/a | desktop: inattiva (ADR-0050): il core è implementato e provato e `attachAi` è collegato in `MilkdownAdapter.ts`, ma la funzione resta irraggiungibile: la costante di build è spenta nella build di rilascio, il flag `ai` del profilo vale false e l'interruttore Milkdown è spento, quindi l'utente non può usarla. Il core rifiuta se la costante di build è spenta, se il flag `ai` del profilo è spento, se il vault è privato (E2EE) o se manca il provider. La rete parte solo dal core Go — workbench: il core WebAssembly non contiene il codice AI (la CSP della pagina non ammette terze parti e il provider metterebbe la chiave nella pagina); ogni metodo di AIAPI rifiuta e la capability aiAssistant è falsa | D: `service_test.go`, `providers_test.go`, `bindings_ai_test.go`, `provider.test.ts`, `gate.test.ts`, `feature.test.ts`, `ai.live.test.ts`, `wiring.test.ts`, `live-ai.spec.ts`, `bindings_ai_js_test.go`, `linked_test.go` |
| `editor.collab` Collaborazione in tempo reale nell'editor (spenta) | missing | missing | n/a | desktop: spenta (ADR-0050): il flag `collab` del profilo, riservato, vale false e non esiste né un provider né un server; la collaborazione asincrona di D-04 resta quella del sync. Il chunk Yjs esiste (`packages/workbench/src/editor/live/chunks/collab.ts`, A-W7) ma non si carica mai: servono la costante di build, il flag `collab` e un provider registrato, e nessuno dei tre c'è in una build rilasciata — workbench: spenta come sul desktop (ADR-0050): stesso flag riservato, nessun provider registrato nella build | D: `features_test.go`, `gate.test.ts`, `collab.test.ts`, `converge.test.ts`, `wiring.test.ts`, `live-collab.spec.ts` |
| `workspace.layout` Schede, pannelli divisi e barre laterali | yes | yes | n/a |  | D: `layout.test.ts`, `TabBar.test.tsx`, `tabs.test.ts`, `workflows.spec.ts` · W: **`workflows.spec.ts`** |
| `outline` Struttura della nota | yes | partial | n/a | workbench: non verificata sul web: nessun test usa il pannello della struttura sul core WebAssembly (lo spec di accessibilità lo apre soltanto); la UI e il codice Go sono quelli del desktop | D: `flatten.test.ts` |
| `links.backlinks` Backlink, link in uscita e menzioni non collegate | yes | yes | n/a |  | D: `BacklinksPanel.test.tsx`, `workflows.spec.ts` · W: **`workflows.spec.ts`** |
| `tags` Tag | yes | partial | n/a | workbench: non verificata sul web: nessun test, né sul desktop né sul web; la UI e il codice Go sono quelli del desktop | — |
| `properties` Proprietà delle note | yes | partial | n/a | workbench: non verificata sul web: nessun test modifica le proprietà sul core WebAssembly; la UI e il codice Go sono quelli del desktop | D: `properties_test.go` |
| `note.stats` Statistiche della nota | yes | partial | n/a | workbench: non verificata sul web: nessun test legge le statistiche sul core WebAssembly (lo spec di accessibilità le apre soltanto); la UI e il codice Go sono quelli del desktop | D: `StatsPanel.test.tsx`, `noteStats.test.ts` |
| `graph` Grafo del vault e grafo locale | yes | yes | n/a |  | D: `GraphView.test.tsx`, `graph.spec.ts`, `graph_test.go` · W: **`workbench.spec.ts`**, **`graph.spec.ts`** |
| `slides` Presentazioni da una nota | yes | yes | n/a |  | D: `SlideShow.test.tsx`, `SlidesPanel.test.tsx`, `slides.spec.ts` · W: **`slides.spec.ts`** |
| `bookmarks` Segnalibri | yes | partial | n/a | workbench: non verificata sul web: nessun test usa i segnalibri sul core WebAssembly; la UI e il codice Go sono quelli del desktop | D: `BookmarksPanel.test.tsx`, `model.test.ts`, `locate.test.ts` |
| `workspaces` Workspace salvati | yes | partial | n/a | workbench: non verificata sul web: nessun test salva o carica un workspace sul core WebAssembly; la UI e il codice Go sono quelli del desktop | D: `actions.test.ts`, `model.test.ts` |
| `preview` Anteprima dei link | yes | partial | n/a | workbench: non verificata sul web: nessun test apre l'anteprima di un link sul core WebAssembly; la UI e il codice Go sono quelli del desktop | D: `popover.test.ts`, `target.test.ts` |
| `daily` Note giornaliere | yes | partial | n/a | workbench: non verificata sul web: nessun test apre una nota giornaliera sul core WebAssembly; la UI e il codice Go sono quelli del desktop | D: `daily.test.tsx`, `templates_test.go` |
| `templates` Modelli e note con identificativo unico | yes | partial | n/a | workbench: non verificata sul web: nessun test usa i modelli sul core WebAssembly; la UI e il codice Go sono quelli del desktop | D: `bindings_templates_test.go`, `templates_test.go` |
| `composer` Unione ed estrazione di note | yes | partial | n/a | workbench: non verificata sul web: nessun test unisce o estrae note sul core WebAssembly; la UI e il codice Go sono quelli del desktop | D: `composer_test.go` |
| `canvas` Canvas | yes | yes | n/a |  | D: `canvas.spec.ts`, `model.test.ts`, `canvas_test.go` · W: **`canvas.spec.ts`** |
| `presentations` Presentazioni Marp (.marp) | yes | yes | n/a | desktop (nota): editor della sorgente a tutta larghezza, tab Slideshow con le card delle slide (riordino, esclusione, note, impostazioni), presentazione a tutto schermo, export HTML, PDF e PPTX modificabile dai pulsanti del ribbon, con le slide escluse lasciate fuori (ADR-0047, ADR-0048) | D: `engine.test.ts`, `slides.test.ts`, `pptx.test.ts`, `Ribbon.test.tsx`, `MarpShow.test.tsx`, `MarpSlidesPanel.test.tsx`, `SlidesPanel.test.tsx`, `indexer_test.go`, `merge_test.go`, `marp.spec.ts` · W: **`marp.spec.ts`** |
| `bases` Basi (viste tabellari delle note) | yes | partial | n/a | workbench: non verificata sul web: nessun test apre una base sul core WebAssembly; la UI e il codice Go sono quelli del desktop | D: `BaseView.test.tsx`, `bases_test.go`, `bindings_bases_test.go` |
| `drawing.edit` Disegni Excalidraw | yes | yes | n/a | workbench (nota): Excalidraw offline è verificato anche sulla build di produzione, con la CSP del workbench (e2e-security) | D: `drawing.spec.ts`, `drawing-tools.spec.ts`, `commands.test.tsx`, `describe.test.ts`, `drawing_test.go` · W: **`excalidraw-offline.spec.ts`**, **`drawing.spec.ts`**, **`drawing-tools.spec.ts`** |
| `drawing.scene-actions` Azioni sulla scena di un disegno (script Excalidraw) | yes | yes | n/a |  | D: `actions.test.ts`, `more.test.ts`, `drawing-actions.spec.ts`, `drawing-obsidian-tools.spec.ts` · W: **`drawing-actions.spec.ts`**, **`drawing-obsidian-tools.spec.ts`** |
| `drawing.embeds` Immagini, note e disegni dentro un disegno | yes | yes | n/a |  | D: `drawing-embed.spec.ts`, `insert.test.ts`, `tools.test.ts` · W: **`drawing-embed.spec.ts`** |
| `drawing.latex-mermaid` Formule LaTeX e diagrammi Mermaid nei disegni | yes | yes | n/a |  | D: `insert.test.ts`, `insert.test.ts`, `drawing-tools.spec.ts` · W: **`drawing-tools.spec.ts`** |
| `drawing.export` Esportazione di un disegno (PNG, SVG, PDF dal ribbon) ed esportazione automatica | yes | partial | n/a | workbench: non verificata sul web: gli spec di esportazione leggono i file catturati dal mock di Wails e sono esclusi sul web (nel browser è un download); la UI e il codice Go sono quelli del desktop | D: `drawing-export.spec.ts`, `options.test.ts`, `exportCommands.test.ts`, `Ribbon.test.tsx` |
| `drawing.slideshow` Presentazione di un disegno | yes | yes | n/a |  | D: `drawing-slideshow-panel.spec.ts`, `slides.test.ts` · W: **`drawing-slideshow-panel.spec.ts`** |
| `drawing.library` Libreria di forme Excalidraw | yes | yes | n/a |  | D: `drawing-wp6.spec.ts` · W: **`drawing-wp6.spec.ts`** |
| `drawing.legacy` Conversione dei disegni Obsidian (.excalidraw.md) | yes | yes | n/a |  | D: `legacy_test.go`, `drawing-wp6.spec.ts` · W: **`drawing-wp6.spec.ts`** |
| `export.zip` Download del vault come ZIP | yes | yes | yes | workbench (nota): lo ZIP lo scarica il browser — console (nota): un vault privato si decifra nel browser (`packages/vaultcrypto-web`) | D: `export.test.tsx`, `export_test.go` · W: **`workbench.spec.ts`** · K: `VaultExport.test.tsx`, `sharedExport.test.ts`, `admin.spec.ts` · C: `export_test.go`, `service_test.go` |
| `export.note` Esportazione di una nota (PDF, immagine, HTML) | yes | partial | n/a | workbench: non verificata sul web: nessun test esporta una nota (PDF, immagine, HTML) nel browser; la UI e il codice Go sono quelli del desktop — workbench (nota): al posto dei dialoghi nativi il download del browser e `window.print()` (ADR-0029) | D: `export.test.tsx`, `bindings_export_test.go` |
| `import` Importazione da altre applicazioni | yes | partial | n/a | workbench: solo le sorgenti da file; l'importer da cartella richiede una cartella locale (capability localFolders) | D: `ImportWizard.test.tsx`, `importer_test.go`, `bindings_importer_test.go` |
| `admin.users` Amministrazione degli utenti | console-only | console-only | yes | desktop: amministrazione, solo nella console — workbench: amministrazione, solo nella console | K: `Users.test.tsx`, `admin.spec.ts` · C: `admin_test.go`, `service_test.go` |
| `admin.groups` Amministrazione dei gruppi | console-only | console-only | yes | desktop: amministrazione, solo nella console (i gruppi esistono solo nel cloud, D-05) — workbench: amministrazione, solo nella console — console (nota): il ruolo `manager` di un membro si salva e si mostra, con l'avviso che in v1 non dà permessi (ADR-0041 §9) | K: `Groups.test.tsx` · C: `admin_test.go`, `sharing_manager_test.go`, `reserved_role_test.go` |
| `admin.config` Config Profile e configurazione effettiva | console-only | console-only | yes | desktop: amministrazione, solo nella console — workbench: amministrazione, solo nella console | K: `Config.test.tsx` · C: `config_test.go`, `schema_test.go` |
| `admin.storage` Spazio, quote e limiti | console-only | console-only | yes | desktop: amministrazione, solo nella console — workbench: amministrazione, solo nella console — console (nota): la rotta /admin porta qui (prima pagina dell'amministrazione) | K: `Storage.test.tsx`, `Limits.test.tsx`, `admin.spec.ts` · C: `quota_test.go`, `admin_test.go` |
| `admin.audit` Registro di audit | console-only | console-only | yes | desktop: amministrazione, solo nella console — workbench: amministrazione, solo nella console | K: `Audit.test.tsx` · C: `admin_test.go` |

### Comandi (192)

190 su 192 sono disponibili sul web; gli altri richiedono (`Command.requires`) una capability che il browser non ha. L'elenco viene dal registro a runtime (`packages/workbench/src/commands/parity.test.ts`), non dal sorgente; ogni comando dichiara la sua funzione (`Command.feature`, un `FeatureId` generato), che deve essere una di quelle che lo elencano.

| Comando | Gruppo | Sul web | Funzione | Nota |
| --- | --- | --- | --- | --- |
| `note:new` | file | yes | `note.create` |  |
| `note:new-tab` | file | yes | `note.create` |  |
| `folder:new` | file | yes | `note.create` |  |
| `drawing:new` | file | yes | `drawing.edit` |  |
| `canvas:new` | file | yes | `canvas` |  |
| `marp:new` | file | yes | `presentations` |  |
| `marp:present` | view | yes | `presentations` |  |
| `marp:export-html` | file | yes | `presentations` |  |
| `marp:export-pdf` | file | yes | `presentations` |  |
| `marp:export-pptx` | file | yes | `presentations` |  |
| `bases:new` | file | yes | `bases` | non verificata sul web: nessun test apre una base sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `drawing:insert` | editor | yes | `drawing.edit` |  |
| `note:rename` | file | yes | `note.rename` |  |
| `note:delete` | file | yes | `note.delete` |  |
| `sharing:open` | app | yes | `share.manage` |  |
| `sharing:share` | file | yes | `share.create` |  |
| `vault:export-zip` | file | yes | `export.zip` |  |
| `note:export-pdf` | file | yes | `export.note` | non verificata sul web: nessun test esporta una nota (PDF, immagine, HTML) nel browser; la UI e il codice Go sono quelli del desktop |
| `note:export-image` | file | yes | `export.note` | non verificata sul web: nessun test esporta una nota (PDF, immagine, HTML) nel browser; la UI e il codice Go sono quelli del desktop |
| `note:export-html` | file | yes | `export.note` | non verificata sul web: nessun test esporta una nota (PDF, immagine, HTML) nel browser; la UI e il codice Go sono quelli del desktop |
| `update:check` | file | no (needs `updater`) | `app.updater` | la Web UI la serve il cloud ed è sempre aggiornata (il core riporta gli aggiornamenti come disattivati) |
| `import:open` | file | yes | `import` | solo le sorgenti da file; l'importer da cartella richiede una cartella locale (capability localFolders) |
| `vault:switch` | file | no (needs `multiVault`) | `vault.multi-open` | un vault per pagina, scelto nella console (gli handle sincroni di OPFS sono esclusivi); niente recenti né `vault:switch` |
| `vault:close` | file | yes | `vault.open` |  |
| `index:rebuild` | app | yes | `index.rebuild` |  |
| `switcher:open` | navigate | yes | `note.random` |  |
| `palette:open` | navigate | yes | `command-palette` |  |
| `search:vault` | navigate | yes | `search` |  |
| `tab:next` | navigate | yes | `workspace.layout` |  |
| `tab:prev` | navigate | yes | `workspace.layout` |  |
| `tab:close` | navigate | yes | `workspace.layout` |  |
| `tab:pin` | navigate | yes | `workspace.layout` |  |
| `tab:close-right` | navigate | yes | `workspace.layout` |  |
| `tab:close-left` | navigate | yes | `workspace.layout` |  |
| `tab:close-others` | navigate | yes | `workspace.layout` |  |
| `tab:close-all` | navigate | yes | `workspace.layout` |  |
| `pane:close` | navigate | yes | `workspace.layout` |  |
| `mode:toggle-reading` | view | yes | `editor.modes` |  |
| `mode:toggle-source` | view | yes | `editor.modes` |  |
| `mode:live` | view | yes | `editor.modes` |  |
| `mode:source` | view | yes | `editor.modes` |  |
| `mode:reading` | view | yes | `editor.modes` |  |
| `pane:split-right` | view | yes | `workspace.layout` |  |
| `pane:split-down` | view | yes | `workspace.layout` |  |
| `pane:link` | view | yes | `workspace.layout` |  |
| `sidebar:left` | view | yes | `workspace.layout` |  |
| `sidebar:right` | view | yes | `workspace.layout` |  |
| `theme:toggle` | view | yes | `appearance` |  |
| `app:toggle-status-bar` | view | yes | `appearance` |  |
| `separator:insert` | editor | yes | `editor.formatting` |  |
| `sidebar:outline` | view | yes | `outline` | non verificata sul web: nessun test usa il pannello della struttura sul core WebAssembly (lo spec di accessibilità lo apre soltanto); la UI e il codice Go sono quelli del desktop |
| `graph:open` | view | yes | `graph` |  |
| `graph:open-local` | view | yes | `graph` |  |
| `sidebar:properties` | view | yes | `properties` | non verificata sul web: nessun test modifica le proprietà sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `slides:start` | view | yes | `slides` |  |
| `slides:start-here` | view | yes | `slides` |  |
| `sidebar:slides` | view | yes | `slides` |  |
| `sidebar:stats` | view | yes | `note.stats` | non verificata sul web: nessun test legge le statistiche sul core WebAssembly (lo spec di accessibilità le apre soltanto); la UI e il codice Go sono quelli del desktop |
| `sidebar:backlinks` | view | yes | `links.backlinks` |  |
| `sidebar:tags` | view | yes | `tags` | non verificata sul web: nessun test, né sul desktop né sul web; la UI e il codice Go sono quelli del desktop |
| `sidebar:files` | view | yes | `files.explorer` |  |
| `editor:bold` | editor | yes | `editor.formatting` |  |
| `editor:italic` | editor | yes | `editor.formatting` |  |
| `editor:highlight` | editor | yes | `editor.formatting` |  |
| `editor:strike` | editor | yes | `editor.formatting` |  |
| `editor:code` | editor | yes | `editor.formatting` |  |
| `editor:comment` | editor | yes | `editor.formatting` |  |
| `editor:link` | editor | yes | `editor.formatting` |  |
| `editor:wikilink` | editor | yes | `editor.formatting` |  |
| `editor:heading-1` | editor | yes | `editor.formatting` |  |
| `editor:heading-2` | editor | yes | `editor.formatting` |  |
| `editor:heading-3` | editor | yes | `editor.formatting` |  |
| `editor:heading-4` | editor | yes | `editor.formatting` |  |
| `editor:heading-5` | editor | yes | `editor.formatting` |  |
| `editor:heading-6` | editor | yes | `editor.formatting` |  |
| `editor:bullet` | editor | yes | `editor.formatting` |  |
| `editor:numbered` | editor | yes | `editor.formatting` |  |
| `editor:quote` | editor | yes | `editor.formatting` |  |
| `editor:task` | editor | yes | `editor.formatting` |  |
| `editor:find` | editor | yes | `editor.find` |  |
| `editor:goto-line` | editor | yes | `editor.find` |  |
| `sync:connect` | app | yes | `vault.create`, `sync.link` |  |
| `sync:now` | app | yes | `sync.engine` |  |
| `sync:conflicts` | app | yes | `conflicts` |  |
| `sync:history` | app | yes | `revisions` | non verificata sul web: nessun test apre lo storico delle revisioni dal browser; la UI e il codice Go sono quelli del desktop |
| `recovery:open` | file | yes | `history.local` |  |
| `recovery:deleted` | file | yes | `trash` | non verificata sul web: nessun test elenca o ripristina i file eliminati dal browser; la UI e il codice Go sono quelli del desktop |
| `sync:settings` | app | yes | `sync.engine` |  |
| `sync:unlock` | app | yes | `crypto.unlock` |  |
| `bookmark:note` | navigate | yes | `bookmarks` | non verificata sul web: nessun test usa i segnalibri sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `bookmark:heading` | navigate | yes | `bookmarks` | non verificata sul web: nessun test usa i segnalibri sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `bookmark:block` | navigate | yes | `bookmarks` | non verificata sul web: nessun test usa i segnalibri sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `bookmark:search` | navigate | yes | `bookmarks` | non verificata sul web: nessun test usa i segnalibri sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `bookmark:graph` | navigate | yes | `bookmarks` | non verificata sul web: nessun test usa i segnalibri sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `bookmark:new-group` | navigate | yes | `bookmarks` | non verificata sul web: nessun test usa i segnalibri sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `bookmark:open` | navigate | yes | `bookmarks` | non verificata sul web: nessun test usa i segnalibri sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `sidebar:bookmarks` | view | yes | `bookmarks` | non verificata sul web: nessun test usa i segnalibri sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `workspace:save` | view | yes | `workspaces` | non verificata sul web: nessun test salva o carica un workspace sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `workspace:load` | view | yes | `workspaces` | non verificata sul web: nessun test salva o carica un workspace sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `workspace:manage` | view | yes | `workspaces` | non verificata sul web: nessun test salva o carica un workspace sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `preview:link` | editor | yes | `preview` | non verificata sul web: nessun test apre l'anteprima di un link sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `preview:toggle` | view | yes | `preview` | non verificata sul web: nessun test apre l'anteprima di un link sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `settings:open` | app | yes | `settings` |  |
| `settings:hotkeys` | app | yes | `hotkeys` | non verificata sul web: nessun test personalizza una scorciatoia sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `daily:open-today` | navigate | yes | `daily` | non verificata sul web: nessun test apre una nota giornaliera sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `daily:previous` | navigate | yes | `daily` | non verificata sul web: nessun test apre una nota giornaliera sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `daily:next` | navigate | yes | `daily` | non verificata sul web: nessun test apre una nota giornaliera sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `unique:new` | file | yes | `templates` | non verificata sul web: nessun test usa i modelli sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `template:insert` | editor | yes | `templates` | non verificata sul web: nessun test usa i modelli sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `template:new-from` | file | yes | `templates` | non verificata sul web: nessun test usa i modelli sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `composer:merge` | file | yes | `composer` | non verificata sul web: nessun test unisce o estrae note sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `composer:extract` | editor | yes | `composer` | non verificata sul web: nessun test unisce o estrae note sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `note:random` | navigate | yes | `note.random` |  |
| `drawing:fixed-spacing-horizontal` | editor | yes | `drawing.scene-actions` |  |
| `drawing:fixed-spacing-vertical` | editor | yes | `drawing.scene-actions` |  |
| `drawing:fixed-distance-centers-horizontal` | editor | yes | `drawing.scene-actions` |  |
| `drawing:fixed-distance-centers-vertical` | editor | yes | `drawing.scene-actions` |  |
| `drawing:expand-rectangles-horizontal` | editor | yes | `drawing.scene-actions` |  |
| `drawing:expand-rectangles-horizontal-centered` | editor | yes | `drawing.scene-actions` |  |
| `drawing:expand-rectangles-vertical` | editor | yes | `drawing.scene-actions` |  |
| `drawing:expand-rectangles-vertical-centered` | editor | yes | `drawing.scene-actions` |  |
| `drawing:set-dimensions-position` | editor | yes | `drawing.scene-actions` |  |
| `drawing:golden-ratio` | editor | yes | `drawing.scene-actions` |  |
| `drawing:grid-images` | editor | yes | `drawing.scene-actions` |  |
| `drawing:auto-layout` | editor | yes | `drawing.scene-actions` |  |
| `drawing:darken-background` | editor | yes | `drawing.scene-actions` |  |
| `drawing:lighten-background` | editor | yes | `drawing.scene-actions` |  |
| `drawing:background-opacity` | editor | yes | `drawing.scene-actions` |  |
| `drawing:invert-colors` | editor | yes | `drawing.scene-actions` |  |
| `drawing:set-stroke-width` | editor | yes | `drawing.scene-actions` |  |
| `drawing:set-font-family` | editor | yes | `drawing.scene-actions` |  |
| `drawing:set-text-alignment` | editor | yes | `drawing.scene-actions` |  |
| `drawing:box-selected-elements` | editor | yes | `drawing.scene-actions` |  |
| `drawing:box-each-selected-group` | editor | yes | `drawing.scene-actions` |  |
| `drawing:ellipse-selected-elements` | editor | yes | `drawing.scene-actions` |  |
| `drawing:change-shape` | editor | yes | `drawing.scene-actions` |  |
| `drawing:boolean-union` | editor | yes | `drawing.scene-actions` |  |
| `drawing:boolean-intersection` | editor | yes | `drawing.scene-actions` |  |
| `drawing:boolean-difference` | editor | yes | `drawing.scene-actions` |  |
| `drawing:boolean-xor` | editor | yes | `drawing.scene-actions` |  |
| `drawing:split-ellipse` | editor | yes | `drawing.scene-actions` |  |
| `drawing:connect-elements` | editor | yes | `drawing.scene-actions` |  |
| `drawing:elbow-connectors` | editor | yes | `drawing.scene-actions` |  |
| `drawing:normalize-arrows` | editor | yes | `drawing.scene-actions` |  |
| `drawing:add-connector-point` | editor | yes | `drawing.scene-actions` |  |
| `drawing:add-next-step` | editor | yes | `drawing.scene-actions` |  |
| `drawing:split-text-by-lines` | editor | yes | `drawing.scene-actions` |  |
| `drawing:concatenate-lines` | editor | yes | `drawing.scene-actions` |  |
| `drawing:text-to-sticky-notes` | editor | yes | `drawing.scene-actions` |  |
| `drawing:convert-text-to-link` | editor | yes | `drawing.scene-actions` |  |
| `drawing:repeat-elements` | editor | yes | `drawing.scene-actions` |  |
| `drawing:convert-freedraw-to-line` | editor | yes | `drawing.scene-actions` |  |
| `drawing:zoom-to-fit-selected` | editor | yes | `drawing.scene-actions` |  |
| `drawing:toggle-grid` | editor | yes | `drawing.scene-actions` |  |
| `drawing:set-grid-size` | editor | yes | `drawing.scene-actions` |  |
| `drawing:select-elements-of-type` | editor | yes | `drawing.scene-actions` |  |
| `drawing:copy-styles-to-defaults` | editor | yes | `drawing.scene-actions` |  |
| `drawing:pen-fine` | editor | yes | `drawing.scene-actions` |  |
| `drawing:pen-marker` | editor | yes | `drawing.scene-actions` |  |
| `drawing:pen-highlighter` | editor | yes | `drawing.scene-actions` |  |
| `drawing:laser-pointer` | editor | yes | `drawing.scene-actions` |  |
| `drawing:mindmap-from-text` | editor | yes | `drawing.scene-actions` |  |
| `drawing:calendar-year` | editor | yes | `drawing.scene-actions` |  |
| `drawing:calendar-linear` | editor | yes | `drawing.scene-actions` |  |
| `drawing:comic-panels` | editor | yes | `drawing.scene-actions` |  |
| `drawing:speech-bubble` | editor | yes | `drawing.scene-actions` |  |
| `drawing:apply-color-scheme` | editor | yes | `drawing.scene-actions` |  |
| `drawing:organic-line` | editor | yes | `drawing.scene-actions` |  |
| `drawing:reset-latex-size` | editor | yes | `drawing.scene-actions` |  |
| `drawing:reverse-arrows` | editor | yes | `drawing.scene-actions` |  |
| `drawing:bullet-points` | editor | yes | `drawing.scene-actions` |  |
| `drawing:cycle-stroke-width` | editor | yes | `drawing.scene-actions` |  |
| `drawing:insert-latex` | editor | yes | `drawing.latex-mermaid` |  |
| `drawing:insert-mermaid` | editor | yes | `drawing.latex-mermaid` |  |
| `drawing:insert-image` | editor | yes | `drawing.embeds` |  |
| `drawing:insert-drawing` | editor | yes | `drawing.embeds` |  |
| `drawing:insert-note` | editor | yes | `drawing.embeds` |  |
| `drawing:create-note-and-embed` | editor | yes | `drawing.embeds` |  |
| `drawing:deconstruct-into-new-drawing` | editor | yes | `drawing.embeds` |  |
| `drawing:refresh-note-cards` | editor | yes | `drawing.embeds` |  |
| `drawing:set-auto-export` | editor | yes | `drawing.export` | non verificata sul web: gli spec di esportazione leggono i file catturati dal mock di Wails e sono esclusi sul web (nel browser è un download); la UI e il codice Go sono quelli del desktop |
| `drawing:export-png` | editor | yes | `drawing.export` | non verificata sul web: gli spec di esportazione leggono i file catturati dal mock di Wails e sono esclusi sul web (nel browser è un download); la UI e il codice Go sono quelli del desktop |
| `drawing:export-svg` | editor | yes | `drawing.export` | non verificata sul web: gli spec di esportazione leggono i file catturati dal mock di Wails e sono esclusi sul web (nel browser è un download); la UI e il codice Go sono quelli del desktop |
| `drawing:export-pdf` | editor | yes | `drawing.export` | non verificata sul web: gli spec di esportazione leggono i file catturati dal mock di Wails e sono esclusi sul web (nel browser è un download); la UI e il codice Go sono quelli del desktop |
| `drawing:slideshow` | editor | yes | `drawing.slideshow` |  |
| `drawing:set-slide-notes` | editor | yes | `drawing.slideshow` |  |
| `drawing:describe` | editor | yes | `drawing.edit` |  |
| `drawing:tools-panel` | editor | yes | `drawing.edit` |  |
| `drawing:import-library` | editor | yes | `drawing.library` |  |
| `drawing:export-library` | editor | yes | `drawing.library` |  |
| `drawing:import-legacy` | editor | yes | `drawing.legacy` |  |
| `drawing:edit-latex` | editor | yes | `drawing.latex-mermaid` |  |

### Azioni dei pannelli (13)

I pulsanti dei pannelli che non sono comandi ma realizzano una funzione (`defineAction` in `packages/workbench/src/commands/actions.ts`, mostrati da `<ActionButton>`, ADR-0045 §2). Come i comandi nominano la loro funzione e le capability che richiedono (`requires`) o di cui fanno le veci dove mancano (`excludes`); l'elenco viene dal registro a runtime.

| Azione | Desktop | Web | Funzione |
| --- | --- | --- | --- |
| `vault:open-folder` | yes | no (needs `localFolders`) | `vault.local-folder` |
| `mount:open` | yes | yes | `mounts` |
| `mount:remove` | yes | yes | `mounts` |
| `mount:delete-copy` | yes | yes | `mounts` |
| `mount:keep-copy` | yes | no (needs `detachedCopies`) | `mounts` |
| `mount:download-copy` | no (only without `detachedCopies`) | yes | `mounts` |
| `cloud-vault:new` | yes | no (needs `unlinkVault`) | `vault.create` |
| `sync:unlink` | yes | no (needs `unlinkVault`) | `sync.unlink` |
| `sync:remove-from-browser` | no (only without `unlinkVault`) | yes | `sync.unlink` |
| `sync:pause` | yes | yes | `sync.engine` |
| `vault:lock` | yes | yes | `crypto.unlock` |
| `account:sign-in` | yes | no (needs `ownsSession`) | `account.session` |
| `account:sign-out` | yes | no (needs `ownsSession`) | `account.session` |

### Binding Go (141 metodi, 21 servizi)

Il dispatcher del core espone tutti i 141 metodi (verificato da `TestDispatcherMatchesTheGeneratedBindings`). **20 su 141** sono chiamati da un test del workbench web contro il core vero (`web/e2e`, `web/e2e-cloud`); gli altri girano nello stesso codice Go, provato sotto WASM dai test del core (`task test-wasm`), ma non hanno ancora un test nel browser.

| Binding | Funzione | Chiamato in un test web | Nota |
| --- | --- | --- | --- |
| `AIAPI.Cancel` | `editor.ai` | — | il core WebAssembly non contiene il codice AI (la CSP della pagina non ammette terze parti e il provider metterebbe la chiave nella pagina); ogni metodo di AIAPI rifiuta e la capability aiAssistant è falsa |
| `AIAPI.SetKey` | `editor.ai` | — | il core WebAssembly non contiene il codice AI (la CSP della pagina non ammette terze parti e il provider metterebbe la chiave nella pagina); ogni metodo di AIAPI rifiuta e la capability aiAssistant è falsa |
| `AIAPI.Start` | `editor.ai` | — | il core WebAssembly non contiene il codice AI (la CSP della pagina non ammette terze parti e il provider metterebbe la chiave nella pagina); ogni metodo di AIAPI rifiuta e la capability aiAssistant è falsa |
| `AIAPI.Status` | `editor.ai` | — | il core WebAssembly non contiene il codice AI (la CSP della pagina non ammette terze parti e il provider metterebbe la chiave nella pagina); ogni metodo di AIAPI rifiuta e la capability aiAssistant è falsa |
| `AuthAPI.Login` | `account.session` | — | la sessione è quella OIDC della pagina, gestita dalla console (accesso e «Esci»); il workbench non offre login, logout né server |
| `AuthAPI.Logout` | `account.session` | — | la sessione è quella OIDC della pagina, gestita dalla console (accesso e «Esci»); il workbench non offre login, logout né server |
| `AuthAPI.ReregisterDevice` | `devices.revoked` | — |  |
| `AuthAPI.Status` | `account.login` | — |  |
| `BasesAPI.Load` | `bases` | — | non verificata sul web: nessun test apre una base sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `BasesAPI.NewBaseContent` | `bases` | — | non verificata sul web: nessun test apre una base sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `BasesAPI.Run` | `bases` | — | non verificata sul web: nessun test apre una base sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `BasesAPI.UpdateProperty` | `bases` | — | non verificata sul web: nessun test apre una base sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `BasesAPI.UpdateView` | `bases` | — | non verificata sul web: nessun test apre una base sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `ComposerAPI.ApplyMerge` | `composer` | — | non verificata sul web: nessun test unisce o estrae note sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `ComposerAPI.Extract` | `composer` | — | non verificata sul web: nessun test unisce o estrae note sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `ComposerAPI.PlanMerge` | `composer` | — | non verificata sul web: nessun test unisce o estrae note sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `ComposerAPI.SuggestTitle` | `composer` | — | non verificata sul web: nessun test unisce o estrae note sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `ConfigAPI.Effective` | `config.flags` | — |  |
| `ConfigAPI.Refresh` | `config.flags` | — |  |
| `DrawingAPI.ImportLegacy` | `drawing.legacy` | — |  |
| `DrawingAPI.ReadPreview` | `drawing.edit` | — |  |
| `DrawingAPI.SavePreview` | `drawing.edit` | — |  |
| `DrawingAPI.WriteExport` | `drawing.export` | — | non verificata sul web: gli spec di esportazione leggono i file catturati dal mock di Wails e sono esclusi sul web (nel browser è un download); la UI e il codice Go sono quelli del desktop |
| `ExportAPI.Print` | `export.note` | — | non verificata sul web: nessun test esporta una nota (PDF, immagine, HTML) nel browser; la UI e il codice Go sono quelli del desktop |
| `ExportAPI.SaveFile` | `export.note` | — | non verificata sul web: nessun test esporta una nota (PDF, immagine, HTML) nel browser; la UI e il codice Go sono quelli del desktop |
| `ExportAPI.SaveHTML` | `export.note` | — | non verificata sul web: nessun test esporta una nota (PDF, immagine, HTML) nel browser; la UI e il codice Go sono quelli del desktop |
| `GraphAPI.Build` | `graph` | yes |  |
| `HistoryAPI.GetSettings` | `history.local` | — |  |
| `HistoryAPI.List` | `history.local` | yes |  |
| `HistoryAPI.ListDeleted` | `trash` | — | non verificata sul web: nessun test elenca o ripristina i file eliminati dal browser; la UI e il codice Go sono quelli del desktop |
| `HistoryAPI.Read` | `history.local` | — |  |
| `HistoryAPI.Restore` | `history.local`, `trash` | — |  |
| `HistoryAPI.SetSettings` | `history.local` | — |  |
| `ImporterAPI.Cancel` | `import` | — | solo le sorgenti da file; l'importer da cartella richiede una cartella locale (capability localFolders) |
| `ImporterAPI.DefaultFolder` | `import` | — | solo le sorgenti da file; l'importer da cartella richiede una cartella locale (capability localFolders) |
| `ImporterAPI.Detect` | `import` | — | solo le sorgenti da file; l'importer da cartella richiede una cartella locale (capability localFolders) |
| `ImporterAPI.ListSources` | `import` | — | solo le sorgenti da file; l'importer da cartella richiede una cartella locale (capability localFolders) |
| `ImporterAPI.PickFile` | `import` | — | solo le sorgenti da file; l'importer da cartella richiede una cartella locale (capability localFolders) |
| `ImporterAPI.Preview` | `import` | — | solo le sorgenti da file; l'importer da cartella richiede una cartella locale (capability localFolders) |
| `ImporterAPI.Report` | `import` | — | solo le sorgenti da file; l'importer da cartella richiede una cartella locale (capability localFolders) |
| `ImporterAPI.Run` | `import` | — | solo le sorgenti da file; l'importer da cartella richiede una cartella locale (capability localFolders) |
| `LinksAPI.ApplyRename` | `note.rename` | yes |  |
| `LinksAPI.Backlinks` | `links.backlinks` | yes |  |
| `LinksAPI.Outgoing` | `links.backlinks` | — |  |
| `LinksAPI.PlanRename` | `note.rename` | — |  |
| `LinksAPI.Resolve` | `editor.links` | — | non verificata sul web: nessun test usa il completamento dei link sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `LinksAPI.Suggest` | `editor.links` | — | non verificata sul web: nessun test usa il completamento dei link sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `LinksAPI.UnlinkedMentions` | `links.backlinks` | — |  |
| `PropertiesAPI.Keys` | `properties` | — | non verificata sul web: nessun test modifica le proprietà sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `PropertiesAPI.Remove` | `properties` | — | non verificata sul web: nessun test modifica le proprietà sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `PropertiesAPI.Schema` | `properties` | — | non verificata sul web: nessun test modifica le proprietà sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `PropertiesAPI.SetType` | `properties` | — | non verificata sul web: nessun test modifica le proprietà sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `PropertiesAPI.Update` | `properties` | — | non verificata sul web: nessun test modifica le proprietà sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `SearchAPI.Explain` | `search` | — |  |
| `SearchAPI.Query` | `search` | yes |  |
| `SettingsAPI.Capabilities` | `settings` | — |  |
| `SettingsAPI.Get` | `settings` | yes |  |
| `SettingsAPI.Info` | `settings` | yes |  |
| `SettingsAPI.Set` | `settings` | yes |  |
| `SharingAPI.AcceptShare` | `invitations` | — |  |
| `SharingAPI.CreateCloudShare` | `share.create` | — |  |
| `SharingAPI.CreateShare` | `share.create` | — |  |
| `SharingAPI.DeclineShare` | `invitations` | — |  |
| `SharingAPI.Invitations` | `invitations` | — |  |
| `SharingAPI.ListShares` | `share.manage` | — |  |
| `SharingAPI.Mounts` | `mounts` | — | un mount si apre nella sua pagina (/vaults/:id/open?share=, anche da Impostazioni › Condivisione, attraverso il guard e i marcatori dell'host); la copia di un mount revocato non si conserva come cartella (nel browser nessuno potrebbe riaprirla) ma si scarica come ZIP (capability detachedCopies) |
| `SharingAPI.OpenMount` | `mounts` | — | un mount si apre nella sua pagina (/vaults/:id/open?share=, anche da Impostazioni › Condivisione, attraverso il guard e i marcatori dell'host); la copia di un mount revocato non si conserva come cartella (nel browser nessuno potrebbe riaprirla) ma si scarica come ZIP (capability detachedCopies) |
| `SharingAPI.RemoveGrant` | `share.grants` | — |  |
| `SharingAPI.RemoveMount` | `mounts` | — | un mount si apre nella sua pagina (/vaults/:id/open?share=, anche da Impostazioni › Condivisione, attraverso il guard e i marcatori dell'host); la copia di un mount revocato non si conserva come cartella (nel browser nessuno potrebbe riaprirla) ma si scarica come ZIP (capability detachedCopies) |
| `SharingAPI.RevokeShare` | `share.manage` | — |  |
| `SharingAPI.SearchDirectoryGroups` | `share.grants` | — |  |
| `SharingAPI.SearchDirectoryUsers` | `share.grants` | — |  |
| `SharingAPI.SetGrant` | `share.grants` | — |  |
| `SharingAPI.Share` | `share.manage` | — |  |
| `SharingAPI.UpdateShare` | `share.update` | — |  |
| `SharingAPI.VaultShares` | `share.manage` | — |  |
| `SyncAPI.ConflictTexts` | `conflicts` | — |  |
| `SyncAPI.Conflicts` | `conflicts` | — |  |
| `SyncAPI.CopyVerdict` | `sync.unlink` | — | la copia nel browser appartiene al vault cloud e il lancio la ricollegherebbe; al posto di «Scollega» c'è «Rimuovi da questo browser», che carica le modifiche e cancella la copia quando il core la dice cancellabile (SyncAPI.CopyVerdict, web/src/workbench/guard.ts); uscire dal vault carica le modifiche e lascia nel marcatore ciò che resta, così «Esci» e «Dimentica questo browser» lo chiedono prima di cancellare |
| `SyncAPI.DeleteCloudVault` | `vault.delete` | — |  |
| `SyncAPI.Devices` | `devices` | — |  |
| `SyncAPI.History` | `revisions` | — | non verificata sul web: nessun test apre lo storico delle revisioni dal browser; la UI e il codice Go sono quelli del desktop |
| `SyncAPI.Info` | `sync.link` | yes |  |
| `SyncAPI.LinkExisting` | `sync.link` | — |  |
| `SyncAPI.LinkNew` | `vault.create` | yes |  |
| `SyncAPI.ListCloudVaults` | `vault.list` | — |  |
| `SyncAPI.ListDeletedCloudVaults` | `vault.restore` | — |  |
| `SyncAPI.RenameCloudVault` | `vault.rename` | — |  |
| `SyncAPI.ResolveConflict` | `conflicts` | — |  |
| `SyncAPI.RestoreCloudVault` | `vault.restore` | — |  |
| `SyncAPI.RestoreRevision` | `revisions` | — | non verificata sul web: nessun test apre lo storico delle revisioni dal browser; la UI e il codice Go sono quelli del desktop |
| `SyncAPI.RevisionText` | `revisions` | — | non verificata sul web: nessun test apre lo storico delle revisioni dal browser; la UI e il codice Go sono quelli del desktop |
| `SyncAPI.RevokeDevice` | `devices` | — |  |
| `SyncAPI.SetPaused` | `sync.engine` | yes |  |
| `SyncAPI.SetPollInterval` | `sync.engine` | — |  |
| `SyncAPI.Status` | `sync.engine` | yes |  |
| `SyncAPI.SyncNow` | `sync.engine` | yes |  |
| `SyncAPI.Unlink` | `sync.unlink` | — | la copia nel browser appartiene al vault cloud e il lancio la ricollegherebbe; al posto di «Scollega» c'è «Rimuovi da questo browser», che carica le modifiche e cancella la copia quando il core la dice cancellabile (SyncAPI.CopyVerdict, web/src/workbench/guard.ts); uscire dal vault carica le modifiche e lascia nel marcatore ciò che resta, così «Esci» e «Dimentica questo browser» lo chiedono prima di cancellare |
| `SyncAPI.Usage` | `usage` | — |  |
| `TagsAPI.List` | `tags` | yes | non verificata sul web: nessun test, né sul desktop né sul web; la UI e il codice Go sono quelli del desktop |
| `TemplatesAPI.CreateFromTemplate` | `templates` | — | non verificata sul web: nessun test usa i modelli sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `TemplatesAPI.DailyAdjacent` | `daily` | — | non verificata sul web: nessun test apre una nota giornaliera sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `TemplatesAPI.Expand` | `templates` | — | non verificata sul web: nessun test usa i modelli sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `TemplatesAPI.List` | `templates` | — | non verificata sul web: nessun test usa i modelli sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `TemplatesAPI.NewUnique` | `templates` | — | non verificata sul web: nessun test usa i modelli sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `TemplatesAPI.OpenDaily` | `daily` | — | non verificata sul web: nessun test apre una nota giornaliera sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `TemplatesAPI.ReadSettings` | `daily` | — | non verificata sul web: nessun test apre una nota giornaliera sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `TemplatesAPI.WriteSettings` | `daily` | — | non verificata sul web: nessun test apre una nota giornaliera sul core WebAssembly; la UI e il codice Go sono quelli del desktop |
| `UpdaterAPI.Check` | `app.updater` | — | la Web UI la serve il cloud ed è sempre aggiornata (il core riporta gli aggiornamenti come disattivati) |
| `UpdaterAPI.GetSettings` | `app.updater` | — | la Web UI la serve il cloud ed è sempre aggiornata (il core riporta gli aggiornamenti come disattivati) |
| `UpdaterAPI.Install` | `app.updater` | — | la Web UI la serve il cloud ed è sempre aggiornata (il core riporta gli aggiornamenti come disattivati) |
| `UpdaterAPI.SetSettings` | `app.updater` | — | la Web UI la serve il cloud ed è sempre aggiornata (il core riporta gli aggiornamenti come disattivati) |
| `UpdaterAPI.Skip` | `app.updater` | — | la Web UI la serve il cloud ed è sempre aggiornata (il core riporta gli aggiornamenti come disattivati) |
| `UpdaterAPI.Status` | `app.updater` | — | la Web UI la serve il cloud ed è sempre aggiornata (il core riporta gli aggiornamenti come disattivati) |
| `VaultAPI.CloseVault` | `vault.open` | yes |  |
| `VaultAPI.CreateFolder` | `note.create` | — |  |
| `VaultAPI.DownloadFile` | `files.open-by-type` | — | il browser non ha applicazioni a cui passare un file né un file manager; dopo la conferma «Apertura File» il file si scarica (VaultAPI.DownloadFile), ADR-0047 |
| `VaultAPI.ExportZip` | `export.zip` | yes |  |
| `VaultAPI.ListOpen` | `vault.multi-open` | yes | un vault per pagina, scelto nella console (gli handle sincroni di OPFS sono esclusivi); niente recenti né `vault:switch` |
| `VaultAPI.ListRecent` | `vault.open` | — |  |
| `VaultAPI.ListTree` | `files.explorer` | — |  |
| `VaultAPI.OpenVault` | `vault.open` | yes |  |
| `VaultAPI.OpenWithSystemApp` | `files.open-by-type` | — | il browser non ha applicazioni a cui passare un file né un file manager; dopo la conferma «Apertura File» il file si scarica (VaultAPI.DownloadFile), ADR-0047 |
| `VaultAPI.PickFolder` | `vault.local-folder` | — | si aprono vault del cloud, copiati nel browser (OPFS); il browser non apre una cartella del computer come vault |
| `VaultAPI.ReadBinary` | `attachments` | — |  |
| `VaultAPI.ReadConfig` | `settings.vault` | — |  |
| `VaultAPI.ReadNote` | `note.edit` | yes |  |
| `VaultAPI.RebuildIndex` | `index.rebuild` | — |  |
| `VaultAPI.Rename` | `note.rename` | — |  |
| `VaultAPI.RevealInFolder` | `files.open-by-type` | — | il browser non ha applicazioni a cui passare un file né un file manager; dopo la conferma «Apertura File» il file si scarica (VaultAPI.DownloadFile), ADR-0047 |
| `VaultAPI.SaveAttachment` | `attachments` | — |  |
| `VaultAPI.Trash` | `vault.system-trash`, `note.delete` | — |  |
| `VaultAPI.WriteConfig` | `settings.vault` | — |  |
| `VaultAPI.WriteNote` | `note.edit` | yes |  |
| `VaultCryptoAPI.Activity` | `crypto.unlock` | — |  |
| `VaultCryptoAPI.ChangePassphrase` | `crypto.change-passphrase` | — | non verificata sul web: nessun test cambia la passphrase dal browser; la UI e il codice Go sono quelli del desktop |
| `VaultCryptoAPI.DiskEncryption` | `crypto.disk-check` | — | nel browser non c'è un disco di cui parlare (il binding non viene chiamato) |
| `VaultCryptoAPI.Lock` | `crypto.unlock` | — |  |
| `VaultCryptoAPI.RegenerateRecoveryKey` | `crypto.recovery-key` | — | non verificata sul web: nessun test genera una nuova recovery key dal browser; la UI e il codice Go sono quelli del desktop |
| `VaultCryptoAPI.SetPassphrase` | `crypto.unlock` | — |  |
| `VaultCryptoAPI.Unlock` | `crypto.unlock` | — |  |

### Operazioni REST (83)

Da `api/openapi.yaml`. **68 su 83** sono chiamate dalla console (`web/src`); le altre le usa il core (sincronizzazione, condivisione) oppure nessun client.

| Operazione | Metodo e percorso | Funzione | Chiamata dalla console |
| --- | --- | --- | --- |
| `healthz` | GET `/healthz` | server_only: sonda di liveness per l'orchestratore, nessuna funzione utente | — |
| `readyz` | GET `/readyz` | server_only: sonda di readiness per l'orchestratore, nessuna funzione utente | — |
| `getClientConfig` | GET `/client-config` | server_only: configurazione pubblica letta all'avvio da desktop, workbench e console (issuer OIDC, client id), nessuna funzione utente | — |
| `getMe` | GET `/me` | `account.login` | yes |
| `deleteMyAccount` | DELETE `/me` | `account.data` | yes |
| `listMyDevices` | GET `/me/devices` | `devices` | yes |
| `registerDevice` | POST `/me/devices` | `devices`, `devices.revoked` | — |
| `revokeDevice` | DELETE `/me/devices/{deviceId}` | `devices` | yes |
| `getEffectiveConfig` | GET `/config/effective` | `config.flags` | yes |
| `getMyUsage` | GET `/me/usage` | `usage` | yes |
| `exportMyData` | GET `/me/export` | `account.data` | yes |
| `listVaults` | GET `/vaults` | `vault.list`, `vault.restore`, `usage` | yes |
| `createVault` | POST `/vaults` | `vault.create` | yes |
| `getVault` | GET `/vaults/{vaultId}` | `vault.list` | — |
| `updateVault` | PATCH `/vaults/{vaultId}` | `vault.rename` | yes |
| `deleteVault` | DELETE `/vaults/{vaultId}` | `vault.delete` | yes |
| `restoreVault` | POST `/vaults/{vaultId}:restore` | `vault.restore` | yes |
| `getVaultTree` | GET `/vaults/{vaultId}/tree` | `sync.link`, `export.zip` | yes |
| `getKeyEnvelopes` | GET `/vaults/{vaultId}/key-envelopes` | `crypto.unlock`, `export.zip` | yes |
| `putKeyEnvelope` | PUT `/vaults/{vaultId}/key-envelopes/{kind}` | `vault.create`, `crypto.change-passphrase`, `crypto.recovery-key` | — |
| `getChanges` | GET `/vaults/{vaultId}/changes` | `sync.engine` | — |
| `checkBlobs` | POST `/vaults/{vaultId}/blobs:check` | `sync.engine` | — |
| `getBlob` | GET `/vaults/{vaultId}/blobs/{sha256}` | `sync.engine`, `export.zip` | yes |
| `putBlob` | PUT `/vaults/{vaultId}/blobs/{sha256}` | `sync.engine` | — |
| `commit` | POST `/vaults/{vaultId}/commit` | `sync.engine` | — |
| `listRevisions` | GET `/vaults/{vaultId}/files/{fileId}/revisions` | `revisions` | — |
| `getRevisionContent` | GET `/vaults/{vaultId}/files/{fileId}/revisions/{rev}/content` | `revisions` | — |
| `restoreRevision` | POST `/vaults/{vaultId}/files/{fileId}/revisions/{rev}:restore` | `revisions` | — |
| `listMyGroups` | GET `/me/groups` | `account.groups` | yes |
| `searchDirectoryUsers` | GET `/directory/users` | `share.grants` | yes |
| `searchDirectoryGroups` | GET `/directory/groups` | `share.grants` | yes |
| `listShares` | GET `/shares` | `share.manage`, `invitations` | yes |
| `createShare` | POST `/shares` | `share.create` | yes |
| `getShare` | GET `/shares/{shareId}` | `share.manage` | — |
| `updateShare` | PATCH `/shares/{shareId}` | `share.update` | yes |
| `revokeShare` | DELETE `/shares/{shareId}` | `share.manage` | yes |
| `putGrant` | PUT `/shares/{shareId}/grants/{principalType}/{principalId}` | `share.grants` | yes |
| `deleteGrant` | DELETE `/shares/{shareId}/grants/{principalType}/{principalId}` | `share.grants` | yes |
| `acceptShare` | POST `/shares/{shareId}:accept` | `invitations` | yes |
| `declineShare` | POST `/shares/{shareId}:decline` | `invitations` | yes |
| `listSharedWithMe` | GET `/shared-with-me` | `invitations`, `mounts` | yes |
| `adminListUsers` | GET `/admin/users` | `admin.users` | yes |
| `adminCreateUser` | POST `/admin/users` | `admin.users` | yes |
| `adminGetUser` | GET `/admin/users/{userId}` | `admin.users` | yes |
| `adminUpdateUser` | PATCH `/admin/users/{userId}` | `admin.users` | yes |
| `adminDeleteUser` | DELETE `/admin/users/{userId}` | `admin.users` | yes |
| `adminSuspendUser` | POST `/admin/users/{userId}:suspend` | `admin.users` | yes |
| `adminActivateUser` | POST `/admin/users/{userId}:activate` | `admin.users` | yes |
| `adminResetPassword` | POST `/admin/users/{userId}:reset-password` | `admin.users` | yes |
| `adminSetUserRole` | PUT `/admin/users/{userId}/role` | `admin.users` | yes |
| `adminSetUserQuota` | PUT `/admin/users/{userId}/quota` | `admin.storage` | yes |
| `adminListUserVaults` | GET `/admin/users/{userId}/vaults` | `admin.users` | yes |
| `adminListUserDevices` | GET `/admin/users/{userId}/devices` | `admin.users` | yes |
| `adminListUserSessions` | GET `/admin/users/{userId}/sessions` | `admin.users` | yes |
| `adminUserEffectiveConfig` | GET `/admin/users/{userId}/config/effective` | `admin.config` | yes |
| `adminListGroups` | GET `/admin/groups` | `admin.groups` | yes |
| `adminCreateGroup` | POST `/admin/groups` | `admin.groups` | yes |
| `adminGetGroup` | GET `/admin/groups/{groupId}` | `admin.groups` | yes |
| `adminUpdateGroup` | PATCH `/admin/groups/{groupId}` | `admin.groups` | yes |
| `adminDeleteGroup` | DELETE `/admin/groups/{groupId}` | `admin.groups` | yes |
| `adminListGroupMembers` | GET `/admin/groups/{groupId}/members` | `admin.groups` | yes |
| `adminSetGroupMember` | PUT `/admin/groups/{groupId}/members/{userId}` | `admin.groups` | yes |
| `adminRemoveGroupMember` | DELETE `/admin/groups/{groupId}/members/{userId}` | `admin.groups` | yes |
| `adminGetGroupProfiles` | GET `/admin/groups/{groupId}/config-profiles` | `admin.config` | yes |
| `adminSetGroupProfiles` | PUT `/admin/groups/{groupId}/config-profiles` | `admin.config` | yes |
| `adminListConfigProfiles` | GET `/admin/config-profiles` | `admin.config` | yes |
| `adminCreateConfigProfile` | POST `/admin/config-profiles` | `admin.config` | yes |
| `adminGetConfigProfile` | GET `/admin/config-profiles/{profileId}` | `admin.config` | yes |
| `adminUpdateConfigProfile` | PUT `/admin/config-profiles/{profileId}` | `admin.config` | yes |
| `adminDeleteConfigProfile` | DELETE `/admin/config-profiles/{profileId}` | `admin.config` | yes |
| `adminListProfileVersions` | GET `/admin/config-profiles/{profileId}/versions` | `admin.config` | yes |
| `adminGetProfileVersion` | GET `/admin/config-profiles/{profileId}/versions/{version}` | `admin.config` | yes |
| `adminRestoreProfileVersion` | POST `/admin/config-profiles/{profileId}/versions/{version}:restore` | `admin.config` | yes |
| `adminGetStorageSettings` | GET `/admin/settings/storage` | `admin.storage` | yes |
| `adminPutStorageSettings` | PUT `/admin/settings/storage` | `admin.storage` | yes |
| `adminStorageOverview` | GET `/admin/storage/overview` | `admin.storage` | yes |
| `adminBulkQuota` | POST `/admin/storage/bulk-quota` | `admin.storage` | yes |
| `adminAuditLog` | GET `/admin/audit-log` | `admin.audit` | yes |
| `adminAuditLogCsv` | GET `/admin/audit-log.csv` | `admin.audit` | yes |
| `exportVaultZip` | GET `/vaults/{vaultId}/export.zip` | `export.zip` | yes |
| `createExport` | POST `/vaults/{vaultId}/exports` | `export.zip` | yes |
| `getExport` | GET `/vaults/{vaultId}/exports/{exportId}` | `export.zip` | yes |
| `downloadExport` | GET `/vaults/{vaultId}/exports/{exportId}/download` | `export.zip` | — |

### Spec e2e per target (31)

Gli spec di `apps/desktop/frontend/e2e` girano su entrambi i target della matrice (`web/playwright.workbench-ui.config.ts`: `desktop-mock` = UI sul mock Wails, `web-core` = workbench sul core WebAssembly). Sul web: **27** interi, **2** in parte, **2** esclusi; `opt-in` = benchmark che girano solo con la loro variabile d'ambiente. Un'esclusione si dichiara con `skipOnWeb(<funzione>, <motivo>)`; i test sono contati nel sorgente (un ciclo conta una volta).

| Spec | Test | Desktop (mock) | Web (core) | Esclusioni sul web |
| --- | --- | --- | --- | --- |
| `apps/desktop/frontend/e2e/a11y.spec.ts` | 8 | yes | yes | — |
| `apps/desktop/frontend/e2e/account-panels.spec.ts` | 3 | yes | yes | — |
| `apps/desktop/frontend/e2e/canvas.spec.ts` | 5 | yes | yes | — |
| `apps/desktop/frontend/e2e/cloud-vaults.spec.ts` | 2 | yes | yes | — |
| `apps/desktop/frontend/e2e/drawing-actions.spec.ts` | 12 | yes | yes | — |
| `apps/desktop/frontend/e2e/drawing-embed.spec.ts` | 8 | yes | yes | — |
| `apps/desktop/frontend/e2e/drawing-export.spec.ts` | 6 | yes | partial (4 of 6 skipped) | `drawing.export` (un test): the spec reads the files the Wails mock captures from the save dialog (window.__mock.fileExports); in the browser an export is a download · `drawing.export` (un test): the spec reads the files the Wails mock captures from the save dialog (window.__mock.fileExports); in the browser an export is a download · `drawing.export` (un test): the spec cancels the save dialog of the Wails mock (window.__mock.exportCancelled); the browser has no save dialog to cancel · `drawing.export` (un test): the spec reads the exports the Wails mock captures (window.__mock.drawingExports) |
| `apps/desktop/frontend/e2e/drawing-obsidian-tools.spec.ts` | 3 | yes | yes | — |
| `apps/desktop/frontend/e2e/drawing-slideshow-panel.spec.ts` | 2 | yes | yes | — |
| `apps/desktop/frontend/e2e/drawing-tools.spec.ts` | 4 | yes | yes | — |
| `apps/desktop/frontend/e2e/drawing-wp5.spec.ts` | 12 | yes | partial (2 of 12 skipped) | `drawing.export` (un test): the spec reads the exports the Wails mock captures (window.__mock.drawingExports) · `drawing.export` (un test): in headless Chromium the print dialog of the browser returns at once and the print layer goes on afterprint; the Wails mock keeps it to inspect |
| `apps/desktop/frontend/e2e/drawing-wp6.spec.ts` | 8 | yes | yes | — |
| `apps/desktop/frontend/e2e/drawing.spec.ts` | 5 | yes | yes | — |
| `apps/desktop/frontend/e2e/editor-find.spec.ts` | 4 | yes | yes | — |
| `apps/desktop/frontend/e2e/editor-toolbar.spec.ts` | 2 | yes | yes | — |
| `apps/desktop/frontend/e2e/fullscreen.spec.ts` | 1 | yes | yes | — |
| `apps/desktop/frontend/e2e/graph-bench.spec.ts` | 1 | opt-in | no | `graph`: the synthetic graph comes from the Wails mock (window.__MEMOBRAIN_GRAPH_FIXTURE__) |
| `apps/desktop/frontend/e2e/graph.spec.ts` | 1 | yes | yes | — |
| `apps/desktop/frontend/e2e/keyboard.spec.ts` | 5 | yes | yes | — |
| `apps/desktop/frontend/e2e/live-ai.spec.ts` | 1 | yes | yes | — |
| `apps/desktop/frontend/e2e/live-collab.spec.ts` | 1 | yes | yes | — |
| `apps/desktop/frontend/e2e/live-frame.spec.ts` | 7 | yes | yes | — |
| `apps/desktop/frontend/e2e/live-input.spec.ts` | 19 | yes | yes | — |
| `apps/desktop/frontend/e2e/live-views.spec.ts` | 6 | yes | yes | — |
| `apps/desktop/frontend/e2e/marp.spec.ts` | 8 | yes | yes | — |
| `apps/desktop/frontend/e2e/open-by-type.spec.ts` | 3 | yes | yes | — |
| `apps/desktop/frontend/e2e/sharing.spec.ts` | 2 | yes | yes | — |
| `apps/desktop/frontend/e2e/slides.spec.ts` | 3 | yes | yes | — |
| `apps/desktop/frontend/e2e/status-bar.spec.ts` | 1 | yes | yes | — |
| `apps/desktop/frontend/e2e/ui-perf.spec.ts` | 2 | opt-in | no | `files.explorer`: the harness seeds 10 000 notes into the Wails mock and its budgets are calibrated on it (docs/qa) |
| `apps/desktop/frontend/e2e/workflows.spec.ts` | 4 | yes | yes | — |

<!-- parity:end -->
