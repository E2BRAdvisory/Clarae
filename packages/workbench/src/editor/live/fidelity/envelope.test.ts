import { splitFrontmatter } from '@memobrain/markdown';
import { describe, expect, it } from 'vitest';
import {
  adoptFrontmatter,
  guardLeadingRule,
  joinEnvelope,
  sameBody,
  splitEnvelope,
  splitInserted,
} from './envelope';

const FILES: Record<string, string> = {
  plain: 'Hello\n\nWorld\n',
  empty: '',
  'only newline': '\n',
  'no final newline': 'Hello\n\nWorld',
  'many final newlines': 'Hello\n\n\n\n',
  frontmatter: '---\ntitle: A\ntags: [x]\n---\n\nBody\n',
  'frontmatter without body': '---\ntitle: A\n---\n',
  'frontmatter, blank lines and spaces after': '---\ntitle: A\n---  \n\n\nBody  \n',
  bom: '\uFEFFHello\n',
  'bom and frontmatter': '\uFEFF---\na: 1\n---\nBody\n',
  crlf: 'a\r\n\r\nb\r\n',
  'crlf frontmatter': '---\r\na: 1\r\n---\r\nBody\r\n',
  'crlf no final newline': 'a\r\nb',
  'bom crlf': '\uFEFFa\r\nb\r\n',
  // the second mark is text of the body: the indexer takes off one, and sees no frontmatter behind two
  'two bom': '\uFEFF\uFEFFHello\n',
  'two bom and what looks like a frontmatter': '\uFEFF\uFEFF---\na: 1\n---\nBody\n',
  'lone CR': 'a\rb\n',
  'trailing spaces and tabs': 'a  \n\tb \t\n',
};

describe('envelope', () => {
  for (const [name, raw] of Object.entries(FILES)) {
    it(`gives back "${name}" byte for byte`, () => {
      const env = splitEnvelope(raw);
      expect(env.mixedEol).toBe(false);
      expect(joinEnvelope(env, env.body)).toBe(raw);
    });
  }

  it('takes the BOM, the frontmatter and the dominant line ending apart', () => {
    const env = splitEnvelope('\uFEFF---\r\ntitle: A\r\n---\r\nBody\r\nmore\r\n');
    expect(env.bom).toBe('\uFEFF');
    expect(env.frontmatter).toBe('---\ntitle: A\n---\n');
    expect(env.eol).toBe('\r\n');
    expect(env.body).toBe('Body\nmore\n');
  });

  it('refuses a file with both kinds of line ending: the layer would normalise it', () => {
    expect(splitEnvelope('a\r\nb\nc\r\n').mixedEol).toBe(true);
    expect(splitEnvelope('a\nb\n').mixedEol).toBe(false);
  });

  it('the dominant line ending of a tie is LF', () => {
    expect(splitEnvelope('a\r\nb\n').eol).toBe('\n');
  });

  it('a frontmatter that is not closed is body', () => {
    const env = splitEnvelope('---\ntitle: A\nBody\n');
    expect(env.frontmatter).toBe('');
    expect(env.body).toBe('---\ntitle: A\nBody\n');
  });

  it('only the body counts when two files are compared', () => {
    const a = splitEnvelope('---\na: 1\n---\nBody\n');
    expect(sameBody(a, splitEnvelope('---\na: 2\n---\nBody\n'))).toBe(true);
    expect(sameBody(a, splitEnvelope('---\r\na: 1\r\n---\r\nBody\r\n'))).toBe(true);
    expect(sameBody(a, splitEnvelope('---\na: 1\n---\nBody!\n'))).toBe(false);
    expect(sameBody(a, splitEnvelope('---\na: 1\n---\nBody\r\n\nx'))).toBe(false);
  });
});

describe('a rule at the start of the body (M6)', () => {
  const body = '---\n\ntext\n\n---\n\nmore\n';

  it('is read as a frontmatter by the index: the case the guard is for', () => {
    expect(splitFrontmatter(body).yaml).not.toBeNull();
  });

  it('is written *** so the file does not change meaning at the next reload', () => {
    const written = joinEnvelope(splitEnvelope(''), body);
    expect(written.startsWith('***\n')).toBe(true);
    const again = splitEnvelope(written);
    expect(again.frontmatter).toBe('');
    expect(again.body).toBe(written);
  });

  it('is left alone when no other rule follows (nothing reads it as a frontmatter)', () => {
    expect(guardLeadingRule('', '---\n\ntext\n')).toBe('---\n\ntext\n');
  });

  it('is left alone in a note that has a frontmatter of its own', () => {
    const env = splitEnvelope('---\na: 1\n---\n---\ntext\n---\n');
    expect(env.frontmatter).toBe('---\na: 1\n---\n');
    expect(joinEnvelope(env, env.body)).toBe('---\na: 1\n---\n---\ntext\n---\n');
  });

  it('only touches the first line, and only the bare rule', () => {
    expect(guardLeadingRule('', '---\n\ntext\n\n---\n')).toBe('***\n\ntext\n\n---\n');
    expect(guardLeadingRule('', '***\n\ntext\n\n---\n')).toBe('***\n\ntext\n\n---\n');
    // a rule the index does not read as a frontmatter opening is not touched
    expect(splitFrontmatter('--- \n\ntext\n\n---\n').yaml).toBeNull();
    expect(guardLeadingRule('', '--- \n\ntext\n\n---\n')).toBe('--- \n\ntext\n\n---\n');
  });
});

describe('a fragment inserted with a frontmatter (a template, a paste)', () => {
  const template = '---\ntags: [daily]\n---\n# Day\n';

  it('has its frontmatter apart: it belongs to the envelope, not to the editor', () => {
    expect(splitInserted(template)).toEqual({
      frontmatter: '---\ntags: [daily]\n---\n',
      body: '# Day\n',
    });
    expect(splitInserted('no frontmatter\n')).toEqual({
      frontmatter: '',
      body: 'no frontmatter\n',
    });
    expect(splitInserted('---\r\na: 1\r\n---\r\nx\r\n').frontmatter).toBe('---\na: 1\n---\n');
  });

  it('has no mark in its frontmatter: a note with a mark of its own is not left with two', () => {
    const fragment = '\uFEFF' + template;
    expect(splitInserted(fragment)).toEqual({
      frontmatter: '---\ntags: [daily]\n---\n',
      body: '# Day\n',
    });
    const env = adoptFrontmatter(splitEnvelope('\uFEFFHello\n'), splitInserted(fragment));
    const file = joinEnvelope(env, '# Day\nHello\n');
    expect(file).toBe('\uFEFF---\ntags: [daily]\n---\n# Day\nHello\n');
    // what the indexer reads: the block, as a frontmatter
    expect(splitFrontmatter(file).yaml).toBe('tags: [daily]\n');
    expect(splitEnvelope(file).frontmatter).toBe('---\ntags: [daily]\n---\n');
    // a fragment with a mark and no frontmatter is left as it is
    expect(splitInserted('\uFEFFplain\n')).toEqual({ frontmatter: '', body: '\uFEFFplain\n' });
  });

  it('becomes the frontmatter of a note that has none', () => {
    const env = splitEnvelope('Hello\n');
    const next = adoptFrontmatter(env, splitInserted(template));
    expect(next.frontmatter).toBe('---\ntags: [daily]\n---\n');
    expect(joinEnvelope(next, '# Day\nHello\n')).toBe('---\ntags: [daily]\n---\n# Day\nHello\n');
  });

  it('does not replace the frontmatter a note already has', () => {
    const env = splitEnvelope('---\na: 1\n---\nHello\n');
    expect(adoptFrontmatter(env, splitInserted(template))).toBe(env);
  });
});
