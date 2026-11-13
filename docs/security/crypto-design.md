# Design crittografico dei vault privati: pacchetto per la revisione esterna

Stato: preparazione all'audit esterno (M7-WP2). **Non è stato eseguito alcun audit o penetration test**: questo documento e i test collegati servono a metterne un terzo nelle condizioni di farlo in tempi brevi. Riferimenti normativi interni: `Specifications.md` §3.8 (D-02), ADR-0011, ADR-0012.

Ogni affermazione è verificata sul codice; i percorsi sono relativi alla radice del repository. Aggiornato il 2026-11-01 con l'envelope v2 (ADR-0034, rilascio N), la normalizzazione NFC della passphrase, i token di path `enc2` legati al file (ADR-0042, rilascio N), l'igiene delle chiavi in memoria e il tetto della calibrazione di Argon2id; il 2026-11-02 con il rilascio N+1 dei due ADR (formati v2 accesi per default, migrazione dei token `enc1` e pin forte); il 2026-11-03 con la politica della passphrase applicata dal core (ADR-0045 §8).

## 1. Perimetro e risorse da proteggere

| Risorsa                                            | Dove vive                                            | Protezione                                                    |
| -------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| Contenuto dei file di un vault privato             | Blob su S3, sul client in chiaro                     | AES-256-GCM a chunk (`shared/go/vaultcrypto/blob.go`)         |
| Path dei file                                      | Colonne `files.path`, `file_revisions.path`          | `enc1:`/`enc2:` AES-256-GCM; unicità via `hmac1:` (`path.go`) |
| VMK (Vault Master Key, 256 bit)                    | Mai sul server in chiaro; keychain del SO sui client | Avvolta in due envelope (`vault_key_envelopes`)               |
| Passphrase e recovery key                          | Solo nella testa/nei supporti dell'utente            | Mai trasmesse; solo KEK derivate localmente                   |
| Metadati (nome vault, dimensioni, conteggi, tempi) | Database del server                                  | **Non protetti** (§6)                                         |

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

Implementazione: `shared/go/vaultcrypto/keys.go` (Go), `packages/vaultcrypto-web/src/keys.ts` (TypeScript). Le etichette HKDF sono costanti con prefisso di versione (`clarae/v1/…`) per la separazione di dominio. HKDF-SHA256 senza salt per le sottochiavi: la VMK è già uniforme a 256 bit.

- **Envelope**: due formati, descritti in §5.3. Il v1 è `nonce(12) ‖ AES-256-GCM(KEK, VMK) ‖ tag(16)` = 60 byte, senza AAD. Il v2 (ADR-0034) è `0x02 ‖ nonce(12) ‖ AES-256-GCM(KEK, VMK; AAD) ‖ tag(16)` = 61 byte, legato a `vault_id` e al tipo di envelope. Nonce casuale: ogni KEK avvolge un solo valore (la VMK), il rischio di collisione è trascurabile.
- **Recovery key**: 256 bit CSPRNG; testo = Base32 (alfabeto RFC 4648) in gruppi da 5 con checksum SHA-256 troncato a 16 bit (`"memobrain/v1/recovery-checksum" ‖ chiave`). Il checksum rileva refusi, non è un controllo di sicurezza. KEK_rec = HKDF(recovery key, salt dell'envelope): nessuno stretching, la chiave ha già piena entropia.
- **Passphrase**: minimo 12 caratteri e zxcvbn ≥ 3 (§3.8.2), imposti dal **core Go** a ogni passphrase nuova (sotto); il server non può verificarli. Prima di Argon2id la passphrase si normalizza in Unicode **NFC** (§5.4), così la stessa passphrase digitata con caratteri composti o scomposti (tastiere e sistemi operativi diversi) deriva la stessa KEK.
- **Cache locale della VMK**: keychain del sistema operativo (`apps/desktop/internal/crypto/keystore.go`); la Web UI non la persiste.
- **Igiene delle chiavi in memoria** (best effort):
  - un vault sbloccato tiene un solo `*Subkeys` (`apps/desktop/internal/crypto/manager.go`), che contiene l'unica copia di lunga durata della VMK; le sottochiavi si passano per puntatore, non più per valore;
  - al blocco (manuale, per inattività o allo scollegamento) `Subkeys.Wipe` azzera `K_path_enc`, `K_path_key` e la VMK. Un `RWMutex` per vault fa sì che il blocco aspetti le operazioni in corso; un'operazione che parte dopo riceve `ErrLocked`. Le funzioni di `vaultcrypto` rifiutano sottochiavi azzerate (`ErrWiped`): nulla viene mai cifrato con una chiave a zero;
  - la libreria azzera i propri buffer intermedi appena copiati (uscite di Argon2id e HKDF, `K_file`, VMK decifrata); il gestore delle chiavi azzera KEK e copie della VMK dopo wrap, unwrap e verifica; `Material.Wipe` azzera il materiale di creazione;
  - **limiti di Go**: il runtime può aver già copiato un array (passaggio per valore, crescita dello stack, spostamenti del garbage collector); lo schedule AES dentro `crypto/cipher`, le stringhe immutabili (passphrase, VMK in base64 verso il keychain) e la memoria lineare del WASM non si possono azzerare. Lo scopo è avere meno copie vive per meno tempo, non una garanzia (§8).
- **Dove si applica la politica della passphrase** (ADR-0045 §8). `crypto.ValidatePassphrase` (`apps/desktop/internal/crypto/policy.go`) è il controllo, nel core, di ogni binding che imposta una passphrase nuova: creazione di un vault privato (`SyncAPI.LinkNew` → `sync.Manager.Link`, poi `crypto.Manager.NewMaterial`), cambio di passphrase (`VaultCryptoAPI.ChangePassphrase`) e passphrase nuova dopo la recovery key (`VaultCryptoAPI.SetPassphrase`, anche dal gate di sblocco del web), tutti con un secondo controllo in `crypto.Manager.NewPassphraseEnvelope`. Sono gli unici punti che avvolgono la VMK sotto una passphrase scelta dall'utente; il browser non crea envelope (`packages/vaultcrypto-web` li apre soltanto, per lo ZIP). Il controllo avviene prima della rete e prima della verifica della vecchia passphrase; il rifiuto è l'errore tipizzato `weak-passphrase: <motivo>: <testo>` con motivo `too-short` o `guessable`, che il workbench traduce (`errorMessage`, chiavi `errors.weak-passphrase_<motivo>`) e il gate DOM del web pure (`gateErrorText`). La regola, sulla forma NFC:
  - almeno 12 code point (`MinPassphraseLength`); una stringa UTF-8 non valida è rifiutata come troppo corta;
  - punteggio zxcvbn ≥ 3 (`MinPassphraseScore`), stimato sui primi 64 code point (`MaxEstimatedLength`; `strength.ts` legge lo stesso prefisso): il confronto con i dizionari è quadratico nei byte, e 256 caratteri CJK o emoji costavano secondi già in nativo, 64 restano sotto i 30 ms; una passphrase i cui primi 64 caratteri sono deboli è debole. Lo stimatore Go è `github.com/trustelem/zxcvbn` v1.0.1 (MIT, Go puro, compila per `js/wasm`), un port completo di zxcvbn 4.4.2: lo stesso algoritmo basato sui tentativi di `@zxcvbn-ts`, con dizionari leggermente diversi. Il port `ccojocar/zxcvbn-go`, più aggiornato, è stato scartato perché usa il punteggio del vecchio zxcvbn (tempi di attacco, soglia del 3 circa cento volte più alta) e rifiuterebbe passphrase che la UI accetta. Su una passphrase al limite i due lati possono quindi dare 2 e 3; i casi su cui devono concordare stanno in `shared/conformance/passphrase/policy.json`, eseguito sia dai test Go (`policy_test.go`) sia da quelli TS (`strength.test.ts`). Divergenza nota: le ripetizioni con separatori (`dragon-dragon`) valgono 3 per il port Go e 0 per `@zxcvbn-ts`, quindi la UI resta più severa del core in quei casi;
  - costo nel core WebAssembly: circa +0,8 MB gzip (dizionari e `dlclark/regexp2`), circa 35 ms e 10 MB di heap all'avvio del worker per costruire i dizionari ordinati.

  React (`PassphraseFields`) e il gate DOM tengono il riscontro immediato con `@zxcvbn-ts` (`strength.ts`, ora anch'esso sulla forma NFC) ma non sono più l'unica difesa. **La politica vale solo per le passphrase nuove**: sbloccare, verificare la vecchia passphrase, rigenerare la recovery key e riavvolgere in v2 l'envelope aperto non la controllano, quindi un vault creato con una regola più debole (solo lunghezza, fino alla 1.3) resta apribile; al primo cambio la passphrase nuova deve rispettarla (`TestPolicyIsNotAppliedToExistingPassphrases`).

- **Cambio passphrase / recovery key**: nuovo envelope della stessa VMK, nessuna ri-cifratura dei dati. Il formato del nuovo envelope segue le regole di migrazione di §5.3. Dopo un cambio, i vecchi envelope scaricati prima restano validi per chi conosceva la vecchia passphrase: senza rotazione della VMK una passphrase compromessa resta utile contro ciò che l'attaccante ha già copiato (§6).

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

**Token `enc2` legati al file (ADR-0042).** `enc1` lega il path solo al vault: un server malevolo potrebbe associare al file X il token del file Y dello stesso vault. Il formato `enc2` lega il token anche al file:

```text
enc2 : "enc2:" + base64url(nonce (12) ‖ AES-256-GCM(K_path_enc, path NFC; AAD) ‖ tag (16))
AAD  : "memobrain/v2/path" (17 B ASCII) ‖ vault_id (16 B) ‖ file_id (16 B)
```

- Stessa chiave e stesso nonce casuale di `enc1`; le due AAD differiscono per lunghezza e prefisso, quindi un token rietichettato da una versione all'altra non si apre. `path_key` (`hmac1`) non cambia: unicità e `PATH_COLLISION` restano identiche in un vault misto.
- **Lettura**: `DecryptPathFor(sub, vault_id, file_id, token)` in Go e `decryptPathFor` in TS accettano i due formati; il motore di sync e l'export ZIP passano il `file_id` della change o della voce del manifest. Un `enc2` di un altro file o vault è `ErrDecrypt`/`DecryptError`: la change va in quarantena e il file locale non viene toccato.
- **Prima di cifrare** un path il client applica la regola completa dei nomi riservati di Windows (`pathrules.NormalizePortable`), che per i vault privati il server non può controllare.
- **Pinning** (client desktop e core WASM): `path_v2:<id cloud>` in `sync.db` annota che il vault ha token `enc2` (visti o scritti e accettati) e da lì i nuovi token restano `enc2`; `path_v2_file:<file_id>` annota il singolo file e da lì un suo token `enc1` è rifiutato (`ErrPathDowngrade`, quarantena); `path_v2_strong:<id cloud>` (pin forte, sotto) fa rifiutare ogni token `enc1` del vault.
- **Stato della migrazione: rilascio N+1 (2026-11-02).**
  - Tutti i client leggono `enc1` ed `enc2`; il server accetta i due prefissi (`resolvePath`).
  - Si scrive `enc2` per default: `features.path_v2` è acceso nello schema del Config Profile. Un amministratore può spegnerlo; un vault annotato continua comunque a scrivere `enc2`.
  - **Migrazione dei token rimasti `enc1`** (`apps/desktop/internal/sync/pathmigrate.go`), solo con il flag acceso e il vault sbloccato. Il client riscrive il token come `enc2` con un `move` verso lo stesso path: stesso `hmac1`, `base_rev` del file, contenuto invariato. Il server accetta un move sul `path_key` del file stesso (`move` in `services/cloud/internal/sync/ops.go`, test `TestPrivateVaultAcceptsEnc2PathTokens`).
  - La migrazione gira solo alla fine di un ciclo di sync che non ha trovato altro da fare: un lotto per ciclo (100 file), almeno 15 s tra due lotti, 30 s al massimo per lotto. Tocca solo i file sincronizzati alla revisione dell'albero, senza modifiche locali, candidati al merge o errori, e il cui path decifrato coincide con quello locale. Un conflitto lascia il file a un passaggio successivo, e un errore non fa mai fallire il ciclo.
  - Il progresso sta nell'albero del server, più i contatori e l'ora del lotto successivo in `sync.db` (`path_v2_migration:<id cloud>`): dopo un riavvio la migrazione riprende.
  - **Pin forte**: quando un albero completo (`GET /tree`) ha almeno un file e nessun token `enc1`, e il cursore del client ha raggiunto il suo `as_of_seq`, il client annota `path_v2_strong:<id cloud>`. Da lì rifiuta ogni token `enc1` del vault: change in quarantena (ADR-0039), file locale intatto.
  - L'export ZIP del browser, senza stato, continua ad accettare `enc1`.

### 5.3 Envelope della VMK: v1 e v2 (ADR-0034)

```text
v1 : nonce (12) ‖ AES-256-GCM(KEK, VMK) ‖ tag (16)                         = 60 B, nessun AAD
v2 : 0x02 ‖ nonce (12) ‖ AES-256-GCM(KEK, VMK; AAD) ‖ tag (16)              = 61 B
AAD: "memobrain/v2/envelope" (21 B ASCII) ‖ vault_id (16 B) ‖ kind ("passphrase" | "recovery", ASCII)
```

- **Lettura** (`Unwrap(kek, wrapped, vaultID, kind)` in Go, `unwrap(kek, wrapped, vaultId, kind)` in TS): 60 byte → v1; 61 byte con primo byte `0x02` → v2 con AAD obbligatoria; qualunque altra lunghezza o byte di versione → `ErrDecrypt`/`DecryptError`. Un v2 servito per un altro vault o come altro tipo non si apre e appare come passphrase sbagliata. Il downgrade non è possibile: il corpo di un v2 privato del byte di versione non si apre come v1, perché il tag GCM copre l'AAD.
- **Server**: `vaults.ValidateEnvelope` accetta 60 byte, oppure 61 byte che iniziano con `0x02`; non interpreta altro.
- **Pinning** (solo client desktop e core WASM; l'export ZIP del browser non ha stato persistente): dopo aver aperto o caricato un envelope v2 di un certo tipo, il client lo annota in `sync.db` (`envelope_v2:<id cloud>:<kind>`) e da quel momento rifiuta un v1 di quel tipo per quel vault (`ErrEnvelopeDowngrade`). Il pin è per tipo, perché l'envelope di recovery resta v1 finché non si usa la recovery key.
- **Stato della migrazione: rilascio N+1 (2026-11-02).**
  - Tutti i client leggono v1 e v2: desktop, core WASM del workbench web, `vaultcrypto-web` dell'export ZIP.
  - `features.envelope_v2` è acceso per default nello schema del Config Profile; un amministratore può spegnerlo. Con il flag acceso:
    - v2 alla creazione (subito dopo, perché l'id del vault lo assegna il server) e a ogni cambio di passphrase o di recovery key;
    - upgrade a v2 dell'envelope aperto allo sblocco, con la passphrase o con la recovery key;
    - caricamento best effort, solo se l'envelope sul server è ancora quello aperto.
  - Indipendentemente dal flag, un tipo di envelope già v2 non torna mai v1.
  - ADR-0034 non prevede un pin forte: un envelope di recovery mai usato resta v1, e si apre, finché l'utente non usa o non rigenera la recovery key.
  - I desktop fino alla 1.2.4 non aprono un envelope v2 (guida admin, `backup-upgrade.md`).

### 5.4 Normalizzazione della passphrase

- **Scrittura**: `DeriveKEKPassphrase` (Go) e `deriveKekPassphrase` (TS) derivano la KEK dalla forma NFC della passphrase. È la regola di ogni envelope nuovo: creazione, cambio passphrase, nuova passphrase dopo la recovery.
- **Lettura** (`OpenWithPassphrase` / `openWithPassphrase`): si provano in ordine la forma NFC, l'input esatto e la sua forma NFD, senza duplicati (`PassphraseForms` / `passphraseForms`). Gli envelope scritti prima della normalizzazione, dai byte grezzi di un input non NFC, continuano così ad aprirsi, anche da un dispositivo che produce l'altra forma. Una passphrase ASCII costa una sola derivazione; una passphrase sbagliata con caratteri scomponibili ne costa fino a tre.
- **Convergenza**: un envelope aperto solo con una forma legacy viene ri-avvolto sotto la forma NFC, con gli stessi parametri KDF, solo con `features.envelope_v2` acceso (nell'upgrade a v2). Con il flag spento resta com'è, perché un client anteriore a questa versione deve poterlo ancora aprire digitando la stessa forma non NFC.
- **Recovery key**: invariata. Alfabeto Base32 ASCII con checksum: un carattere non ASCII fa fallire il parsing prima di qualsiasi derivazione, quindi non serve normalizzare.
- **Limite**: NFC dipende dalla versione Unicode dell'implementazione (`golang.org/x/text` in Go, il motore JavaScript nel browser). Per i caratteri già assegnati la normalizzazione è stabile; un carattere assegnato solo nelle versioni più recenti potrebbe normalizzarsi in modo diverso tra due client di epoche diverse. È un caso marginale, e il fallback sull'input esatto lo copre quando l'input è identico.

## 6. Parametri e minimi

| Parametro                     | Valore                                                                                                                                                                   | Dove è imposto                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Argon2id minimo               | t=3, m=64 MiB, p=4                                                                                                                                                       | Go: `keys.go` (`MinT`, `MinMKiB`, `MinP`); TS: `keys.ts`; server: `vaults.ValidateEnvelope` (`services/cloud/internal/vaults/service.go`) |
| Argon2id massimo              | t=12, m=1 GiB, p=16                                                                                                                                                      | idem (protegge il client da envelope ostili che causerebbero DoS)                                                                         |
| Calibrazione                  | memoria raddoppiata fino a ≈ tempo-bersaglio, mai oltre 256 MiB (`MaxCalibratedMKiB`, `CalibratePassphraseKDF`)                                                          | salvata nell'envelope, usata da ogni dispositivo                                                                                          |
| Salt KDF                      | ≥ 8 byte (generati 16)                                                                                                                                                   | client e server                                                                                                                           |
| `WeakKdfError` / `ErrWeakKDF` | un envelope con parametri sotto il minimo o sopra il massimo, algoritmo diverso o salt non valido **non viene derivato**: un server ostile non può declassare l'Argon2id | `DeriveKEKPassphrase` (Go), `deriveKekPassphrase` (TS)                                                                                    |
| Chunk                         | default 64 KiB, max 16 MiB                                                                                                                                               | `blob.go`, `blob.ts`                                                                                                                      |

I minimi di Argon2id sono quelli dello spec (t=3, m=64 MiB, p=4); la scelta di parametri più alti è del dispositivo che crea il vault. Non esiste una politica server per alzare i minimi sui vault esistenti.

**Tetto della calibrazione: il client più debole.** I parametri scelti dal dispositivo che crea il vault valgono per tutti i dispositivi che lo aprono. Il più lento è il browser: l'export ZIP della Web UI (`hash-wasm`) esegue le p corsie una dopo l'altra in WebAssembly a thread singolo e alloca m KiB di memoria lineare, mentre Go le esegue in parallelo. Un vault calibrato su un Mac veloce a 512 MiB richiedeva al browser 512 MiB di memoria WASM e una derivazione diverse volte più lenta. Il tetto è ora 256 MiB (`MaxCalibratedMKiB`): con il tempo-bersaglio di 500 ms su un desktop nativo, il browser resta nell'ordine di pochi secondi e di una quantità di memoria disponibile sulle macchine comuni. La calibrazione stessa esegue al più due derivazioni di prova (64 e 128 MiB). Gli envelope esistenti non cambiano: il massimo accettato in lettura resta 1 GiB, quindi quelli calibrati prima fino a 512 MiB continuano ad aprirsi ovunque; un cambio di passphrase li ricalibra sotto il nuovo tetto.

## 7. Cosa vede e non vede il server

| Vede                                                                                                                             | Non vede                                                          |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Ciphertext e relativo SHA-256, dimensioni del ciphertext (≈ plaintext + 16 B/chunk + 25 B)                                       | Contenuto dei file, VMK, passphrase, recovery key, K_*            |
| `path_enc` (opaco), `path_key` (uguaglianza di path)                                                                             | Path in chiaro, struttura delle cartelle, estensioni              |
| Envelope (KDF, salt, wrapped VMK, formato v1/v2)                                                                                 | KEK                                                               |
| Nome del vault, `kind`, numero di file, byte totali, timestamp, sequenza e frequenza delle modifiche, dispositivi, utente autore | Quali file sono cambiati nel merge, diff, contenuto dello storico |

Un vault privato non è condivisibile: `POST /shares` risponde `409 VAULT_ENCRYPTED` e il trigger `shares_vault_kind_chk` lo vieta anche a livello di database; export ZIP, ricerca e diff si fanno sul client (browser con WebCrypto, `packages/vaultcrypto-web/src/export.ts`, o desktop).

## 8. Limiti noti (accettati o rinviati)

1. **Nessuna rotazione della VMK** (post-1.0): chi ha conosciuto la passphrase e ha copiato envelope e ciphertext può decifrare tutto ciò che ha copiato anche dopo un cambio passphrase. Non c'è forward secrecy per i ciphertext passati se la passphrase viene compromessa.
2. **Attacco offline alla passphrase** con database + token owner (envelope sul server): mitigato da Argon2id e dalla policy di robustezza applicata dal core del client (§4), non eliminato; un client modificato può ancora scegliere una passphrase debole, perché il server non la vede.
3. **Metadati**: dimensioni (anche per file), numero di file, timing e frequenza delle modifiche, `path_key` deterministico, elenco dispositivi, nome del vault.
4. **Web UI**: la decifratura nel browser si fida del JavaScript servito. CSP e SRI (`docs/security/pentest-scope.md`, test in `services/cloud/web-embed/security_test.go` e `web/e2e-security`) riducono la superficie ma non proteggono da un server che cambia anche l'`index.html`.
5. **Dati locali in chiaro** sul dispositivo (`index.db`, copia del vault): demandati alla cifratura del disco.
6. **Rollback/ritardo di revisioni**: un server malevolo può nascondere revisioni recenti o riproporne di vecchie (ogni blob è autentico ma l'_ordine_ e la completezza non sono firmati). Non esiste un registro di trasparenza.
7. **Envelope v1 senza AAD durante la migrazione** (ADR-0034). Gli envelope v1, scritti per default fino al rilascio N, non sono legati a `vault_id`: un server può scambiare gli envelope di due vault dello stesso utente. La decifratura fallisce o cede la VMK dell'altro vault, mai dati di terzi. Il formato v2 chiude il problema per i vault migrati; il pinning per tipo impedisce di ripresentare un v1 a un dispositivo che ha già visto il v2. Restano esposti i vault ancora v1 e i dispositivi che non hanno mai visto il v2 (primo sblocco, export ZIP del browser), finché un dispositivo con il flag acceso (il default dal rilascio N+1) non sblocca il vault e carica l'upgrade, o se l'amministratore spegne `features.envelope_v2`. Gli envelope di recovery dei vault mai recuperati restano v1 finché l'utente non usa o non rigenera la recovery key.
8. **Troncamento in chiaro del file intero**: non rilevabile da chi non conosce lo stato precedente (stesso punto del rollback).
9. **Cifratura dei metadati dei commit** (`op`, `base_rev`, `kind`): in chiaro per necessità del protocollo (ordinamento e concorrenza ottimistica).
10. **Token di path `enc1` non legati al file durante la migrazione** (ADR-0042). Un server malevolo può associare a un file il token `enc1` di un altro file dello stesso vault: il client scrive il contenuto del primo al path del secondo. Il formato `enc2` chiude il problema per i file migrati; il pin di file impedisce di ripresentare un `enc1` per un file già visto in `enc2`. Restano esposti i file che hanno ancora `enc1` e che il dispositivo non ha mai visto in `enc2`, finché la migrazione del rilascio N+1 non li riscrive e un albero senza `enc1` non accende il pin forte; i vault che nessun dispositivo con il flag acceso sblocca; l'export ZIP del browser (senza stato persistente) per i file `enc1`. Le revisioni dello storico conservano il token con cui sono state scritte, e un file cancellato prima della migrazione e ripristinato dopo il pin forte torna con il suo ultimo token `enc1`: i dispositivi con il pin forte lo mettono in quarantena (i dati restano sul server). Il danno resta dentro i dati dell'utente: il server non impara nulla.
11. **Cancellazione delle chiavi in memoria solo best effort** (§4): Go non garantisce che una chiave non sia stata copiata prima dell'azzeramento, e lo schedule AES, le stringhe e la memoria del WASM non si possono azzerare. Un dump della memoria di un processo con un vault sbloccato espone comunque le chiavi.

## 9. Come Go e TypeScript restano uguali

- **Vettori di conformità positivi**: `shared/conformance/crypto/vectors.json`, generati dal codice Go (`UPDATE_VECTORS=1 go test ./vaultcrypto/` in `shared/go`) e verificati da `shared/go/vaultcrypto/vaultcrypto_test.go` (`TestVectors`) e da `packages/vaultcrypto-web/src/vectors.test.ts`. Coprono:
  - KEK da passphrase (Argon2id) e da recovery key;
  - wrap v1 e `wrap_v2` (passphrase e recovery, con l'AAD in esadecimale);
  - `passphrase_normalization`: input NFC e NFD con la stessa KEK, KEK grezza dell'input NFD, un envelope legacy v1 aperto da entrambe le forme, un envelope v2 corrente;
  - sottochiavi, blob (vuoto, parziale, esatto, due chunk, chunk di default) e path `enc1`;
  - `paths_v2` (ADR-0042): token `enc2` con l'AAD in esadecimale, lo stesso path per due `file_id` diversi, `hmac1` invariato.
- **Vettori negativi** (nuovi): `shared/conformance/crypto/negative-vectors.json`, generati dal Go (`TestNegativeVectors`, stesso `UPDATE_VECTORS=1`) e verificati in Go e in TS (`packages/vaultcrypto-web/src/negative.test.ts`). Coprono tag alterato (primo e ultimo chunk), ciphertext e salt alterati, `chunk_size` alterato, troncamento al confine di chunk e dentro un tag, primo chunk rimosso, chunk riordinati/duplicati/aggiunti, dati in coda, magic/versione/chunk size non validi (zero, oltre il massimo), AAD sbagliata (vault, file), VMK sbagliata, token di path alterati/di altro vault/prefisso sconosciuto/base64 invalido, token `enc2` alterati, di un altro file (`file_id` scambiato) o di un altro vault, `enc2` rietichettato `enc1` (downgrade) ed `enc1` rietichettato `enc2`, `enc2` troncati o non base64url, envelope alterati, KEK sbagliata, lunghezza errata, envelope v2 aperti per un altro vault, con `kind` scambiato o sconosciuto, con byte di versione alterato, troncati a 60 byte o privati del byte di versione (downgrade), con tag alterato o byte in coda, 10 casi di KDF fuori range, 5 recovery key malformate.
  Ogni vettore dichiara la classe di errore (`decrypt`, `format`) oppure `any` dove le due implementazioni rifiutano ma classificano diversamente (dati in coda più corti di un tag: in TS è errore di formato, in Go è errore di autenticazione perché il chunk precedente viene autenticato per primo). **Entrambe rifiutano sempre.**
- **Politica della passphrase**: `shared/conformance/passphrase/policy.json` (passphrase, esito, motivo; anche forme NFD e testi non latini) è eseguito da `apps/desktop/internal/crypto/policy_test.go` e da `packages/workbench/src/sync/strength.test.ts`: il core e il riscontro della UI accettano e rifiutano le stesse passphrase per lo stesso motivo. Contiene solo casi lontani dal limite, perché i dizionari dei due stimatori non sono identici (§4).
- **Verifica** (nessun servizio di CI, ADR-0036): i test Go e TS sui vettori girano in `task ci` (`test-go`, `test-ts`). La riproducibilità dei vettori, che prima controllava il job `crypto-vectors` di `security.yml` (rimosso nella 1.2.2), si verifica a mano prima di un rilascio: rigenerare come sotto e controllare che `git diff --exit-code shared/conformance/crypto` non mostri differenze.
- **Rigenerare**: `cd shared/go && UPDATE_VECTORS=1 go test -run 'TestVectors|TestNegativeVectors' ./vaultcrypto/`, poi eseguire i test TS e committare i JSON. Un cambio dei vettori positivi è un cambio di formato e richiede una nuova versione (`NDS2`).

## 10. Checklist per il revisore

- [ ] Ogni chiave ha un solo uso e una etichetta HKDF distinta (`keys.go` righe `info*`). Nessuna chiave deriva da un'altra di livello inferiore.
- [ ] Nessun riuso di nonce: blob (nuova salt → nuova `K_file` per cifratura; contatore per chunk), path (nonce casuale, una chiave), wrap (nonce casuale, KEK per valore unico; l'upgrade a v2 ri-cifra la stessa VMK sotto la stessa KEK con un nonce nuovo).
- [ ] Envelope v2 (§5.3): AAD con `vault_id` e `kind`, byte di versione, rifiuto di lunghezze diverse da 60/61, impossibilità di downgrade; pinning per tipo in `apps/desktop/internal/sync/manager_ops.go`; scrittura v1/v2 governata da `features.envelope_v2` (`apps/desktop/internal/crypto/manager.go`, `writeV2`).
- [ ] Politica della passphrase nel core (§4): `crypto.ValidatePassphrase` su ogni binding che imposta una passphrase nuova (`LinkNew` privato, `ChangePassphrase`, `SetPassphrase`) e in `NewMaterial`/`NewPassphraseEnvelope`; nessun controllo sulle passphrase esistenti (sblocco, verifica, recovery key, upgrade v2); fixture comuni in `shared/conformance/passphrase/policy.json`.
- [ ] Normalizzazione NFC della passphrase e ordine dei tentativi in apertura (§5.4): nessuna forma provata oltre a NFC, input esatto e NFD; il ri-avvolgimento degli envelope legacy avviene solo con il flag acceso.
- [ ] Token di path `enc2` (§5.2, ADR-0042): AAD con `vault_id` e `file_id`, nessuna apertura incrociata tra versioni, `hmac1` invariato; pin di vault, di file e pin forte in `apps/desktop/internal/sync/pull.go` (`clearPath`, `pinPathV2`, `loadPathPins`, `writePathV2`); scrittura e migrazione governate da `features.path_v2`; migrazione e condizioni del pin forte in `apps/desktop/internal/sync/pathmigrate.go` (`migrationOp`, `strongPin`).
- [ ] Igiene delle chiavi (§4): un solo `*Subkeys` per vault sbloccato, `Wipe` al blocco sotto `RWMutex`, rifiuto di sottochiavi azzerate (`ErrWiped`), azzeramento di KEK e copie della VMK nel gestore delle chiavi.
- [ ] L'AAD del blob copre vault, file, indice e ultimo chunk; confrontare con i casi di `negative-vectors.json`.
- [ ] Gestione errori: nessuna differenza osservabile utile tra tag sbagliato e chiave sbagliata (`ErrDecrypt`); l'output parziale della decifratura in streaming viene scartato dal chiamante (commento in `DecryptBlob`): verificare i chiamanti in `apps/desktop/internal/sync` e `packages/vaultcrypto-web/src/export.ts`.
- [ ] Bound e minimi dei parametri Argon2id (client e server identici), tetto della calibrazione a 256 MiB (§6) e comportamento di `DeriveKEKPassphrase` con envelope ostili.
- [ ] Confronti in tempo costante: checksum della recovery key (non segreto), tag GCM (libreria). Nessun confronto di segreti con `==` su stringhe.
- [ ] Origine dell'entropia: `crypto/rand` (Go), `crypto.getRandomValues` (browser, `bytes.ts`).
- [ ] Gestione della VMK in memoria e su disco: keychain del SO (desktop), nessuna persistenza in `localStorage`/IndexedDB nella Web UI (`packages/vaultcrypto-web`, `web/src/export`).
- [ ] Argon2id in WASM (`hash-wasm`): versione bloccata in `yarn.lock`, richiede `'wasm-unsafe-eval'` nella CSP, nessun `unsafe-eval`.
- [ ] Il server non ha percorsi che restituiscano o registrino envelope, path o contenuto in chiaro (log, audit, metriche): grep di `wrapped_vmk` e `kdf` in `services/cloud/internal`.
- [ ] Limiti di §8: confermare che siano accettabili per la 1.0 e come documentati all'utente.
