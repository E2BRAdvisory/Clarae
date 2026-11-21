import { describe, expect, it } from 'vitest';
import type { NoteEditorHandle } from './handle';
import { editorsVersion, onEditorsChange, registerEditor, unregisterEditor } from './registry';

const handle = {} as NoteEditorHandle;

describe('the editor registry tells when an editor comes or goes', () => {
  it('calls the listeners on a registration and on an unregistration, until they stop', () => {
    let calls = 0;
    const v0 = editorsVersion();
    const stop = onEditorsChange(() => calls++);
    registerEditor('p-test', handle);
    unregisterEditor('p-test', handle);
    expect(calls).toBe(2);
    expect(editorsVersion()).toBe(v0 + 2);
    unregisterEditor('p-test', handle); // already gone: nothing changed
    expect(calls).toBe(2);
    stop();
    registerEditor('p-test', handle);
    unregisterEditor('p-test', handle);
    expect(calls).toBe(2);
  });
});
