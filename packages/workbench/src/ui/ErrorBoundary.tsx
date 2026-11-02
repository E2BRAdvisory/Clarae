// Error boundaries: a view that throws while rendering (a bug, a malformed file, a code-split chunk
// that could not be downloaded) is replaced by a message with a way out, instead of React
// unmounting the whole workbench and leaving a blank window (React logs the error itself). One
// wraps the shell (mount.tsx), smaller ones each pane, sidebar panel, settings section, dialog and
// embedded view, so a broken view leaves the others working.
import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, InlineError } from '@memobrain/ui';
import { flushWorkbench } from '../app/lifecycle';
import { errorMessage } from '../util/errors';
import { isChunkLoadError, resetFailedViews } from './lazyView';

/**
 * Where the fallback shows: the whole page, a pane or panel, a block inside a note, or a modal in
 * place of a dialog (it then needs `onClose`, the dialog's own way out being gone).
 */
export type BoundaryScope = 'shell' | 'view' | 'inline' | 'dialog';

interface Props {
  scope: BoundaryScope;
  children: ReactNode;
  /** The boundary starts over when this changes (another file in the tab, another panel). */
  resetKey?: unknown;
  /** Offers a Close button that gives up on the view (dialogs). */
  onClose?: () => void;
}

interface State {
  error: unknown;
  /** Bumped by "Try again": remounts the children from scratch. */
  attempt: number;
}

/** Writes the pending edits, then reloads the page (a new download of every chunk). */
export function reloadWorkbench(): void {
  void flushWorkbench().finally(() => window.location.reload());
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    // A thrown `undefined` or `null` is still a failure.
    return { error: error ?? new Error('unknown error') };
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error !== null && !Object.is(prev.resetKey, this.props.resetKey))
      this.setState({ error: null });
  }

  private retry = (): void => {
    resetFailedViews();
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  override render(): ReactNode {
    const { error, attempt } = this.state;
    if (error !== null)
      return (
        <ErrorFallback
          scope={this.props.scope}
          error={error}
          onRetry={this.retry}
          onClose={this.props.onClose}
        />
      );
    // The key remounts the subtree on a retry, so no half-initialised state survives.
    return <BoundaryContent key={attempt}>{this.props.children}</BoundaryContent>;
  }
}

function BoundaryContent({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function ErrorFallback({
  scope,
  error,
  onRetry,
  onClose,
}: {
  scope: BoundaryScope;
  error: unknown;
  onRetry: () => void;
  onClose?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const chunk = isChunkLoadError(error);
  const title =
    scope === 'shell' ? t('app.crash.shell') : chunk ? t('app.crash.load') : t('app.crash.view');
  const small = scope === 'inline';
  const body = (
    <div className={`error-boundary ${scope}`} data-testid="error-boundary">
      <p className="error-boundary-title">{title}</p>
      <InlineError>{errorMessage(error)}</InlineError>
      <div className="error-boundary-actions">
        <Button small={small} variant={scope === 'shell' ? 'default' : 'primary'} onClick={onRetry}>
          {t('app.crash.retry')}
        </Button>
        {(scope === 'shell' || chunk) && (
          <Button
            small={small}
            variant={scope === 'shell' ? 'primary' : 'default'}
            onClick={reloadWorkbench}
          >
            {t('app.crash.reload')}
          </Button>
        )}
        {onClose && (
          <Button small={small} onClick={onClose}>
            {t('common.close')}
          </Button>
        )}
      </div>
    </div>
  );
  if (scope !== 'dialog') return body;
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="alertdialog" aria-modal="true" aria-label={title}>
        {body}
      </div>
    </div>
  );
}
