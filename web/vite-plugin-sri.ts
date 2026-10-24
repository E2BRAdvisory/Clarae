import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/**
 * Adds Subresource Integrity (`integrity` + `crossorigin`) to the script and
 * stylesheet/modulepreload tags of the emitted index.html. Runs after the
 * bundle is written so it hashes the exact bytes served from dist/.
 */
export function sri(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'nodus-sri',
    apply: 'build',
    enforce: 'post',
    configResolved(c) {
      config = c;
    },
    writeBundle() {
      const outDir = join(config.root, config.build.outDir);
      const indexPath = join(outDir, 'index.html');
      const html = readFileSync(indexPath, 'utf8');
      const integrity = (url: string): string => {
        const file = join(outDir, url.replace(/^\//, '').split(/[?#]/)[0] ?? '');
        const digest = createHash('sha384').update(readFileSync(file)).digest('base64');
        return `sha384-${digest}`;
      };
      const patched = html.replace(
        /<(script|link)\b([^>]*)>/g,
        (tag, name: string, attrs: string) => {
          const m = /\b(?:src|href)="(\/[^"]+)"/.exec(attrs);
          if (!m?.[1]) return tag;
          const isScript = name === 'script' && /\bsrc=/.test(attrs);
          const isStyle = name === 'link' && /rel="(?:stylesheet|modulepreload)"/.test(attrs);
          if (!isScript && !isStyle) return tag;
          let out = attrs.replace(/\s+(?:integrity|crossorigin)(?:="[^"]*")?/g, '');
          out = `${out.replace(/\s*\/$/, '')} crossorigin integrity="${integrity(m[1])}"`;
          return `<${name}${out}>`;
        },
      );
      writeFileSync(indexPath, patched);
    },
  };
}
