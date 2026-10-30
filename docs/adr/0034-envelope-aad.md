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
- Da aggiornare: `docs/security/crypto-design.md` (§4, §5, §9, checklist §10), la guida admin (flag `features.envelope_v2`) e lo schema del Config Profile (`features.envelope_v2`, nelle due copie).
- Lo spec cambia in §3.8.2, riga «Envelope»: `0x02 ‖ nonce ‖ AES-256-GCM(KEK, VMK; AAD = "memobrain/v2/envelope" ‖ vault_id ‖ kind) ‖ tag`, con v1 accettato in lettura. In §3.8.7 si aggiungono i nuovi vettori e la regola del pinning (vedi `docs/spec-v1.2-proposta.md`).
- Va deciso prima dell'audit esterno (`docs/release/v1.0.0-checklist.md` §5): se si sceglie di farlo dopo la 1.0, l'audit va informato che il formato dell'envelope cambierà.
