// The style of a file, read from the file: what a block that has to be written again is written with.
//
// A block the user did not touch is never written again (the original text is put back), so the style
// only matters for the blocks that changed or are new. They follow the habits of the file: `*` or `-`
// for bullets, `_` or `*` for emphasis, fences of backticks or tildes, the kind of rule, 1. 1. 1. or
// 1. 2. 3., and how far the content of a list item is indented. The counts are taken on the positions
// of the mdast, so what the file does the most wins.

export interface Style {
  bullet: '-' | '*' | '+';
  /** The delimiter of ordered lists: `1.` or `1)`. */
  bulletOrdered: '.' | ')';
  emphasis: '*' | '_';
  strong: '*' | '_';
  fence: '`' | '~';
  rule: '-' | '*' | '_';
  incrementListMarker: boolean;
  listItemIndent: 'one' | 'tab' | 'mixed';
}

export const defaultStyle: Style = {
  bullet: '-',
  bulletOrdered: '.',
  emphasis: '*',
  strong: '*',
  fence: '`',
  rule: '-',
  incrementListMarker: true,
  listItemIndent: 'one',
};

interface MdNode {
  type: string;
  children?: MdNode[] | undefined;
  position?: { start: { offset: number }; end: { offset: number } } | undefined;
  ordered?: boolean | null | undefined;
}

function walk(n: MdNode, f: (n: MdNode) => void): void {
  f(n);
  for (const c of n.children ?? []) walk(c, f);
}

/** The most frequent key of a tally, or `def`. */
function top<T extends string>(counts: Record<string, number>, def: T): T {
  let best: string = def;
  let n = 0;
  for (const [k, v] of Object.entries(counts)) {
    if (v > n) {
      best = k;
      n = v;
    }
  }
  return best as T;
}

export function inferStyle(body: string, tree: MdNode): Style {
  const bullets: Record<string, number> = {};
  const emph: Record<string, number> = {};
  const strong: Record<string, number> = {};
  const fences: Record<string, number> = {};
  const rules: Record<string, number> = {};
  const indent: Record<string, number> = {};
  const delimiters: Record<string, number> = {};
  let ordered = 0;
  let allOnes = 0;
  walk(tree, (n) => {
    const at = n.position?.start.offset;
    if (at === undefined) return;
    const ch = body[at] ?? '';
    const bump = (m: Record<string, number>, k: string): void => {
      m[k] = (m[k] ?? 0) + 1;
    };
    switch (n.type) {
      case 'listItem': {
        if ('-*+'.includes(ch) && ch !== '') {
          bump(bullets, ch);
          const gap = /^[-*+]([ \t]+)\S/.exec(body.slice(at, at + 12))?.[1];
          if (gap !== undefined) bump(indent, gap.length === 1 ? 'one' : 'tab');
        }
        break;
      }
      case 'emphasis':
        if (ch === '*' || ch === '_') bump(emph, ch);
        break;
      case 'strong':
        if (ch === '*' || ch === '_') bump(strong, ch);
        break;
      case 'code':
        if (ch === '`' || ch === '~') bump(fences, ch);
        break;
      case 'thematicBreak':
        if (ch === '-' || ch === '*' || ch === '_') bump(rules, ch);
        break;
      case 'list': {
        if (!n.ordered) break;
        const nums = (n.children ?? []).map((c) =>
          Number(
            /^\d+/.exec(
              body.slice(c.position?.start.offset ?? 0, (c.position?.start.offset ?? 0) + 12),
            )?.[0],
          ),
        );
        const delim = /^\d+([.)])/.exec(body.slice(at, at + 12))?.[1];
        if (delim) bump(delimiters, delim);
        if (nums.length > 1) {
          ordered++;
          if (nums.every((x) => x === nums[0])) allOnes++;
        }
        break;
      }
      default:
        break;
    }
  });
  return {
    bullet: top(bullets, defaultStyle.bullet),
    bulletOrdered: top(delimiters, defaultStyle.bulletOrdered),
    emphasis: top(emph, defaultStyle.emphasis),
    strong: top(strong, defaultStyle.strong),
    fence: top(fences, defaultStyle.fence),
    rule: top(rules, defaultStyle.rule),
    incrementListMarker: !(ordered > 0 && allOnes === ordered),
    listItemIndent: top(indent, defaultStyle.listItemIndent),
  };
}
