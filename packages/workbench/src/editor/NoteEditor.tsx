// The editor of a note. By default it is the CodeMirror `Editor`, as it always was.
//
// A build with the engine switch on (`MEMOBRAIN_LIVE_ENGINE=milkdown`, ADR-0049, A-D8) resolves this
// module to NoteEditor.live.tsx instead (the `live-engine` plugin of packages/workbench/build): the Live
// mode is then Milkdown, in a chunk of its own. The switch is a build constant, never a setting, and
// nothing of Milkdown is in a build without it.
export { Editor as NoteEditor } from './Editor';
