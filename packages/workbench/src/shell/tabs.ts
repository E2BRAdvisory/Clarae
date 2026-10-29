import type { LeftTab, RightTab } from '../state/store';
import type { IconName } from './icons';

/** Search is not a permanent tab: the header button opens it, and it shows only while active. */
export function leftTabs(current: LeftTab): LeftTab[] {
  return current === 'search' ? ['files', 'outline', 'search'] : ['files', 'outline'];
}

export const RIGHT_TABS: RightTab[] = ['properties', 'tags', 'links', 'slides', 'stats'];

export const RIGHT_TAB_ICONS: Record<RightTab, IconName> = {
  properties: 'properties',
  tags: 'tag',
  links: 'link',
  slides: 'slides',
  stats: 'stats',
};
