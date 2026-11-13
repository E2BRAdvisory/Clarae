import { parseSlides } from '@clarae/markdown';
import { api } from '../app/api';
import { useActiveNote } from '../state/activeNote';
import { selectActivePath, useAppStore } from '../state/store';
import { dialog } from '../ui/dialogs';
import { slideIndexAtLine } from './model';
import { useSlideshow } from './store';

/**
 * Starts the presentation of the note in focus, from its first slide or (`here`) from the slide
 * that holds the cursor.
 */
export async function startSlideshow(here: boolean): Promise<void> {
  const st = useAppStore.getState();
  const path = selectActivePath(st);
  if (!st.vault || !path || !/\.md$/i.test(path)) return;
  let index = 0;
  if (here) {
    try {
      const live = useActiveNote.getState().note;
      const text =
        live && live.path === path && live.vaultId === st.vault.id
          ? live.current()
          : (await api.vault.readNote(st.vault.id, path)).content;
      index = slideIndexAtLine(parseSlides(text), st.stats?.line ?? 1);
    } catch (e) {
      await dialog.error(e);
      return;
    }
  }
  useSlideshow.getState().start(st.vault.id, path, index);
}
