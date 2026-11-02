import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { insertFiles, smartPaste, type PasteDeps } from './paste';

const views: EditorView[] = [];

function editor(doc: string, deps: PasteDeps, readOnly = false): EditorView {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      extensions: [smartPaste(deps), EditorState.readOnly.of(readOnly)],
    }),
  });
  views.push(view);
  return view;
}

const file = (name: string): File => new File([new Uint8Array([1, 2, 3])], name);

/** saveAttachment that waits until `release` is called. */
function heldSave() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const save = vi.fn(async (name: string) => {
    await gate;
    return `att/${name}`;
  });
  return { save, release: () => release() };
}

afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
});

describe('insertFiles', () => {
  it('inserts the embed where the paste happened, after edits made while saving', async () => {
    const held = heldSave();
    const deps = { saveAttachment: held.save, enabled: () => true };
    const view = editor('hello world', deps);
    const done = insertFiles(view, [file('a.png')], deps, 6);
    // The user keeps typing before the paste point while the file is written.
    view.dispatch({ changes: { from: 0, insert: '>> ' } });
    held.release();
    await done;
    expect(view.state.doc.toString()).toBe('>> hello ![[att/a.png]]world');
  });

  it('never inserts beyond the end of a document that got shorter', async () => {
    const held = heldSave();
    const deps = { saveAttachment: held.save, enabled: () => true };
    const view = editor('some long text', deps);
    const done = insertFiles(view, [file('b.png')], deps, 14);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'x' } });
    held.release();
    await expect(done).resolves.toBeUndefined();
    expect(view.state.doc.toString()).toBe('x![[att/b.png]]');
  });

  it('reports a file that could not be stored and keeps the others', async () => {
    const onError = vi.fn();
    const deps: PasteDeps = {
      saveAttachment: vi.fn((name: string) =>
        name === 'bad.png'
          ? Promise.reject(new Error('permission: read-only vault'))
          : Promise.resolve(`att/${name}`),
      ),
      enabled: () => true,
      onError,
    };
    const view = editor('', deps);
    await insertFiles(view, [file('bad.png'), file('ok.png')], deps, 0);
    expect(view.state.doc.toString()).toBe('![[att/ok.png]]');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]?.[0])).toContain('read-only');
  });

  it('does not touch an editor that was closed meanwhile', async () => {
    const held = heldSave();
    const deps = { saveAttachment: held.save, enabled: () => true };
    const view = editor('text', deps);
    const done = insertFiles(view, [file('c.png')], deps, 0);
    view.destroy();
    held.release();
    await done;
    expect(view.state.doc.toString()).toBe('text');
  });

  it('stores nothing in a read-only editor', async () => {
    const save = vi.fn(() => Promise.resolve('att/x.png'));
    const deps = { saveAttachment: save, enabled: () => true };
    const view = editor('text', deps, true);
    await insertFiles(view, [file('x.png')], deps, 0);
    expect(save).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('text');
  });
});
