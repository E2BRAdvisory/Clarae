// The one place that talks to WebViewAPI (M18, track E): it keeps the native views of the
// applications in step with the tabs that show them.
//
// A native view is not part of the page: the shell adds it to the window above the web view of the
// application, so it is always above the HTML. Everything here follows from that.
//
//   - Placement. The tab shows an empty placeholder (the "stage"); its rectangle, as fractions of the
//     viewport (not of pixels: the number does not depend on the pixel ratio or on the zoom of the
//     application), is what the view is given, kept up to date by a ResizeObserver, the resize of the
//     window, scrolling and every change of layout, at most once per frame.
//   - Visibility. Whatever the user must see over the view hides it: a drag (a tab, a splitter, a
//     file), a stage that is not shown (an inactive tab), and anything of the application that is
//     drawn above the stage, which a probe finds with `elementsFromPoint` without touching the
//     palette, the menus, the dialogs or the tooltips that cover it. It comes back when nothing does.
//   - Life. A view belongs to a tab. Hiding the tab hides the view and keeps its page; closing the
//     tab closes the view. A tab restored with the layout loads nothing until its stage is shown.
//     Leaving, locking or closing a vault ends its views (webview:closed tells the UI).
//   - Keys. A page with the keyboard focus gets every key, so the combinations of the application
//     are reserved (ReserveKeys) and the core hands them back as webview:key.
//
// Nothing here is called where the capability `embeddedBrowser` is off: the core refuses every call
// of WebViewAPI there (the page of an application opens in the system browser).
import { create } from 'zustand';
import { api, type ViewBounds } from '../app/api';
import { Events, type EventName, type EventPayload } from '../app/events';
import { can } from '../platform';
import { useAppStore } from '../state/store';
import { allPanes, paneOfTab, type Layout } from '../workspace/layout';
import { errorCodeOf } from '../util/errors';
import { isWebapp } from './model';

/** What the manager asks of the core: WebViewAPI through the facade, or a double in tests. */
export type ViewCalls = typeof api.webview;

/** The state of the page of a view, as the core reports it (untrusted text: show it, never follow it). */
export interface PageState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** Something the core refused to do for the page, said once to the user. */
export type ViewNotice =
  | { id: number; kind: 'blocked'; url: string; reason: string }
  | { id: number; kind: 'new-window'; url: string; opened: boolean }
  | { id: number; kind: 'download'; url: string }
  | { id: number; kind: 'permission'; permission: string; origin: string };

/** What the UI shows of the view of a tab. */
export interface ViewState {
  /**
   * `pending`: nothing was asked yet (the stage is not shown, or something covers it); `opening`;
   * `open`; `closed`: the core ended it (see `reason`); `failed`: it could not be opened (`error`).
   */
  phase: 'pending' | 'opening' | 'open' | 'closed' | 'failed';
  /** The reason of webview:closed. */
  reason: string;
  /** The raw message of the error that made it `failed` (the UI translates its code). */
  error: string;
  page: PageState;
  /** The page did not load; a certificate that is refused has no way around it. */
  loadError: { certificate: boolean; code: number; message: string } | null;
  /** The process that renders the page ended. */
  crashed: boolean;
  notices: ViewNotice[];
  /** The native view is hidden now (covered, dragged over, or its stage is not shown). */
  hidden: boolean;
}

const emptyPage = (url: string): PageState => ({
  url,
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
});

const initialState = (url: string): ViewState => ({
  phase: 'pending',
  reason: '',
  error: '',
  page: emptyPage(url),
  loadError: null,
  crashed: false,
  notices: [],
  hidden: true,
});

/** The view of each tab (by tab id), for the components. */
export const useViewStates = create<{ views: Record<string, ViewState> }>(() => ({ views: {} }));

export const useViewState = (tabId: string): ViewState | undefined =>
  useViewStates((s) => s.views[tabId]);

const patch = (tabId: string, change: (v: ViewState) => ViewState): void =>
  useViewStates.setState((s) => {
    const cur = s.views[tabId];
    return cur ? { views: { ...s.views, [tabId]: change(cur) } } : s;
  });

const NOTICES_SHOWN = 3;

/**
 * What ended a view for a reason that no longer holds once its stage is shown again: the data were cleared,
 * or the profile turned the browser off and has turned it on (BrowserView shows the stage only then).
 */
const RESTARTS = ['data-cleared', 'disabled'];

/** A drag that has sent no dragover for this long is over (browsers send one every ~50 ms). */
const DRAG_SILENCE_MS = 300;
/** The wait after a dragleave that names no destination, for the dragover that tells the drag goes on. */
const DRAG_LEAVE_GRACE_MS = 120;

/** Events kept for a view that is still opening. */
const EARLY_EVENTS = 32;

/** A notice before it has an id. */
type NewNotice = ViewNotice extends infer N
  ? N extends ViewNotice
    ? Omit<N, 'id'>
    : never
  : never;

// ---- geometry (pure) ----------------------------------------------------------------------------

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * The rectangle of a stage as the core wants it: fractions (0..1) of the viewport, origin top-left.
 * Divided by `innerWidth` and `innerHeight` only, never by the pixel ratio or a zoom. Null when the
 * stage has no area inside the viewport (nothing to place yet).
 */
export function normalizeBounds(
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  innerWidth: number,
  innerHeight: number,
): ViewBounds | null {
  if (!(innerWidth > 0) || !(innerHeight > 0)) return null;
  const x = clamp01(rect.left / innerWidth);
  const y = clamp01(rect.top / innerHeight);
  const right = clamp01((rect.left + rect.width) / innerWidth);
  const bottom = clamp01((rect.top + rect.height) / innerHeight);
  const width = right - x;
  const height = bottom - y;
  if (!(width > 0) || !(height > 0)) return null;
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}

const sameBounds = (a: ViewBounds | null, b: ViewBounds | null): boolean =>
  a !== null &&
  b !== null &&
  Math.abs(a.x - b.x) < 1e-5 &&
  Math.abs(a.y - b.y) < 1e-5 &&
  Math.abs(a.width - b.width) < 1e-5 &&
  Math.abs(a.height - b.height) < 1e-5;

/** Distance from the edge of the stage of the outermost probe points: furniture on the border is not a cover. */
const PROBE_INSET = 8;
const PROBE_COLUMNS = 9;
const PROBE_ROWS = 7;

/**
 * Whether something of the application is drawn above the stage: the topmost element at any of a
 * grid of points of the stage is not the stage or one of its descendants. A palette, a menu, a
 * dialog with its backdrop, a context menu, a tooltip: all of them are found without a line of their
 * own code. An element with `pointer-events: none` is not seen (it is not a cover for the pointer
 * either); something smaller than the grid step (about a ninth of the width) can slip between the points.
 */
export function isCovered(
  stage: Element,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  at: (x: number, y: number) => Element[] = (x, y) => document.elementsFromPoint(x, y),
): boolean {
  const inset = Math.min(PROBE_INSET, rect.width / 2, rect.height / 2);
  const w = Math.max(0, rect.width - 2 * inset);
  const h = Math.max(0, rect.height - 2 * inset);
  for (let r = 0; r < PROBE_ROWS; r++)
    for (let c = 0; c < PROBE_COLUMNS; c++) {
      const x = rect.left + inset + (w * c) / (PROBE_COLUMNS - 1);
      const y = rect.top + inset + (h * r) / (PROBE_ROWS - 1);
      const top = at(x, y)[0];
      if (top && !stage.contains(top)) return true;
    }
  return false;
}

// ---- the manager ---------------------------------------------------------------------------------

interface Want {
  bounds: ViewBounds | null;
  visible: boolean;
}

interface Rec {
  tabId: string;
  vaultId: string;
  /** The address the tab is registered with (the file's). */
  url: string;
  viewId: string | null;
  opening: boolean;
  /** The tab is gone: drop what comes back from the core. */
  dead: boolean;
  stage: HTMLElement | null;
  paneFocused: boolean;
  /** The native view has the keyboard focus (it said so with webview:focus). */
  nativeFocused: boolean;
  focusWanted: boolean;
  want: Want;
  sent: { bounds: ViewBounds | null; visible: boolean | null };
  pushing: boolean;
  again: boolean;
  /** The address the core was last pointed at. */
  navigated: string;
}

/** Where a tab shows an application. */
export interface Placement {
  tabId: string;
  vaultId: string;
  /** The address of the file, already checked by checkWebappUrl. */
  url: string;
  stage: HTMLElement;
  /** The pane of the tab has the focus of the application. */
  paneFocused: boolean;
}

export interface NativeViewsOptions {
  api?: ViewCalls;
  /** Whether this host has the embedded browser (the capability, read at the time of the call). */
  embedded?: () => boolean;
  /** Runs `cb` before the next frame (tests run it at once). */
  frame?: (cb: () => void) => number;
  cancelFrame?: (id: number) => void;
}

const noop = (): void => undefined;
const isGone = (e: unknown): boolean => errorCodeOf(e) === 'webview-not-found';

export class NativeViews {
  private readonly calls: ViewCalls;
  private readonly embedded: () => boolean;
  private readonly frame: (cb: () => void) => number;
  private readonly cancelFrame: (id: number) => void;
  private readonly recs = new Map<string, Rec>();
  private readonly suppressors = new Set<string>();
  private noticeId = 0;
  private frameId = 0;
  private started = 0;
  private stops: (() => void)[] = [];
  private domStops: (() => void) | null = null;
  private ro: ResizeObserver | null = null;
  private keyHandler: (accelerator: string) => void = noop;
  private lastKeys = '';
  private early: { viewId: string; vaultId: string; apply: (r: Rec) => void }[] = [];
  constructor(o: NativeViewsOptions = {}) {
    this.calls = o.api ?? api.webview;
    this.embedded = o.embedded ?? (() => can('embeddedBrowser'));
    this.frame = o.frame ?? ((cb) => window.requestAnimationFrame(cb));
    this.cancelFrame = o.cancelFrame ?? ((id) => window.cancelAnimationFrame(id));
  }

  // ---- lifecycle of the manager ----

  /**
   * Starts listening (events of the core, the layout, the vault in use). Returns the function that
   * stops it; calls nest, so React's double effect is harmless. It does nothing where there is no
   * embedded browser.
   */
  start(onKey: (accelerator: string) => void = noop): () => void {
    if (!this.embedded()) return noop;
    this.keyHandler = onKey;
    if (this.started++ === 0) {
      this.stops.push(
        this.listen(Events.webviewState, (p) =>
          this.withView(p, (r) =>
            patch(r.tabId, (v) => ({
              ...v,
              page: {
                url: p.url,
                title: p.title,
                loading: p.loading,
                canGoBack: p.canGoBack,
                canGoForward: p.canGoForward,
              },
              // a new load starts: what failed before is over
              ...(p.loading ? { loadError: null, crashed: false } : {}),
            })),
          ),
        ),
        this.listen(Events.webviewBlocked, (p) =>
          this.withView(p, (r) =>
            this.notice(r, { kind: 'blocked', url: p.url, reason: p.reason }),
          ),
        ),
        this.listen(Events.webviewNewWindow, (p) =>
          this.withView(p, (r) =>
            this.notice(r, { kind: 'new-window', url: p.url, opened: p.opened }),
          ),
        ),
        this.listen(Events.webviewDownload, (p) =>
          this.withView(p, (r) => this.notice(r, { kind: 'download', url: p.url })),
        ),
        this.listen(Events.webviewPermission, (p) =>
          this.withView(p, (r) =>
            this.notice(r, { kind: 'permission', permission: p.permission, origin: p.origin }),
          ),
        ),
        this.listen(Events.webviewLoadError, (p) =>
          this.withView(p, (r) => {
            patch(r.tabId, (v) => ({
              ...v,
              loadError: { certificate: p.certificate, code: p.code, message: p.message },
              page: { ...v.page, loading: false },
            }));
            this.update(); // a card is over the stage now: the view steps aside
          }),
        ),
        this.listen(Events.webviewCrashed, (p) =>
          this.withView(p, (r) => {
            patch(r.tabId, (v) => ({ ...v, crashed: true, page: { ...v.page, loading: false } }));
            this.update();
          }),
        ),
        this.listen(Events.webviewFocus, (p) =>
          this.withView(p, (r) => {
            r.nativeFocused = true;
            const pane = this.paneOf(r.tabId);
            if (pane) useAppStore.getState().focusPane(pane);
          }),
        ),
        this.listen(Events.webviewKey, (p) => this.keyHandler(p.accelerator)),
        this.listen(Events.webviewClosed, (p) =>
          this.withView(p, (r) => {
            r.viewId = null;
            r.sent = { bounds: null, visible: null };
            r.nativeFocused = false;
            patch(r.tabId, (v) => ({
              ...v,
              phase: 'closed',
              reason: p.reason,
              loadError: null,
              crashed: false,
              hidden: true,
            }));
          }),
        ),
      );
      let prev = useAppStore.getState();
      this.stops.push(
        useAppStore.subscribe((s) => {
          const before = prev;
          prev = s;
          if (s.vault?.id !== before.vault?.id) this.vaultChanged(before.vault?.id ?? null);
          else if (s.layout !== before.layout) this.reconcile(s.layout);
        }),
      );
    }
    return () => {
      if (--this.started > 0) return;
      for (const stop of this.stops.splice(0)) stop();
      this.closeEverything();
    };
  }

  /**
   * Reserves the combinations of the application (ReserveKeys). A list the core refuses as a whole
   * (one accelerator that this build and the core read differently) is cut down to the ones it
   * takes, so one bad combination never takes the others with it. Calls with the same list do nothing.
   */
  async reserveKeys(accelerators: readonly string[]): Promise<void> {
    if (!this.embedded()) return;
    const key = accelerators.join('\n');
    if (key === this.lastKeys) return;
    this.lastKeys = key;
    try {
      await this.calls.reserveKeys([...accelerators]);
    } catch (e) {
      if (errorCodeOf(e) !== 'webview-invalid-accelerator') return;
      const ok: string[] = [];
      for (const a of accelerators) {
        try {
          await this.calls.reserveKeys([a]);
          ok.push(a);
        } catch {
          /* this one is refused */
        }
      }
      await this.calls.reserveKeys(ok).catch(noop);
    }
  }

  private listen<N extends EventName>(name: N, h: (p: EventPayload<N>) => void): () => void {
    return api.on(name, h);
  }

  private withView(p: { viewId: string; vaultId: string }, f: (r: Rec) => void): void {
    for (const r of this.recs.values())
      if (r.viewId === p.viewId && r.vaultId === p.vaultId) return f(r);
    // The core knows a view before it answers the call that made it, so its first events can come
    // first. While a view of that vault is opening they wait for the answer (a few, never for long).
    for (const r of this.recs.values())
      if (r.opening && r.vaultId === p.vaultId) {
        this.early.push({ viewId: p.viewId, vaultId: p.vaultId, apply: f });
        if (this.early.length > EARLY_EVENTS) this.early.shift();
        return;
      }
  }

  /** Applies the events that came before the answer of Open, to the view it named. */
  private replayEarly(r: Rec): void {
    const mine = this.early.filter((e) => e.viewId === r.viewId && e.vaultId === r.vaultId);
    this.early = this.early.filter((e) => !mine.includes(e));
    // nothing else is opening: what is left was for views that never came
    if (![...this.recs.values()].some((x) => x.opening)) this.early = [];
    for (const e of mine) e.apply(r);
  }

  private notice(r: Rec, n: NewNotice): void {
    const notice: ViewNotice = { ...n, id: ++this.noticeId };
    patch(r.tabId, (v) => ({ ...v, notices: [...v.notices, notice].slice(-NOTICES_SHOWN) }));
  }

  // ---- what BrowserView does ----

  /**
   * Shows the application of a tab in its stage. The view is opened when the stage is shown and
   * nothing covers it (never for a tab that is only restored), and follows the stage from then on.
   * Returns the function to call when the stage goes away: it hides the view and keeps its page.
   */
  attach(p: Placement): () => void {
    let r = this.recs.get(p.tabId);
    if (r && r.vaultId !== p.vaultId) {
      this.drop(r);
      r = undefined;
    }
    if (!r) {
      r = {
        tabId: p.tabId,
        vaultId: p.vaultId,
        url: p.url,
        viewId: null,
        opening: false,
        dead: false,
        stage: null,
        paneFocused: p.paneFocused,
        nativeFocused: false,
        focusWanted: false,
        want: { bounds: null, visible: false },
        sent: { bounds: null, visible: null },
        pushing: false,
        again: false,
        navigated: p.url,
      };
      this.recs.set(p.tabId, r);
      useViewStates.setState((s) => ({ views: { ...s.views, [p.tabId]: initialState(p.url) } }));
    }
    const cur = useViewStates.getState().views[p.tabId];
    // The data of the applications were cleared: what ended with them starts again.
    if (cur?.phase === 'closed' && RESTARTS.includes(cur.reason)) this.reset(r);
    if (r.stage && r.stage !== p.stage) this.ro?.unobserve(r.stage);
    r.stage = p.stage;
    r.paneFocused = p.paneFocused;
    if (p.paneFocused && !r.nativeFocused) r.focusWanted = true;
    this.installDom();
    this.ro?.observe(p.stage);
    this.setUrl(r, p.url);
    const rec = r;
    this.update();
    return () => this.detach(rec, p.stage);
  }

  private detach(r: Rec, stage: HTMLElement): void {
    if (r.stage !== stage) return; // already attached to another stage (a remount)
    this.ro?.unobserve(stage);
    r.stage = null;
    r.want = { ...r.want, visible: false };
    patch(r.tabId, (v) => ({ ...v, hidden: true }));
    void this.push(r);
    this.uninstallDomIfIdle();
  }

  /** The pane of the tab gained or lost the focus of the application. */
  setPaneFocused(tabId: string, focused: boolean): void {
    const r = this.recs.get(tabId);
    if (!r || r.paneFocused === focused) return;
    r.paneFocused = focused;
    if (!focused) {
      // the keyboard went elsewhere: the page has it no more, and a Focus asked for before must not follow
      r.nativeFocused = false;
      r.focusWanted = false;
    } else if (!r.nativeFocused) r.focusWanted = true;
    void this.push(r);
  }

  private setUrl(r: Rec, url: string): void {
    if (r.url === url && r.navigated === url) return;
    r.url = url;
    if (!r.viewId) {
      r.navigated = url;
      patch(r.tabId, (v) => ({ ...v, page: { ...v.page, url } }));
      return;
    }
    if (r.navigated === url) return;
    r.navigated = url;
    const { vaultId, viewId } = r;
    this.calls.navigate(vaultId, viewId, url).catch((e) => this.failed(r, e));
  }

  /** Whether the tab has a native view that can be navigated. */
  hasView(tabId: string): boolean {
    const r = this.recs.get(tabId);
    return !!r?.viewId;
  }

  /** The page of the view, for the commands (null when there is no view). */
  pageOf(tabId: string): PageState | null {
    return this.recs.get(tabId)?.viewId
      ? (useViewStates.getState().views[tabId]?.page ?? null)
      : null;
  }

  back(tabId: string): void {
    this.act(tabId, (r, id) => this.calls.back(r.vaultId, id));
  }

  forward(tabId: string): void {
    this.act(tabId, (r, id) => this.calls.forward(r.vaultId, id));
  }

  /** Reloads the page; a view that is gone, or never opened, is opened again. */
  reload(tabId: string): void {
    const r = this.recs.get(tabId);
    if (!r || r.opening) return; // a view that is still opening is about to load
    if (!r.viewId) return this.reopen(tabId);
    patch(tabId, (v) => ({ ...v, loadError: null, crashed: false }));
    this.update();
    this.act(tabId, (rec, id) => this.calls.reload(rec.vaultId, id));
  }

  /**
   * The vault was unlocked: a view that ended with its lock (or never opened because of it) opens again.
   * It does not act on a view that ended for another reason.
   */
  resumeAfterUnlock(tabId: string): void {
    const v = useViewStates.getState().views[tabId];
    if (!v) return;
    const lockedOut =
      (v.phase === 'closed' && (v.reason === 'vault-locked' || v.reason === 'vault-closed')) ||
      (v.phase === 'failed' && errorCodeOf(v.error) === 'vault-locked');
    if (lockedOut) this.reopen(tabId);
  }

  /** Opens the view again after it ended or failed (a click on the button of its card). */
  reopen(tabId: string): void {
    const r = this.recs.get(tabId);
    if (!r || r.opening) return;
    this.reset(r);
    this.update();
  }

  private reset(r: Rec): void {
    const old = r.viewId;
    if (old) this.calls.close(r.vaultId, old).catch(noop);
    r.viewId = null;
    r.opening = false;
    r.nativeFocused = false;
    r.sent = { bounds: null, visible: null };
    r.navigated = r.url;
    useViewStates.setState((s) => ({ views: { ...s.views, [r.tabId]: initialState(r.url) } }));
  }

  /** Deletes the session data of the vault's applications on this device (the core closes the views first). */
  async clearData(vaultId: string): Promise<void> {
    await this.calls.clearData(vaultId);
  }

  dismissNotice(tabId: string, id: number): void {
    patch(tabId, (v) => ({ ...v, notices: v.notices.filter((n) => n.id !== id) }));
  }

  private act(tabId: string, call: (r: Rec, viewId: string) => Promise<void>): void {
    const r = this.recs.get(tabId);
    if (!r?.viewId) return;
    call(r, r.viewId).catch((e) => this.failed(r, e));
  }

  private failed(r: Rec, e: unknown): void {
    // A call that was in flight when the core told the view ended (webview:closed) fails as unknown: the
    // reason it gave is the one to keep.
    if (isGone(e) && r.viewId) {
      r.viewId = null;
      r.sent = { bounds: null, visible: null };
      patch(r.tabId, (v) => ({ ...v, phase: 'closed', reason: 'gone', hidden: true }));
    }
  }

  // ---- closing ----

  /** The tab is gone for good: its view closes. */
  closeTab(tabId: string): void {
    const r = this.recs.get(tabId);
    if (r) this.drop(r, true);
  }

  private drop(r: Rec, close = true): void {
    r.dead = true;
    this.recs.delete(r.tabId);
    if (r.stage) this.ro?.unobserve(r.stage);
    r.stage = null;
    if (close && r.viewId) this.calls.close(r.vaultId, r.viewId).catch(noop);
    r.viewId = null;
    useViewStates.setState((s) => ({
      views: Object.fromEntries(Object.entries(s.views).filter(([id]) => id !== r.tabId)),
    }));
    this.uninstallDomIfIdle();
  }

  /** The tabs of the layout decide which views live: one whose tab is gone (or is no application) closes. */
  private reconcile(layout: Layout): void {
    const live = new Set(
      allPanes(layout.root).flatMap((p) => p.tabs.filter((t) => isWebapp(t.path)).map((t) => t.id)),
    );
    for (const r of [...this.recs.values()]) if (!live.has(r.tabId)) this.drop(r);
    // the focus of the application moved to another pane
    this.update();
  }

  /** The vault in use changed or closed: its views end (the core closes them too; this is the UI's side). */
  private vaultChanged(previous: string | null): void {
    for (const r of [...this.recs.values()]) if (r.vaultId === previous) this.drop(r, false);
    if (previous) this.calls.closeVault(previous).catch(noop);
  }

  private closeEverything(): void {
    for (const r of [...this.recs.values()]) this.drop(r);
    this.removeDom();
  }

  /** The pane that shows a tab (for webview:focus). */
  paneOf(tabId: string): string | undefined {
    return paneOfTab(useAppStore.getState().layout, tabId)?.id;
  }

  // ---- suppression: the user must see something else ----

  /**
   * Hides every view until the returned function is called (a drag, a splitter, anything the UI
   * knows will move over the views). Takes effect at once, not at the next frame.
   */
  suppress(key: string): () => void {
    const token = `${key}#${++this.noticeId}`;
    this.suppressors.add(token);
    this.update();
    return () => {
      if (this.suppressors.delete(token)) this.update();
    };
  }

  // ---- the work of a frame ----

  /** Asks for an update before the next frame (resizing and scrolling fire many times per frame). */
  schedule(): void {
    if (this.frameId) return;
    this.frameId = this.frame(() => {
      this.frameId = 0;
      this.update();
    });
  }

  /** Measures every stage and brings its view to where it should be, now. */
  update(): void {
    if (this.frameId) {
      this.cancelFrame(this.frameId);
      this.frameId = 0;
    }
    const suppressed = this.suppressors.size > 0;
    for (const r of this.recs.values()) {
      const stage = r.stage;
      if (!stage || !stage.isConnected) {
        // No stage to show it in. The core makes a view visible, so what matters is what it was told,
        // not what was wanted before: a view that finished opening after its tab went away is hidden here.
        r.want = { ...r.want, visible: false };
        if (r.sent.visible !== false) void this.push(r);
        continue;
      }
      const rect = stage.getBoundingClientRect();
      const bounds = normalizeBounds(rect, window.innerWidth, window.innerHeight);
      // A card of BrowserView (a load error, a crashed page) is over the stage: the view steps aside.
      const st = useViewStates.getState().views[r.tabId];
      const card = !!(st?.loadError || st?.crashed);
      const visible = bounds !== null && !card && !suppressed && !isCovered(stage, rect, this.at);
      const hidden = !visible;
      r.want = { bounds: bounds ?? r.want.bounds, visible };
      if (useViewStates.getState().views[r.tabId]?.hidden !== hidden)
        patch(r.tabId, (v) => ({ ...v, hidden }));
      if (!r.viewId) {
        if (!r.opening && visible && bounds && this.canOpen(r)) void this.open(r, bounds);
        continue;
      }
      void this.push(r);
    }
  }

  private readonly at = (x: number, y: number): Element[] => document.elementsFromPoint(x, y);

  private canOpen(r: Rec): boolean {
    const v = useViewStates.getState().views[r.tabId];
    return !!v && (v.phase === 'pending' || v.phase === 'opening');
  }

  private async open(r: Rec, bounds: ViewBounds): Promise<void> {
    r.opening = true;
    patch(r.tabId, (v) => ({ ...v, phase: 'opening', error: '', reason: '' }));
    const url = r.url;
    try {
      const opened = await this.calls.open(r.vaultId, url, bounds);
      r.opening = false;
      if (r.dead) {
        this.calls.close(r.vaultId, opened.viewId).catch(noop);
        return;
      }
      r.viewId = opened.viewId;
      r.navigated = url;
      r.sent = { bounds, visible: true };
      patch(r.tabId, (v) => ({
        ...v,
        phase: 'open',
        page: { ...emptyPage(url), loading: true },
      }));
      // what the view said before the answer arrived (a certificate refused at once, a page that
      // loaded): it is the state of the view, in the order it came
      this.replayEarly(r);
      // the address changed while the view was opening
      if (r.url !== url) this.setUrl(r, r.url);
      this.update();
    } catch (e) {
      r.opening = false;
      if (![...this.recs.values()].some((x) => x.opening)) this.early = [];
      if (r.dead) return;
      patch(r.tabId, (v) => ({
        ...v,
        phase: 'failed',
        error: e instanceof Error ? e.message : String(e),
        hidden: true,
      }));
    }
  }

  /** Sends what the view should look like, in order, one call at a time (the latest wish wins). */
  private async push(r: Rec): Promise<void> {
    if (r.pushing) {
      r.again = true;
      return;
    }
    r.pushing = true;
    try {
      do {
        r.again = false;
        const id = r.viewId;
        if (!id || r.dead) break;
        const { bounds, visible } = r.want;
        if (bounds && !sameBounds(bounds, r.sent.bounds)) {
          await this.calls.setBounds(r.vaultId, id, bounds);
          r.sent.bounds = bounds;
        }
        if (visible !== r.sent.visible) {
          await this.calls.setVisible(r.vaultId, id, visible);
          r.sent.visible = visible;
          // The driver takes the keyboard from a view it hides. One that comes back has it again, if its
          // pane has the focus of the application (the core asks the UI to call Focus after SetVisible).
          if (!visible) r.nativeFocused = false;
          else if (r.paneFocused && !r.nativeFocused) r.focusWanted = true;
        }
        if (!r.paneFocused) r.focusWanted = false;
        if (r.focusWanted && r.sent.visible && r.viewId === id) {
          r.focusWanted = false;
          await this.calls.focus(r.vaultId, id);
          r.nativeFocused = true;
        }
      } while (r.again);
    } catch (e) {
      this.failed(r, e);
    } finally {
      r.pushing = false;
    }
  }

  // ---- the page's own events: layout, scroll, overlays, drags ----

  private installDom(): void {
    if (this.domStops) return;
    const stops: (() => void)[] = [];
    const on = <T extends EventTarget>(
      target: T,
      type: string,
      h: (e: Event) => void,
      capture = false,
    ): void => {
      target.addEventListener(type, h, capture);
      stops.push(() => target.removeEventListener(type, h, capture));
    };
    const again = (): void => this.schedule();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(again);
      for (const r of this.recs.values()) if (r.stage) this.ro.observe(r.stage);
      stops.push(() => {
        this.ro?.disconnect();
        this.ro = null;
      });
    }
    on(window, 'resize', again);
    // scrolling anywhere moves a stage (the capture phase sees the ones that do not bubble)
    on(document, 'scroll', again, true);
    on(document, 'focusin', again, true);
    on(document, 'transitionend', again, true);
    on(document, 'animationend', again, true);
    on(document, 'pointerup', again, true);
    on(document, 'keyup', again, true);
    if (typeof MutationObserver !== 'undefined') {
      // what is drawn above a stage appears or changes as nodes and as classes, styles, attributes
      const mo = new MutationObserver(again);
      mo.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden', 'aria-modal'],
      });
      stops.push(() => mo.disconnect());
    }
    // A drag (a tab, a file from the system) must pass over the stages, and a native view would take it.
    // Its end is not always told: a file dropped where nothing accepts it, a drag that began in a native
    // view, a drag that leaves the window give no dragend and no drop here. But dragover comes again and
    // again while one goes on (every few tens of milliseconds), so a drag that sends none is over.
    let endDrag: (() => void) | null = null;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const finishDrag = (): void => {
      clearTimeout(watchdog);
      endDrag?.();
      endDrag = null;
    };
    const watch = (ms: number): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(finishDrag, ms);
    };
    const beginDrag = (): void => {
      endDrag ??= this.suppress('drag');
      watch(DRAG_SILENCE_MS);
    };
    on(document, 'dragstart', beginDrag, true);
    on(document, 'dragenter', beginDrag, true);
    on(document, 'dragover', beginDrag, true);
    on(document, 'dragend', finishDrag, true);
    on(document, 'drop', finishDrag, true);
    on(
      document,
      'dragleave',
      (e) => {
        if (!endDrag) return;
        const d = e as DragEvent;
        // Out of the window altogether: over. Out of an element with no destination named (what browsers
        // give for most of them): over unless a dragover follows at once.
        if (
          d.clientX <= 0 ||
          d.clientY <= 0 ||
          d.clientX >= window.innerWidth ||
          d.clientY >= window.innerHeight
        )
          finishDrag();
        else if (d.relatedTarget === null) watch(DRAG_LEAVE_GRACE_MS);
      },
      true,
    );
    // A splitter (the divider of two panes, of a sidebar) is dragged over the stages too.
    let endResize: (() => void) | null = null;
    const finishResize = (): void => {
      endResize?.();
      endResize = null;
    };
    on(
      window,
      'pointerdown',
      (e) => {
        const t = e.target;
        if (t instanceof Element && t.closest('[role="separator"]') && !endResize)
          endResize = this.suppress('resize');
      },
      true,
    );
    on(window, 'pointerup', finishResize, true);
    on(window, 'pointercancel', finishResize, true);
    on(window, 'blur', () => {
      finishResize();
      finishDrag();
    });
    // Nothing tells that a menu closed by itself on a timer (a toast, a tooltip): look now and then.
    const timer = window.setInterval(again, 500);
    stops.push(() => window.clearInterval(timer));
    this.domStops = () => {
      finishDrag();
      finishResize();
      for (const stop of stops.splice(0)) stop();
    };
  }

  private uninstallDomIfIdle(): void {
    for (const r of this.recs.values()) if (r.stage) return;
    this.removeDom();
  }

  private removeDom(): void {
    this.domStops?.();
    this.domStops = null;
    if (this.frameId) {
      this.cancelFrame(this.frameId);
      this.frameId = 0;
    }
  }
}

/** The manager of the application. */
export const nativeViews = new NativeViews();
