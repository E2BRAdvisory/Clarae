# ADR-0042 — Token di path legati al file (formato enc2)

|                       |                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | proposta                                                                                                                                    |
| **Data**              | 2026-11-01                                                                                                                                  |
| **Riferimenti spec**  | §3.8.1 (modello di minaccia, A3 server attivamente malevolo), §3.8.3 (path cifrati), §3.8.5, §3.8.7 (test vector); D-02; ADR-0009           |
| **Devia dallo spec?** | sì (§3.8.3 e §3.8.7) → nuovo formato del token di path accanto a `enc1:`; richiede aggiornamento di `Specifications.md` da parte dell'owner |

## Contesto

Nei vault privati il server conserva per ogni file un token di path opaco (`files.path`, `file_revisions.path`) e una chiave di unicità deterministica (`files.path_key`):

- `enc1:` + base64url(nonce(12) ‖ AES-256-GCM(K_path_enc, path NFC; AAD = `vault_id`) ‖ tag(16)), con nonce casuale;
- `hmac1:` + hex(HMAC-SHA256(K_path_key, NFC + casefold(path))), su cui il server applica `PATH_COLLISION` senza conoscere il path (ADR-0009).

L'AAD di `enc1` contiene solo `vault_id`, mentre l'AAD dei blob contiene anche il `file_id` (`crypto-design.md` §5.1). La review del 2026-11-01 (rilievo _path-token-not-bound-to-file_) ne ricava uno scenario dell'avversario A3: in `GET /changes` o in `GET /tree` il server associa al file X il token di path del file Y (e il suo `hmac1`). Il client decifra entrambi senza errore e scrive il contenuto di X al path di Y: per esempio una nota sostituita dal contenuto di un'altra sotto un nome fidato. Il server non impara nulla e il danno resta dentro i dati dell'utente, ma è un'alterazione dell'integrità non rilevata, che il modello di minaccia dichiara coperta. `crypto-design.md` §8 non la elencava tra i limiti.

Vincoli:

- **compatibilità**: i vault privati esistenti hanno solo token `enc1` e devono continuare a funzionare su ogni client (desktop, core WASM del workbench web, export ZIP del browser in `packages/vaultcrypto-web`);
- **D-02, nessun lockout**: nessun passo della migrazione può rendere illeggibile un vault a un dispositivo aggiornato;
- il token si riscrive solo quando un file nasce o si sposta (create, move, modify di un file revocato): un file mai spostato conserva il suo `enc1` per sempre, salvo migrazione esplicita.

## Decisione

**Formato enc2.**

```text
enc2 = "enc2:" + base64url(nonce (12) ‖ AES-256-GCM(K_path_enc, path NFC; AAD) ‖ tag (16))
AAD  = "memobrain/v2/path" (17 B ASCII) ‖ vault_id (16 B) ‖ file_id (16 B)
```

- Stessa chiave `K_path_enc` di `enc1`, stesso nonce casuale a 96 bit. Le due AAD hanno lunghezze diverse (16 e 49 byte) e la v2 ha un prefisso di dominio: un token rietichettato da una versione all'altra non si apre (né l'upgrade `enc1→enc2` né il downgrade `enc2→enc1`).
- Il prefisso è la versione: il server lo convalida per forma senza capirlo, come oggi `enc1:`.
- **`hmac1` non cambia**: dipende solo dal path, non dalla versione del token né dal `file_id`. Unicità (`PATH_COLLISION`), ricerca per prefisso e deduplica sul server restano identiche, anche in un vault misto `enc1`/`enc2`.

**Lettura (tutti i client).** `DecryptPathFor(sub, vault_id, file_id, token)` in Go e `decryptPathFor(...)` in TS accettano `enc1` (controllato sul vault) ed `enc2` (controllato su vault e file). `DecryptPath` senza `file_id` resta e legge solo `enc1`. Il motore di sync passa sempre il `file_id` della change o della voce del tree; l'export ZIP passa il `file_id` della voce del manifest.

**Scrittura.** Il client scrive `enc2` solo se:

- il flag del Config Profile `features.path_v2` è acceso (**spento per default** nel rilascio N), oppure
- il vault è annotato come già passato a `enc2` su questo dispositivo (pin di vault, sotto).

Altrimenti scrive `enc1`, che ogni client sa leggere.

**Pinning** (trust on first use, come ADR-0034; solo client desktop e core WASM, che hanno `sync.db`):

- **pin di vault** `path_v2:<id cloud>` in `sync_meta`: si accende quando il motore decifra un token `enc2` di quel vault o quando il server accetta un `enc2` scritto da questo dispositivo. Da quel momento i nuovi token restano `enc2` anche a flag spento: un vault non torna mai a `enc1`. L'id cloud è nella chiave, così una cartella ricollegata a un altro vault non eredita il pin.
- **pin di file** `path_v2_file:<file_id>`: si accende alle stesse condizioni, per quel file. Da quel momento un token `enc1` per quel file è rifiutato (`ErrPathDowngrade`) e la change finisce in quarantena (ADR-0039), senza toccare il file locale. Un file mai visto in `enc2` continua ad accettare `enc1`, che usa legittimamente finché non viene spostato.

Il pin di file non produce falsi positivi tra client del rilascio N: per scrivere il path di un file (move, revive) un client deve averne l'ultima revisione (`base_rev`), quindi ha già decifrato il suo `enc2`, ha acceso il pin di vault e scrive `enc2`. Un client anteriore al rilascio N non sa decifrare `enc2`: mette la change in quarantena e non scrive mai quel file.

**Migrazione in due rilasci** (stesso schema di ADR-0034):

1. **Rilascio N (questo):** tutti i client leggono `enc1` ed `enc2`. Si scrive ancora `enc1`, salvo con `features.path_v2` acceso o vault annotato. Il pinning è attivo.
2. **Rilascio N+1:**
   - `features.path_v2` diventa acceso per default;
   - migrazione dei token rimasti `enc1`: il client, a vault sbloccato, riscrive in `enc2` il path dei file che ne hanno ancora uno `enc1` (un move verso lo stesso path, stesso `hmac1`), in lotti e in background;
   - quando un tree completo non contiene più token `enc1`, il client accende un **pin forte** di vault e da lì rifiuta qualunque `enc1`.

**Server.** Oggi `resolvePath` (`services/cloud/internal/sync/service.go`) accetta solo token che iniziano con `enc1:`. Deve accettare anche `enc2:`, con gli stessi controlli di forma (lunghezza, alfabeto base64url, niente separatori). Nessuna migrazione dello schema: `path` è già `TEXT`. Questa modifica server è un **prerequisito** per accendere `features.path_v2`: con il server attuale un commit `enc2` è rifiutato con `PATH_INVALID` e il file resta parcheggiato con l'errore, senza perdita di dati. `syncproto.IsOpaquePath` (oggi usato solo da `Op.Validate` nei test) va allineato allo stesso modo. Per il rilascio N+1 il server deve anche accettare un move il cui `path_key` resta quello del file stesso.

**Test vector.**

- `shared/conformance/crypto/vectors.json`: nuova sezione `paths_v2` (vault, file, path, nonce, AAD in esadecimale, token, `hmac1`), con lo stesso path cifrato per due `file_id` diversi.
- `negative-vectors.json`, sezione `paths` (campo opzionale `file_id`): token `enc2` alterato, di un altro file (`file_id` scambiato), di un altro vault, `enc2` rietichettato `enc1` (downgrade), `enc1` rietichettato `enc2` (upgrade forgiato), `enc2` troncato e non base64url, prefisso sconosciuto `enc3:`.
- Go (`shared/go/vaultcrypto`) e TS (`packages/vaultcrypto-web`) li verificano entrambi; il motore di sync ha test con cifratura reale per scambio, downgrade e scrittura governata dal flag (`apps/desktop/internal/sync/pathv2_test.go`).

## Alternative considerate

- **Documentare il limite e non cambiare formato** — scartata come stato finale: il costo è piccolo (un prefisso, 32 byte di AAD) e chiude l'unico dato cifrato non legato al file. Resta la situazione dei vault non migrati durante il rilascio N, documentata in `crypto-design.md` §8.
- **Mettere il `file_id` nell'AAD di `enc1` senza cambiare prefisso** — scartata: i token esistenti non si aprirebbero più (lockout, contrario a D-02), e senza versione esplicita il client dovrebbe provare entrambe le AAD a ogni lettura.
- **Una sottochiave nuova per `enc2`** (`memobrain/v2/path-enc`) — non necessaria: la separazione tra le versioni è data dall'AAD, e una chiave in più va derivata, testata e cancellata su ogni client.
- **Pin solo di vault, che rifiuta ogni `enc1` dopo il primo `enc2`** — scartata per il rilascio N: in un vault misto i file mai spostati hanno legittimamente `enc1` e finirebbero in quarantena. Diventa il pin forte del rilascio N+1, dopo la migrazione.
- **Legare anche `hmac1` al `file_id`** — scartata: la chiave di unicità deve essere uguale per due file con lo stesso path, altrimenti il server non potrebbe più rilevare `PATH_COLLISION`.
- **Scrivere `enc2` subito** — scartata: i dispositivi non aggiornati non leggerebbero più i file nuovi o spostati, e il server attuale rifiuta il prefisso.

## Conseguenze

- Uno scambio di token di path tra file dello stesso vault viene rilevato per ogni file `enc2`: decifratura fallita, change in quarantena, file locale intatto. Durante il rilascio N restano esposti i file che hanno ancora `enc1` e che il dispositivo non ha mai visto in `enc2`, e l'export ZIP del browser (senza stato persistente) per i file `enc1`.
- La cronologia del desktop (`Manager.History`, `apps/desktop/internal/sync/manager_ops.go`) usa ancora `DecryptPath` senza `file_id`: per una revisione con token `enc2` il path apparirebbe vuoto. Va passata a `DecryptFilePath(row.FileID, r.Path)` prima di accendere il flag.
- Il flag `features.path_v2` va collegato in `apps/desktop/internal/app` (accanto a `features.envelope_v2`, con `sync.Manager.SetPathV2`), documentato nella guida admin ed elencato nelle due copie dello schema del Config Profile.
- Il server va aggiornato come descritto sopra prima di accendere il flag.
- Da aggiornare nello spec: §3.8.3, riga del path cifrato (`enc2:` con AAD `"memobrain/v2/path" ‖ vault_id ‖ file_id`, `enc1:` accettato in lettura); §3.8.5 (il server accetta i due prefissi); §3.8.7 (vettori `paths_v2` e negativi, regola del pinning).

## Esito

Stato dell'implementazione al 2026-11-01: **rilascio N completato lato client**, in attesa della modifica server. Lo stato resta «proposta» finché l'owner non accetta l'ADR e aggiorna lo spec.

- **Libreria Go** (`shared/go/vaultcrypto/path.go`): `EncryptPathV2`/`EncryptPathV2WithNonce`, `DecryptPathFor`, `PathAADV2`, `PathTokenVersion`, `PathEncPrefixV2`. `EncryptPath` (enc1) resta lo scrittore di default; `DecryptPath` legge solo `enc1`.
- **Libreria TS** (`packages/vaultcrypto-web/src/path.ts`): `encryptPathV2`, `decryptPathFor`, `pathAadV2`, `pathTokenVersion`, `PATH_ENC_PREFIX_V2`. L'export ZIP decifra i path con `decryptPathFor` e il `file_id` della voce; l'API esistente non cambia (nessuna modifica a `web/src/export`).
- **Client desktop e core WASM**: `sync.Cipher` espone `PathV2()`, `EncryptPath(fileID, path, v2)` e `DecryptFilePath(fileID, token)`; il motore applica pin e scelta del formato (`pull.go`, `push.go`); `crypto.Manager.SetPathV2` e `sync.Manager.SetPathV2` ricevono il flag.
- **Prima di scrivere un token** il client applica anche la regola completa dei nomi riservati di Windows (`pathrules.NormalizePortable`), perché per i vault privati il server non può controllare i nomi.
