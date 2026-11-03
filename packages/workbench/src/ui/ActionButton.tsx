// The button of a declarative action (commands/actions.ts, ADR-0045 §2). It hides itself where the
// host lacks what the action needs (`requires`, `excludes`) or where the action does not apply to
// its argument (`when`), and disables itself while the action cannot run or is running. Panels
// never test a capability for an action: they render <ActionButton id=… arg=… />, or call
// useAction() when a shared component draws the button (CloudVaultsTable's «New vault»).
import { useContext, useState, type ReactNode } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  actionById,
  isActionAvailable,
  type Action,
  type ActionArg,
  type ActionId,
} from '../commands/actions';
import { usePlatform } from '../platform';
import { queryClient as sharedQueryClient } from '../state/queryClient';

/** The argument, mandatory unless the action takes none. */
type ArgProp<Id extends ActionId> = [ActionArg<Id>] extends [void]
  ? { arg?: undefined }
  : { arg: ActionArg<Id> };

/** An action ready to show: null when it is hidden. */
export interface BoundAction {
  /** i18n key of its text. */
  label: string | undefined;
  enabled: boolean;
  run: () => Promise<void>;
}

/** useAction without the typing of the argument (ActionButton's props type it already). */
function useBoundAction(id: ActionId, arg: unknown): BoundAction | null {
  // The tree's client (tests give their own), else the app's: an action never needs a provider.
  const queryClient = useContext(QueryClientContext) ?? sharedQueryClient;
  // The capabilities and the host's hooks (removeFromBrowser, openMount) the action reads.
  usePlatform();
  const a = actionById(id) as unknown as Action<unknown>;
  if (!isActionAvailable(a) || (a.when && !a.when(arg))) return null;
  return {
    label: typeof a.label === 'function' ? a.label(arg) : a.label,
    enabled: a.enabled ? a.enabled(arg) : true,
    run: async () => {
      await a.run(arg, { queryClient });
    },
  };
}

/**
 * The action `id` bound to its argument, or null where it is not offered (the host lacks a
 * capability it needs, or it does not apply to the argument). Re-renders when the platform changes.
 */
export function useAction<Id extends ActionId>(
  id: Id,
  ...rest: [ActionArg<Id>] extends [void] ? [] : [arg: ActionArg<Id>]
): BoundAction | null {
  return useBoundAction(id, rest[0]);
}

type ActionButtonProps<Id extends ActionId> = {
  id: Id;
  className?: string;
  /** Disabled by the panel too (another form open, a locked vault…). */
  disabled?: boolean;
  /** Told when the action starts and ends (a panel that shows "signing in…"). */
  onPending?: (pending: boolean) => void;
  /** Replaces the action's label. */
  children?: ReactNode;
} & ArgProp<Id>;

export function ActionButton<Id extends ActionId>(props: ActionButtonProps<Id>) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const bound = useBoundAction(props.id, props.arg);
  if (!bound) return null;
  const click = async () => {
    setPending(true);
    props.onPending?.(true);
    try {
      await bound.run();
    } finally {
      setPending(false);
      props.onPending?.(false);
    }
  };
  return (
    <button
      type="button"
      className={props.className}
      data-action-id={props.id}
      disabled={pending || !bound.enabled || props.disabled}
      onClick={() => void click()}
    >
      {props.children ?? (bound.label ? t(bound.label) : props.id)}
    </button>
  );
}
