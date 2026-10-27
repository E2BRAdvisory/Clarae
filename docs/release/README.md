# Processo di rilascio

Dettagli tecnici e scelte: ADR-0023. Segreti e variabili: `secrets.md`. **Stato**: le pipeline GitHub (`release.yml`, `release-images.yml`) sono scritte e validate con `actionlint` ma **non sono mai state eseguite**; firma, notarizzazione, cosign e pubblicazione sono configurate e non verificate. Il primo giro reale è il release candidate (RC).

## Versioni e canali

- Versioni semver: `MAJOR.MINOR.PATCH`, con pre-release `-rc.N` / `-beta.N`. Il tag git è `vX.Y.Z[-pre]` ed è l'unica fonte della versione: finisce nel binario (`-X main.Version`, schermata About), nell'`Info.plist`, nelle risorse versione Windows, nell'immagine OCI e nel chart Helm.
- Canali di aggiornamento del desktop: **stable** (tag senza pre-release) e **beta** (tag con `-`). Ogni canale ha il suo manifest firmato (`<base>/stable/manifest.json`, `<base>/beta/manifest.json`).
- Un client su `stable` non vede mai una pre-release; uno su `beta` vede sia le RC sia le stable più recenti (il manifest beta è quello dell'ultimo tag di qualsiasi tipo).

## Prima di tagliare

1. `main` verde in CI (`make ci`), checklist cross-OS aggiornata (`docs/qa/`).
2. Variabili e segreti configurati (`secrets.md`); `UPDATE_PUBLIC_KEY` corrisponde alla chiave privata in `UPDATE_SIGNING_KEY` (provare con `bin/release`).
3. (Consigliato) dry run: Actions, "Release", Run workflow, versione `0.0.0-dryrun.1`. Costruisce tutto senza creare release; con `use_secrets` firma davvero.
4. Note di rilascio: sezione `## X.Y.Z` in `CHANGELOG.md` (se manca, `scripts/release/notes.sh` usa i messaggi di commit dall'ultimo tag).

## Tagliare un rilascio

```sh
git tag -a v1.0.0 -m "MemoBrain Notes 1.0.0" && git push origin v1.0.0     # azione dell'utente: gli agenti non fanno tag/push
```

Il push del tag avvia due workflow:

- **Release**: test, build su macOS/Windows/Linux, firma e notarizzazione (su tag mancano segreti = errore), `SHA256SUMS`, SBOM, attestazione di provenienza, manifest di aggiornamento firmato, **GitHub Release in bozza** con tutti i file.
- **Release images**: immagine cloud multi-arch su GHCR, firma cosign keyless, SBOM e provenienza BuildKit; chart Helm come artefatto OCI firmato (`oci://ghcr.io/<owner>/charts/memobrain`).

Poi, a mano:

1. Scaricare gli artefatti della bozza e **verificarli** (sotto), eseguire la checklist cross-OS su macchine pulite (installazione, apertura `memobrain://`, login, update dalla versione precedente).
2. Pubblicare la Release (toglie lo stato di bozza).
3. **Attivare il canale di aggiornamento**: copiare `manifest.json` e `manifest.json.sig` nella cartella del canale (`stable/` o `beta/` sotto `UPDATE_BASE_URL`). Finché non lo si fa, nessun client riceve l'aggiornamento: è il passaggio di "go live" e va fatto per ultimo. Gli URL degli artefatti nel manifest puntano agli asset della Release.

Regola sul `sequence` del manifest: è il numero di run del workflow, quindi cresce a ogni rilascio. **Non rieseguire il workflow di un tag vecchio dopo averne pubblicato uno più nuovo**: produrrebbe un manifest con sequence maggiore e versione minore, che i client rifiutano (revoca a monte) ma che sporcherebbe il canale.

## Release candidate

Tag `v1.0.0-rc.1`: il workflow lo tratta come pre-release (canale beta, Release marcata `prerelease`). Si promuove a stable solo con un nuovo tag `v1.0.0` costruito da zero (mai rinominare un RC: il binario porta la versione del tag).

## Verificare gli artefatti

```sh
sha256sum -c SHA256SUMS
# manifest di aggiornamento
bin/release verify-manifest -in manifest.json -pubkey "$UPDATE_PUBLIC_KEY"
# immagine OCI
cosign verify ghcr.io/ORG/memobrain-cloud:1.0.0 \
  --certificate-identity-regexp '^https://github.com/ORG/REPO/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
# attestazione di provenienza dei file
gh attestation verify memobrain-1.0.0-linux-amd64.deb --repo ORG/REPO
# macOS
spctl --assess --type open --context context:primary-signature -v memobrain-1.0.0-darwin-universal.dmg
xcrun stapler validate memobrain-1.0.0-darwin-universal.dmg
```

## Build locali (senza segreti)

- `make release-desktop OS=darwin V=1.0.0-rc.1` (poi `scripts/release/package-macos.sh 1.0.0-rc.1`): `.app` universale e `.dmg` **non firmato**. Funziona su macOS; `OS=windows` produce l'installer NSIS anche da macOS con `makensis` installato (non firmato, non provato su Windows).
- `scripts/release/package-linux.sh` richiede `nfpm` e `appimagetool` su Linux.
- Icone: l'app non ha ancora un'icona definitiva; si usa `apps/desktop/build/appicon.png` (1024 px, Wails ricava `icon.ico` e `iconfile.icns`). Sostituire quel file e `build/windows/icon.ico` quando c'è la grafica finale: nient'altro da toccare.

## Ruotare la chiave di aggiornamento

La chiave pubblica è compilata nei client: una rotazione richiede che i client già installati si fidino della nuova chiave **prima** che la vecchia sia ritirata.

1. `bin/release gen-key`; conservare la nuova privata.
2. Rilasciare una versione di transizione `N` costruita con `UPDATE_PUBLIC_KEY` = nuova pubblica, ma il cui manifest è ancora firmato con la **vecchia** chiave (i client in campo la accettano). `release.yml` firma con `UPDATE_SIGNING_KEY`: tenere la vecchia in quel segreto per questo giro.
3. Quando la base installata è passata a `N` (o a una versione successiva), sostituire `UPDATE_SIGNING_KEY` con la nuova privata. I client `< N` non riceveranno più aggiornamenti automatici: installazione manuale.
4. Distruggere la vecchia privata.

**Compromissione della privata**: chi la possiede può firmare manifest che tutti i client accettano; deve però controllare anche l'hosting del canale (o il DNS) per farli arrivare, e l'hash degli artefatti nel manifest è firmato, non sostituibile. Risposta: fermare subito la pubblicazione sul canale, ruotare come sopra distribuendo però la versione di transizione **fuori canale** (sito, e-mail), e pubblicare un avviso. Per questo la privata vive solo nei segreti del repository (ambiente protetto con approvazione consigliata) e in una copia offline cifrata.

## Rollback di un rilascio

I client non scendono mai di versione (regola anti-rollback, ADR-0023). Un rilascio difettoso si corregge con una nuova versione di patch. Per impedire che un'installazione specifica continui a girare, alzare `min_version` nel manifest successivo (i client sotto la soglia vedono l'aggiornamento come obbligatorio). Ripubblicare il vecchio manifest non ha effetto sui client già aggiornati e viene rifiutato come replay.
