import { describe, expect, it } from 'vitest';
import { attachmentName, attachmentUrl, isPlainUrl, isRichHtml, toBase64 } from './pasteCore';

describe('what smart paste decides', () => {
  it('keeps the name of a real file and dates a generic one', () => {
    expect(attachmentName(new File([], 'report.pdf'))).toBe('report.pdf');
    expect(attachmentName(new File([], 'image.png', { type: 'image/png' }))).toMatch(
      /^Pasted image \d{14}\.png$/,
    );
    expect(attachmentName(new File([], '', { type: 'image/webp' }))).toMatch(
      /^Pasted image \d{14}\.webp$/,
    );
  });

  it('writes the URL of an attachment encoded, its folders kept', () => {
    expect(attachmentUrl('attachments/Pasted image 1.png')).toBe(
      'attachments/Pasted%20image%201.png',
    );
    expect(attachmentUrl('a#b/c?d.png')).toBe('a%23b/c%3Fd.png');
  });

  it('takes a URL alone, and HTML that has structure', () => {
    expect(isPlainUrl(' https://example.org/a?b=1 ')).toBe(true);
    expect(isPlainUrl('see https://example.org')).toBe(false);
    expect(isPlainUrl('ftp://example.org')).toBe(false);
    expect(isRichHtml('<p>a</p>')).toBe(true);
    expect(isRichHtml('<body>a</body>')).toBe(false);
    expect(isRichHtml('<span>a</span>')).toBe(false);
  });

  it('encodes the bytes of a file in base64', async () => {
    expect(await toBase64(new File([new Uint8Array([1, 2, 3])], 'a'))).toBe('AQID');
  });
});
