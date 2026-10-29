import { mountWorkbench } from '@memobrain/workbench';

// The whole UI lives in @memobrain/workbench (shared with the Web UI, ADR-0029); the desktop only
// decides where it is mounted.
const container = document.getElementById('root');
if (!container) {
  throw new Error('missing #root element');
}
void mountWorkbench(container);
