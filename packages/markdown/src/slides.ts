// Slides of a note (ADR-0027). The Go twin is apps/desktop/internal/parser/slides.go; both are
// checked against the fixtures in shared/conformance/slides.
import { parseProperties, splitFrontmatter } from './extract';

export const SLIDE_TRANSITIONS = ['none', 'fade', 'slide', 'zoom'] as const;
export const SLIDE_THEMES = ['auto', 'light', 'dark'] as const;
export type SlideTransition = (typeof SLIDE_TRANSITIONS)[number];
export type SlideTheme = (typeof SLIDE_THEMES)[number];

export interface SlideConfig {
  transition: SlideTransition;
  theme: SlideTheme;
  progress: boolean;
  numbers: boolean;
  /** Show the speaker notes in the presenter view. */
  notes: boolean;
}

export const DEFAULT_SLIDE_CONFIG: SlideConfig = {
  transition: 'slide',
  theme: 'auto',
  progress: true,
  numbers: false,
  notes: true,
};

export interface Slide {
  /** 1-based line (frontmatter included) of the first non-blank line of the slide. */
  line: number;
  /** Markdown of the slide, without the surrounding blank lines and the speaker notes. */
  content: string;
  /** Speaker notes (the lines after a `Note:` line), trimmed. */
  notes: string;
}

export interface SlideDeck {
  config: SlideConfig;
  slides: Slide[];
}

/** Frontmatter keys of the configuration (flat: the properties editor handles scalar values). */
export const SLIDE_KEYS = {
  transition: 'slide-transition',
  theme: 'slide-theme',
  progress: 'slide-progress',
  numbers: 'slide-numbers',
  notes: 'slide-notes',
} as const;

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

export function parseSlideConfig(src: string): SlideConfig {
  const p = parseProperties(src);
  return {
    transition: oneOf(p[SLIDE_KEYS.transition], SLIDE_TRANSITIONS, DEFAULT_SLIDE_CONFIG.transition),
    theme: oneOf(p[SLIDE_KEYS.theme], SLIDE_THEMES, DEFAULT_SLIDE_CONFIG.theme),
    progress: bool(p[SLIDE_KEYS.progress], DEFAULT_SLIDE_CONFIG.progress),
    numbers: bool(p[SLIDE_KEYS.numbers], DEFAULT_SLIDE_CONFIG.numbers),
    notes: bool(p[SLIDE_KEYS.notes], DEFAULT_SLIDE_CONFIG.notes),
  };
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const SEPARATOR = /^---[ \t]*$/;
const NOTES = /^note:[ \t]*(.*)$/i;

interface Draft {
  lines: { n: number; text: string }[];
  notes: string[];
  inNotes: boolean;
}

const fresh = (): Draft => ({ lines: [], notes: [], inNotes: false });

function finish(d: Draft): Slide | null {
  const first = d.lines.findIndex((l) => l.text.trim() !== '');
  if (first < 0) return null; // nothing to show
  let last = d.lines.length - 1;
  while ((d.lines[last] as { text: string }).text.trim() === '') last--;
  return {
    line: (d.lines[first] as { n: number }).n,
    content: d.lines
      .slice(first, last + 1)
      .map((l) => l.text)
      .join('\n'),
    notes: d.notes.join('\n').trim(),
  };
}

/** Splits a note into slides and reads its configuration. */
export function parseSlides(src: string): SlideDeck {
  const text = src.startsWith('\uFEFF') ? src.slice(1) : src;
  const fm = splitFrontmatter(text);
  const lines = fm.body.split('\n').map((l) => l.replace(/\r$/, ''));
  const slides: Slide[] = [];
  let cur = fresh();
  let fence: { char: string; len: number } | null = null;
  let math = false;
  const push = (): void => {
    const s = finish(cur);
    if (s) slides.push(s);
    cur = fresh();
  };

  lines.forEach((line, i) => {
    const n = fm.lines + i + 1;
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.char === '`' ? '`' : '~'}{${fence.len},}[ \\t]*$`);
      if (close.test(line)) fence = null;
    } else if (math) {
      if (line.trim() === '$$') math = false;
    } else {
      const open = FENCE_OPEN.exec(line);
      if (open) {
        const marker = open[1] as string;
        fence = { char: marker[0] as string, len: marker.length };
      } else if (line.trim() === '$$') {
        math = true;
      } else if (SEPARATOR.test(line) && (i === 0 || (lines[i - 1] as string).trim() === '')) {
        push();
        return;
      } else {
        const note = NOTES.exec(line);
        if (note && !cur.inNotes) {
          cur.inNotes = true;
          if ((note[1] as string) !== '') cur.notes.push(note[1] as string);
          return;
        }
      }
    }
    if (cur.inNotes) cur.notes.push(line);
    else cur.lines.push({ n, text: line });
  });
  push();
  return { config: parseSlideConfig(text), slides };
}
