# ADR-0044 — Watcher su macOS con FSEvents (via purego) al posto di kqueue

|                       |                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Stato**             | proposta                                                                                                        |
| **Data**              | 2026-11-01                                                                                                      |
| **Riferimenti spec**  | §2.5 "watcher" (tabella dei moduli), §3.8 A "Rilevamento locale", registro dei rischi (affidabilità `fsnotify`) |
| **Devia dallo spec?** | sì (§2.5 e §3.8 A citano solo `fsnotify`) → richiede aggiornamento di `Specifications.md` da parte dell'owner   |

## Contesto

Su macOS `fsnotify` usa kqueue, che tiene aperto **un descrittore per ogni file** di ogni cartella osservata (oltre a uno per cartella). Misura sui dataset di `task perf` (`TestWatcherDescriptors`, `MEMOBRAIN_WATCH_FD_DIR`):

| vault                       | fsnotify (kqueue)      | FSEvents          |
| --------------------------- | ---------------------- | ----------------- |
| 10 052 file in 328 cartelle | 10 378 fd, avvio 0,5 s | 11 fd, avvio 5 ms |
| 50 252 file in 718 cartelle | 50 973 fd, avvio 3,1 s | 11 fd, avvio 5 ms |

Con `kern.maxfilesperproc` (122 880 sulla macchina di misura, meno su altre configurazioni) un vault Obsidian con molti allegati porta il processo a `EMFILE`: falliscono allora tutte le aperture (index.db, sync.db, scritture atomiche, socket). Il rilievo era stato rinviato in M11-W4.

## Decisione

- Su macOS il watcher usa **FSEvents**: un solo stream ricorsivo sulla radice del vault (`kFSEventStreamCreateFlagFileEvents | NoDefer | WatchRoot`, latenza 50 ms, coda dispatch seriale), nessun descrittore per file. Le API di CoreServices/CoreFoundation/libdispatch sono raggiunte con `github.com/ebitengine/purego` (già nel grafo delle dipendenze, ora diretta): niente cgo, la build incrociata resta possibile.
- Gli eventi passano dallo stesso debounce/coalescing; i flag `MustScanSubDirs`, `UserDropped`, `KernelDropped`, `RootChanged` producono una riconciliazione completa. I path reali (`/private/var/…`) sono ricondotti alla radice del vault; `.git/` e i file interni restano esclusi.
- Se FSEvents non si inizializza si torna a `fsnotify`.
- Su Linux/Windows resta `fsnotify` (inotify: un watch per cartella). Al raggiungimento di un limite di sistema (`ENOSPC` di `max_user_watches`, `EMFILE`/`ENFILE`) il watcher smette di aggiungere watch, conta le cartelle non osservate (`Watcher.Degraded()`), lo registra una volta e porta la riconciliazione a 1 minuto.
- Nel browser la riconciliazione periodica è disattivata per default: lì solo il core scrive e notifica ogni scrittura (`Watcher.Notify`).

## Alternative considerate

- **`github.com/fsnotify/fsevents`** — richiede cgo e non è tra le dipendenze; purego dà lo stesso risultato senza toolchain C.
- **kqueue solo sulle cartelle + riscansione** — un descrittore per cartella, ma le scritture in place (VS Code, `>>`) non modificano la cartella e sarebbero viste solo dalla riconciliazione.
- **Tetto ai watch + riconciliazione più frequente** — limita i danni ma su vault grandi lascia quasi tutto alla riconciliazione.

## Conseguenze

- Il watcher di macOS non consuma più descrittori in proporzione al vault; l'avvio dell'osservazione è immediato.
- purego diventa dipendenza diretta del desktop (callback C verso Go: una sola callback condivisa, i callback purego non si liberano).
- Il percorso `fsnotify` su macOS resta solo come ripiego: i test di watcher su macOS esercitano FSEvents, quelli su Linux `fsnotify`.
- Da recepire nello spec: §2.5 (tabella `watcher`) e §3.8 A ("FSEvents su macOS, `fsnotify` altrove").
