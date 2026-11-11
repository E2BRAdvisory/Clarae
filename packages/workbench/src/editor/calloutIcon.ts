// The icon of each callout type (the names of the shell's icon set), shared by the CodeMirror Live Preview
// and the Milkdown Live editor.
import type { IconName } from '../shell/icons';

export const CALLOUT_ICONS: Record<string, IconName> = {
  note: 'edit',
  abstract: 'list',
  summary: 'list',
  tldr: 'list',
  info: 'info',
  todo: 'task',
  tip: 'lightbulb',
  hint: 'lightbulb',
  important: 'fire',
  success: 'success',
  check: 'success',
  done: 'success',
  question: 'help',
  help: 'help',
  faq: 'help',
  warning: 'warning',
  caution: 'warning',
  attention: 'warning',
  failure: 'error',
  fail: 'error',
  missing: 'error',
  danger: 'bolt',
  error: 'bolt',
  bug: 'bug',
  example: 'example',
  quote: 'quote',
  cite: 'quote',
};

export function calloutIcon(type: string): IconName {
  return CALLOUT_ICONS[type.toLowerCase()] ?? 'edit';
}
