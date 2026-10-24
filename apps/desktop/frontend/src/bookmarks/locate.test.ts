import { describe, expect, it } from 'vitest';
import { blockAtLine, headingAtLine, newBlockId } from './locate';

const doc = [
  '---',
  'title: x',
  '---',
  '# Top',
  'intro line',
  '',
  '## Sub',
  'first para line',
  'second para line ^abc-1',
  '',
  '- item one',
  '- item two ^two',
].join('\n');

describe('headingAtLine', () => {
  it('finds the heading above the line, with frontmatter offset', () => {
    expect(headingAtLine(doc, 5)).toEqual({ text: 'Top', level: 1 });
    expect(headingAtLine(doc, 8)).toEqual({ text: 'Sub', level: 2 });
    expect(headingAtLine(doc, 2)).toBeNull();
  });
});

describe('blockAtLine', () => {
  it('uses the whole paragraph and reads its id', () => {
    expect(blockAtLine(doc, 8)).toEqual({ id: 'abc-1', endLine: 9 });
    expect(blockAtLine(doc, 9)).toEqual({ id: 'abc-1', endLine: 9 });
  });
  it('treats list items as single blocks', () => {
    expect(blockAtLine(doc, 11)).toEqual({ id: null, endLine: 11 });
    expect(blockAtLine(doc, 12)).toEqual({ id: 'two', endLine: 12 });
  });
  it('has no block on blank lines and headings', () => {
    expect(blockAtLine(doc, 6)).toBeNull();
    expect(blockAtLine(doc, 7)).toBeNull();
    expect(blockAtLine(doc, 99)).toBeNull();
  });
});

describe('newBlockId', () => {
  it('makes six base-36 characters', () => {
    expect(newBlockId()).toMatch(/^[a-z0-9]{6}$/);
  });
});
