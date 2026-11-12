// How the slash menu of the Live editor draws its items (the groups it sorts them in and the icon beside each).
// Presentation only, and only here: the list and the rules of the menu are slash/items.ts's, which Source
// shares and which is loaded at start, and this file loads with the editor.
import type { ChromeIconName } from '../chrome/icons';

/** The sections of the menu (the headings of its groups: `slash.group.<id>`). */
export type SlashGroup = 'text' | 'list' | 'advanced' | 'vault';

export interface SlashLook {
  group: SlashGroup;
  icon: ChromeIconName;
}

const LOOK: Record<string, SlashLook> = {
  h1: { group: 'text', icon: 'looksOne' },
  h2: { group: 'text', icon: 'looksTwo' },
  h3: { group: 'text', icon: 'looks3' },
  quote: { group: 'text', icon: 'quote' },
  callout: { group: 'text', icon: 'callout' },
  divider: { group: 'text', icon: 'separator' },
  bullet: { group: 'list', icon: 'bullet' },
  numbered: { group: 'list', icon: 'numbered' },
  task: { group: 'list', icon: 'task' },
  code: { group: 'advanced', icon: 'codeBlock' },
  table: { group: 'advanced', icon: 'table' },
  math: { group: 'advanced', icon: 'math' },
  link: { group: 'advanced', icon: 'link' },
  wikilink: { group: 'advanced', icon: 'wikilink' },
  embed: { group: 'advanced', icon: 'embed' },
  date: { group: 'advanced', icon: 'today' },
  drawing: { group: 'vault', icon: 'pencil' },
  template: { group: 'vault', icon: 'note' },
};

/** The look of an item; one that is not listed goes in Advanced with no icon. */
export const slashLook = (id: string): { group: SlashGroup; icon?: ChromeIconName } =>
  LOOK[id] ?? { group: 'advanced' };
