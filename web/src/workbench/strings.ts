// The few messages the workbench page shows before (and instead of) the UI. Once the UI is up it has its
// own translations (it/en, packages/workbench/src/i18n).
const EN = {
  core: 'Starting the vault engine…',
  session: 'Signing in to the cloud…',
  vault: 'Opening the vault…',
  ui: 'Loading the interface…',
  busy: 'A vault is already open in another tab of this browser. Close it and open this one again.',
  noCore: 'The vault engine is not part of this build.',
  notFound: 'This address does not point to a vault.',
  failed: 'The vault could not be opened:',
  disabled: 'Your administrator has turned off opening vaults in the browser.',
  back: 'Back to the console',
} as const;

const IT: Record<keyof typeof EN, string> = {
  core: 'Avvio del motore dei vault…',
  session: 'Accesso al cloud…',
  vault: 'Apertura del vault…',
  ui: "Caricamento dell'interfaccia…",
  busy: 'Un vault è già aperto in un’altra scheda di questo browser. Chiudila e apri di nuovo questo.',
  noCore: 'Il motore dei vault non fa parte di questa versione.',
  notFound: 'Questo indirizzo non punta a un vault.',
  failed: 'Non è stato possibile aprire il vault:',
  disabled: "L'amministratore ha disattivato l'apertura dei vault nel browser.",
  back: 'Torna alla console',
};

export type MessageKey = keyof typeof EN;

export function message(key: MessageKey): string {
  return (document.documentElement.lang === 'it' ? IT : EN)[key];
}
