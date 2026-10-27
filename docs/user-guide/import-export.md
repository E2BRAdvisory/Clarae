# Importare ed esportare

## Importare

_Importa…_ (palette comandi) apre una procedura guidata in più passi:

1. **Sorgente:** cartella Markdown/HTML (o zip), Evernote (ENEX), Notion (esportazione Markdown/CSV in zip), Roam, Bear, Google Keep (Takeout), CSV. L'app riconosce la sorgente dal contenuto e propone quella probabile.
2. **Opzioni:** cartella di destinazione nel vault, conversione dei link in `[[wikilink]]`, cartella degli allegati, inclusione di note archiviate o nel cestino, e per i CSV delimitatore, colonna del titolo e del corpo (le altre colonne diventano proprietà).
3. **Anteprima:** quante note e allegati verranno creati e un campione dei titoli, con eventuali avvisi. **Non viene scritto nulla** finché non premete _Importa_.
4. **Avanzamento e report:** al termine un riepilogo (note e allegati creati, link riscritti, elementi saltati o falliti) e una nota di report apribile.

Garanzie: l'importazione **non sovrascrive mai** note esistenti (in caso di nome uguale ne crea di nuove con un suffisso); se la annullate, quanto già scritto resta; gli archivi vengono controllati contro file malevoli (percorsi fuori cartella, archivi "bomba", XML esterno).

## Esportare una nota

- **PDF:** _Esporta in PDF_ apre la finestra di stampa del sistema: scegliete "Salva come PDF".
- **HTML:** _Esporta in HTML_ salva un file **autonomo** (immagini incorporate, formule e diagrammi già renderizzati, nessuna risorsa remota). Gli elementi che non possono stare in un documento autonomo e quelli troppo grandi sono elencati nell'avviso finale.

## Esportare un vault

- **Vault locale:** i file sono già normali file nella cartella: copiatela dove volete.
- **Vault del cloud, dalla Web UI** (pagina _Vault_): _Scarica ZIP_.
  - _Condiviso:_ lo ZIP è generato dal server (per vault grandi in background: lo stato passa da "in coda" a "pronto" e il download parte da solo).
  - _Privato:_ lo ZIP è costruito **nel vostro browser**, dopo aver inserito passphrase o chiave di recupero; il server non vede mai i contenuti. Non chiudete la scheda finché non termina.
- Dall'app: _Esporta vault come ZIP_.
