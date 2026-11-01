// The package's own strings, in English and Italian: the components are the same on every host, so
// are their words. The host only says which language to use (`lang`); interpolation is i18next's
// `{{name}}`, plurals are `_one` / `_other` (CLDR, Intl.PluralRules), so the consistency checks of
// @memobrain/ui (i18nCheck) apply as they do to the hosts' own resources.

const en = {
  'vaults.caption': 'Cloud vaults',
  'vaults.colName': 'Name',
  'vaults.colKind': 'Type',
  'vaults.colSize': 'Size',
  'vaults.colFiles': 'Files',
  'vaults.colCreated': 'Created',
  'vaults.colActions': 'Actions',
  'vaults.kindShared': 'Shared',
  'vaults.kindPrivate': 'Private (encrypted)',
  'vaults.empty': 'You have no cloud vaults yet',
  'vaults.emptyHint': 'Create one here, or connect a folder from the desktop app.',
  'vaults.loading': 'Loading…',
  'vaults.loadFailed': 'Could not load the vaults: {{message}}',
  'vaults.new': 'New vault',
  'vaults.open': 'Open',
  'vaults.openAria': 'Open {{name}} in the browser',
  'vaults.rename': 'Rename',
  'vaults.renameAria': 'Rename {{name}}',
  'vaults.delete': 'Delete',
  'vaults.deleteAria': 'Delete {{name}}',
  'vaults.current': 'Open in this page: go back to the console to delete it.',
  'vaults.cancel': 'Cancel',
  'vaults.save': 'Save',
  'vaults.renamed': '“{{name}}” renamed.',
  'vaults.created': '“{{name}}” created.',
  'vaults.deleted': '“{{name}}” deleted. You can restore it from “Deleted vaults”.',
  'vaults.restored': '“{{name}}” restored.',

  'rename.title': 'Rename vault',
  'rename.label': 'Name',
  'rename.hint':
    'Every device and the console show the new name; folders on a computer keep their own.',

  'delete.title': 'Delete “{{name}}”?',
  'delete.retentionDays_one':
    'The cloud keeps it for {{count}} day: until then you can restore it from “Deleted vaults”, then it is removed for good.',
  'delete.retentionDays_other':
    'The cloud keeps it for {{count}} days: until then you can restore it from “Deleted vaults”, then it is removed for good.',
  'delete.retention':
    'The cloud keeps it for the retention period set by the administrator: until then you can restore it from “Deleted vaults”, then it is removed for good.',
  'delete.devices':
    'Devices connected to it stop synchronizing. Anyone it is shared with loses access.',
  'delete.localCopy':
    'The copy on this device stays where it is, with all its files, and is disconnected from the cloud.',
  'delete.private':
    'It is a private vault: this device forgets its key. To connect it again after a restore you need the passphrase or the recovery key.',
  'delete.confirm': 'Delete',

  'deleted.title': 'Deleted vaults',
  'deleted.intro': 'Restorable until the cloud removes them for good.',
  'deleted.colDeleted': 'Deleted',
  'deleted.colPurge': 'Removed for good',
  'deleted.purgeUnknown': 'after the retention period',
  'deleted.restore': 'Restore',
  'deleted.restoreAria': 'Restore {{name}}',
  'deleted.relink':
    'A restored vault is not connected again by itself: connect it from the device as an existing vault.',

  'create.title': 'New cloud vault',
  'create.name': 'Name',
  'create.kind': 'Type',
  'create.shared': 'Shared',
  'create.sharedText':
    'Stored readable by the server, so it can be shared with people and groups and downloaded as ZIP from the console.',
  'create.private': 'Private (end-to-end encrypted)',
  'create.privateText':
    'Encrypted on your devices with a passphrase (at least 12 characters) and a recovery key shown once: the server cannot read it, and it can never be shared. Lose both and the content is lost.',
  'create.privateInBrowser':
    'The keys are made in the browser workbench, which opens to ask for the passphrase.',
  'create.privateUnavailable':
    'A private vault needs the browser workbench, which the administrator has turned off: create it from the desktop app.',
  'create.kindFixed': 'The type cannot be changed later.',
  'create.submit': 'Create',
  'create.continue': 'Continue',

  'errors.NAME_IN_USE': 'You already have a vault with this name.',
  'errors.NOT_FOUND': 'The vault no longer exists, or its retention period is over.',
  'errors.VALIDATION_FAILED': 'The name is not valid (1 to 120 characters).',
  'errors.FORBIDDEN': 'You are not allowed to do this.',
  'errors.generic': 'It did not work: {{message}}',
} as const;

export type MessageKey = keyof typeof en;
type Messages = Record<MessageKey, string>;

const it: Messages = {
  'vaults.caption': 'Vault nel cloud',
  'vaults.colName': 'Nome',
  'vaults.colKind': 'Tipo',
  'vaults.colSize': 'Dimensione',
  'vaults.colFiles': 'File',
  'vaults.colCreated': 'Creato',
  'vaults.colActions': 'Azioni',
  'vaults.kindShared': 'Condiviso',
  'vaults.kindPrivate': 'Privato (cifrato)',
  'vaults.empty': 'Non hai ancora vault nel cloud',
  'vaults.emptyHint': "Creane uno qui, oppure collega una cartella dall'app desktop.",
  'vaults.loading': 'Caricamento…',
  'vaults.loadFailed': 'Impossibile caricare i vault: {{message}}',
  'vaults.new': 'Nuovo vault',
  'vaults.open': 'Apri',
  'vaults.openAria': 'Apri {{name}} nel browser',
  'vaults.rename': 'Rinomina',
  'vaults.renameAria': 'Rinomina {{name}}',
  'vaults.delete': 'Elimina',
  'vaults.deleteAria': 'Elimina {{name}}',
  'vaults.current': 'Aperto in questa pagina: torna alla console per eliminarlo.',
  'vaults.cancel': 'Annulla',
  'vaults.save': 'Salva',
  'vaults.renamed': '«{{name}}» rinominato.',
  'vaults.created': '«{{name}}» creato.',
  'vaults.deleted': '«{{name}}» eliminato. Puoi ripristinarlo da «Vault eliminati».',
  'vaults.restored': '«{{name}}» ripristinato.',

  'rename.title': 'Rinomina vault',
  'rename.label': 'Nome',
  'rename.hint':
    'Tutti i dispositivi e la console mostrano il nuovo nome; le cartelle sul computer mantengono il loro.',

  'delete.title': 'Eliminare «{{name}}»?',
  'delete.retentionDays_one':
    'Il cloud lo conserva per {{count}} giorno: fino ad allora puoi ripristinarlo da «Vault eliminati», poi viene rimosso definitivamente.',
  'delete.retentionDays_other':
    'Il cloud lo conserva per {{count}} giorni: fino ad allora puoi ripristinarlo da «Vault eliminati», poi viene rimosso definitivamente.',
  'delete.retention':
    "Il cloud lo conserva per il periodo di conservazione stabilito dall'amministratore: fino ad allora puoi ripristinarlo da «Vault eliminati», poi viene rimosso definitivamente.",
  'delete.devices':
    "I dispositivi collegati smettono di sincronizzarlo. Chi lo riceve in condivisione perde l'accesso.",
  'delete.localCopy':
    "La copia su questo dispositivo resta dov'è, con tutti i suoi file, e viene scollegata dal cloud.",
  'delete.private':
    'È un vault privato: questo dispositivo dimentica la sua chiave. Per ricollegarlo dopo un ripristino servono la passphrase o la chiave di recupero.',
  'delete.confirm': 'Elimina',

  'deleted.title': 'Vault eliminati',
  'deleted.intro': 'Ripristinabili finché il cloud non li rimuove definitivamente.',
  'deleted.colDeleted': 'Eliminato',
  'deleted.colPurge': 'Rimozione definitiva',
  'deleted.purgeUnknown': 'al termine della conservazione',
  'deleted.restore': 'Ripristina',
  'deleted.restoreAria': 'Ripristina {{name}}',
  'deleted.relink':
    'Un vault ripristinato non si ricollega da solo: collegalo dal dispositivo come vault esistente.',

  'create.title': 'Nuovo vault nel cloud',
  'create.name': 'Nome',
  'create.kind': 'Tipo',
  'create.shared': 'Condiviso',
  'create.sharedText':
    'Il server lo conserva leggibile: si può condividere con persone e gruppi e scaricare come ZIP dalla console.',
  'create.private': 'Privato (cifrato end-to-end)',
  'create.privateText':
    'Cifrato sui tuoi dispositivi con una passphrase (almeno 12 caratteri) e una chiave di recupero mostrata una volta sola: il server non può leggerlo e non si può mai condividere. Persi entrambi, il contenuto è perso.',
  'create.privateInBrowser':
    'Le chiavi si creano nel workbench del browser, che si apre per chiedere la passphrase.',
  'create.privateUnavailable':
    "Un vault privato richiede il workbench del browser, disattivato dall'amministratore: crealo dall'app desktop.",
  'create.kindFixed': 'Il tipo non si può cambiare in seguito.',
  'create.submit': 'Crea',
  'create.continue': 'Continua',

  'errors.NAME_IN_USE': 'Hai già un vault con questo nome.',
  'errors.NOT_FOUND': 'Il vault non esiste più, oppure il periodo di conservazione è finito.',
  'errors.VALIDATION_FAILED': 'Il nome non è valido (da 1 a 120 caratteri).',
  'errors.FORBIDDEN': 'Non hai il permesso di farlo.',
  'errors.generic': 'Non è riuscito: {{message}}',
};

export const resources: Record<'en' | 'it', Messages> = { en, it };

export type Lang = keyof typeof resources;
export type Vars = Record<string, string | number>;
/** Looks a key up; plural keys are named without their suffix (`delete.retentionDays`). */
export type TFunction = (key: MessageKey | PluralBase, vars?: Vars) => string;
type PluralBase = MessageKey extends infer K
  ? K extends `${infer B}_${'one' | 'other'}`
    ? B
    : never
  : never;

/** The supported language closest to a BCP 47 tag ("it-IT" → "it"; anything else → "en"). */
export const langOf = (tag: string | undefined): Lang =>
  tag?.toLowerCase().startsWith('it') ? 'it' : 'en';

export function createT(tag: string | undefined): TFunction {
  const lang = langOf(tag);
  const dict = resources[lang];
  const plural = new Intl.PluralRules(lang);
  return (key, vars) => {
    let msg: string | undefined;
    if (typeof vars?.['count'] === 'number') {
      const form = plural.select(vars['count']);
      msg =
        (dict as Record<string, string>)[`${key}_${form}`] ??
        (dict as Record<string, string>)[`${key}_other`];
    }
    msg ??= (dict as Record<string, string>)[key] ?? key;
    return msg.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) =>
      vars && name in vars ? String(vars[name]) : '',
    );
  };
}
