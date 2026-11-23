# Documentazione di Clarae notanda

**Clarae notanda** è un'app di knowledge management _local-first_. Le note sono file ordinari (`.md`, `.canvas`, `.base`, `.excalidraw`) in una cartella, il _vault_, compatibile con i vault di Obsidian: l'app funziona completamente offline e il cloud è facoltativo.

- **Client desktop** (macOS, Windows, Linux) su Wails v3, Go e React/TypeScript: editor Markdown, link e backlink, grafo, ricerca full-text, lavagne, disegni Excalidraw, basi, presentazioni, applicazioni web e terminale integrato.
- **Cloud Service** self-hosted in Go (PostgreSQL, storage S3-compatibile, autenticazione Keycloak/OIDC) per sincronizzare i vault tra dispositivi e condividerli con utenti e gruppi. Il merge avviene sempre sul client: il server ordina le modifiche e archivia i contenuti senza interpretarli.
- **Due tipi di vault cloud**, scelti alla creazione: _privati_, cifrati end-to-end sul client e non condivisibili, e _condivisi_, collaborativi e con la presenza in tempo reale degli altri utenti.
- **Web UI** incorporata nel binario del cloud: console utente e di amministrazione, e il workbench del vault nel browser, con la stessa interfaccia del desktop sul core Go compilato in WebAssembly.

Questa pagina è il punto d'ingresso alla documentazione del repository; la versione corrente è descritta nel [CHANGELOG](../CHANGELOG.md).

## Fonti di verità

| Documento                                 | Contenuto                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Specifications.md](../Specifications.md) | Specifica (v1.9): architettura, vincoli V-xx, decisioni D-xx, schema del database, API, protocollo di sync |
| [ADR](adr/README.md)                      | Deviazioni e precisazioni rispetto allo spec, con il loro stato                                            |
| [Roadmap](roadmap.md)                     | Piano di sviluppo per milestone, con work package, ordine e criteri di uscita                              |
| [CHANGELOG](../CHANGELOG.md)              | Note di rilascio di ogni versione                                                                          |
| [README](../README.md)                    | Presentazione, installazione rapida e ambiente di sviluppo                                                 |
| [CONTRIBUTING](../CONTRIBUTING.md)        | Regole per contribuire                                                                                     |

## Da dove cominciare

| Chi                              | Da leggere                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Chi usa l'app                    | [Guida utente](user-guide/README.md)                                                                                  |
| Chi installa e gestisce il cloud | [Guida dell'amministratore](admin-guide/README.md)                                                                    |
| Chi sviluppa                     | [Ambiente di sviluppo](dev-setup.md), [Architettura](architecture.md), [Desktop e web allineati](desktop-web-sync.md) |

## Guida utente

Indice della guida: [user-guide/README.md](user-guide/README.md).

- [Installazione](user-guide/installazione.md): requisiti e passi per macOS, Windows e Linux, aggiornamento dalle versioni 1.x.
- [Il primo vault](user-guide/primo-vault.md): creare o aprire un vault e orientarsi nell'interfaccia.
- [Scrivere, link e proprietà](user-guide/scrivere-link-proprieta.md): editor, modalità Live, Sorgente e Lettura, link interni, proprietà.
- [Template e note giornaliere](user-guide/template-note-giornaliere.md): modelli di nota e note del giorno.
- [Ricerca](user-guide/ricerca.md): ricerca full-text e operatori.
- [Lavagne, disegni, basi e grafo](user-guide/canvas-disegni-bases-grafo.md): file `.canvas`, disegni Excalidraw, `.base`, grafo 2D e 3D.
- [Presentazioni](user-guide/presentazioni.md): presentare una nota Markdown o slide curate.
- [Applicazioni](user-guide/applicazioni.md): pagine web registrate nel vault e aperte in una scheda.
- [Terminale](user-guide/terminale.md): il terminale integrato del client desktop.
- [Sincronizzazione e cloud](user-guide/sync-cloud.md): collegare il cloud e sincronizzare i vault.
- [Vault privati e condivisi](user-guide/vault-privati-condivisi.md): cifratura end-to-end, passphrase e recovery key.
- [Condivisione e gruppi](user-guide/condivisione-gruppi.md): condividere vault, cartelle e documenti.
- [Presenza](user-guide/presenza.md): chi altro ha aperto lo stesso documento in un vault condiviso.
- [Cronologia e recupero](user-guide/cronologia-recupero.md): snapshot locali, storico delle versioni e copie di conflitto.
- [Importare ed esportare](user-guide/import-export.md): importazione guidata da altre app ed esportazione.
- [Impostazioni e scorciatoie](user-guide/impostazioni-scorciatoie.md): impostazioni per vault e scorciatoie da tastiera.
- [Accessibilità](user-guide/accessibilita.md): stato dei controlli di accessibilità.
- [Risoluzione dei problemi](user-guide/risoluzione-problemi.md): problemi frequenti e rimedi.

## Guida dell'amministratore

Indice della guida: [admin-guide/README.md](admin-guide/README.md).

- [Installazione](admin-guide/installazione.md): componenti, Helm su Kubernetes, Docker Compose, segreti e verifica.
- [Riferimento di configurazione](admin-guide/configurazione.md): tutte le variabili d'ambiente di `clarae-cloud` e il flag `--role`.
- [Keycloak](admin-guide/keycloak.md): realm, client OIDC e validazione dei token.
- [Config profile, quote, limiti e audit](admin-guide/profili-quote-audit.md): governance dalla console di amministrazione.
- [Presenza in tempo reale](admin-guide/presenza.md): il canale WebSocket della presenza e come esporlo.
- [Monitoraggio e osservabilità](admin-guide/monitoraggio.md): endpoint di salute, metriche, log e tracce.
- [Backup, ripristino e upgrade](admin-guide/backup-upgrade.md): principi e comandi essenziali.
- [Runbook degli incidenti](admin-guide/runbook.md): sintomo, verifica, rimedio.
- [Migrazione a Clarae notanda](admin-guide/migrazione-clarae.md): aggiornare un'installazione fatta con le versioni 1.x.
- [Runbook di backup e restore](runbook/backup-restore.md): procedure dettagliate per PostgreSQL e bucket S3, con RPO e RTO misurati.

## Sviluppo e architettura

- [Ambiente di sviluppo](dev-setup.md): prerequisiti, task, stack locale, avvio di cloud e desktop.
- [Architettura](architecture.md): panoramica del codice per chi inizia.
- [Desktop e web allineati](desktop-web-sync.md): come si aggiunge una funzione con la parità desktop/workbench/console per costruzione.
- [Web UI](web-ui.md): console utente e di amministrazione e host del workbench.
- [Parità tra il workbench web e il client desktop](web-workbench-parity.md): stato funzione per funzione (tabelle generate da `scripts/parity.mjs`).
- [Glossario e linee guida per la traduzione](qa/i18n-glossary.md): terminologia italiana e regole delle stringhe it/en.

## Decisioni architetturali (ADR)

L'elenco completo, con lo stato di ogni decisione, è in [adr/README.md](adr/README.md); i nuovi ADR partono dal [template](adr/0000-template.md). Alcuni dei più strutturali:

- [ADR-0029](adr/0029-web-workbench.md) e [ADR-0030](adr/0030-desktop-core-wasm.md): workbench del vault nella Web UI e core Go in WebAssembly.
- [ADR-0037](adr/0037-registro-funzioni-e-cloud-features.md) e [ADR-0045](adr/0045-parita-per-costruzione.md): parità desktop/web per costruzione.
- [ADR-0051](adr/0051-wails-v3.md): migrazione a Wails v3.
- [ADR-0052](adr/0052-rebrand-clarae-notanda.md): il nome «Clarae notanda».
- [ADR-0064](adr/0064-terminale-integrato-e-finestra-separata.md): terminale integrato.
- [ADR-0065](adr/0065-presenza-in-tempo-reale.md): presenza in tempo reale sui vault condivisi.

## Sicurezza

- [Design crittografico dei vault privati](security/crypto-design.md): pacchetto per la revisione esterna della cifratura end-to-end.
- [Conservazione dei dati e cancellazione GDPR](security/data-retention.md): durata di ogni classe di dato e cancellazione dell'account.
- [Preparazione al penetration test](security/pentest-scope.md): perimetro, regole e modello di report.

## Qualità e verifica manuale

Accessibilità:

- [Client desktop](qa/a11y-desktop.md): copertura automatica e checklist manuale.
- [Web UI](qa/a11y-web.md): copertura automatica e checklist manuale.

Checklist e runbook di verifica per milestone:

- [M0 — «Hello vault» con login](qa/m0-checklist.md)
- [M1 — Parità con Obsidian](qa/obsidian-parity.md)
- [M3 — Disegni e canvas](qa/m3-drawings-canvas.md)
- [M4 — Condivisione, gruppi e configurazione](qa/m4-sharing.md)
- [M5 — Console admin ed export](qa/m5-admin-export.md)
- [M6 — Ricerca incorporata, export, impostazioni](qa/m6-search-export.md)
- [M8 — Revisione della shell desktop](qa/m8-shell-ui.md)
- [M15 — Client desktop su Wails v3](qa/m15-wails3-matrice.md)
- [M18 — Applicazioni in una vista nativa](qa/m18-webview-matrice.md)
- [Versione 1.7 — Prove sulla finestra reale](qa/verifica-manuale-1.7.md)
- [M21 — Correttivi dello schizzo del 2026-11-15](qa/m21-correttivi.md)
- [M22 — Nomi dei file senza estensione e applicazioni su Windows e Linux](qa/m22-nomi-file-e-applicazioni.md)
- [M23 — Terminale integrato e finestra separata](qa/m23-terminale.md)
- [M25 — Presenza in tempo reale](qa/m25-presenza.md)

Benchmark:

- [Graph view (M6)](qa/m6-graph-benchmark.md): grafo 2D da 10k nodi.
- [Grafo 3D (M18)](qa/graph-3d-benchmark.md) e le [misure grezze dello spike](qa/graph-3d-spike-d0/README.md).

## Prestazioni

- [Prestazioni](perf/README.md): obiettivi dell'Appendice A dello spec, misure e come ripeterle.
- [Spike del core WASM](perf/wasm-spike.md): misure alla base di ADR-0030.

## Rilascio

- [Processo di rilascio](release/README.md): `release.yml`, artefatti pubblicati e verifiche prima del tag.
- [Segreti e variabili della pipeline](release/secrets.md): cosa usa la pipeline di rilascio.
- [Checklist di rilascio 1.0.0](release/v1.0.0-checklist.md): storica.
- [Inventario del rebrand](release/rebrand-inventory.md): storico del primo cambio di nome, prima della 1.0.

## Proposte di aggiornamento dello spec

Documenti storici: ciascuno ha preparato una versione di `Specifications.md`, poi recepita dall'owner.

- [v1.2](spec-v1.2-proposta.md)
- [v1.7](spec-v1.7-proposta.md)
- [v1.8](spec-v1.8-proposta.md)
- [v1.9](spec-v1.9-proposta.md)
