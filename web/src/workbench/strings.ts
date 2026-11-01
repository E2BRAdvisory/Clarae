// The few messages the workbench page shows before (and instead of) the UI, and the page-level overlays
// that cover it (a locked private vault, a stopped engine). Once the UI is up it has its own translations
// (it/en, packages/workbench/src/i18n).
const EN = {
  core: 'Starting the vault engine…',
  session: 'Signing in to the cloud…',
  vault: 'Opening the vault…',
  ui: 'Loading the interface…',
  busy: 'A vault is already open in another tab of this browser. Close it and open this one again.',
  noCore: 'The vault engine is not part of this build.',
  notFound: 'This address does not point to a vault.',
  badCreate: 'This address does not say which vault to create: start again from the console.',
  failed: 'The vault could not be opened:',
  disabled: 'Your administrator has turned off opening vaults in the browser.',
  back: 'Back to the console',
  signInFailed:
    'Sign-in could not start: the server or the identity provider did not answer. Check the connection and try again.',
  retry: 'Retry',
  fatal: 'The vault engine stopped. Reload the page to continue.',
  reload: 'Reload',
  locking: 'Uploading your changes and locking the vault…',
  removing: 'Uploading your changes and removing the vault from this browser…',
  removeKeptTitle: 'Changes not uploaded',
  removeKeptHint:
    'The copy in this browser was kept so they are not lost. Stay to let the sync finish, or delete the copy anyway.',
  stay: 'Stay in the vault',
  lockedTitle: 'Vault locked',
  lockedPending_one: '{n} change not uploaded yet is kept in this browser as clear text.',
  lockedPending_other: '{n} changes not uploaded yet are kept in this browser as clear text.',
  lockedConflicts_one: '{n} conflict is not resolved yet.',
  lockedConflicts_other: '{n} conflicts are not resolved yet.',
  lockedUnscanned: 'Changes made in this browser may not have been uploaded yet.',
  lockedHint: 'Unlock the vault to upload them, or delete this copy.',
  unlock: 'Unlock',
  deleteAnyway: 'Delete anyway',
  deleteConfirm:
    'Delete the copy of this vault from this browser? The changes that were not uploaded are lost for good.',
  deleteConfirmButton: 'Delete',
  cancel: 'Cancel',
  gateTitle: 'Changes not uploaded',
  passphrase: 'Passphrase',
  recoveryKey: 'Recovery key',
  useRecoveryKey: 'Use the recovery key',
  newPassphraseIntro:
    'You used the recovery key: choose a new passphrase (at least 12 characters).',
  newPassphrase: 'New passphrase',
  newPassphraseAgain: 'Repeat the new passphrase',
  newPassphraseShort: 'The passphrase needs at least 12 characters.',
  newPassphraseMismatch: 'The two passphrases differ.',
  save: 'Save',
} as const;

const IT: Record<keyof typeof EN, string> = {
  core: 'Avvio del motore dei vault…',
  session: 'Accesso al cloud…',
  vault: 'Apertura del vault…',
  ui: "Caricamento dell'interfaccia…",
  busy: 'Un vault è già aperto in un’altra scheda di questo browser. Chiudila e apri di nuovo questo.',
  noCore: 'Il motore dei vault non fa parte di questa versione.',
  notFound: 'Questo indirizzo non punta a un vault.',
  badCreate: 'Questo indirizzo non dice quale vault creare: ricomincia dalla console.',
  failed: 'Non è stato possibile aprire il vault:',
  disabled: "L'amministratore ha disattivato l'apertura dei vault nel browser.",
  back: 'Torna alla console',
  signInFailed:
    "Impossibile avviare l'accesso: il server o il provider di identità non ha risposto. Controlla la connessione e riprova.",
  retry: 'Riprova',
  fatal: 'Il motore dei vault si è fermato. Ricarica la pagina per continuare.',
  reload: 'Ricarica',
  locking: 'Caricamento delle modifiche e blocco del vault…',
  removing: 'Caricamento delle modifiche e rimozione del vault da questo browser…',
  removeKeptTitle: 'Modifiche non caricate',
  removeKeptHint:
    'La copia in questo browser è stata conservata per non perderle. Resta per far finire la sincronizzazione, oppure elimina comunque la copia.',
  stay: 'Resta nel vault',
  lockedTitle: 'Vault bloccato',
  lockedPending_one:
    '{n} modifica non ancora caricata resta in questo browser come testo in chiaro.',
  lockedPending_other:
    '{n} modifiche non ancora caricate restano in questo browser come testo in chiaro.',
  lockedConflicts_one: '{n} conflitto non è ancora risolto.',
  lockedConflicts_other: '{n} conflitti non sono ancora risolti.',
  lockedUnscanned: 'Le modifiche fatte in questo browser potrebbero non essere ancora caricate.',
  lockedHint: 'Sblocca il vault per caricarle, oppure elimina questa copia.',
  unlock: 'Sblocca',
  deleteAnyway: 'Elimina comunque',
  deleteConfirm:
    'Eliminare la copia di questo vault da questo browser? Le modifiche non caricate vanno perse per sempre.',
  deleteConfirmButton: 'Elimina',
  cancel: 'Annulla',
  gateTitle: 'Modifiche non caricate',
  passphrase: 'Passphrase',
  recoveryKey: 'Chiave di recupero',
  useRecoveryKey: 'Usa la chiave di recupero',
  newPassphraseIntro:
    'Hai usato la chiave di recupero: scegli una nuova passphrase (almeno 12 caratteri).',
  newPassphrase: 'Nuova passphrase',
  newPassphraseAgain: 'Ripeti la nuova passphrase',
  newPassphraseShort: 'La passphrase deve avere almeno 12 caratteri.',
  newPassphraseMismatch: 'Le due passphrase sono diverse.',
  save: 'Salva',
};

export type MessageKey = keyof typeof EN;

/** The keys that have a `_one` / `_other` form, without the suffix. */
type PluralBase<K> = K extends `${infer B}_one` ? B : never;
export type PluralKey = PluralBase<MessageKey>;

export function message(key: MessageKey, n?: number): string {
  const text = (document.documentElement.lang === 'it' ? IT : EN)[key];
  return n === undefined ? text : text.replaceAll('{n}', String(n));
}

/** A message with a count: picks the singular or plural form. */
export function plural(key: PluralKey, n: number): string {
  return message(`${key}_${n === 1 ? 'one' : 'other'}` as MessageKey, n);
}
