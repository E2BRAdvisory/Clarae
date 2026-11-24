// The content a new drawing or presentation starts from: the template asked for, else the one
// chosen in Settings > Daily notes & templates, else nothing (the caller has its own first content).
// A template that is gone, unreadable or not what it should be never fails a creation.
import { api, type TemplateKind } from '../app/api';
import { parseScene } from '../drawing/scene';
import { uiLang } from './lang';
import { useNotesSettings } from './settings';

export async function templateText(
  vaultId: string,
  kind: Exclude<TemplateKind, 'note'>,
  title: string,
  ref?: string,
): Promise<string | null> {
  const s = await useNotesSettings.getState().ready(vaultId);
  const chosen = ref ?? (kind === 'drawing' ? s.newDrawingTemplate : s.newPresentationTemplate);
  if (!chosen) return null;
  try {
    const text = await api.templates.expand(vaultId, chosen, title, uiLang());
    if (kind === 'drawing') parseScene(text);
    return text;
  } catch {
    return null;
  }
}
