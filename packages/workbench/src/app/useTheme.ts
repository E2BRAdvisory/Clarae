import { useSyncExternalStore } from 'react';
import { currentTheme, watchTheme } from './theme';

/** The theme in force, followed live: the setting and, for "system", the operating system's. */
export function useEffectiveTheme(): 'light' | 'dark' {
  return useSyncExternalStore(watchTheme, currentTheme);
}
