import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import {
  hidePreview,
  isPreviewOpen,
  previewElement,
  schedulePreview,
  showPreview,
} from './popover';
import { loadPreview, stripRemoteResources } from './service';
import { previewWanted } from './hover';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { useSettings } from '../state/settings';
import { useAppStore } from '../state/store';
import { installWailsMock } from '../test/wails-mock';
import { activeTab, emptyLayout } from '../workspace/layout';

let vaultId = '';
let seq = 0;

const NOTE = [
  '---',
  'title: hidden',
  '---',
  '# Alpha',
  'Intro text with [[Other#Deep]] and ![x](https://evil.example/p.png)',
  '',
  '<script>window.__pwned = 1</script>',
  '<img src="https://evil.example/a.png" alt="remote">',
  '',
  '## Deep',
  'Deep body ^deep1',
  '',
  '## Next',
  'Other body',
].join('\n');

async function setup(): Promise<void> {
  const mock = installWailsMock();
  const v = await api.vault.open(`/v/Pv${++seq}`);
  vaultId = v.id;
  const files = mock.vaults.get(v.id)?.files;
  files?.set('Other.md', NOTE);
  files?.set('Home.md', 'Go to [[Other]]');
  files?.set('pic.png', 'x');
  useAppStore.setState({ vault: v, layout: emptyLayout() });
}

const anchor = { left: 10, right: 50, top: 10, bottom: 30 };

describe('page preview', () => {
  beforeEach(async () => {
    initI18n('en');
    await setup();
  });
  afterEach(() => hidePreview());

  it('renders the whole note, a heading section or a block', async () => {
    const all = await loadPreview(vaultId, 'Home.md', { target: 'Other', heading: '', block: '' });
    expect(all.ok && all.title).toBe('Other');
    expect(all.ok && all.html).toContain('Intro text');
    expect(all.ok && all.html).not.toContain('title: hidden');

    const sec = await loadPreview(vaultId, 'Home.md', {
      target: 'Other',
      heading: 'Deep',
      block: '',
    });
    expect(sec.ok && sec.html).toContain('Deep body');
    expect(sec.ok && sec.html).not.toContain('Other body');

    const blk = await loadPreview(vaultId, 'Home.md', {
      target: 'Other',
      heading: '',
      block: 'deep1',
    });
    expect(blk.ok && blk.html).toContain('Deep body');

    expect(
      await loadPreview(vaultId, 'Home.md', { target: 'Other', heading: 'Nope', block: '' }),
    ).toEqual({
      ok: false,
      reason: 'section',
    });
    expect(
      await loadPreview(vaultId, 'Home.md', { target: 'Missing', heading: '', block: '' }),
    ).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(
      await loadPreview(vaultId, 'Home.md', { target: 'pic.png', heading: '', block: '' }),
    ).toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('shows a sanitized popover without scripts or remote resources', async () => {
    await showPreview({
      vaultId,
      fromPath: 'Home.md',
      spec: { target: 'Other', heading: '', block: '' },
      anchor,
    });
    const el = previewElement();
    expect(el).not.toBeNull();
    expect(el?.querySelector('.page-preview-title')?.textContent).toBe('Other');
    expect(el?.textContent).toContain('Intro text');
    expect(el?.querySelector('script')).toBeNull();
    expect(el?.querySelector('[src]')).toBeNull();
    expect(el?.querySelector('[style]')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    // The popover itself is position: fixed and placed on screen.
    expect(el?.style.left).toBe('10px');
  });

  it('explains a link that cannot be previewed', async () => {
    await showPreview({
      vaultId,
      fromPath: 'Home.md',
      spec: { target: 'Missing', heading: '', block: '' },
      anchor,
    });
    expect(previewElement()?.textContent).toContain('does not exist');
  });

  it('closes on Escape and returns focus', async () => {
    const button = document.createElement('button');
    document.body.append(button);
    await showPreview({
      vaultId,
      fromPath: 'Home.md',
      spec: { target: 'Other', heading: '', block: '' },
      anchor,
      focus: true,
      returnFocus: button,
    });
    expect(document.activeElement).toBe(previewElement());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isPreviewOpen()).toBe(false);
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it('opens a link clicked inside the preview and closes (no nested preview)', async () => {
    await showPreview({
      vaultId,
      fromPath: 'Home.md',
      spec: { target: 'Other', heading: '', block: '' },
      anchor,
    });
    const link = previewElement()?.querySelector<HTMLElement>('a.wikilink');
    expect(link?.dataset['heading']).toBe('Deep');
    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(isPreviewOpen()).toBe(false);
    await waitFor(() => expect(activeTab(useAppStore.getState().layout)?.path).toBe('Other.md'));
    expect(useAppStore.getState().reveal?.heading).toBe('Deep');
  });

  it('opens after the delay, once per link', async () => {
    const req = {
      vaultId,
      fromPath: 'Home.md',
      spec: { target: 'Other', heading: '', block: '' },
      anchor,
    };
    schedulePreview(req, 0);
    schedulePreview(req, 0);
    await waitFor(() => expect(isPreviewOpen()).toBe(true));
    const first = previewElement();
    schedulePreview(req, 0); // same link: nothing changes
    await new Promise((r) => setTimeout(r, 20));
    expect(previewElement()).toBe(first);
  });

  it('honors the settings: disabled, modifier required, or always', () => {
    useSettings.setState({
      editor: { ...useSettings.getState().editor, pagePreview: true, pagePreviewAlways: false },
    });
    expect(previewWanted(false)).toBe(false);
    expect(previewWanted(true)).toBe(true);
    useSettings.setState({ editor: { ...useSettings.getState().editor, pagePreviewAlways: true } });
    expect(previewWanted(false)).toBe(true);
    useSettings.setState({ editor: { ...useSettings.getState().editor, pagePreview: false } });
    expect(previewWanted(true)).toBe(false);
    useSettings.getState().reset();
  });
});

describe('stripRemoteResources', () => {
  it('keeps blob: and inline image data, removes everything else with a src', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<img src="blob:x"><img src="data:image/png;base64,AA"><img src="http://e/x.png" alt="alt text"><video src="https://e/v.mp4"></video><img src="file:///etc/passwd">';
    stripRemoteResources(root);
    expect(root.querySelectorAll('[src]')).toHaveLength(2);
    expect(root.textContent).toBe('alt text');
  });
});
