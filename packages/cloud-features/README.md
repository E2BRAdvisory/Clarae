# @memobrain/cloud-features

La UI di **gestione dei vault cloud**, scritta una volta sola per la console web, il desktop e il workbench del browser ([ADR-0037 §2](../../docs/adr/0037-registro-funzioni-e-cloud-features.md)).

## Regola

Ogni nuova funzione di gestione dei vault cloud (vault, dispositivi, utilizzo, condivisioni, grant, inviti, directory…) **nasce qui**, mai direttamente in `web/src/pages` o in `packages/workbench/src/settings`. Gli host si limitano a montare i componenti e a passare un adattatore e qualche callback. La funzione va registrata in `shared/parity/features.yaml` con i test di entrambe le superfici.

## Contenuto

| Pezzo                           | Cosa fa                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CloudPort` (`src/port.ts`)     | L'unica interfaccia da cui dipendono i componenti: `listVaults`, `listDeletedVaults`, `createVault` (solo condivisi), `renameVault`, `deleteVault`, `restoreVault`, più `capabilities` (`createShared`, `createPrivate`, `keepsLocalCopy`, `deletedRetentionDays`). I tipi sono quelli generati da OpenAPI (`Schemas['Vault']` di `@memobrain/api-client`). `errorCode()` legge il codice applicativo da entrambi gli adattatori. |
| `RestCloudPort` (`src/rest.ts`) | Adattatore della console: REST con il client generato e `unwrap()`/`ApiError`.                                                                                                                                                                                                                                                                                                                                                    |
| `CoreCloudPort`                 | Adattatore di desktop e workbench sui binding Go. Sta in `packages/workbench/src/cloud/CoreCloudPort.ts`, accanto alla facciata dei binding che usa: così la dipendenza va in un solo verso (workbench → cloud-features) e questo pacchetto non conosce Wails. Converte i DTO dei binding (camelCase) nel tipo OpenAPI.                                                                                                           |
| `CloudVaultsTable`              | Elenco con dimensione, file e creazione; _Apri_ (se l'host dà `openHref`), _Rinomina_, _Elimina_ con conferma (conservazione e, dove la copia locale resta, «la copia su questo dispositivo resta ed è scollegata»); sezione _Vault eliminati_ con _Ripristina_ e data di rimozione definitiva se la conservazione è nota. Callback: `onNew` (flusso dell'host), `onCreatePrivate`, `onChanged`, `isCurrent`.                     |
| `NewVaultDialog`                | Nome e tipo; per il privato spiega E2EE, passphrase, chiave di recupero e non condivisibilità (D-02). Un vault privato lo crea sempre l'host (le chiavi le fa il core Go): la console apre il workbench sulla rotta `/vaults/new/open?kind=private&name=…`.                                                                                                                                                                       |

## Scelte

- **Stile.** I componenti usano quelli di `@memobrain/ui` (classi `nd-*`) e aggiungono solo classi di layout `mbcf-*`; niente stile inline né `<style>` (CSP, V-02). La console carica `@memobrain/ui/styles.css` e `@memobrain/cloud-features/styles.css`. Il workbench non può caricare il design system della console (le sue regole globali toccherebbero l'editor): importa `@memobrain/cloud-features/workbench.css`, che prende solo le regole dei componenti (`@memobrain/ui/components.css`, soltanto classi `nd-*`) e dentro `.mbcf` mappa i token `--nd-*` su quelli del workbench.
- **Testi.** Il pacchetto ha un proprio dizionario it/en (`src/i18n.ts`, interpolazione `{{nome}}` e plurali `_one`/`_other` come i18next); l'host passa solo la lingua (`lang`). Gli stessi testi valgono così su ogni host, e `i18n.test.ts` applica i controlli di coerenza di `@memobrain/ui` (`i18nCheck`).
- **Dati.** I componenti usano react-query dell'host (`QueryClientProvider`), con chiavi proprie per adattatore (`cloudKeys`); `onChanged` permette all'host di aggiornare il resto (utilizzo, collegamento del vault aperto).

## Test

Una sola suite dei componenti (`src/testing/suite.tsx`, esportata da `@memobrain/cloud-features/testing`) gira su entrambi gli adattatori:

```sh
yarn workspace @memobrain/cloud-features run test                                  # RestCloudPort su un finto server REST (src/testing/fakeRest.ts)
yarn workspace @memobrain/workbench exec vitest run src/cloud/CoreCloudPort.test.tsx  # CoreCloudPort sul mock di Wails
```
