import { Suspense, type ReactNode } from 'react';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * Hosts a code-split dialog (a lazyView): nothing shows while its chunk downloads, and a dialog
 * that cannot be loaded (or that throws) is replaced by a message with "Try again" and Close,
 * instead of reaching the shell's boundary and taking the whole workbench down.
 */
export function LazyDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <ErrorBoundary scope="dialog" onClose={onClose}>
      <Suspense fallback={null}>{children}</Suspense>
    </ErrorBoundary>
  );
}
