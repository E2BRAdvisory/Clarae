import { lazyView } from '../ui/lazyView';

// xterm and the panel are fetched the first time the terminal shows (ADR-0020: the initial bundle
// does not carry them). The panel keeps its screens while hidden, so it is made once and then kept.
export const LazyTerminalPanel = lazyView(async () => ({
  default: (await import('./TerminalPanel')).TerminalPanel,
}));
