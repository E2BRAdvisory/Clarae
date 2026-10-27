# ADR-0016 — Bookmarks, workspaces e page preview: dettagli

|                       |                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| **Stato**             | proposta                                                                                       |
| **Data**              | 2026-10-24                                                                                     |
| **Riferimenti spec**  | §2.2.1 (Workspaces, Bookmarks, Page preview), §3.4.2 e §3.4.6 (scope di sync di `.memobrain/`) |
| **Devia dallo spec?** | no (lo spec e `shared/go/pathrules` concordano; vedi "Scope di sync")                          |

## Contesto

M6-WP3 (seconda metà) aggiunge segnalibri, layout salvati e anteprima al passaggio sui link. Tutto vive nel frontend: i file passano da `VaultAPI.ReadConfig/WriteConfig`, la cui allow-list contiene già `bookmarks.json` e `workspaces.json` (nessuna modifica Go).

## Decisione

**`.memobrain/bookmarks.json`** — `{ "version": 1, "items": [...] }`, stessa forma di Obsidian (`file`, `folder`, `search`, `graph`, `group`). `file`: `path` e `subpath` (`#Titolo` oppure `#^id`); `search`: `query`; `graph`: `title` e `options` (oggetto opaco); `group`: `title` e `items` annidati. Campi e tipi sconosciuti sono conservati in scrittura; elementi malformati di tipo noto sono scartati. Gli elementi non hanno id: si indirizzano per percorso di indici. Rename/spostamento aggiornano i percorsi (hook additivo in `renameEntry`); la cancellazione non rimuove il segnalibro, che viene mostrato come mancante (il cestino è recuperabile e un sync può riportare il file). Il file viene riletto quando il watcher segnala una modifica esterna; le scritture proprie sono riconosciute e ignorate.

**`.memobrain/workspaces.json`** — `{ "version": 1, "workspaces": [{ name, savedAt, layout, left, right }] }`, dove `layout` ha la forma di `workspace.json` (`parseLayout`) e `left`/`right` sono `{open, tab, width}`. Il nome è univoco senza distinguere maiuscole; salvare con un nome esistente sovrascrive dopo conferma. Il caricamento fa prima il flush di tutte le note aperte (registro `workspaces/flush.ts`, agganciato a `useNoteDocument`), poi scarta i tab con file inesistenti.

**Scope di sync.** `workspaces.json` è locale al dispositivo: §3.4.6 lo dichiara "No" e `pathrules.IsExcluded` esclude ogni `.memobrain/workspace*.json` (il prefisso copre anche `workspaces.json`). `bookmarks.json` non è escluso da `pathrules`, quindi viene sincronizzato come impostazione utente; la tabella §3.4.6 non lo elenca esplicitamente: suggerito aggiungerlo alla riga "per utente".

**Vault di sola lettura (mount viewer):** segnalibri e workspace si leggono e si aprono, ma le modifiche sono disabilitate (comandi e menu nascosti o non attivi), non tenute in memoria.

**Hook del grafo.** `bookmarks/graphHook.ts`: `registerGraphBookmarks({ open(options), capture?() })`. Il modulo grafo si registra una volta; senza registrazione un segnalibro `graph` mostra un avviso e "Bookmark current graph" è disabilitato. `options` non è mai interpretato dai segnalibri.

**Page preview.** Estensione CodeMirror (`mousemove` + `posAtCoords`, riconosce `[[…]]` nel testo, quindi vale in Live Preview e Source) e handler sulla reading view. Con Cmd/Ctrl premuto (o sempre, impostazione `pagePreviewAlways`; disattivabile con `pagePreview`, in `editor.json`) e dopo 350 ms mostra un popover `position: fixed` (nessun layout shift, max 340 px con scroll) con il rendering di `renderMarkdown` (sezione per `#Titolo`, blocco per `#^id`). Chiusura: uscita del puntatore, Esc, click fuori, scroll, digitazione. Alternativa da tastiera: comando "Preview link under cursor" (anche su un link a fuoco nella reading view), che sposta il fuoco nel popover. Sicurezza: HTML già sanificato (DOMPurify), in più rimozione di ogni `src` non `blob:`/`data:image`, niente `style`; gli embed sono idratati con un solo livello; il popover non ha hover, quindi nessuna anteprima annidata; i link esterni passano da `openExternal`/`isSafeExternalUrl`.

## Alternative considerate

- **Preview solo sui nodi `.cm-wikilink`** — scartata: non funziona in Source e con il link attivo.
- **Rimuovere i segnalibri dei file cancellati** — scartata: perdita silenziosa in caso di cancellazione esterna o sync parziale.
- **Id persistiti per elemento** — scartata: si discosta dal formato Obsidian senza benefici.

## Conseguenze

Un file di segnalibri modificato su due dispositivi segue la risoluzione di sync dei file non `.md` (copia di conflitto). La sidebar sinistra ha un tab in più (`bookmarks`); i workspace salvati con tab sconosciuti restano caricabili (il tab non viene validato).
