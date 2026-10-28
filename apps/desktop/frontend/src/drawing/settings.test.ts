import { describe, expect, it } from 'vitest';
import {
  defaultDrawingSettings,
  defaultItemState,
  drawingDir,
  drawingName,
  parseDrawingSettings,
} from './settings';

describe('parseDrawingSettings', () => {
  it('falls back to defaults on empty or broken files', () => {
    expect(parseDrawingSettings('')).toEqual(defaultDrawingSettings);
    expect(parseDrawingSettings('{nope')).toEqual(defaultDrawingSettings);
  });

  it('keeps valid keys and drops invalid values', () => {
    const s = parseDrawingSettings(
      JSON.stringify({
        defaultMode: 'bogus',
        creationLocation: 'folder',
        creationFolder: 'Drawings',
        embedWidth: -5,
        nameFormat: '  ',
        unknown: 1,
      }),
    );
    expect(s).toEqual({
      ...defaultDrawingSettings,
      creationLocation: 'folder',
      creationFolder: 'Drawings',
    });
  });

  it('clamps the embed width', () => {
    expect(parseDrawingSettings('{"embedWidth": 99999}').embedWidth).toBe(4000);
  });
});

describe('drawingName', () => {
  const now = new Date(2026, 9, 24, 9, 5);
  it('expands tokens and strips unsafe characters', () => {
    expect(drawingName(defaultDrawingSettings, now)).toBe('Drawing 2026-10-24 09.05');
    expect(drawingName({ nameFormat: 'a/b:{DD}' }, now)).toBe('a-b-24');
  });
});

describe('drawingDir', () => {
  const editor = { attachmentLocation: 'folder', attachmentsFolder: 'files' } as const;
  it('picks the folder by location mode', () => {
    expect(drawingDir({ creationLocation: 'current', creationFolder: '' }, editor, 'a/b.md')).toBe(
      'a',
    );
    expect(drawingDir({ creationLocation: 'current', creationFolder: '' }, editor, null)).toBe('');
    expect(
      drawingDir({ creationLocation: 'folder', creationFolder: '/D/' }, editor, 'a/b.md'),
    ).toBe('D');
    expect(
      drawingDir({ creationLocation: 'attachments', creationFolder: '' }, editor, 'a/b.md'),
    ).toBe('files');
  });
});

describe('export settings', () => {
  it('validates scale, padding and auto-export choices', () => {
    const s = parseDrawingSettings(
      JSON.stringify({
        exportScale: 7,
        exportPadding: 9999,
        autoExport: 'gif',
        autoExportTheme: 'dark',
      }),
    );
    expect(s.exportScale).toBe(2);
    expect(s.exportPadding).toBe(200);
    expect(s.autoExport).toBe('none');
    expect(s.autoExportTheme).toBe('dark');
    expect(parseDrawingSettings('{"autoExport":"both","exportScale":3}')).toMatchObject({
      autoExport: 'both',
      exportScale: 3,
    });
  });
});

describe('tool favorites', () => {
  it('keeps unique ids and drops anything else', () => {
    expect(
      parseDrawingSettings('{"toolFavorites":["a","b","a",3,null,"c"]}').toolFavorites,
    ).toEqual(['a', 'b', 'c']);
    expect(parseDrawingSettings('{"toolFavorites":"x"}').toolFavorites).toEqual([]);
  });
});

describe('default element style', () => {
  it('validates colors, font and size, and falls back to "no default"', () => {
    const s = parseDrawingSettings(
      JSON.stringify({
        defaultStroke: 'red',
        defaultFill: '#ABCDEF',
        defaultFont: 4,
        defaultFontSize: 500,
      }),
    );
    expect(s).toMatchObject({
      defaultStroke: '',
      defaultFill: '#ABCDEF',
      defaultFont: 0,
      defaultFontSize: 0,
    });
    expect(
      parseDrawingSettings('{"defaultFill":"transparent","defaultFont":6,"defaultFontSize":24}'),
    ).toMatchObject({
      defaultFill: 'transparent',
      defaultFont: 6,
      defaultFontSize: 24,
    });
  });

  it('maps only what is set to the editor state', () => {
    expect(defaultItemState(defaultDrawingSettings)).toEqual({});
    expect(
      defaultItemState({
        defaultStroke: '#e03131',
        defaultFill: '',
        defaultFont: 5,
        defaultFontSize: 0,
      }),
    ).toEqual({ currentItemStrokeColor: '#e03131', currentItemFontFamily: 5 });
  });
});
