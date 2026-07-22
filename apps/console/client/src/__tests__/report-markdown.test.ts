import { describe, expect, it } from 'vitest';
import { parseReportMarkdown, tokenizeInline } from '../report-markdown';

describe('tokenizeInline', () => {
  it('splits **bold** into a bold token', () => {
    expect(tokenizeInline('a **bold** word')).toEqual([
      { kind: 'text', value: 'a ' },
      { kind: 'bold', value: 'bold' },
      { kind: 'text', value: ' word' },
    ]);
  });

  it('splits `code` into a code token', () => {
    expect(tokenizeInline('run `npm test` now')).toEqual([
      { kind: 'text', value: 'run ' },
      { kind: 'code', value: 'npm test' },
      { kind: 'text', value: ' now' },
    ]);
  });

  it('handles multiple tokens mixed with plain text', () => {
    expect(tokenizeInline('**A** and `b` and **c**')).toEqual([
      { kind: 'bold', value: 'A' },
      { kind: 'text', value: ' and ' },
      { kind: 'code', value: 'b' },
      { kind: 'text', value: ' and ' },
      { kind: 'bold', value: 'c' },
    ]);
  });

  it('leaves plain text with no markers as a single text token', () => {
    expect(tokenizeInline('nothing special here')).toEqual([{ kind: 'text', value: 'nothing special here' }]);
  });

  it('leaves an unterminated marker literal (not treated as a token)', () => {
    expect(tokenizeInline('a **unterminated bold')).toEqual([{ kind: 'text', value: 'a **unterminated bold' }]);
  });
});

describe('parseReportMarkdown', () => {
  it('splits paragraphs on a blank line', () => {
    const blocks = parseReportMarkdown('First paragraph.\n\nSecond paragraph.');
    expect(blocks).toEqual([
      { kind: 'paragraph', tokens: [{ kind: 'text', value: 'First paragraph.' }] },
      { kind: 'paragraph', tokens: [{ kind: 'text', value: 'Second paragraph.' }] },
    ]);
  });

  it('joins consecutive non-blank lines within one paragraph with a space', () => {
    const blocks = parseReportMarkdown('line one\nline two');
    expect(blocks).toEqual([{ kind: 'paragraph', tokens: [{ kind: 'text', value: 'line one line two' }] }]);
  });

  it('groups consecutive "- " lines into one bullets block', () => {
    const blocks = parseReportMarkdown('- item one\n- item two\n- item three');
    expect(blocks).toEqual([
      {
        kind: 'bullets',
        items: [
          [{ kind: 'text', value: 'item one' }],
          [{ kind: 'text', value: 'item two' }],
          [{ kind: 'text', value: 'item three' }],
        ],
      },
    ]);
  });

  it('a bullet list followed by a paragraph produces two separate blocks', () => {
    const blocks = parseReportMarkdown('- item one\n- item two\n\nSome closing text.');
    expect(blocks).toEqual([
      { kind: 'bullets', items: [[{ kind: 'text', value: 'item one' }], [{ kind: 'text', value: 'item two' }]] },
      { kind: 'paragraph', tokens: [{ kind: 'text', value: 'Some closing text.' }] },
    ]);
  });

  it('applies inline tokenization within paragraphs and bullets', () => {
    const blocks = parseReportMarkdown('**Result**: all green\n\n- fixed `a.spec.ts`');
    expect(blocks[0]).toEqual({
      kind: 'paragraph',
      tokens: [{ kind: 'bold', value: 'Result' }, { kind: 'text', value: ': all green' }],
    });
    expect(blocks[1]).toEqual({
      kind: 'bullets',
      items: [[{ kind: 'text', value: 'fixed ' }, { kind: 'code', value: 'a.spec.ts' }]],
    });
  });

  it('returns no blocks for empty input', () => {
    expect(parseReportMarkdown('')).toEqual([]);
    expect(parseReportMarkdown('   \n\n  ')).toEqual([]);
  });
});
