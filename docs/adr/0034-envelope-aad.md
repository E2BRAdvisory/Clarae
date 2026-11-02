# ADR-0034 — Envelope della VMK legati al vault e al tipo (formato v2 con AAD)

|                       |                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Stato**             | proposta                                                                                                                                  |
| **Data**              | 2026-10-30                                                                                                                                |
| **Riferimenti spec**  | §3.8.1 (modello di minaccia, A3 server attivamente malevolo), §3.8.2 (riga «Envelope»), §3.8.4 (flussi), §3.8.7 (test vector); D-02; O-03 |
| **Devia dallo spec?** | sì (§3.8.2 e §3.8.7) → formato dell'envelope versionato con AAD; richiede aggiornamento di `Specifications.md` da parte dell'owner        |

## Contesto

L'envelope di un vault privato è oggi `nonce(12) ‖ AES-256-GCM(KEK, VMK) ‖ tag(16)`, 60 byte senza AAD:

- in Go: `shared/go/vaultcrypto/keys.go`, `Wrap`/`Unwrap` con AAD `nil`;
- in TS: `packages/vaultcrypto-web/src/keys.ts`;
- sul server: `vault_key_envelopes.wrapped_vmk`, convalidato solo per lunghezza.

`docs/security/crypto-design.md` (§4) lo segnala al revisore: «l'envelope non è legato al `vault_id`». L'analisi dei gap del 2026-10-30 l'ha ripreso tra le migliorie di igiene crittografica.

Che cosa permette questa assenza. Un server attivamente malevolo (A3) può servire, per il vault B, l'envelope del vault A dello stesso owner. Se le due passphrase coincidono, cosa frequente per un utente con più vault, il client sblocca B con la VMK di A senza accorgersene. Le conseguenze sono limitate:

- il contenuto esistente di B non si decifra, perché l'AAD dei blob e dei path contiene `vault_id`, quindi il bootstrap fallisce;
- un dispositivo che ha già la VMK nel keychain non rilegge l'envelope.

Il server non impara nessuna chiave. Restano però due effetti indesiderati:

1. un errore che si presenta come «dati corrotti» invece che come «envelope sbagliato»;
2. nella finestra prima del primo download, scritture locali cifrate con una VMK sbagliata, che gli altri dispositivi non potranno leggere.

Anche lo scambio dei due tipi di envelope (`passphrase`/`recovery`) non è rilevato dal formato: oggi lo intercettano solo i parametri KDF diversi.

È difesa in profondità, non una vulnerabilità di riservatezza. Non blocca la 1.0, ma va decisa prima dell'audit esterno, perché un cambio di formato dopo l'audit costa una seconda revisione.

## Decisione

**Formato v2.** `wrapped_vmk = 0x02 ‖ nonce(12) ‖ AES-256-GCM(KEK, VMK; AAD) ‖ tag(16)`, cioè 61 byte, con:

```text
AAD = "memobrain/v2/envelope" ‖ vault_id (16 byte) ‖ kind ("passphrase" | "recovery")
```

Il byte di versione rende il formato esplicito, e il v1 resta riconoscibile dalla sola lunghezza (60 byte). La KEK, i parametri KDF, la recovery key e la VMK non cambiano. Non c'è ri-cifratura dei dati.

**Lettura (client Go e TS).**

- `Unwrap(kek, wrapped, vaultID, kind)` accetta v1 (60 byte, senza AAD) e v2 (61 byte, AAD obbligatoria).
- Un v2 che non si apre con il `vault_id` e il `kind` attesi è `ErrDecrypt`, come una passphrase sbagliata. Il client mostra comunque un messaggio distinto quando la stessa passphrase apre l'envelope di un altro vault dell'utente: si può verificare, perché il client conosce gli id dei propri vault.
- Il downgrade non è possibile: un v2 privato del byte di versione e dell'AAD non si apre come v1, perché il tag GCM copre l'AAD.

**Pinning per vault.** Dopo aver aperto un envelope v2 di un vault, il client annota in `sync.db` (`meta` per vault) che quel vault è passato al v2. Da quel momento rifiuta gli envelope v1 di quel vault. Altrimenti un server malevolo potrebbe ripresentare un vecchio v1 di un altro vault per aggirare il legame: è un controllo trust-on-first-use, sufficiente perché il v1 viene eliminato con la migrazione.

**Scrittura e migrazione, in due rilasci.** Un client vecchio non saprebbe aprire un envelope v2: scrivere v2 prima che tutti i client sappiano leggerlo bloccherebbe i dispositivi non aggiornati.

1. **Rilascio N:** tutti i client (desktop, workbench web, `vaultcrypto-web` dell'export ZIP) leggono v1 e v2, e scrivono ancora v1.
2. **Rilascio N+1:**
   - si scrive v2 alla creazione del vault, al cambio di passphrase e alla rigenerazione della recovery key;
   - a ogni sblocco con passphrase di un vault ancora v1, il client ri-avvolge la stessa VMK in v2 e lo carica con `PUT /vaults/{vid}/key-envelopes/passphrase`;
   - l'envelope di recovery passa al v2 quando l'utente sblocca con la recovery key, oppure la rigenera; fino ad allora resta v1 (la recovery key serve di rado, e chiederla solo per migrare sarebbe peggio);
   - il passaggio alla scrittura v2 è un feature flag del Config Profile (`features.envelope_v2`, acceso per default nel rilascio N+1), così un'istanza con dispositivi rimasti indietro può rimandarlo.

**Server.** `vaults.ValidateEnvelope` accetta 60 o 61 byte e, per 61, solo il primo byte `0x02`. Non interpreta altro: AAD e contenuto restano opachi. Nessuna migrazione dello schema: `wrapped_vmk` è già `BYTEA`, e `KeyEnvelopeInput.wrapped_vmk` in OpenAPI passa da «60 bytes» a «60 (v1) o 61 (v2) bytes».

**Test vector.**

- `shared/conformance/crypto/vectors.json` aggiunge `wrap_v2`, mantenendo `wrap` (v1).
- `negative-vectors.json` aggiunge:
  - v2 con `vault_id` diverso;
  - v2 con `kind` scambiato;
  - v2 con byte di versione alterato;
  - v2 troncato a 60 byte, cioè il tentativo di downgrade;
  - v1 di un vault già passato al v2 (rifiutato dal pinning, test del client e non della libreria).
- Go e TS li verificano entrambi, come oggi (`security.yml`, job `crypto-vectors`).

## Alternative considerate

- **Lasciare l'envelope senza AAD e documentare il limite** — scartata come stato finale: il costo è piccolo (un byte, un parametro) e chiude l'unica parte del formato non legata al contesto. Resta la situazione del rilascio N.
- **Versione nel JSON (`kdf.format` o un campo `version` dell'API)** — scartata: mescola il formato della cifratura con i parametri della KDF, e il server dovrebbe interpretarlo. Il byte in testa al ciphertext opaco è autodescrittivo e il server lo convalida senza capirlo.
- **Rotazione della VMK al posto del legame** — fuori tema: la rotazione (con ri-cifratura di tutti i dati) risponde a una passphrase compromessa, non alla sostituzione degli envelope. Resta tra i limiti di `crypto-design.md` §8.
- **Scrivere v2 subito** — scartata: i dispositivi non aggiornati non riuscirebbero più a sbloccare il vault.

## Conseguenze

- Una sostituzione o uno scambio di envelope viene rilevato al momento dello sblocco, con un errore chiaro, invece che come dati illeggibili più tardi.
- Due rilasci per completare la migrazione. Gli envelope di recovery dei vault mai recuperati restano v1 finché l'utente non rigenera la recovery key: le impostazioni del vault lo possono suggerire.
- Da aggiornare: `docs/security/crypto-design.md` (§4, §5, §9, checklist §10), la guida admin (flag `features.envelope_v2`) e lo schema del Config Profile (`features.envelope_v2`; dal W8 lo schema è uno solo, `api/config-profile.schema.json`, da cui si generano le costanti Go e TS).
- Lo spec cambia in §3.8.2, riga «Envelope»: `0x02 ‖ nonce ‖ AES-256-GCM(KEK, VMK; AAD = "memobrain/v2/envelope" ‖ vault_id ‖ kind) ‖ tag`, con v1 accettato in lettura. In §3.8.7 si aggiungono i nuovi vettori e la regola del pinning (vedi `docs/spec-v1.2-proposta.md`).
- Va deciso prima dell'audit esterno (`docs/release/v1.0.0-checklist.md` §5): se si sceglie di farlo dopo la 1.0, l'audit va informato che il formato dell'envelope cambierà.

## Esito

Stato dell'implementazione al 2026-11-01: **rilascio N completato**. Lo stato dell'ADR resta «proposta» finché l'owner non lo accetta e aggiorna lo spec.

Che cosa fa il rilascio N, come prescritto dalla sezione «Scrittura e migrazione» («tutti i client […] leggono v1 e v2, e scrivono ancora v1»):

- **Libreria Go** (`shared/go/vaultcrypto/keys.go`): `Unwrap(kek, wrapped, vaultID, kind)` accetta v1 (60 byte, senza AAD) e v2 (61 byte, `0x02` in testa); `WrapV2`/`WrapV2WithNonce` scrivono v2; `Wrap` (v1) resta lo scrittore di default; `EnvelopeAAD` ed `EnvelopeVersion` espongono l'AAD e il riconoscimento del formato.
- **Libreria TS** (`packages/vaultcrypto-web/src/keys.ts`): le stesse funzioni (`unwrap`, `wrapV2`, `envelopeAad`, `envelopeVersion`). L'export ZIP del browser (`unlockVault(envelopes, secret, vaultId)`, chiamato da `web/src/export/privateExport.ts`) legge i due formati e non riscrive mai gli envelope.
- **AAD**, byte per byte: i 21 byte ASCII `memobrain/v2/envelope`, i 16 byte dell'UUID del vault, il `kind` in ASCII (`passphrase` o `recovery`), senza separatori né lunghezze. Il formato è univoco perché i primi due campi hanno lunghezza fissa.
- **Server**: `vaults.ValidateEnvelope` accetta 60 byte, oppure 61 byte con il primo byte `0x02`, e rifiuta tutto il resto (test unitari e di integrazione).
- **Client desktop e core WASM del workbench web** (`apps/desktop/internal/crypto`, `internal/sync`): leggono v1 e v2. Ogni sblocco passa il `vault_id` del cloud, che il gestore delle chiavi conosce già perché indicizza i vault per id cloud.
- **Flag**: `features.envelope_v2` del Config Profile, **spento per default** in questo rilascio (`apps/desktop/internal/app/managed.go`, applicato a ogni cambio di configurazione). Lo schema del Config Profile accetta già la chiave (`additionalProperties: boolean`).
- **Comportamento con il flag acceso** (quello del rilascio N+1, già implementato):
  - creazione: il vault nasce con envelope v1, perché l'id lo assegna il server alla creazione; subito dopo il client carica le versioni v2 con `PUT /key-envelopes/{kind}`;
  - cambio passphrase e nuova recovery key scrivono v2;
  - allo sblocco con la passphrase, un envelope v1 viene ri-avvolto in v2 con gli stessi parametri KDF e la KEK della forma NFC (la stessa, salvo per gli envelope legacy descritti più sotto);
  - allo sblocco con la recovery key, l'envelope di recovery passa al v2.
  - Il caricamento è best effort: la VMK resta la stessa e l'envelope precedente continua a funzionare. Il client sostituisce l'envelope solo se sul server c'è ancora quello che ha aperto, così non sovrascrive una passphrase cambiata nel frattempo da un altro dispositivo.
- **Vettori**: `vectors.json` → `wrap_v2` (passphrase e recovery, con l'AAD in esadecimale); `negative-vectors.json` → `vault_id` diverso, `kind` scambiato, `kind` sconosciuto, byte di versione alterato (`0x03` e `0x01`), v2 troncato a 60 byte, v2 privato del byte di versione (downgrade), tag alterato, byte in coda. Go e TS li verificano entrambi.

Precisazioni rispetto al testo della decisione:

1. **Pinning per tipo di envelope, non per vault.** Il client annota in `sync.db` (`envelope_v2:<id cloud>:<kind>`) che un tipo di envelope di quel vault è passato al v2. Lo annota quando ne apre uno o quando ne carica uno. Da quel momento rifiuta un v1 di quel tipo con `ErrEnvelopeDowngrade`. Un pin per l'intero vault avrebbe rifiutato anche l'envelope di recovery legittimo, che secondo questo stesso ADR resta v1 finché non si usa la recovery key: si rischiava di chiudere fuori l'utente. L'id cloud fa parte della chiave, quindi una cartella ricollegata a un altro vault non eredita il pin.
2. **Mai declassare.** Anche con il flag spento, un client che ha visto (o annotato) un envelope v2 di un tipo continua a scrivere v2 per quel tipo. Così un dispositivo con il flag spento non riporta a v1 un vault già migrato.
3. Non è implementato il messaggio distinto «la passphrase apre l'envelope di un altro tuo vault»: uno scambio di envelope v2 appare come passphrase errata, e uno v1 al posto di un tipo annotato appare come `ErrEnvelopeDowngrade`.

Resta per il **rilascio N+1**:

- accendere `features.envelope_v2` per default (`envelopeV2Enabled` in `apps/desktop/internal/app/managed.go`, oggi con default `false`);
- documentare il flag nella guida admin;
- elencare `envelope_v2` nello schema del Config Profile (`api/config-profile.schema.json`, unica fonte dal W8: la copia in `configprofiles` è stata rimossa e le costanti si generano con `task gen-features`) — fatto, default `false`;
- aggiornare la descrizione di `KeyEnvelopeInput.wrapped_vmk` in `api/openapi.yaml`, oggi «(60 bytes)», a «60 (v1) o 61 (v2) bytes». Il campo non ha vincoli `minLength`/`maxLength`, quindi il server accetta già entrambi;
- aggiornare lo spec: §3.8.2, riga «Envelope», e §3.8.7, come indicato sopra in «Conseguenze».

**Normalizzazione della passphrase (modifica collegata, stesso intervento).** La KEK si deriva ora dalla passphrase normalizzata in Unicode NFC (`DeriveKEKPassphrase` in Go, `deriveKekPassphrase` in TS). Ogni nuovo envelope (creazione, cambio passphrase, nuova passphrase dopo la recovery) usa questa regola. In apertura il client prova, in ordine, la forma NFC, l'input esatto e la sua forma NFD, saltando i duplicati (`PassphraseForms` / `passphraseForms`, `OpenWithPassphrase` / `openWithPassphrase`). Così gli envelope scritti prima, con i byte grezzi di un input non NFC, continuano ad aprirsi. Un envelope aperto solo con una forma legacy viene ri-avvolto sotto la forma NFC solo con il flag acceso, nello stesso upgrade: con il flag spento, un dispositivo non aggiornato che digita la stessa forma non NFC continua a sbloccare. La recovery key non cambia: alfabeto Base32 ASCII con checksum; un carattere non ASCII è già rifiutato prima di qualsiasi derivazione. Vettori: `passphrase_normalization` in `vectors.json`, con input NFC e NFD che danno la stessa KEK, la KEK grezza dell'input NFD e un envelope legacy aperto da entrambe le forme. **Lo spec va aggiornato in §3.8.2** (riga «KDF della passphrase»): la passphrase si normalizza in NFC prima di Argon2id, e in lettura si provano anche l'input esatto e la sua forma NFD.

**Rilascio N+1 (2026-11-02).** L'owner ha deciso di eseguire il rilascio N+1. Il campo «Stato» resta «proposta»: l'accettazione dell'ADR e l'aggiornamento dello spec spettano all'owner.

- **Flag acceso per default.** `features.envelope_v2` ha `default: true` in `api/config-profile.schema.json`. Le costanti generate (`task gen-features`: `shared/go/features`, `@memobrain/api-client/features`) valgono `true`, e tutti i consumatori leggono quelle:
  - i default del prodotto distribuiti dal cloud (`configprofiles.ProductDefaults`), quindi anche i client del rilascio N collegati a un cloud aggiornato ricevono il flag acceso;
  - `crypto.NewManager`: `Options.EnvelopeV2` è ora un `*bool`, e `nil` prende il default dello schema;
  - `envelopeV2Enabled` del desktop e del core WASM del workbench web (`apps/desktop/internal/app/managed.go`).

  Un client senza profilo scrive quindi v2.

- **Comportamento con il default**, verificato dai test:
  - creazione: v2 subito dopo la creazione;
  - sblocco con la passphrase o con la recovery key: upgrade a v2;
  - cambio della passphrase e nuova recovery key: scritti in v2.

  Test unitari: `TestEnvelopeV2OnByDefault`, `TestEnvelopeV2FromProfile`. Test d'integrazione: `TestPrivateVaultEnvelopeV2ByDefault`, e `TestPrivateVaultEnvelopeV2Migration`, dove il client del rilascio N ha ora il flag spento in modo esplicito.

- **Nient'altro.** Per il rilascio N+1 questo ADR non prevede un pin forte né il rifiuto dei v1 dopo un upgrade completo, e non sono stati aggiunti. Restano i pin per tipo: un envelope di recovery mai usato resta v1 e continua ad aprirsi finché l'utente non usa o non rigenera la recovery key. Nessun lockout.
- **Flag spento dall'amministratore.** Il client smette di scrivere v2 e di fare l'upgrade allo sblocco. Un tipo di envelope già visto o scritto in v2 resta v2 (precisazione 2).
- **Fatte anche** le altre voci rimaste per il rilascio N+1: il flag è documentato nella guida admin (`docs/admin-guide/profili-quote-audit.md`, con una nota di aggiornamento in `docs/admin-guide/backup-upgrade.md`), e la descrizione di `KeyEnvelopeInput.wrapped_vmk` in `api/openapi.yaml` cita già v1 e v2. Resta all'owner l'aggiornamento dello spec (§3.8.2 e §3.8.7).
- **Compatibilità.** I desktop fino alla 1.2.4 non sanno aprire un envelope v2: dopo l'upgrade fatto da un altro dispositivo non sbloccano più quel vault. Il dispositivo va aggiornato prima del cloud, che distribuisce il flag acceso; in alternativa, finché restano dispositivi vecchi, si imposta `features.envelope_v2: false` nel profilo globale. Il workbench web è servito dal cloud ed è sempre aggiornato. Nessuna perdita di dati: VMK e contenuto non cambiano, e un desktop aggiornato riapre il vault con la stessa passphrase.
