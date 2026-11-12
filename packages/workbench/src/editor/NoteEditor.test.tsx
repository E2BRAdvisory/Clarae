// The editor of a note: the Live mode is Milkdown, Source is CodeMirror under it, and a note that Live
// cannot hold shows as Source with a notice.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../i18n';
import { defaultEditorSettings } from '../state/settings';
import { defaultContext } from './context';
import { getEditor } from './registry';
import { NoteEditor, type NoteEditorProps } from './NoteEditor';
import { SourceEditor } from './source/SourceEditor';
import { LiveSession } from './live/fidelity/session';

beforeAll(() => {
  initI18n('en');
});
afterEach(() => cleanup());

function props(over: Partial<NoteEditorProps> = {}): NoteEditorProps {
  return {
    id: 'pane',
    doc: 'one\n\ntwo\n\nthree\n',
    version: 1,
    mode: 'live',
    settings: defaultEditorSettings,
    context: defaultContext,
    completion: {
      backend: { suggest: () => Promise.resolve([]), resolve: () => Promise.resolve('') },
      notePath: () => 'n.md',
      linkFormat: () => 'shortest',
    },
    paste: { saveAttachment: () => Promise.resolve(''), enabled: () => false },
    onChange: () => undefined,
    onStats: () => undefined,
    ...over,
  };
}

const live = () => waitFor(() => expect(getEditor('pane')?.kind).toBe('live'), { timeout: 20_000 });
const source = () =>
  waitFor(() => expect(getEditor('pane')?.kind).toBe('source'), { timeout: 20_000 });

describe('the CodeMirror editor under Live', () => {
  it('takes no typing while Live is on its way, and takes it again if Live does not come', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SourceEditor {...props({ onChange })} />);
    const ed = getEditor('pane')!;
    expect(ed.readOnly()).toBe(false);
    rerender(<SourceEditor {...props({ onChange, suspended: 'wait' })} />);
    expect(ed.readOnly()).toBe(true);
    // the commands and the toolbar dispatch on the view: they are closed too
    act(() => void ed.replaceSelection('X'));
    expect(ed.text()).toBe('one\n\ntwo\n\nthree\n');
    expect(onChange).not.toHaveBeenCalled();
    rerender(<SourceEditor {...props({ onChange })} />);
    expect(ed.readOnly()).toBe(false);
    act(() => void ed.replaceSelection('X'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('still takes the file when it is loaded again while Live is on its way', () => {
    const { rerender } = render(<SourceEditor {...props({ suspended: 'wait' })} />);
    rerender(<SourceEditor {...props({ suspended: 'wait', doc: 'new\n', version: 2 })} />);
    expect(getEditor('pane')!.text()).toBe('new\n');
  });

  it('stays read-only for a read-only pane when Live is gone', () => {
    const { rerender } = render(<SourceEditor {...props({ readOnly: true, suspended: 'wait' })} />);
    rerender(<SourceEditor {...props({ readOnly: true })} />);
    expect(getEditor('pane')!.readOnly()).toBe(true);
  });
});

describe('the Live mode with Milkdown', () => {
  it('shows Milkdown, with the name of the editor on it alone, and the CodeMirror one out of the way', async () => {
    const { container } = render(<NoteEditor {...props()} />);
    await live();
    // the Live editor registers a moment before the pane renders the other one as away
    await waitFor(() => expect(screen.getAllByLabelText('Note editor')).toHaveLength(1));
    expect(getEditor('pane')?.text()).toBe('one\n\ntwo\n\nthree\n');
    const hidden = container.querySelector('.editor-host[data-suspended]');
    expect(hidden?.getAttribute('data-suspended')).toBe('away');
    expect(hidden?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.live-host')).not.toBeNull();
  });

  it('opens a note that is over the limits as Source, with a notice, and says why', async () => {
    const big = Array.from({ length: 3001 }, (_, i) => `p${i}`).join('\n\n');
    render(<NoteEditor {...props({ doc: big })} />);
    await source();
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('shown as Source');
    expect(notice.textContent).toContain('more than 3,000 blocks');
    expect(screen.getAllByLabelText('Note editor')).toHaveLength(1);
  });

  it('opens a note that the layer cannot hold as Source, with a notice', async () => {
    const open = vi
      .spyOn(LiveSession, 'open')
      .mockReturnValue({ ok: false, reason: 'parse-error', detail: 'lost' });
    try {
      render(<NoteEditor {...props()} />);
      const notice = await screen.findByRole('status', {}, { timeout: 20_000 });
      expect(notice.textContent).toContain('could not read it without losing');
      await source();
    } finally {
      open.mockRestore();
    }
  });

  it('opens a note whose lines end both ways as Source', async () => {
    render(<NoteEditor {...props({ doc: 'a\r\nb\nc\r\n' })} />);
    const notice = await screen.findByRole('status', {}, { timeout: 20_000 });
    expect(notice.textContent).toContain('CRLF');
    await source();
  });

  it('does not report an edit for opening, and reports one for typing, once', async () => {
    const onChange = vi.fn<(text: () => string) => void>();
    render(<NoteEditor {...props({ onChange })} />);
    await live();
    expect(onChange).not.toHaveBeenCalled();
    act(() => void getEditor('pane')?.replaceSelection('X'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]()).toBe('Xone\n\ntwo\n\nthree\n');
  });

  it('takes the file when it changes on disk, without an edit and without a notice', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<NoteEditor {...props({ onChange })} />);
    await live();
    rerender(<NoteEditor {...props({ onChange, doc: 'one\n\ntwo!\n\nthree\n', version: 2 })} />);
    await waitFor(() => expect(getEditor('pane')?.text()).toBe('one\n\ntwo!\n\nthree\n'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  describe('a file that changes on disk into a text Live cannot hold', () => {
    const disk = 'one\r\n\r\nNEW\n\nthree\n';

    it('shows the new text as Source with a notice, and writes nothing back over it', async () => {
      const onChange = vi.fn<(text: () => string) => void>();
      const { rerender } = render(<NoteEditor {...props({ onChange })} />);
      await live();
      rerender(<NoteEditor {...props({ onChange, doc: disk, version: 2 })} />);
      const notice = await screen.findByRole('status', {}, { timeout: 20_000 });
      expect(notice.textContent).toContain('CRLF');
      await source();
      // CodeMirror reads every line end as LF
      expect(getEditor('pane')!.text()).toBe('one\n\nNEW\n\nthree\n');
      act(() => void getEditor('pane')!.replaceSelection('X'));
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange.mock.calls[0]![0]()).toBe('Xone\n\nNEW\n\nthree\n');
      expect(screen.getAllByLabelText('Note editor')).toHaveLength(1);
    });

    it('drops what Live had typed in favour of the file, and reports no edit of its own', async () => {
      const onChange = vi.fn<(text: () => string) => void>();
      const { rerender } = render(<NoteEditor {...props({ onChange })} />);
      await live();
      act(() => void getEditor('pane')!.replaceSelection('Z'));
      expect(onChange).toHaveBeenCalledTimes(1);
      rerender(<NoteEditor {...props({ onChange, doc: disk, version: 2 })} />);
      await screen.findByRole('status', {}, { timeout: 20_000 });
      await source();
      expect(getEditor('pane')!.text()).toBe('one\n\nNEW\n\nthree\n');
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('tries Live again when the file is loaded again with a text it can hold', async () => {
      const { rerender } = render(<NoteEditor {...props()} />);
      await live();
      rerender(<NoteEditor {...props({ doc: disk, version: 2 })} />);
      await source();
      rerender(<NoteEditor {...props({ doc: 'one\n\nNEW\n\nthree\n', version: 3 })} />);
      await live();
      expect(screen.queryByRole('status')).toBeNull();
      expect(getEditor('pane')!.text()).toBe('one\n\nNEW\n\nthree\n');
    });
  });

  it('is read-only when the pane is', async () => {
    const { rerender } = render(<NoteEditor {...props({ readOnly: true })} />);
    await live();
    expect(getEditor('pane')?.readOnly()).toBe(true);
    expect(getEditor('pane')?.replaceSelection('X')).toBe(false);
    rerender(<NoteEditor {...props({ readOnly: false })} />);
    await waitFor(() => expect(getEditor('pane')?.readOnly()).toBe(false));
  });

  it('goes to Source with what Live did as one step of the CodeMirror history, and the selection', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<NoteEditor {...props({ onChange })} />);
    await live();
    const mk = getEditor('pane')!;
    mk.gotoLine(3);
    mk.replaceSelection('Z');
    expect(mk.text()).toBe('one\n\nZtwo\n\nthree\n');
    onChange.mockClear();
    rerender(
      <NoteEditor {...props({ onChange, mode: 'source', doc: 'one\n\nZtwo\n\nthree\n' })} />,
    );
    await source();
    const cm = getEditor('pane')!;
    expect(cm.text()).toBe('one\n\nZtwo\n\nthree\n');
    // what came over is no edit to report (Live reported it), and its place came with it
    expect(onChange).not.toHaveBeenCalled();
    expect(cm.cursor().line).toBe(3);
    // Undo in Source takes back what Live did
    cm.exec('undo');
    expect(cm.text()).toBe('one\n\ntwo\n\nthree\n');
    cm.exec('redo');
    expect(cm.text()).toBe('one\n\nZtwo\n\nthree\n');
  });

  it('goes to Live from Source with the selection it had, and shows the text Source has', async () => {
    const { rerender } = render(<NoteEditor {...props({ mode: 'source' })} />);
    await source();
    getEditor('pane')!.gotoLine(5);
    rerender(<NoteEditor {...props({ mode: 'live', doc: 'one\n\ntwo\n\nthree\n' })} />);
    await live();
    expect(getEditor('pane')!.cursor().line).toBe(5);
    expect(getEditor('pane')!.text()).toBe('one\n\ntwo\n\nthree\n');
  });

  it('keeps a file with CRLF line ends through a pass to Source and back when it was not edited', async () => {
    const onChange = vi.fn();
    const crlf = 'one\r\n\r\ntwo\r\n';
    const { rerender } = render(<NoteEditor {...props({ onChange, doc: crlf })} />);
    await live();
    rerender(<NoteEditor {...props({ onChange, doc: crlf, mode: 'source' })} />);
    await source();
    rerender(<NoteEditor {...props({ onChange, doc: crlf, mode: 'live' })} />);
    await live();
    expect(getEditor('pane')!.text()).toBe(crlf);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the text again in Source after Live is gone, and stays in Source until Live is asked for again', async () => {
    const big = Array.from({ length: 3001 }, (_, i) => `p${i}`).join('\n\n');
    const { rerender } = render(<NoteEditor {...props({ doc: big })} />);
    await source();
    rerender(<NoteEditor {...props({ doc: big, mode: 'source' })} />);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(getEditor('pane')!.kind).toBe('source');
  });
});
