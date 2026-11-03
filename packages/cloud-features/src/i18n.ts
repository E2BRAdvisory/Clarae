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

  'common.loading': 'Loading…',
  'common.loadMore': 'Load more',
  'common.loadFailed': 'Could not load the data: {{message}}',
  'common.cancel': 'Cancel',
  'common.save': 'Save',

  'devices.caption': 'Devices',
  'devices.colName': 'Device',
  'devices.colPlatform': 'Platform',
  'devices.colVersion': 'Version',
  'devices.colSeen': 'Last seen',
  'devices.colStatus': 'Status',
  'devices.colActions': 'Actions',
  'devices.never': 'Never',
  'devices.active': 'Active',
  'devices.revokedBadge': 'Revoked',
  'devices.thisDevice': 'This device',
  'devices.currentNote': 'The device you are using: sign out to disconnect it.',
  'devices.platformWeb': 'Browser',
  'devices.empty': 'No registered devices',
  'devices.emptyHint':
    'A device appears here once you sign in from the desktop app or open a vault in the browser.',
  'devices.revoke': 'Revoke',
  'devices.revokeAria': 'Revoke {{name}}',
  'devices.confirmTitle': 'Revoke this device?',
  'devices.confirmBody':
    '“{{name}}” stops synchronizing and must sign in again to reconnect. Its local copies stay where they are.',
  'devices.revoked': '“{{name}}” revoked.',

  'usage.barLabel': 'Storage used',
  'usage.caption': '{{used}} of {{quota}}',
  'usage.captionUnlimited': '{{used}} used, no limit',
  'usage.percent': '{{percent}}%',
  'usage.level_ok': 'Plenty of space left.',
  'usage.level_warning': 'Your space is running low.',
  'usage.level_critical': 'Your space is almost full: free some space soon.',
  'usage.level_full':
    'Your space is full: new changes cannot be uploaded until you free some space.',
  'usage.note':
    'Only the current files count, not their history. Shares you receive count toward their owner’s space.',
  'usage.byVault': 'Space by vault',
  'usage.colVault': 'Vault',
  'usage.colShare': 'Share of the space used',
  'usage.noVaults': 'You have no cloud vaults yet.',

  'shares.ownedTitle': 'Shared by me',
  'shares.new': 'New share',
  'shares.ownedEmpty': 'You have not shared anything yet',
  'shares.ownedEmptyHint': 'Share a whole shared vault, or one of its folders, with “New share”.',
  'shares.disabled': 'Sharing is turned off by your administrator.',
  'shares.type_vault': 'Vault',
  'shares.type_folder': 'Folder',
  'shares.type_file': 'Document',
  'shares.inVault': 'in {{vault}}',
  'shares.expires': 'Expires {{date}}',
  'shares.noExpiry': 'No expiry',
  'shares.from': 'From {{owner}}',
  'shares.edit': 'Edit',
  'shares.editAria': 'Edit {{name}}',
  'shares.manage': 'Manage access',
  'shares.hide': 'Hide access',
  'shares.manageAria': 'Access to {{name}}',
  'shares.revoke': 'Revoke',
  'shares.revokeAria': 'Revoke {{name}}',
  'shares.revokeTitle': 'Revoke “{{name}}”?',
  'shares.revokeBody':
    'The people and groups it is shared with lose access at once. Copies they kept on their devices stay with them, disconnected.',
  'shares.revoked': '“{{name}}” revoked.',
  'shares.created': '“{{name}}” shared. Add the people and groups who can see it.',
  'shares.updated': '“{{name}}” updated.',
  'shares.managerNote': 'You manage this share: only its owner can revoke it.',
  'shares.shareInside': 'Share inside',
  'shares.shareInsideAria': 'Share inside {{name}}',

  'shareForm.newTitle': 'New share',
  'shareForm.editTitle': 'Edit “{{name}}”',
  'shareForm.vault': 'Vault',
  'shareForm.noSharedVaults':
    'You have no shared vaults: create one first. Private vaults are end-to-end encrypted and can never be shared.',
  'shareForm.privateExcluded':
    'Private vaults are end-to-end encrypted and cannot be shared, so they are not listed.',
  'shareForm.what': 'What to share',
  'shareForm.wholeVault': 'The whole vault',
  'shareForm.folder': 'A folder',
  'shareForm.folderPath': 'Folder',
  'shareForm.folderHint': 'Path from the root of the vault, for example Projects/Alfa.',
  'shareForm.name': 'Name',
  'shareForm.nameHint': 'What the people you share with see.',
  'shareForm.expiry': 'Expires on',
  'shareForm.expiryHint': 'Optional: access ends at the end of this day.',
  'shareForm.clearExpiry': 'No expiry',
  'shareForm.create': 'Share',
  'shareForm.insideTitle': 'Share inside “{{name}}”',
  'shareForm.inside': 'Inside “{{name}}” · in {{vault}}',
  'shareForm.insideNote':
    'As a manager you can share only what lies inside this share, with access up to Manager. The owner of the vault can revoke what you create.',
  'shareForm.wholeFolder': 'The whole folder',
  'shareForm.subfolder': 'A subfolder',
  'shareForm.subfolderPath': 'Subfolder',
  'shareForm.subfolderHint': 'Path inside {{folder}}, for example Drafts.',

  'grants.caption': 'Access',
  'grants.none': 'Nobody has access yet.',
  'grants.colWho': 'Who',
  'grants.colPermission': 'Permission',
  'grants.colStatus': 'Status',
  'grants.colActions': 'Actions',
  'grants.user': 'User',
  'grants.group': 'Group',
  'grants.permission_viewer': 'Viewer',
  'grants.permission_editor': 'Editor',
  'grants.permission_manager': 'Manager',
  'grants.status_pending': 'Pending',
  'grants.status_accepted': 'Accepted',
  'grants.status_declined': 'Declined',
  'grants.permissionOf': 'Permission of {{name}}',
  'grants.remove': 'Remove',
  'grants.removeAria': 'Remove {{name}}',
  'grants.saved': 'Access of {{name}} updated.',
  'grants.removed': '{{name}} no longer has access.',
  'grants.add': 'Add people or groups',
  'grants.addType': 'Add a',
  'grants.searchLabel': 'Name or username',
  'grants.searchHint': 'At least two characters.',
  'grants.newPermission': 'With permission',
  'grants.search': 'Search',
  'grants.results': 'Search results',
  'grants.noResults': 'No match.',
  'grants.addOne': 'Add',
  'grants.addAria': 'Add {{name}}',
  'grants.already': 'Already has access',

  'invitations.title': 'Invitations',
  'invitations.none': 'No invitations.',
  'invitations.accepted': 'Accepted shares',
  'invitations.declined': 'Declined',
  'invitations.accept': 'Accept',
  'invitations.acceptAria': 'Accept {{name}}',
  'invitations.decline': 'Decline',
  'invitations.declineAria': 'Decline {{name}}',
  'invitations.open': 'Open',
  'invitations.openAria': 'Open {{name}} in the browser',
  'invitations.acceptedStatus': 'Invitation to “{{name}}” accepted.',
  'invitations.declinedStatus': 'Invitation to “{{name}}” declined.',

  'groups.caption': 'My groups',
  'groups.colName': 'Group',
  'groups.colDescription': 'Description',
  'groups.colRole': 'Role',
  'groups.role_member': 'Member',
  'groups.role_manager': 'Manager',
  'groups.roleReserved': 'The manager role gives no extra permission in this version.',
  'groups.empty': 'You are not in any group.',
  'groups.note': 'Groups are managed by the administrators. People can share with a whole group.',

  'errors.NAME_IN_USE': 'You already have a vault with this name.',
  'errors.VAULT_ENCRYPTED': 'A private vault is end-to-end encrypted: it can never be shared.',
  'errors.NOT_FOUND_share': 'The share no longer exists.',
  'errors.NOT_FOUND_device': 'The device no longer exists.',
  'errors.VALIDATION_FAILED_share':
    'Check the name (1 to 120 characters), the folder and the expiry, which must be in the future.',
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

  'common.loading': 'Caricamento…',
  'common.loadMore': 'Carica altri',
  'common.loadFailed': 'Impossibile caricare i dati: {{message}}',
  'common.cancel': 'Annulla',
  'common.save': 'Salva',

  'devices.caption': 'Dispositivi',
  'devices.colName': 'Dispositivo',
  'devices.colPlatform': 'Piattaforma',
  'devices.colVersion': 'Versione',
  'devices.colSeen': 'Ultimo accesso',
  'devices.colStatus': 'Stato',
  'devices.colActions': 'Azioni',
  'devices.never': 'Mai',
  'devices.active': 'Attivo',
  'devices.revokedBadge': 'Revocato',
  'devices.thisDevice': 'Questo dispositivo',
  'devices.currentNote': 'È il dispositivo che stai usando: esci per scollegarlo.',
  'devices.platformWeb': 'Browser',
  'devices.empty': 'Nessun dispositivo registrato',
  'devices.emptyHint':
    "Un dispositivo compare qui quando accedi dall'app desktop o apri un vault nel browser.",
  'devices.revoke': 'Revoca',
  'devices.revokeAria': 'Revoca {{name}}',
  'devices.confirmTitle': 'Revocare questo dispositivo?',
  'devices.confirmBody':
    '«{{name}}» smette di sincronizzare e deve accedere di nuovo per ricollegarsi. Le sue copie locali restano dove sono.',
  'devices.revoked': '«{{name}}» revocato.',

  'usage.barLabel': 'Spazio occupato',
  'usage.caption': '{{used}} di {{quota}}',
  'usage.captionUnlimited': '{{used}} occupati, nessun limite',
  'usage.percent': '{{percent}}%',
  'usage.level_ok': 'Hai ancora molto spazio.',
  'usage.level_warning': 'Il tuo spazio sta per finire.',
  'usage.level_critical': 'Il tuo spazio è quasi pieno: libera un po’ di spazio al più presto.',
  'usage.level_full':
    'Il tuo spazio è pieno: le nuove modifiche non si caricano finché non liberi spazio.',
  'usage.note':
    'Contano solo i file attuali, non la loro cronologia. Le condivisioni che ricevi contano nello spazio di chi le possiede.',
  'usage.byVault': 'Spazio per vault',
  'usage.colVault': 'Vault',
  'usage.colShare': 'Quota dello spazio occupato',
  'usage.noVaults': 'Non hai ancora vault nel cloud.',

  'shares.ownedTitle': 'Condivisi da me',
  'shares.new': 'Nuova condivisione',
  'shares.ownedEmpty': 'Non hai ancora condiviso nulla',
  'shares.ownedEmptyHint':
    'Condividi un intero vault condiviso, o una sua cartella, con «Nuova condivisione».',
  'shares.disabled': "La condivisione è disattivata dall'amministratore.",
  'shares.type_vault': 'Vault',
  'shares.type_folder': 'Cartella',
  'shares.type_file': 'Documento',
  'shares.inVault': 'in {{vault}}',
  'shares.expires': 'Scade il {{date}}',
  'shares.noExpiry': 'Nessuna scadenza',
  'shares.from': 'Da {{owner}}',
  'shares.edit': 'Modifica',
  'shares.editAria': 'Modifica {{name}}',
  'shares.manage': 'Gestisci accessi',
  'shares.hide': 'Nascondi accessi',
  'shares.manageAria': 'Accessi a {{name}}',
  'shares.revoke': 'Revoca',
  'shares.revokeAria': 'Revoca {{name}}',
  'shares.revokeTitle': 'Revocare «{{name}}»?',
  'shares.revokeBody':
    "Le persone e i gruppi con cui è condiviso perdono subito l'accesso. Le copie che hanno tenuto sui loro dispositivi restano a loro, scollegate.",
  'shares.revoked': '«{{name}}» revocato.',
  'shares.created': '«{{name}}» condiviso. Aggiungi le persone e i gruppi che possono vederlo.',
  'shares.updated': '«{{name}}» aggiornato.',
  'shares.managerNote': 'Gestisci questa condivisione: solo chi la possiede può revocarla.',
  'shares.shareInside': 'Condividi una parte',
  'shares.shareInsideAria': 'Condividi una parte di {{name}}',

  'shareForm.newTitle': 'Nuova condivisione',
  'shareForm.editTitle': 'Modifica «{{name}}»',
  'shareForm.vault': 'Vault',
  'shareForm.noSharedVaults':
    'Non hai vault condivisi: creane prima uno. I vault privati sono cifrati end-to-end e non si possono mai condividere.',
  'shareForm.privateExcluded':
    'I vault privati sono cifrati end-to-end e non si possono condividere, perciò non sono elencati.',
  'shareForm.what': 'Cosa condividere',
  'shareForm.wholeVault': "L'intero vault",
  'shareForm.folder': 'Una cartella',
  'shareForm.folderPath': 'Cartella',
  'shareForm.folderHint': 'Percorso dalla radice del vault, per esempio Progetti/Alfa.',
  'shareForm.name': 'Nome',
  'shareForm.nameHint': 'Quello che vedono le persone con cui condividi.',
  'shareForm.expiry': 'Scade il',
  'shareForm.expiryHint': "Facoltativa: l'accesso termina alla fine di questo giorno.",
  'shareForm.clearExpiry': 'Nessuna scadenza',
  'shareForm.create': 'Condividi',
  'shareForm.insideTitle': 'Condividi una parte di «{{name}}»',
  'shareForm.inside': 'Dentro «{{name}}» · in {{vault}}',
  'shareForm.insideNote':
    'Come gestore puoi condividere solo ciò che sta dentro questa condivisione, con accesso fino a Gestore. Chi possiede il vault può revocare ciò che crei.',
  'shareForm.wholeFolder': "L'intera cartella",
  'shareForm.subfolder': 'Una sottocartella',
  'shareForm.subfolderPath': 'Sottocartella',
  'shareForm.subfolderHint': 'Percorso dentro {{folder}}, per esempio Bozze.',

  'grants.caption': 'Accessi',
  'grants.none': 'Nessuno ha ancora accesso.',
  'grants.colWho': 'Chi',
  'grants.colPermission': 'Permesso',
  'grants.colStatus': 'Stato',
  'grants.colActions': 'Azioni',
  'grants.user': 'Utente',
  'grants.group': 'Gruppo',
  'grants.permission_viewer': 'Lettore',
  'grants.permission_editor': 'Editor',
  'grants.permission_manager': 'Gestore',
  'grants.status_pending': 'In attesa',
  'grants.status_accepted': 'Accettato',
  'grants.status_declined': 'Rifiutato',
  'grants.permissionOf': 'Permesso di {{name}}',
  'grants.remove': 'Rimuovi',
  'grants.removeAria': 'Rimuovi {{name}}',
  'grants.saved': 'Accesso di {{name}} aggiornato.',
  'grants.removed': '{{name}} non ha più accesso.',
  'grants.add': 'Aggiungi persone o gruppi',
  'grants.addType': 'Aggiungi un',
  'grants.searchLabel': 'Nome o nome utente',
  'grants.searchHint': 'Almeno due caratteri.',
  'grants.newPermission': 'Con il permesso',
  'grants.search': 'Cerca',
  'grants.results': 'Risultati della ricerca',
  'grants.noResults': 'Nessun risultato.',
  'grants.addOne': 'Aggiungi',
  'grants.addAria': 'Aggiungi {{name}}',
  'grants.already': 'Ha già accesso',

  'invitations.title': 'Inviti',
  'invitations.none': 'Nessun invito.',
  'invitations.accepted': 'Condivisioni accettate',
  'invitations.declined': 'Rifiutati',
  'invitations.accept': 'Accetta',
  'invitations.acceptAria': 'Accetta {{name}}',
  'invitations.decline': 'Rifiuta',
  'invitations.declineAria': 'Rifiuta {{name}}',
  'invitations.open': 'Apri',
  'invitations.openAria': 'Apri {{name}} nel browser',
  'invitations.acceptedStatus': 'Invito a «{{name}}» accettato.',
  'invitations.declinedStatus': 'Invito a «{{name}}» rifiutato.',

  'groups.caption': 'I miei gruppi',
  'groups.colName': 'Gruppo',
  'groups.colDescription': 'Descrizione',
  'groups.colRole': 'Ruolo',
  'groups.role_member': 'Membro',
  'groups.role_manager': 'Gestore',
  'groups.roleReserved': 'In questa versione il ruolo di gestore non dà permessi in più.',
  'groups.empty': 'Non fai parte di nessun gruppo.',
  'groups.note':
    'I gruppi li gestiscono gli amministratori. Si può condividere con un intero gruppo.',

  'errors.NAME_IN_USE': 'Hai già un vault con questo nome.',
  'errors.VAULT_ENCRYPTED': 'Un vault privato è cifrato end-to-end: non si può mai condividere.',
  'errors.NOT_FOUND_share': 'La condivisione non esiste più.',
  'errors.NOT_FOUND_device': 'Il dispositivo non esiste più.',
  'errors.VALIDATION_FAILED_share':
    'Controlla il nome (da 1 a 120 caratteri), la cartella e la scadenza, che deve essere nel futuro.',
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
