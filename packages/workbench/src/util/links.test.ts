import { afterEach, describe, expect, it, vi } from 'vitest';
import { configurePlatform } from '../platform';
import { handleLinkClick, installLinkGuard, interceptLinks } from './links';

afterEach(() => {
  document.body.replaceChildren();
  configurePlatform();
  vi.restoreAllMocks();
});

function rendered(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

const click = (el: Element, init: MouseEventInit = {}): MouseEvent => {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
};

describe('interceptLinks', () => {
  it('opens wikilinks and relative links in the vault, never navigating', () => {
    const root = rendered(
      '<a class="wikilink" data-target="Other" data-heading="H" data-block="">x</a>' +
        '<a href="Sub%20dir/100%.md#part">y</a>',
    );
    const openLink = vi.fn();
    interceptLinks(root, { openLink });
    const [wiki, rel] = root.querySelectorAll('a');
    expect(click(wiki as Element).defaultPrevented).toBe(true);
    expect(openLink).toHaveBeenLastCalledWith(
      { target: 'Other', heading: 'H', block: '', alias: '', embed: false },
      false,
    );
    expect(click(rel as Element, { ctrlKey: true }).defaultPrevented).toBe(true);
    // A malformed escape is kept as written instead of throwing.
    expect(openLink).toHaveBeenLastCalledWith(
      { target: 'Sub%20dir/100%.md', heading: '', block: '', alias: '', embed: false },
      true,
    );
  });

  it('sends external URLs outside the app and drops unsafe ones', () => {
    configurePlatform({ kind: 'web' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const root = rendered(
      '<a href="https://example.com/">e</a><a href="javascript:alert(1)">j</a>',
    );
    interceptLinks(root, {});
    const [ext, js] = root.querySelectorAll('a');
    expect(click(ext as Element).defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
    expect(click(js as Element).defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledOnce();
  });

  it('routes tags to the search and leaves in-page anchors alone', () => {
    const root = rendered('<a class="tag" data-tag="#idea">#idea</a><a href="#fn-1">1</a>');
    const searchTag = vi.fn();
    const stop = interceptLinks(root, { searchTag });
    const [tag, foot] = root.querySelectorAll('a');
    expect(click(tag as Element).defaultPrevented).toBe(true);
    expect(searchTag).toHaveBeenCalledWith('#idea');
    expect(click(foot as Element).defaultPrevented).toBe(false);
    stop();
    expect(click(tag as Element).defaultPrevented).toBe(false);
  });

  it('reports whether the click was on a link', () => {
    const root = rendered('<p>text <a href="Note.md">n</a></p>');
    const p = root.querySelector('p') as Element;
    expect(
      handleLinkClick({ target: p, metaKey: false, ctrlKey: false, preventDefault() {} }, {}),
    ).toBe(false);
  });
});

describe('installLinkGuard', () => {
  it('stops any unhandled anchor from navigating, except downloads and host links', () => {
    configurePlatform({ kind: 'web' });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    installLinkGuard();
    installLinkGuard(); // once only
    const root = rendered(
      '<a href="Other.md">a</a><a href="https://example.com/">b</a>' +
        '<a href="blob:x" download="f.zip">c</a><a href="/vaults" data-allow-navigation>d</a>',
    );
    const [rel, ext, dl, host] = root.querySelectorAll('a');
    expect(click(rel as Element).defaultPrevented).toBe(true);
    expect(click(ext as Element).defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledOnce();
    expect(click(dl as Element).defaultPrevented).toBe(false);
    expect(click(host as Element).defaultPrevented).toBe(false);
  });
});
