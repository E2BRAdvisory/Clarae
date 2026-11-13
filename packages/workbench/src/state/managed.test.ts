import { describe, expect, it } from 'vitest';
import { FEATURES, FEATURE_DEFAULTS, Feature } from '@clarae/api-client/features';
import {
  featureOn,
  fromState,
  isLocked,
  managedAppearance,
  managedEditor,
  managedHotkeys,
  managedTheme,
  unmanaged,
} from './managed';
import { defaultAppearance, defaultEditorSettings, resolveSettings } from './settings';

const managed = (config: Record<string, unknown>, locked: string[] = []) =>
  fromState({ version: 3, config, lockedKeys: locked, managed: true, fetchedAt: '', features: {} });

describe('managed configuration', () => {
  it('locks a key or a whole section', () => {
    expect(isLocked(['editor.fontSize'], 'editor.fontSize')).toBe(true);
    expect(isLocked(['editor.fontSize'], 'editor.lineWrap')).toBe(false);
    expect(isLocked(['editor'], 'editor.lineWrap')).toBe(true);
    expect(isLocked(['editor'], 'editorial')).toBe(false);
    expect(isLocked([], 'x')).toBe(false);
  });

  it('maps the configuration to app settings', () => {
    const cfg = {
      editor: { fontSize: 18, lineWrap: false, linkFormat: 'path', unknown: 1 },
      appearance: { accent: '#112233', zoom: 1.25, theme: 'dark', statusBar: true },
      hotkeys: { 'palette:open': 'Mod-j', bad: 5 },
    };
    expect(managedEditor(cfg)).toEqual({ fontSize: 18, wrap: false, linkFormat: 'path' });
    expect(managedAppearance(cfg)).toEqual({ accent: '#112233', zoom: 125, statusBar: true });
    expect(managedTheme(cfg)).toBe('dark');
    expect(managedHotkeys(cfg)).toEqual({ 'palette:open': ['Mod-j'] });
    expect(managedTheme({})).toBeUndefined();
  });

  it('a feature missing from the configuration takes the default of the schema', () => {
    expect(featureOn({}, 'drawings')).toBe(true);
    expect(featureOn({ drawings: false }, 'drawings')).toBe(false);
    // Off by default in api/config-profile.schema.json: the chat placeholder. The v2 formats of
    // ADR-0034 and ADR-0042 are on by default since release N+1, and a profile can turn them off.
    expect(featureOn({}, Feature.Chat)).toBe(false);
    expect(featureOn({}, Feature.EnvelopeV2)).toBe(true);
    expect(featureOn({}, Feature.PathV2)).toBe(true);
    expect(featureOn({ envelope_v2: false }, Feature.EnvelopeV2)).toBe(false);
    expect(featureOn({ chat: true }, Feature.Chat)).toBe(true);
    for (const f of FEATURES) expect(featureOn({}, f)).toBe(FEATURE_DEFAULTS[f]);
  });
});

describe('settings resolution', () => {
  const user = { editor: {}, appearance: {}, hotkeys: {} };

  it('without a server nothing changes', () => {
    const r = resolveSettings(user, unmanaged);
    expect(r.editor).toEqual(defaultEditorSettings);
    expect(r.appearance).toEqual(defaultAppearance);
    expect(r.hotkeys).toEqual({});
  });

  it('administrator defaults apply until the user chooses, the user wins over them', () => {
    const m = managed({
      editor: { fontSize: 18, wrap: true, lineWrap: false },
      hotkeys: { 'palette:open': 'Mod-j' },
    });
    expect(resolveSettings(user, m).editor.fontSize).toBe(18);
    expect(resolveSettings(user, m).editor.wrap).toBe(false);
    const chosen = { ...user, editor: { fontSize: 12 }, hotkeys: { 'palette:open': ['Mod-k'] } };
    const r = resolveSettings(chosen, m);
    expect(r.editor.fontSize).toBe(12);
    expect(r.hotkeys['palette:open']).toEqual(['Mod-k']);
  });

  it('locked keys are forced whatever the user chose', () => {
    const m = managed(
      {
        editor: { fontSize: 18, lineWrap: false },
        appearance: { zoom: 1.5, statusBar: true },
        hotkeys: { 'palette:open': 'Mod-j' },
      },
      ['editor.fontSize', 'appearance.zoom', 'appearance.statusBar', 'hotkeys.palette:open'],
    );
    const chosen = {
      editor: { fontSize: 12, wrap: true },
      appearance: { zoom: 80, statusBar: false },
      hotkeys: { 'palette:open': ['Mod-k'] },
    };
    const r = resolveSettings(chosen, m);
    expect(r.editor.fontSize).toBe(18); // locked
    expect(r.editor.wrap).toBe(true); // managed but not locked: the user's choice stands
    expect(r.appearance.zoom).toBe(150);
    expect(r.appearance.statusBar).toBe(true); // locked on: the status bar stays
    expect(r.hotkeys['palette:open']).toEqual(['Mod-j']);
  });
});
