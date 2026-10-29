# Design crittografico dei vault privati: pacchetto per la revisione esterna

Stato: preparazione all'audit esterno (M7-WP2). **Non è stato eseguito alcun audit o penetration test**: questo documento e i test collegati servono a metterne un terzo nelle condizioni di farlo in tempi brevi. Riferimenti normativi interni: `Specifications.md` §3.8 (D-02), ADR-0011, ADR-0012.

Ogni affermazione è verificata sul codice; i percorsi sono relativi alla radice del repository.

## 1. Perimetro e risorse da proteggere

| Risorsa                                            | Dove vive                                            | Protezione                                            |
| -------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| Contenuto dei file di un vault privato             | Blob su S3, sul client in chiaro                     | AES-256-GCM a chunk (`shared/go/vaultcrypto/blob.go`) |
| Path dei file                                      | Colonne `files.path`, `file_revisions.path`          | `enc1:` AES-256-GCM; unicità via `hmac1:` (`path.go`) |
| VMK (Vault Master Key, 256 bit)                    | Mai sul server in chiaro; keychain del SO sui client | Avvolta in due envelope (`vault_key_envelopes`)       |
| Passphrase e recovery key                          | Solo nella testa/nei supporti dell'utente            | Mai trasmesse; solo KEK derivate localmente           |
| Metadati (nome vault, dimensioni, conteggi, tempi) | Database del server                                  | **Non protetti** (§6)                                 |

Fuori perimetro della crittografia: vault condivisi (non E2EE, D-02), cifratura a riposo del disco del dispositivo (§3.8.6 dello spec), autenticazione OIDC.

## 2. Confini di fiducia

```text
 Dispositivo utente (fidato)      |  Rete (TLS)  |  Server cloud + PG + S3 (non fidato per il contenuto)
 passphrase, recovery key, VMK,   |              |  vede: ciphertext, path_enc, path_key, envelope,
 plaintext, indici locali         |              |  dimensioni, tempi, id utente/dispositivo
                                  |              |
 Browser (Web UI)  — fidato solo nella misura in cui lo è il JavaScript servito dal server stesso
```

- Il server è autorità per ordine delle modifiche, quote e ACL; **non interpreta mai** il contenuto (il merge è sul client). Un server compromesso può rifiutare il servizio, ritardare, cancellare o riproporre revisioni vecchie, ma non leggere né alterare in modo non rilevabile i contenuti di un vault privato.
- Un server malevolo può servire JavaScript alterato alla Web UI e ottenere passphrase/VMK in quel browser. Il client desktop firmato (M7-WP3) è il livello di fiducia massimo.

## 3. Modello di minaccia (§3.8.1 dello spec, riformulato)

|                 |                                                                                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protegge da     | Lettura di contenuti e path da parte di amministratori, operatori, leak del database o del bucket, compromissione del server.                                                                                                                                    |
| Non protegge da | Compromissione del dispositivo; metadati osservabili dal server; server che serve JS alterato alla Web UI; attacco offline alla passphrase da chi ottenga database **e** un token dell'owner (l'envelope passphrase sta sul server: trade-off dichiarato, O-03). |
| Fuori ambito    | Condivisione di vault cifrati (rifiutata con `VAULT_ENCRYPTED`, anche da trigger DB `shares_vault_kind_chk`, migrazione `0004`); rotazione della VMK (post-1.0).                                                                                                 |

Avversari considerati: (A1) amministratore o operatore curioso, (A2) chi esfiltra DB e bucket, (A3) server attivamente malevolo (sostituzione, riordino, troncamento, replay di blob), (A4) attaccante di rete oltre TLS (coperto da TLS e dall'AEAD), (A5) attaccante con il solo token dell'owner (può scaricare gli envelope: attacco offline alla passphrase, mitigato da Argon2id).

## 4. Gerarchia delle chiavi

```text
passphrase ──Argon2id(t,m,p,salt)──► KEK_pass ─┐
                                               ├─ AES-256-GCM unwrap ─► VMK (256 bit CSPRNG, una per vault)
recovery key ──HKDF-SHA256(salt)───► KEK_rec  ─┘                          │
                                                                          ├─ HKDF("memobrain/v1/path-enc") → K_path_enc
                                                                          ├─ HKDF("memobrain/v1/path-key") → K_path_key
                                                                          └─ HKDF("memobrain/v1/file" ‖ file_id ‖ salt_file) → K_file
```

Implementazione: `shared/go/vaultcrypto/keys.go` (Go), `packages/vaultcrypto-web/src/keys.ts` (TypeScript). Le etichette HKDF sono costanti con prefisso di versione (`memobrain/v1/…`) per la separazione di dominio. HKDF-SHA256 senza salt per le sottochiavi: la VMK è già uniforme a 256 bit.

- **Envelope** (`wrap`): `nonce(12) ‖ AES-256-GCM(KEK, VMK) ‖ tag(16)` = 60 byte (`WrappedVMKSize` lato server). Nonce casuale: ogni KEK avvolge un solo valore, il rischio di collisione è trascurabile. Nessun AAD: l'envelope non è legato al `vault_id` (nota per il revisore, §9).
- **Recovery key**: 256 bit CSPRNG; testo = Base32 (alfabeto RFC 4648) in gruppi da 5 con checksum SHA-256 troncato a 16 bit (`"memobrain/v1/recovery-checksum" ‖ chiave`). Il checksum rileva refusi, non è un controllo di sicurezza. KEK_rec = HKDF(recovery key, salt dell'envelope): nessuno stretching, la chiave ha già piena entropia.
- **Passphrase**: minimo 12 caratteri e zxcvbn ≥ 3, imposti dal client desktop (`packages/workbench/src/sync/strength.ts`); il server non può verificarli.
- **Cache locale della VMK**: keychain del sistema operativo (`apps/desktop/internal/crypto/keystore.go`); la Web UI non la persiste.
- **Cambio passphrase / recovery key**: nuovo envelope della stessa VMK, nessuna ri-cifratura dei dati. Dopo un cambio, i vecchi envelope scaricati prima restano validi per chi conosceva la vecchia passphrase: senza rotazione della VMK una passphrase compromessa resta utile contro ciò che l'attaccante ha già copiato (§6).

## 5. Formati

### 5.1 Blob `NDS1` (§3.8.3)

```text
header : "NDS1" | versione (1 B) | salt_file (16 B) | chunk_size (4 B big endian)      = 25 B
corpo  : chunk_0 ‖ … ‖ chunk_n        ogni chunk = ciphertext ‖ tag GCM (16 B)
nonce  : 96 bit, contatore big endian = indice del chunk
AAD    : vault_id (16) ‖ file_id (16) ‖ indice (8, big endian) ‖ flag "ultimo chunk" (1)
```

- `chunk_size` ∈ [1, 16 MiB]; ogni chunk salvo l'ultimo ha esattamente `chunk_size` byte, l'ultimo ne ha 1..`chunk_size` (file vuoto = un chunk vuoto). Il cifratore legge un chunk in anticipo per sapere quale è l'ultimo (`blob.go`).
- Una nuova `salt_file` casuale per ogni cifratura produce una nuova `K_file`: i nonce a contatore non si ripetono mai sotto la stessa chiave.
- L'AAD lega il chunk a vault, file, posizione e fine-file: scambio tra file o vault, riordino, duplicazione, troncamento al confine di chunk e aggiunta di chunk sono rilevati. L'header non è autenticato direttamente: `salt_file` altera `K_file` (decifratura fallisce), `chunk_size` altera il parsing (fallisce), `versione` ≠ 1 è rifiutata.
- `blob_hash` = SHA-256 del blob **cifrato** (integrità del trasferimento, non del contenuto). Il server accetta un blob per un vault solo se lo ha caricato quel vault (`vault_blobs`), così `blobs:check` non rivela cosa conservano altri.

### 5.2 Path (§3.8.3)

- `path_enc` = `"enc1:" + base64url(nonce(12) ‖ AES-256-GCM(K_path_enc, path NFC; AAD = vault_id))`, nonce casuale.
- `path_key` = `"hmac1:" + hex(HMAC-SHA256(K_path_key, NFC + casefold(path)))`, deterministico, usato dal server per l'unicità (`PATH_COLLISION`) senza conoscere il path. Rivela l'uguaglianza di due path (es. lo stesso path nelle revisioni successive) ma non il contenuto.
- Con nonce casuali a 96 bit e una sola `K_path_enc` per vault, il limite di sicurezza di AES-GCM (≈ 2^32 cifrature) è molto sopra il numero di path realistico per vault; è un limite noto, non una vulnerabilità pratica.

## 6. Parametri e minimi

| Parametro                     | Valore                                                                                                                                                                   | Dove è imposto                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Argon2id minimo               | t=3, m=64 MiB, p=4                                                                                                                                                       | Go: `keys.go` (`MinT`, `MinMKiB`, `MinP`); TS: `keys.ts`; server: `vaults.ValidateEnvelope` (`services/cloud/internal/vaults/service.go`) |
| Argon2id massimo              | t=12, m=1 GiB, p=16                                                                                                                                                      | idem (protegge il client da envelope ostili che causerebbero DoS)                                                                         |
| Calibrazione                  | memoria raddoppiata fino a ≈ tempo-bersaglio, mai oltre 512 MiB (`CalibratePassphraseKDF`)                                                                               | salvata nell'envelope, usata da ogni dispositivo                                                                                          |
| Salt KDF                      | ≥ 8 byte (generati 16)                                                                                                                                                   | client e server                                                                                                                           |
| `WeakKdfError` / `ErrWeakKDF` | un envelope con parametri sotto il minimo o sopra il massimo, algoritmo diverso o salt non valido **non viene derivato**: un server ostile non può declassare l'Argon2id | `DeriveKEKPassphrase` (Go), `deriveKekPassphrase` (TS)                                                                                    |
| Chunk                         | default 64 KiB, max 16 MiB                                                                                                                                               | `blob.go`, `blob.ts`                                                                                                                      |

I minimi di Argon2id sono quelli dello spec (t=3, m=64 MiB, p=4); la scelta di parametri più alti è del dispositivo che crea il vault. Non esiste una politica server per alzare i minimi sui vault esistenti.

## 7. Cosa vede e non vede il server

| Vede                                                                                                                             | Non vede                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Ciphertext e relativo SHA-256, dimensioni del ciphertext (≈ plaintext + 16 B/chunk + 25 B)                                       | Contenuto dei file, VMK, passphrase, recovery key, K_*            |
| `path_enc` (opaco), `path_key` (uguaglianza di path)                                                                             | Path in chiaro, struttura delle cartelle, estensioni              |
| Envelope (KDF, salt, wrapped VMK)                                                                                                | KEK                                                               |
| Nome del vault, `kind`, numero di file, byte totali, timestamp, sequenza e frequenza delle modifiche, dispositivi, utente autore | Quali file sono cambiati nel merge, diff, contenuto dello storico |

Un vault privato non è condivisibile: `POST /shares` risponde `409 VAULT_ENCRYPTED` e il trigger `shares_vault_kind_chk` lo vieta anche a livello di database; export ZIP, ricerca e diff si fanno sul client (browser con WebCrypto, `packages/vaultcrypto-web/src/export.ts`, o desktop).

## 8. Limiti noti (accettati o rinviati)

1. **Nessuna rotazione della VMK** (post-1.0): chi ha conosciuto la passphrase e ha copiato envelope e ciphertext può decifrare tutto ciò che ha copiato anche dopo un cambio passphrase. Non c'è forward secrecy per i ciphertext passati se la passphrase viene compromessa.
2. **Attacco offline alla passphrase** con database + token owner (envelope sul server): mitigato da Argon2id e dalla policy di robustezza lato client, non eliminato.
3. **Metadati**: dimensioni (anche per file), numero di file, timing e frequenza delle modifiche, `path_key` deterministico, elenco dispositivi, nome del vault.
4. **Web UI**: la decifratura nel browser si fida del JavaScript servito. CSP e SRI (`docs/security/pentest-scope.md`, test in `services/cloud/web-embed/security_test.go` e `web/e2e-security`) riducono la superficie ma non proteggono da un server che cambia anche l'`index.html`.
5. **Dati locali in chiaro** sul dispositivo (`index.db`, copia del vault): demandati alla cifratura del disco.
6. **Rollback/ritardo di revisioni**: un server malevolo può nascondere revisioni recenti o riproporne di vecchie (ogni blob è autentico ma l'_ordine_ e la completezza non sono firmati). Non esiste un registro di trasparenza.
7. **Envelope senza AAD** (non legati a `vault_id`): un server può scambiare gli envelope di due vault dello stesso utente; la decifratura fallisce o cede la VMK dell'altro vault, mai dati di terzi. Valutare di legare `vault_id` nell'AAD in una v2.
8. **Troncamento in chiaro del file intero**: non rilevabile da chi non conosce lo stato precedente (stesso punto del rollback).
9. **Cifratura dei metadati dei commit** (`op`, `base_rev`, `kind`): in chiaro per necessità del protocollo (ordinamento e concorrenza ottimistica).

## 9. Come Go e TypeScript restano uguali

- **Vettori di conformità positivi**: `shared/conformance/crypto/vectors.json`, generati dal codice Go (`UPDATE_VECTORS=1 go test ./vaultcrypto/` in `shared/go`) e verificati da `shared/go/vaultcrypto/vaultcrypto_test.go` (`TestVectors`) e da `packages/vaultcrypto-web/src/vectors.test.ts`: KEK da passphrase (Argon2id) e da recovery key, wrap, sottochiavi, blob (vuoto, parziale, esatto, due chunk, chunk di default), path.
- **Vettori negativi** (nuovi): `shared/conformance/crypto/negative-vectors.json`, generati dal Go (`TestNegativeVectors`, stesso `UPDATE_VECTORS=1`) e verificati in Go e in TS (`packages/vaultcrypto-web/src/negative.test.ts`). Coprono tag alterato (primo e ultimo chunk), ciphertext e salt alterati, `chunk_size` alterato, troncamento al confine di chunk e dentro un tag, primo chunk rimosso, chunk riordinati/duplicati/aggiunti, dati in coda, magic/versione/chunk size non validi (zero, oltre il massimo), AAD sbagliata (vault, file), VMK sbagliata, token di path alterati/di altro vault/prefisso errato/base64 invalido, envelope alterati, KEK sbagliata, lunghezza errata, 10 casi di KDF fuori range, 5 recovery key malformate.
  Ogni vettore dichiara la classe di errore (`decrypt`, `format`) oppure `any` dove le due implementazioni rifiutano ma classificano diversamente (dati in coda più corti di un tag: in TS è errore di formato, in Go è errore di autenticazione perché il chunk precedente viene autenticato per primo). **Entrambe rifiutano sempre.**
- **CI** (`.github/workflows/security.yml`, job `crypto-vectors`): rigenera i vettori e fallisce se il file committato cambia; esegue i test Go e TS.
- **Rigenerare**: `cd shared/go && UPDATE_VECTORS=1 go test -run 'TestVectors|TestNegativeVectors' ./vaultcrypto/`, poi eseguire i test TS e committare i JSON. Un cambio dei vettori positivi è un cambio di formato e richiede una nuova versione (`NDS2`).

## 10. Checklist per il revisore

- [ ] Ogni chiave ha un solo uso e una etichetta HKDF distinta (`keys.go` righe `info*`). Nessuna chiave deriva da un'altra di livello inferiore.
- [ ] Nessun riuso di nonce: blob (nuova salt → nuova `K_file` per cifratura; contatore per chunk), path (nonce casuale, una chiave), wrap (nonce casuale, KEK per valore unico).
- [ ] L'AAD del blob copre vault, file, indice e ultimo chunk; confrontare con i casi di `negative-vectors.json`.
- [ ] Gestione errori: nessuna differenza osservabile utile tra tag sbagliato e chiave sbagliata (`ErrDecrypt`); l'output parziale della decifratura in streaming viene scartato dal chiamante (commento in `DecryptBlob`): verificare i chiamanti in `apps/desktop/internal/sync` e `packages/vaultcrypto-web/src/export.ts`.
- [ ] Bound e minimi dei parametri Argon2id (client e server identici) e comportamento di `DeriveKEKPassphrase` con envelope ostili.
- [ ] Confronti in tempo costante: checksum della recovery key (non segreto), tag GCM (libreria). Nessun confronto di segreti con `==` su stringhe.
- [ ] Origine dell'entropia: `crypto/rand` (Go), `crypto.getRandomValues` (browser, `bytes.ts`).
- [ ] Gestione della VMK in memoria e su disco: keychain del SO (desktop), nessuna persistenza in `localStorage`/IndexedDB nella Web UI (`packages/vaultcrypto-web`, `web/src/export`).
- [ ] Argon2id in WASM (`hash-wasm`): versione bloccata in `yarn.lock`, richiede `'wasm-unsafe-eval'` nella CSP, nessun `unsafe-eval`.
- [ ] Il server non ha percorsi che restituiscano o registrino envelope, path o contenuto in chiaro (log, audit, metriche): grep di `wrapped_vmk` e `kdf` in `services/cloud/internal`.
- [ ] Limiti di §8: confermare che siano accettabili per la 1.0 e come documentati all'utente.
