// Where new notes and pasted attachments go, given the location modes of the
// Files & links settings (pure, so the rules are tested without the UI).
import { isConfigPath } from '../platform/vaultPaths';
import type { EditorSettings } from '../state/settings';

export type NoteLocation = 'folder' | 'current';
export type AttachmentLocation = 'folder' | 'current' | 'subfolder';

const trimSlashes = (s: string): string => s.replace(/^\/+|\/+$/g, '');

/** Folder of a vault path ('' = vault root). */
export function folderOf(path: string | null | undefined): string {
  // A template open in a tab lives in the configuration folder: what is created "next to the
  // active file" goes to the vault root, never among the settings.
  if (!path || !path.includes('/') || isConfigPath(path)) return '';
  return path.slice(0, path.lastIndexOf('/'));
}

const join = (a: string, b: string): string => [a, b].filter(Boolean).join('/');

/** Folder for a new note: the configured one, or the folder of the active note. */
export function newNoteDir(
  s: Pick<EditorSettings, 'newNoteLocation' | 'newNoteFolder'>,
  activePath: string | null,
): string {
  if (s.newNoteLocation === 'current') return folderOf(activePath);
  return trimSlashes(s.newNoteFolder);
}

/** Folder for an attachment saved from the note at notePath. */
export function attachmentDir(
  s: Pick<EditorSettings, 'attachmentLocation' | 'attachmentsFolder'>,
  notePath: string,
): string {
  const folder = trimSlashes(s.attachmentsFolder);
  switch (s.attachmentLocation) {
    case 'current':
      return folderOf(notePath);
    case 'subfolder':
      return join(folderOf(notePath), folder || 'attachments');
    default:
      return folder;
  }
}
