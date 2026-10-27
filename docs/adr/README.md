# Indice degli ADR

Le deviazioni e le precisazioni rispetto a `Specifications.md` si registrano come ADR (template: [`0000-template.md`](0000-template.md)). Gli ADR in stato **proposta** vanno recepiti nello spec dall'owner; quelli **accettata** sono già confermati. Elenco verificato rispetto al contenuto della directory.

| ADR                                                  | Titolo                                                                               | Stato     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ | --------- |
| [0001](0001-url-scheme-delivery.md)                  | Consegna degli URL `nodus://` per sistema operativo (SPIKE-01)                       | accettata |
| [0002](0002-sqlite-fts5-trigram.md)                  | SQLite pure-Go con FTS5 `trigram` per l'indice locale (SPIKE-02)                     | accettata |
| [0003](0003-react-excalidraw.md)                     | React 19 e strategia per Excalidraw (SPIKE-03)                                       | accettata |
| [0004](0004-live-preview.md)                         | Architettura Live Preview, una sola vista CodeMirror (SPIKE-04)                      | accettata |
| [0005](0005-webview-csp.md)                          | Content Security Policy nel webview (SPIKE-05)                                       | accettata |
| [0006](0006-go-toolchain-and-tools-module.md)        | Go 1.26 e modulo `tools/` per gli strumenti di sviluppo                              | accettata |
| [0007](0007-dev-stack.md)                            | Stack di sviluppo locale: RustFS come S3, porte non standard                         | accettata |
| [0008](0008-client-config-endpoint.md)               | Endpoint pubblico `GET /client-config` per il bootstrap                              | accettata |
| [0009](0009-sync-protocol-details.md)                | Dettagli del protocollo di sync (M2)                                                 | proposta  |
| [0010](0010-drawing-and-canvas-details.md)           | Dettagli di disegni e canvas (M3)                                                    | proposta  |
| [0011](0011-sharing-groups-config-details.md)        | Condivisione, gruppi e configurazione distribuita (M4)                               | proposta  |
| [0012](0012-admin-export-details.md)                 | Console admin ed export, ruoli minimi del service account (M5)                       | proposta  |
| [0013](0013-graph-view-details.md)                   | Graph view: Canvas 2D, ctime da frontmatter/mtime (M6-WP1)                           | proposta  |
| [0014](0014-bases-details.md)                        | Bases: sottoinsieme supportato, degrado e round-trip                                 | proposta  |
| [0015](0015-daily-templates-composer-details.md)     | Note giornaliere, template, composer (M6)                                            | proposta  |
| [0016](0016-bookmarks-workspaces-preview-details.md) | Bookmarks, workspaces e page preview                                                 | proposta  |
| [0017](0017-importer-details.md)                     | Importer: mappature per sorgente e limiti                                            | proposta  |
| [0018](0018-local-history-details.md)                | History locale e File recovery (M6-WP5)                                              | proposta  |
| [0019](0019-embedded-search-export-details.md)       | Embedded search, export PDF/HTML, impostazioni residue (M6-WP6)                      | proposta  |
| [0020](0020-performance-details.md)                  | Prestazioni: indicizzazione a lotti, cache di ricerca, albero virtualizzato (M7-WP1) | proposta  |
| [0021](0021-security-privacy-details.md)             | Sicurezza e privacy: GDPR (export e cancellazione), controlli in CI (M7-WP2)         | proposta  |
| [0022](0022-resilience-details.md)                   | Resilienza: garanzie verificate, bug trovati, prova di ripristino (M7-WP2b)          | proposta  |
| [0023](0023-distribution-and-updates-details.md)     | Distribuzione e aggiornamenti: manifest firmato, installer, chart (M7-WP3)           | proposta  |

Nota: gli ADR 0015 e 0018 usano un'intestazione in forma di elenco invece della tabella del template; il contenuto resta valido, l'uniformazione del formato è un'attività di pulizia non bloccante. Le righe 0020–0023 vanno trasformate in link quando i file arrivano (i titoli riportati sono provvisori).
