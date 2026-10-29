import { describe, expect, it } from 'vitest';
import { excalidrawLang } from './lang';

const codes = ['en', 'it-IT', 'pt-BR', 'pt-PT', 'de-DE'];

describe('excalidrawLang', () => {
  it('maps a bare language to its regional variant', () => {
    expect(excalidrawLang('it', codes)).toBe('it-IT');
    expect(excalidrawLang('de', codes)).toBe('de-DE');
  });
  it('prefers an exact match', () => {
    expect(excalidrawLang('pt-PT', codes)).toBe('pt-PT');
    expect(excalidrawLang('pt_br', codes)).toBe('pt-BR');
  });
  it('falls back to English', () => {
    expect(excalidrawLang('xx', codes)).toBe('en');
    expect(excalidrawLang('en-GB', codes)).toBe('en');
  });
});
