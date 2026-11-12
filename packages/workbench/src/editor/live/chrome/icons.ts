// The icons of the chrome of the Live editor (the block handle, the slash menu, the link tooltip): the
// Two tone set of the application (D-01: no other icons), drawn from the application's table and from the
// one of this folder, which loads with the lazy editor chunk (scripts/gen-icons.mjs).
import { ICON_DATA } from '../../../shell/iconData';
import { svgIcon, type IconName } from '../../../shell/icons';
import { ICON_DATA as LIVE_ICON_DATA } from './iconData';

export type LiveIconName = keyof typeof LIVE_ICON_DATA;
/** Any icon the chrome may draw. */
export type ChromeIconName = IconName | LiveIconName;

const table: Record<string, readonly (readonly [string, number?])[]> = {
  ...ICON_DATA,
  ...LIVE_ICON_DATA,
};

/** The icon as a DOM node (`aria-hidden`: the button that holds it has the name). */
export function chromeIcon(name: ChromeIconName, size = 18): SVGSVGElement {
  return svgIcon(table[name] ?? [], size);
}

/**
 * The icon as markup, for the components of Milkdown that take an icon as a string (the link tooltip, the
 * toolbar). They sanitize it before they draw it.
 */
export function chromeIconSvg(name: ChromeIconName, size = 18): string {
  return chromeIcon(name, size).outerHTML;
}

/** `text` as an HTML text node, escaped (it goes inside a string of markup). */
export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Markup for an icon button that Milkdown draws as an icon only: the icon and its name for a screen reader. */
export function namedIcon(name: ChromeIconName, label: string, size = 18): string {
  return `${chromeIconSvg(name, size)}<span class="live-sr">${escapeHtml(label)}</span>`;
}
