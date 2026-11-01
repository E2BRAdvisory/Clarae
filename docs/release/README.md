# Processo di rilascio

Dettagli tecnici e scelte: ADR-0023 e ADR-0031; verifiche: ADR-0036. L'unico workflow GitHub è `release.yml`: costruisce e pubblica, **non firma nulla** e non esegue lint né test. Non c'è un servizio di CI: le verifiche si fanno in locale con `task ci` prima del tag.

## Versioni

Versioni semver: `MAJOR.MINOR.PATCH`, con pre-release `-rc.N` / `-beta.N`. Il tag git è `vX.Y.Z[-pre]` (il workflow accetta anche `X.Y.Z[-pre]` senza `v`) ed è l'unica fonte della versione: finisce nel binario (`-X main.Version`, schermata About), nell'`Info.plist`, nelle risorse versione Windows, nell'immagine OCI e nel chart Helm.

## Prima di tagliare

1. `task ci` verde in locale (ADR-0036): è l'unico controllo prima della pubblicazione, il workflow non ne esegue.
2. Le suite lente elencate in [`docs/dev-setup.md`](../dev-setup.md#verifiche) (integrazione del cloud, sync a due dispositivi e contract test, Playwright, cloud vero), `node scripts/pentest-inventory.mjs --check` e la checklist cross-OS (`docs/qa/`).
3. `info.version` di `api/openapi.yaml` uguale alla versione del tag (poi `task gen-openapi`).
4. Note di rilascio: la sezione _Unreleased_ di `CHANGELOG.md` diventa `## [X.Y.Z] - data` (se manca, `scripts/release/notes.sh` usa i messaggi di commit dall'ultimo tag).

## Tagliare un rilascio

```sh
git tag -a v1.0.0 -m "MemoBrain Notes 1.0.0" && git push origin v1.0.0     # azione dell'utente: gli agenti non fanno tag/push
```

Il push del tag avvia `release.yml`, che:

1. costruisce e pubblica su GHCR l'**immagine cloud** multi-arch (`ghcr.io/<owner>/memobrain-cloud:X.Y.Z`, più `X.Y` sulle versioni stabili) e il **chart Helm** come artefatto OCI (`oci://ghcr.io/<owner>/charts/memobrain`);
2. costruisce gli **installer desktop**: macOS universale (`.dmg`), Windows amd64 (NSIS), Linux amd64 (`.deb` e AppImage);
3. crea e pubblica **una** GitHub Release con gli installer e `SHA256SUMS`, marcata **prerelease** se la versione ha un suffisso.

Gli installer non sono firmati (Gatekeeper e SmartScreen avvisano al primo avvio) e l'updater è compilato fuori dai binari (`ALLOW_UNSIGNED_UPDATES=1`): nessun manifest di aggiornamento. La prima volta i pacchetti GHCR sono privati: renderli pubblici (Package settings, Change visibility) se non devono richiedere un login.

Il workflow usa solo il `GITHUB_TOKEN` del run: `packages: write` per immagine e chart, `contents: write` per la Release; nessun segreto del repository (dettaglio in [secrets.md](secrets.md)). Le note della Release sono la sezione del `CHANGELOG.md` più i comandi `docker pull` e `helm install` e l'avviso sugli installer non firmati.

## Release candidate

Tag `v1.0.0-rc.1`: Release marcata `prerelease`, immagine senza il tag `X.Y`. Si promuove a stable solo con un nuovo tag `v1.0.0` costruito da zero (mai rinominare un RC: il binario porta la versione del tag).

## Verificare gli artefatti

```sh
sha256sum -c SHA256SUMS
```

## Build locali (senza segreti)

- `task release-desktop OS=darwin V=1.0.0-rc.1` (poi `scripts/release/package-macos.sh 1.0.0-rc.1`): `.app` universale e `.dmg` **non firmato**. Funziona su macOS; `OS=windows` (`ARCH=amd64|arm64`) produce l'installer NSIS anche da macOS con `makensis` installato (non firmato, non provato su Windows). Lo script firma `memobrain.exe` prima di impacchettarlo quando `MEMOBRAIN_SIGNTOOL_CMD` è impostata, ed esegue `makensis` direttamente (il template `wails_tools.nsh` è reso da `scripts/release/nsis-render.go`).
- Immagine cloud: `task docker-build` (architettura locale) e `task docker-push` (multi-arch, richiede `docker login` e un builder buildx).
- `scripts/release/package-linux.sh` richiede `nfpm` e `appimagetool` su Linux.
- Icone: generate da `assets/logo.png` con `scripts/brand/gen-brand-assets.py` (vedi `assets/brand/README.md`). Wails ricava `iconfile.icns` da `apps/desktop/build/appicon.png` e usa `build/windows/icon.ico` così com'è; il pacchetto Linux prende `build/linux/memobrain.{png,svg}`.

## Da riattivare

Tolti dalla pipeline nella 1.2.2 e da ripristinare in `release.yml` quando servono (segreti e variabili relativi in [secrets.md](secrets.md#da-riattivare)):

- **firma degli installer:** Developer ID e notarizzazione per macOS, Authenticode per Windows (`memobrain.exe` e installer); senza, gli avvisi del sistema operativo restano;
- **immagine e chart:** firma cosign keyless, SBOM e attestazioni di provenienza;
- **aggiornamento automatico:** manifest firmato (ed25519) per i canali stable e beta, updater compilato nei binari;
- **verifiche automatiche:** un workflow che esegua `task ci` su push e pull request (ADR-0036 lo lascia come opzione se i contributori aumentano);
- **installer arm64:** Windows arm64 (tolto nella 1.2.3) e Linux arm64 (serve un runner arm64).

Le sezioni seguenti valgono solo quando il manifest di aggiornamento torna a essere firmato e pubblicato.

**Scadenza del manifest:** `tools/release gen-manifest` firma un `expires_at` (default 30 giorni, opzione `-validity`, massimo accettato dai client 400 giorni). Un client che trova un manifest scaduto mostra un avviso invece di considerarlo aggiornato, così un canale congelato da un attaccante non passa inosservato. Prima della scadenza va pubblicato un manifest rifirmato con la stessa versione e `sequence` più alta.

### Ruotare la chiave di aggiornamento

La chiave pubblica è compilata nei client: una rotazione richiede che i client già installati si fidino della nuova chiave **prima** che la vecchia sia ritirata.

1. `bin/release gen-key`; conservare la nuova privata.
2. Rilasciare una versione di transizione `N` costruita con `UPDATE_PUBLIC_KEY` = nuova pubblica, ma il cui manifest è ancora firmato con la **vecchia** chiave (i client in campo la accettano). `release.yml` firma con `UPDATE_SIGNING_KEY`: tenere la vecchia in quel segreto per questo giro.
3. Quando la base installata è passata a `N` (o a una versione successiva), sostituire `UPDATE_SIGNING_KEY` con la nuova privata. I client `< N` non riceveranno più aggiornamenti automatici: installazione manuale.
4. Distruggere la vecchia privata.

**Compromissione della privata**: chi la possiede può firmare manifest che tutti i client accettano; deve però controllare anche l'hosting del canale (o il DNS) per farli arrivare, e l'hash degli artefatti nel manifest è firmato, non sostituibile. Risposta: fermare subito la pubblicazione sul canale, ruotare come sopra distribuendo però la versione di transizione **fuori canale** (sito, e-mail), e pubblicare un avviso. Per questo la privata vive solo nei segreti del repository (ambiente protetto con approvazione consigliata) e in una copia offline cifrata.

### Rollback di un rilascio

Oggi, senza updater, un rilascio difettoso si corregge con una nuova versione di patch che gli utenti installano a mano. Con l'updater attivo, i client non scendono mai di versione (regola anti-rollback, ADR-0023) e un rilascio difettoso si corregge con una nuova versione di patch. Per impedire che un'installazione specifica continui a girare, alzare `min_version` nel manifest successivo (i client sotto la soglia vedono l'aggiornamento come obbligatorio). Ripubblicare il vecchio manifest non ha effetto sui client già aggiornati e viene rifiutato come replay.
