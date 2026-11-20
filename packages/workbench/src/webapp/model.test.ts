import { describe, expect, it } from 'vitest';
import {
  checkWebappUrl,
  completeUrl,
  fileNameOf,
  isWebapp,
  nameOf,
  parseWebapp,
  serializeWebapp,
  suggestName,
} from './model';

describe('checkWebappUrl', () => {
  it('accepts http and https with a host', () => {
    expect(checkWebappUrl('https://example.com')).toMatchObject({
      ok: true,
      origin: 'https://example.com',
      host: 'example.com',
    });
    expect(checkWebappUrl('http://localhost:3000/app?x=1#y')).toMatchObject({
      ok: true,
      origin: 'http://localhost:3000',
    });
    expect(checkWebappUrl('HTTPS://Example.COM:443/')).toMatchObject({
      ok: true,
      origin: 'https://example.com',
    });
    expect(checkWebappUrl('http://[::1]:8080/')).toMatchObject({ ok: true });
  });

  it('refuses every scheme that is not http or https', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'clarae://open?vault=x',
      'wails://wails/index.html',
      'mailto:a@b.c',
      'ftp://example.com/',
      'blob:https://example.com/id',
      'about:blank',
    ])
      expect(checkWebappUrl(url), url).toEqual({ ok: false, reason: 'scheme' });
  });

  it('gives the reasons of the core', () => {
    const reason = (url: string): string => {
      const c = checkWebappUrl(url);
      return c.ok ? 'ok' : c.reason;
    };
    expect(reason('')).toBe('empty');
    expect(reason(`https://example.com/${'a'.repeat(17000)}`)).toBe('too-long');
    expect(reason('https://exa mple.com')).toBe('characters');
    expect(reason('https://example.com\\evil.test')).toBe('characters');
    expect(reason('https://example.com/‮')).toBe('characters');
    expect(reason('example.com')).toBe('malformed');
    expect(reason('http:example.com')).toBe('malformed');
    expect(reason('https://user:secret@example.com/')).toBe('credentials');
    expect(reason('https://user@example.com/')).toBe('credentials');
    expect(reason('https:///path')).toBe('host');
    expect(reason('https://example.com:0/')).toBe('port');
    expect(reason('https://example.com:65536/')).toBe('port');
    expect(reason('https://example.com:abc/')).toBe('malformed');
  });
});

describe('parseWebapp', () => {
  const text = (o: unknown): string => JSON.stringify(o);

  it('reads a version 1 file', () => {
    expect(parseWebapp(text({ version: 1, url: 'https://example.com/x' }))).toEqual({
      ok: true,
      url: 'https://example.com/x',
      origin: 'https://example.com',
      host: 'example.com',
    });
  });

  it('is tolerant of what does not matter', () => {
    const withBom = `${String.fromCharCode(0xfeff)}  ${text({ url: 'https://example.com', title: 'x', extra: [1] })}\n`;
    expect(parseWebapp(withBom)).toMatchObject({ ok: true, url: 'https://example.com' });
  });

  it('is strict about what does', () => {
    expect(parseWebapp('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseWebapp('{')).toEqual({ ok: false, reason: 'json' });
    expect(parseWebapp('[]')).toEqual({ ok: false, reason: 'shape' });
    expect(parseWebapp('"https://example.com"')).toEqual({ ok: false, reason: 'shape' });
    expect(parseWebapp(text({ version: 1 }))).toEqual({ ok: false, reason: 'shape' });
    expect(parseWebapp(text({ version: 1, url: 7 }))).toEqual({ ok: false, reason: 'shape' });
    expect(parseWebapp(text({ version: 2, url: 'https://example.com' }))).toEqual({
      ok: false,
      reason: 'version',
    });
  });

  it('refuses an address that is not http or https, whatever the file says', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x'])
      expect(parseWebapp(text({ version: 1, url })), url).toEqual({ ok: false, reason: 'scheme' });
    expect(parseWebapp(text({ version: 1, url: 'https://u:p@example.com' }))).toEqual({
      ok: false,
      reason: 'credentials',
    });
  });

  it('writes what it reads', () => {
    const out = serializeWebapp('https://example.com/a');
    expect(out.endsWith('\n')).toBe(true);
    expect(JSON.parse(out)).toEqual({ version: 1, url: 'https://example.com/a' });
    expect(parseWebapp(out)).toMatchObject({ ok: true, url: 'https://example.com/a' });
  });
});

describe('names and typed addresses', () => {
  it('recognizes the files', () => {
    expect(isWebapp('Tools/GitHub.webapp')).toBe(true);
    expect(isWebapp('Tools/GitHub.WEBAPP')).toBe(true);
    expect(isWebapp('Tools/GitHub.webapp.md')).toBe(false);
  });

  it('suggests a name from the host', () => {
    expect(suggestName('https://www.example.com/a')).toBe('example.com');
    expect(suggestName('nonsense')).toBe('');
  });

  it('makes a name fit for a file', () => {
    expect(fileNameOf('  My: app/1 ')).toBe('My app 1');
    expect(fileNameOf('..hidden')).toBe('hidden');
    expect(fileNameOf('a\u0000b')).toBe('a b');
  });

  it('completes what a person types', () => {
    expect(completeUrl('example.com')).toBe('https://example.com');
    expect(completeUrl(' localhost:3000/x ')).toBe('https://localhost:3000/x');
    expect(completeUrl('http://intranet/')).toBe('http://intranet/');
    expect(completeUrl('')).toBe('');
    // a scheme of its own stays as typed, to be refused for what it is
    expect(completeUrl('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(checkWebappUrl(completeUrl('javascript:alert(1)'))).toEqual({
      ok: false,
      reason: 'scheme',
    });
    expect(checkWebappUrl(completeUrl('mailto:a@b.c'))).toEqual({ ok: false, reason: 'scheme' });
  });
});

describe('nameOf', () => {
  it('is the name of the file without the extension, in any folder and any case', () => {
    expect(nameOf('Docs.webapp')).toBe('Docs');
    expect(nameOf('Tools/Status board.webapp')).toBe('Status board');
    expect(nameOf('Tools/GitHub.WEBAPP')).toBe('GitHub');
    expect(nameOf('example.com.webapp')).toBe('example.com');
    expect(nameOf('Notes/a.md')).toBe('a'); // as the interface shows any file the application opens
    expect(nameOf('Docs/Report.docx')).toBe('Report.docx');
  });
});
