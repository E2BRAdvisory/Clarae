// The few messages the workbench page shows before (and instead of) the UI, and the page-level overlays
// that cover it (a locked private vault, a stopped engine). Once the UI is up it has its own translations
// (it/en, packages/workbench/src/i18n). The texts live in the Web UI resources under `workbench.*`
// (covered by their consistency test), plus Retry/Cancel from the strings shared with @memobrain/ui
// (ADR-0043); the page does not load i18next for them. Named imports keep the rest of the console's
// resources out of the page bundle.
import { common as commonEn } from '@memobrain/ui/i18n/en.json';
import { common as commonIt } from '@memobrain/ui/i18n/it.json';
import { workbench as en } from '../i18n/en.json';
import { workbench as it } from '../i18n/it.json';

type PageKey = keyof typeof en;
type CommonKey = keyof typeof commonEn;
export type MessageKey = `workbench.${PageKey}` | `common.${CommonKey}`;

/** The keys that have a `_one` / `_other` form, without the suffix. */
type PluralBase<K> = K extends `${infer B}_one` ? B : never;
export type PluralKey = PluralBase<MessageKey>;

function lookup(key: MessageKey, italian: boolean): string {
  const dot = key.indexOf('.');
  const scope = key.slice(0, dot);
  const name = key.slice(dot + 1);
  const table: Record<string, string> =
    scope === 'common' ? (italian ? commonIt : commonEn) : italian ? it : en;
  return table[name] ?? key;
}

export function message(key: MessageKey, n?: number): string {
  const text = lookup(key, document.documentElement.lang === 'it');
  return n === undefined ? text : text.replaceAll('{{count}}', String(n));
}

/** A message with a count: picks the singular or plural form. */
export function plural(key: PluralKey, n: number): string {
  return message(`${key}_${n === 1 ? 'one' : 'other'}` as MessageKey, n);
}

/** The startup steps of launch.ts, by message. */
export const STEP_MESSAGE = {
  core: 'workbench.core',
  session: 'workbench.session',
  vault: 'workbench.vault',
  ui: 'workbench.ui',
} as const satisfies Record<string, MessageKey>;
