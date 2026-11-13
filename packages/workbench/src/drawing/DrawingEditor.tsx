// The Excalidraw editor tab (M3-WP1). Loaded lazily by DrawingView: it pulls in the whole
// Excalidraw bundle. The file is saved whole 2 s after the last real edit, with the hash of
// the last read as write precondition (same conflict handling as notes).
import '@excalidraw/excalidraw/index.css';
import * as ExcalidrawLib from '@excalidraw/excalidraw';
import { excalidrawLang } from './lang';
import { ExcalidrawIsland } from './ExcalidrawIsland';
import { Excalidraw, restoreElements, serializeAsJSON } from '@excalidraw/excalidraw';
import type { SceneElement } from './actions/types';
import type { ExcalidrawImperativeAPI, LibraryItems } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { invalidateVault } from '../app/actions';
import { useNoteDocument } from '../editor/useNoteDocument';
import { registerNoteFlusher } from '../workspaces/flush';
import { effectiveTheme, type Theme } from '../app/theme';
import { infoOf, useSync } from '../state/sync';
import { dialog } from '../ui/dialogs';
import { openOrCreate } from '../app/actions';
import { previewWanted } from '../preview/hover';
import { scheduleHidePreview, schedulePreview } from '../preview/popover';
import { openExternal } from '../util/external';
import { commandForEvent } from '../commands/registry';
import { drawingFeatureOn } from '../state/managed';
import { useSettings } from '../state/settings';
import { defaultItemState, useDrawingSettings } from './settings';
import { beginPrint, endPrint } from '../export/commands';
import { ExportDialog, type ExportAction } from './export/ExportDialog';
import {
  autoExportPlan,
  defaultExportOptions,
  exportName,
  framesOf,
  type ExportEl,
  type ExportOptions,
} from './export/options';
import { Icon } from '../shell/icons';
import { enterFullscreen, leaveFullscreen } from '../util/fullscreen';
import { bytesToBase64, copyExport, renderExport, type ExportInput } from './export/render';
import {
  getSceneController,
  registerSceneController,
  unregisterSceneController,
} from './actions/active';
import type { SceneController, ToolKind } from './actions/active';
import { dropVaultFile } from './embed/commands';
import { latexOf, latexPatch } from './latex/insert';
import { fileSettingsOf, normalizeFileExtra, withFileSetting } from './meta';
import { mermaidPatch, parseMermaid } from './mermaid/insert';
import { TextToolDialog } from './TextToolDialog';
import { DescribeDialog } from './DescribeDialog';
import { describeScene } from './describe';
import { ToolsPanel } from './ToolsPanel';
import { moveSlide, playable, slideKey, slidesOf, type Slide } from './slides';
import { useDrawingSlides } from './slidesStore';
import { applyPatch } from './actions/apply';
import {
  folderOf,
  isOverLimit,
  elementAt,
  linkedElementAt,
  parseElementLink,
  parseScene,
  sceneSignature,
  type RawScene,
} from './scene';

const AUTOSAVE_MS = 2000;
/** App commands Excalidraw must not swallow while it has the focus. */
const NAVIGATION_COMMANDS = new Set(['palette:open', 'switcher:open']);
const LIBRARY_FILE = 'excalidraw-library.json';

interface Props {
  vaultId: string;
  path: string;
}

/** Follows the app theme (data-theme attribute, or the OS preference for "system"). */
function useAppTheme(): 'light' | 'dark' {
  const read = (): 'light' | 'dark' =>
    effectiveTheme((document.documentElement.getAttribute('data-theme') ?? 'system') as Theme);
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

/** Prints the drawing (the system dialog offers "Save as PDF"), on the app's print layer. */
async function printDrawing(out: { base64: string }): Promise<void> {
  beginPrint(
    `<p><img alt="" style="max-width:100%" src="data:image/svg+xml;base64,${out.base64}"></p>`,
  );
  const imgs = [...document.querySelectorAll<HTMLImageElement>('#clarae-print img')];
  await Promise.all(imgs.map((i) => i.decode().catch(() => undefined)));
  window.addEventListener('afterprint', endPrint, { once: true });
  try {
    await api.exporter.print();
  } catch {
    window.print(); // no native binding (plain browser): the web view's own print
  }
}

export default function DrawingEditor({ vaultId, path }: Props) {
  const { t, i18n } = useTranslation();
  const doc = useNoteDocument(vaultId, path, AUTOSAVE_MS);
  const locked = useSync((s) => infoOf(s, vaultId).locked || infoOf(s, vaultId).readOnly);
  const theme = useAppTheme();
  const [excalidraw, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [library, setLibrary] = useState<LibraryItems | null>(null);
  const [zen, setZen] = useState(
    () => useDrawingSettings.getState().settings.defaultMode === 'zen',
  );
  const [tool, setTool] = useState<{ kind: ToolKind; editId?: string } | null>(null);
  const [viewing, setViewing] = useState(
    () => useDrawingSettings.getState().settings.defaultMode === 'view',
  );
  const [present, setPresent] = useState(false);
  // The frames played as slides while presenting (empty: plain presentation), and the current one.
  const [deck, setDeck] = useState<Slide[]>([]);
  const [slide, setSlide] = useState(0);
  // Presentation settings of this drawing (Slideshow tab): loop, slide counter, notes.
  const [slideOpts, setSlideOpts] = useState({ loop: false, numbers: true, notes: true });
  const [exporting, setExporting] = useState(false);
  // The format the export dialog opens with (the ribbon buttons preselect one).
  // The format chosen from the ribbon, for this one opening of the dialog; null: the saved default.
  const [exportFormat, setExportFormat] = useState<ExportOptions['format'] | null>(null);
  // The export functions are defined further down: the scene controller reaches them from here.
  const exportHooks = useRef<{ print(): Promise<void> }>({ print: () => Promise.resolve() });
  const host = useRef<HTMLDivElement>(null);
  const signature = useRef('');
  // Top-level keys of the file other than Excalidraw's own (per-drawing settings): kept and
  // written back on every save.
  const extra = useRef<Record<string, unknown>>({});
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  });
  const shownVersion = useRef(0);
  const libraryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The library lives in the vault (.clarae/excalidraw-library.json) and syncs with it.
  useEffect(() => {
    void api.vault
      .readConfig(vaultId, LIBRARY_FILE)
      .then((raw) => {
        try {
          const parsed = raw ? (JSON.parse(raw) as { libraryItems?: LibraryItems }) : {};
          setLibrary(parsed.libraryItems ?? []);
        } catch {
          setLibrary([]);
        }
      })
      .catch(() => setLibrary([]));
  }, [vaultId]);

  // The scene the editor starts from: the file as first loaded. Later versions (sync, external
  // edits) are applied through the Excalidraw API below, never by remounting the editor.
  const parsed = useMemo<{ scene: RawScene } | { error: string }>(() => {
    if (doc.status !== 'ready')
      return { scene: { elements: [], appState: {}, files: {}, extra: {} } };
    try {
      return { scene: parseScene(doc.content) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.status]);

  useEffect(() => {
    if ('scene' in parsed) extra.current = parsed.scene.extra;
  }, [parsed]);

  // A newer version of the file (sync or an external edit): show it in the open editor.
  useEffect(() => {
    if (!excalidraw || doc.status !== 'ready' || doc.version === shownVersion.current) return;
    shownVersion.current = doc.version;
    if (doc.version <= 1) return;
    try {
      const scene = parseScene(doc.content);
      signature.current = sceneSignature(scene.elements, Object.keys(scene.files).length);
      extra.current = scene.extra;
      excalidraw.updateScene({
        elements: restoreElements(scene.elements as never, null),
      });
      const files = Object.values(scene.files);
      if (files.length > 0) excalidraw.addFiles(files as never);
    } catch {
      /* an invalid file on disk is reported by the banner below on next load */
    }
  }, [excalidraw, doc.status, doc.version, doc.content]);

  /** The file text for a scene: Excalidraw's JSON plus the extra top-level keys. */
  const serialize = (
    elements: readonly { id: string; version: number }[],
    appState: Parameters<typeof serializeAsJSON>[1],
    files: Parameters<typeof serializeAsJSON>[2],
  ): string => {
    const json = serializeAsJSON(elements as never, appState, files, 'local');
    // The settings are written under the current key only (a 1.x file keeps its legacy one until now).
    const rest = normalizeFileExtra(extra.current);
    if (Object.keys(rest).length === 0) return json;
    return JSON.stringify({ ...(JSON.parse(json) as object), ...rest }, null, 2);
  };

  const onChange = useCallback(
    (
      elements: readonly { id: string; version: number }[],
      appState: Parameters<typeof serializeAsJSON>[1],
      files: Parameters<typeof serializeAsJSON>[2],
    ) => {
      const sig = sceneSignature(elements, Object.keys(files).length);
      if (sig === signature.current) return; // selection, scroll, zoom: not an edit
      const first = signature.current === '';
      signature.current = sig;
      // The Slideshow tab of the right sidebar lists the frames.
      useDrawingSlides.getState().publish(path, slidesOf(elements as unknown as SceneElement[]));
      if (first) return; // the initial render of the loaded file
      doc.edit(serialize(elements, appState, files));
    },
    [doc, path],
  );
  useEffect(() => () => useDrawingSlides.getState().clear(path), [path]);
  // The frames of a freshly opened drawing (Excalidraw reports no change for the loaded scene).
  // The API can be handed over before the initial scene is applied: then the loaded file's
  // elements are published, otherwise the Slideshow tab would stay empty until the first edit.
  useEffect(() => {
    if (!excalidraw) return;
    const live = excalidraw.getSceneElements();
    const loaded = 'scene' in parsed ? (parsed.scene.elements as unknown as SceneElement[]) : [];
    useDrawingSlides.getState().publish(path, slidesOf(live.length > 0 ? live : loaded));
  }, [excalidraw, path, parsed]);

  // The library write waiting for its delay: written at once when the drawing closes and before
  // the vault is closed or switched or the app quits.
  const libraryPending = useRef<(() => Promise<void>) | null>(null);
  const flushLibrary = useCallback(async (): Promise<void> => {
    clearTimeout(libraryTimer.current);
    const write = libraryPending.current;
    libraryPending.current = null;
    await write?.();
  }, []);
  const onLibraryChange = useCallback(
    (items: LibraryItems) => {
      clearTimeout(libraryTimer.current);
      const body = JSON.stringify({ type: 'excalidrawlib', version: 2, libraryItems: items });
      libraryPending.current = async () => {
        try {
          await api.vault.writeConfig(vaultId, LIBRARY_FILE, body);
        } catch {
          // A read-only vault keeps the library for the session only.
        }
      };
      libraryTimer.current = setTimeout(() => void flushLibrary(), 800);
    },
    [vaultId, flushLibrary],
  );
  useEffect(() => {
    const off = registerNoteFlusher(flushLibrary);
    return () => {
      off();
      void flushLibrary();
    };
  }, [flushLibrary]);

  // Scene-action commands (palette, hotkeys) act on the editor that is mounted.
  const canEdit = useRef(false);
  useEffect(() => {
    canEdit.current = !locked && !present && !viewing;
  }, [locked, present, viewing]);
  // Formulas imported from Obsidian (.excalidraw.md) carry their TeX but no rendered image: draw
  // them once the drawing is open. The same heals a formula whose file went missing.
  const healedFormulas = useRef('');
  useEffect(() => {
    if (!excalidraw || doc.status !== 'ready' || healedFormulas.current === path) return;
    if (!drawingFeatureOn('drawing_latex')) return;
    healedFormulas.current = path;
    const files = excalidraw.getFiles();
    const missing = excalidraw
      .getSceneElements()
      .filter((e) => e.type === 'image' && latexOf(e as never) && !files[String(e.fileId)]);
    if (missing.length === 0 || !canEdit.current) return;
    void (async () => {
      try {
        for (const e of missing) {
          const patch = await latexPatch(latexOf(e)?.latex ?? '', {
            center: { x: 0, y: 0 },
            existing: e,
          });
          excalidraw.addFiles(Object.values(patch.files ?? {}) as never);
          excalidraw.updateScene({
            elements: applyPatch(excalidraw.getSceneElementsIncludingDeleted(), patch) as never,
          });
        }
      } catch {
        /* invalid TeX stays as the empty image: the LaTeX dialog shows MathJax's message */
      }
    })();
  }, [excalidraw, doc.status, path]);

  /** Starts the presentation: the frames become the slides and the laser pointer the tool. */
  const startEvent = useRef<Event | null>(null);
  const startPresent = useCallback(
    (fromId?: string) => {
      startEvent.current = window.event ?? null;
      if (excalidraw) {
        const mb = fileSettingsOf(extra.current);
        setSlideOpts({
          loop: mb['slideLoop'] === 'true',
          numbers: mb['slideNumbers'] !== 'false',
          notes: mb['slideNotes'] !== 'false',
        });
        const slides = playable(slidesOf(excalidraw.getSceneElements()));
        setDeck(slides);
        setSlide(
          Math.max(
            0,
            slides.findIndex((s) => s.id === fromId),
          ),
        );
        excalidraw.setActiveTool({ type: 'laser' });
      }
      setPresent(true);
    },
    [excalidraw],
  );
  useEffect(() => {
    if (!excalidraw) return;
    const controller: SceneController = {
      vaultId,
      canEdit: () => canEdit.current,
      context: () => {
        const st = excalidraw.getAppState();
        return {
          elements: excalidraw.getSceneElementsIncludingDeleted(),
          selected: Object.keys(st.selectedElementIds),
          origin: {
            x: st.width / 2 / st.zoom.value - st.scrollX,
            y: st.height / 2 / st.zoom.value - st.scrollY,
          },
        };
      },
      apply: (patch) => {
        // Brand new elements are completed by Excalidraw (seed, index, defaults) before joining.
        // refreshDimensions re-measures new text (labels of cards and diagrams) with the real fonts.
        const added = patch.add
          ? (restoreElements(patch.add as never, null, {
              refreshDimensions: true,
            }) as unknown as SceneElement[])
          : [];
        const elements = applyPatch(excalidraw.getSceneElementsIncludingDeleted(), {
          ...patch,
          add: added,
        });
        if (patch.files) excalidraw.addFiles(Object.values(patch.files) as never);
        // Text changed by a patch (new font, new label) is re-measured with the real fonts, and
        // its container is resized to fit.
        const touched = new Set(Object.keys(patch.update ?? {}));
        const retext = elements.filter(
          (e) =>
            (e.type === 'text' && touched.has(e.id)) ||
            elements.some((t) => t.type === 'text' && touched.has(t.id) && t.containerId === e.id),
        );
        if (retext.length) {
          const fresh = new Map(
            (
              restoreElements(retext as never, null, {
                refreshDimensions: true,
              }) as unknown as readonly SceneElement[]
            ).map((e) => [e.id, e]),
          );
          elements.forEach((e, i) => {
            const f = fresh.get(e.id);
            if (f) elements[i] = f;
          });
        }
        const view = patch.view;
        const changesElements =
          Object.keys(patch.update ?? {}).length > 0 || added.length > 0 || !!patch.remove?.length;
        const select = view?.select ?? (added.length ? added.map((e) => e.id) : null);
        const appState: Record<string, unknown> = {
          ...(view?.appState ?? {}),
          ...(select
            ? { selectedElementIds: Object.fromEntries(select.map((id) => [id, true])) }
            : {}),
          ...(view?.toggleGrid
            ? { gridModeEnabled: !excalidraw.getAppState().gridModeEnabled }
            : {}),
        };
        // The resulting onChange sees new element versions and schedules the autosave.
        excalidraw.updateScene({
          ...(changesElements ? { elements: elements as never } : {}),
          ...(Object.keys(appState).length ? { appState: appState as never } : {}),
        });
        if (view?.tool) excalidraw.setActiveTool({ type: view.tool as never });
        if (view?.zoomTo?.length) {
          const ids = new Set(view.zoomTo);
          const targets = excalidraw.getSceneElements().filter((e) => ids.has(e.id));
          if (targets.length)
            excalidraw.setViewport({ target: targets, fit: 'contain', animation: true });
        }
      },
      drawingPath: path,
      save: async () => {
        docRef.current.edit(
          serialize(
            excalidraw.getSceneElementsIncludingDeleted(),
            excalidraw.getAppState(),
            excalidraw.getFiles(),
          ),
        );
        await docRef.current.flush();
      },
      files: () => excalidraw.getFiles(),
      setFileSetting: (key, value) => {
        extra.current = withFileSetting(extra.current, key, value);
        // Persist now: the setting lives in the file.
        docRef.current.edit(
          serialize(
            excalidraw.getSceneElementsIncludingDeleted(),
            excalidraw.getAppState(),
            excalidraw.getFiles(),
          ),
        );
      },
      viewportCenter: () => {
        const st = excalidraw.getAppState();
        return {
          x: st.width / 2 / st.zoom.value - st.scrollX,
          y: st.height / 2 / st.zoom.value - st.scrollY,
        };
      },
      defaultColor: () => excalidraw.getAppState().currentItemStrokeColor,
      openTool: (kind, editId) => setTool({ kind, ...(editId ? { editId } : {}) }),
      openExport: (format) => {
        setExportFormat(format);
        setExporting(true);
      },
      printDrawing: () => exportHooks.current.print(),
      importLibrary: async (json) => {
        const items = await ExcalidrawLib.loadLibraryFromBlob(new Blob([json]), 'unpublished');
        await excalidraw.updateLibrary({ libraryItems: items, merge: true, openLibraryMenu: true });
        return items.length;
      },
      startSlideshow: (fromId) => startPresent(fromId),
      fileSettings: () => fileSettingsOf(extra.current),
      showFrame: (id) => {
        const frame = excalidraw.getSceneElements().find((e) => e.id === id);
        if (frame) excalidraw.setViewport({ target: frame, fit: 'contain', animation: true });
      },
      slideThumbnail: async (id, width = 320) => {
        const els = excalidraw.getSceneElements();
        const frame = els.find((e) => e.id === id);
        if (!frame) return '';
        const st = excalidraw.getAppState();
        const svg = await ExcalidrawLib.exportToSvg({
          elements: els,
          files: excalidraw.getFiles(),
          exportPadding: 0,
          exportingFrame: frame as never,
          appState: {
            exportBackground: true,
            viewBackgroundColor: st.viewBackgroundColor,
            exportWithDarkMode: false,
          },
          maxWidthOrHeight: width,
        });
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
      },
      printSlides: async () => {
        const els = excalidraw.getSceneElements();
        const pages: string[] = [];
        for (const sl of playable(slidesOf(els))) {
          const frame = els.find((e) => e.id === sl.id);
          if (!frame) continue;
          const svg = await ExcalidrawLib.exportToSvg({
            elements: els,
            files: excalidraw.getFiles(),
            exportPadding: 0,
            exportingFrame: frame as never,
            appState: { exportBackground: true },
          });
          const b64 = bytesToBase64(
            new TextEncoder().encode(new XMLSerializer().serializeToString(svg)),
          );
          pages.push(
            `<section style="break-after:page"><img alt="" style="max-width:100%" src="data:image/svg+xml;base64,${b64}"></section>`,
          );
        }
        if (pages.length === 0) return;
        beginPrint(pages.join(''));
        const imgs = [...document.querySelectorAll<HTMLImageElement>('#clarae-print img')];
        await Promise.all(imgs.map((i) => i.decode().catch(() => undefined)));
        window.addEventListener('afterprint', endPrint, { once: true });
        try {
          await api.exporter.print();
        } catch {
          window.print();
        }
      },
    };
    registerSceneController(controller);
    return () => unregisterSceneController(controller);
    // `serialize` and the refs are read at call time.
  }, [excalidraw, vaultId, path, startPresent]);

  // Clicking the link of an element: wikilinks open the note (Cmd/Ctrl = new tab, a missing note
  // is created like in the editor), web URLs go to the system browser. Excalidraw's own
  // window.open is always suppressed.
  const onLinkOpen = useCallback(
    (
      element: { link: string | null },
      event: CustomEvent<{ nativeEvent: MouseEvent | React.PointerEvent }>,
    ) => {
      event.preventDefault();
      const link = parseElementLink(element.link);
      if (!link) return;
      if (link.kind === 'external') {
        openExternal(link.url);
        return;
      }
      const native = event.detail.nativeEvent;
      void openOrCreate(path, link, native.metaKey || native.ctrlKey).catch((e: unknown) =>
        dialog.error(e),
      );
    },
    [path],
  );

  // Cmd/Ctrl (or always, per the page-preview setting) + hover over an element that links to a
  // note shows the same popover as a wikilink. The pointer is mapped to scene coordinates.
  const onCanvasMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!excalidraw || !previewWanted(e.metaKey || e.ctrlKey)) return;
      const st = excalidraw.getAppState();
      const x = (e.clientX - st.offsetLeft) / st.zoom.value - st.scrollX;
      const y = (e.clientY - st.offsetTop) / st.zoom.value - st.scrollY;
      const hit = linkedElementAt(
        excalidraw.getSceneElements() as unknown as Parameters<typeof linkedElementAt>[0],
        x,
        y,
      );
      const link = parseElementLink(hit?.link);
      if (!hit || link?.kind !== 'note') {
        scheduleHidePreview();
        return;
      }
      schedulePreview({
        vaultId,
        fromPath: path,
        spec: link,
        anchor: {
          left: e.clientX,
          right: e.clientX,
          top: e.clientY - 4,
          bottom: e.clientY + 4,
        },
      });
    },
    [excalidraw, vaultId, path],
  );

  // A file dragged from the file explorer: images and notes are added where it is dropped.
  const onCanvasDrop = useCallback(
    (e: React.DragEvent) => {
      const dropped = e.dataTransfer.getData('application/x-clarae-path');
      if (!excalidraw || !dropped) return;
      e.preventDefault();
      e.stopPropagation();
      const st = excalidraw.getAppState();
      void dropVaultFile(
        dropped,
        {
          x: (e.clientX - st.offsetLeft) / st.zoom.value - st.scrollX,
          y: (e.clientY - st.offsetTop) / st.zoom.value - st.scrollY,
        },
        path,
      );
    },
    [excalidraw, path],
  );
  const onCanvasDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/x-clarae-path')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  // Double click on a LaTeX formula edits it.
  const onCanvasDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const c = getSceneController(path);
      if (!excalidraw || !c?.canEdit() || !drawingFeatureOn('drawing_latex')) return;
      const st = excalidraw.getAppState();
      const x = (e.clientX - st.offsetLeft) / st.zoom.value - st.scrollX;
      const y = (e.clientY - st.offsetTop) / st.zoom.value - st.scrollY;
      const hit = elementAt(
        excalidraw.getSceneElements() as unknown as Parameters<typeof elementAt>[0],
        x,
        y,
        (el) => latexOf(el as never) !== null,
        0,
      );
      if (hit) setTool({ kind: 'latex', editId: hit.id });
    },
    [excalidraw, path],
  );

  // Excalidraw consumes some Cmd/Ctrl shortcuts while elements are selected (Mod+P, Mod+O).
  // The navigation commands must keep working there, so they are handled on the way down.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const c = commandForEvent(e, useSettings.getState().hotkeys);
      if (!c || !NAVIGATION_COMMANDS.has(c.id)) return;
      e.preventDefault();
      e.stopPropagation();
      void c.run();
    };
    el.addEventListener('keydown', onKey, true);
    return () => el.removeEventListener('keydown', onKey, true);
    // The host element exists once the editor has rendered past its loading state, which is
    // when Excalidraw hands over its API.
  }, [excalidraw]);

  // Presentation mode: read-only, zen and full screen.
  const fullscreenOn = useRef(false);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    if (present) void enterFullscreen(el);
    else if (fullscreenOn.current) void leaveFullscreen();
    fullscreenOn.current = present;
  }, [present]);
  useEffect(
    () => () => {
      if (fullscreenOn.current) void leaveFullscreen();
    },
    [],
  );
  // Slideshow: with frames in the drawing each one is a slide; the laser pointer is the tool while
  // presenting. Escape ends the presentation (also where the webview has no element full screen).
  const wasPresenting = useRef(false);
  useEffect(() => {
    if (present) {
      wasPresenting.current = true;
    } else if (wasPresenting.current && excalidraw) {
      excalidraw.setActiveTool({ type: 'selection' });
      wasPresenting.current = false;
    }
  }, [present, excalidraw]);
  const showSlide = useCallback(() => {
    const id = deck[slide]?.id;
    if (!excalidraw || !id) return;
    const frame = excalidraw.getSceneElements().find((e) => e.id === id);
    if (frame)
      excalidraw.setViewport({ target: frame, fit: 'contain', animation: { duration: 400 } });
  }, [excalidraw, deck, slide]);
  useEffect(() => {
    if (present) showSlide();
  }, [present, showSlide]);
  // Going full screen resizes the canvas: fit the slide again.
  useEffect(() => {
    if (!present || deck.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refit = () => {
      clearTimeout(timer);
      timer = setTimeout(showSlide, 150);
    };
    window.addEventListener('resize', refit);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', refit);
    };
  }, [present, deck, showSlide]);
  // A layout effect: the keys work from the first frame the slides are on screen.
  useLayoutEffect(() => {
    if (!present) return;
    const onKey = (e: KeyboardEvent) => {
      // The Enter that ran the palette command is still travelling up to the document: it must
      // not also advance the first slide.
      if (e === startEvent.current) return;
      if (e.key === 'Escape') {
        setPresent(false);
        return;
      }
      if (deck.length === 0) return;
      const k = slideKey(e.key);
      if (k === undefined) return;
      e.preventDefault();
      setSlide((i) =>
        k === 'first'
          ? 0
          : k === 'last'
            ? deck.length - 1
            : slideOpts.loop
              ? (i + k + deck.length) % deck.length
              : moveSlide(i, k, deck.length),
      );
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [present, deck, slideOpts]);
  useEffect(() => {
    const off = () => {
      if (!document.fullscreenElement) setPresent(false);
    };
    document.addEventListener('fullscreenchange', off);
    return () => document.removeEventListener('fullscreenchange', off);
  }, []);

  /** What the export functions need from the live scene. */
  const exportInput = useCallback((): ExportInput | null => {
    if (!excalidraw) return null;
    return {
      elements: excalidraw.getSceneElementsIncludingDeleted(),
      appState: excalidraw.getAppState() as unknown as Record<string, unknown>,
      files: excalidraw.getFiles(),
      selected: Object.keys(excalidraw.getAppState().selectedElementIds),
    };
  }, [excalidraw]);

  const closeExport = (): void => {
    setExporting(false);
    setExportFormat(null);
  };

  const doExport = async (o: ExportOptions, action: ExportAction) => {
    const input = exportInput();
    if (!input) return;
    closeExport();
    try {
      if (action === 'copy') {
        await copyExport(ExcalidrawLib, input, o);
        return;
      }
      const frameName =
        o.scope.kind === 'frame'
          ? (framesOf(input.elements as ExportEl[]).find(
              (f) => f.id === (o.scope as { id: string }).id,
            )?.name ?? '')
          : '';
      if (action === 'print') {
        await printDrawing(await renderExport(ExcalidrawLib, input, { ...o, format: 'svg' }));
        return;
      }
      const name = exportName(path, o, frameName);
      const out = await renderExport(ExcalidrawLib, input, o);
      if (action === 'saveAs') {
        const res = await api.exporter.saveFile(vaultId, name, out.mime, out.base64);
        if (!res.cancelled)
          await dialog.alert(t('drawing.export'), t('drawing.exported', { path: res.path }));
        return;
      }
      const saved = await api.vault.saveAttachment(vaultId, folderOf(path), name, out.base64);
      invalidateVault(vaultId);
      await dialog.alert(t('drawing.export'), t('drawing.exported', { path: saved }));
    } catch (e) {
      if (e instanceof Error && e.message === 'nothing to export')
        await dialog.alert(t('drawing.export'), t('drawing.nothingToExport'));
      else await dialog.error(e);
    }
  };

  useEffect(() => {
    exportHooks.current.print = () =>
      doExport(
        {
          ...defaultExportOptions(useDrawingSettings.getState().settings),
          scope: { kind: 'all' },
          format: 'svg',
        },
        'print',
      );
  });

  // Auto-export: after a save that followed an edit, write the PNG/SVG variants next to the
  // drawing (overwriting the previous ones). A failure never blocks editing.
  const dirtySinceExport = useRef(false);
  useEffect(() => {
    if (doc.save === 'dirty' || doc.save === 'saving') dirtySinceExport.current = true;
  }, [doc.save]);
  useEffect(() => {
    if (doc.save !== 'saved' || !dirtySinceExport.current || locked) return;
    if (!drawingFeatureOn('drawing_auto_export')) {
      dirtySinceExport.current = false;
      return;
    }
    const cfg = useDrawingSettings.getState().settings;
    // A drawing can override the vault's auto-export choice (stored in the file itself).
    const own = fileSettingsOf(extra.current)['autoExport'];
    const mode =
      own === 'none' || own === 'png' || own === 'svg' || own === 'both' ? own : cfg.autoExport;
    const plan = autoExportPlan(mode, cfg.autoExportTheme);
    const input = exportInput();
    dirtySinceExport.current = false;
    if (plan.length === 0 || !input) return;
    const base = defaultExportOptions(cfg);
    void (async () => {
      for (const { variant, format } of plan) {
        try {
          const out = await renderExport(ExcalidrawLib, input, {
            ...base,
            format,
            dark: variant === 'dark',
            embedScene: false,
          });
          await api.drawing.writeExport(vaultId, path, variant, format, out.base64);
        } catch {
          /* an export that fails (nothing drawn yet, disk) is retried at the next save */
        }
      }
      invalidateVault(vaultId);
    })();
  }, [doc.save, locked, exportInput, vaultId, path]);

  if (doc.status === 'loading' || library === null)
    return <div className="note-loading muted">…</div>;
  if (doc.status === 'error')
    return (
      <div className="note-error" role="alert">
        {doc.error}
      </div>
    );
  if ('error' in parsed)
    return (
      <div className="note-error" role="alert">
        {t('drawing.invalid', { error: parsed.error })}
      </div>
    );

  const saveLabel = {
    saved: t('editor.saved'),
    dirty: t('editor.unsaved'),
    saving: t('editor.saving'),
    conflict: '',
    error: t('editor.saveError'),
  }[doc.save];
  const { scene } = parsed;
  const readOnly = locked || present || viewing;

  return (
    <div className="note-view drawing-view" ref={host}>
      <div className="note-header">
        <span className="path" title={path}>
          {path.replace(/\.excalidraw$/, '')}
        </span>
        <span className={`save-state ${doc.save}`} aria-live="polite">
          {saveLabel}
        </span>
        <div className="mode-toggle" role="group" aria-label={t('drawing.tools')}>
          <button
            onClick={() => {
              setExportFormat(null);
              setExporting(true);
            }}
            disabled={locked}
          >
            {t('drawing.export')}
          </button>
          <button
            className={viewing ? 'active' : ''}
            aria-pressed={viewing}
            onClick={() => setViewing(!viewing)}
            disabled={locked}
          >
            {t(viewing ? 'drawing.edit' : 'drawing.view')}
          </button>
          <button className={zen ? 'active' : ''} aria-pressed={zen} onClick={() => setZen(!zen)}>
            {t('drawing.zen')}
          </button>
          <button
            className={present ? 'active' : ''}
            aria-pressed={present}
            onClick={() => (present ? setPresent(false) : startPresent())}
          >
            {t('drawing.present')}
          </button>
        </div>
      </div>
      {doc.save === 'conflict' && (
        <div className="banner" role="alert">
          <span>{t('editor.conflict')}</span>
          <button onClick={() => void doc.reload()}>{t('editor.reload')}</button>
          <button onClick={() => void doc.overwrite()}>{t('editor.overwrite')}</button>
        </div>
      )}
      {isOverLimit(doc.content) && (
        <div className="banner" role="status">
          {t('drawing.tooLarge')}
        </div>
      )}
      <div
        className={`drawing-canvas${present ? ' presenting' : ''}`}
        onMouseMove={onCanvasMouseMove}
        onDoubleClick={onCanvasDoubleClick}
        onDropCapture={onCanvasDrop}
        onDragOverCapture={onCanvasDragOver}
        onMouseLeave={scheduleHidePreview}
      >
        <ExcalidrawIsland key={path}>
          <Excalidraw
            onExcalidrawAPI={setApi}
            initialData={{
              elements: restoreElements(scene.elements as never, null),
              appState: {
                ...defaultItemState(useDrawingSettings.getState().settings),
                ...scene.appState,
                collaborators: new Map(),
              },
              files: scene.files as never,
              libraryItems: library,
              scrollToContent: true,
            }}
            theme={theme}
            langCode={excalidrawLang(
              i18n.language,
              ExcalidrawLib.languages.map((l) => l.code),
            )}
            viewModeEnabled={readOnly}
            zenModeEnabled={zen || present}
            onChange={onChange}
            onLibraryChange={onLibraryChange}
            onLinkOpen={onLinkOpen}
            UIOptions={{
              // Always the desktop layout: the toolbar stays at the top, centred, at any width.
              getFormFactor: () => 'desktop',
              canvasActions: {
                loadScene: false,
                export: false,
                saveAsImage: false,
                saveToActiveFile: false,
                toggleTheme: false,
              },
            }}
          />
        </ExcalidrawIsland>
        {present && deck.length > 0 && (
          <div className="slideshow-bar" role="toolbar" aria-label={t('drawing.slideshow.label')}>
            <button
              aria-label={t('drawing.slideshow.previous')}
              disabled={slide === 0 && !slideOpts.loop}
              onClick={() =>
                setSlide((i) =>
                  slideOpts.loop
                    ? (i - 1 + deck.length) % deck.length
                    : moveSlide(i, -1, deck.length),
                )
              }
            >
              <Icon name="prev" />
            </button>
            <select
              aria-label={t('drawing.slideshow.slide')}
              value={slide}
              onChange={(e) => setSlide(Number(e.target.value))}
            >
              {deck.map((d, i) => (
                <option key={d.id} value={i}>
                  {d.name}
                </option>
              ))}
            </select>
            {slideOpts.numbers && (
              <span aria-live="polite">
                {t('drawing.slideshow.of', { n: slide + 1, total: deck.length })}
              </span>
            )}
            {slideOpts.notes && deck[slide]?.notes && (
              <span className="slide-notes">{deck[slide]?.notes}</span>
            )}
            <button
              aria-label={t('drawing.slideshow.next')}
              disabled={slide === deck.length - 1 && !slideOpts.loop}
              onClick={() =>
                setSlide((i) =>
                  slideOpts.loop ? (i + 1) % deck.length : moveSlide(i, 1, deck.length),
                )
              }
            >
              <Icon name="chevronRight" />
            </button>
          </div>
        )}
      </div>
      {tool?.kind === 'tools' && <ToolsPanel onClose={() => setTool(null)} />}
      {tool?.kind === 'describe' && excalidraw && (
        <DescribeDialog
          description={describeScene(excalidraw.getSceneElements())}
          onClose={() => setTool(null)}
        />
      )}
      {tool?.kind === 'latex' && (
        <TextToolDialog
          title={t(tool.editId ? 'drawing.latex.editTitle' : 'drawing.latex.insertTitle')}
          hint={t('drawing.latex.hint')}
          initial={
            latexOf(excalidraw?.getSceneElements().find((e) => e.id === tool.editId))?.latex ?? ''
          }
          rows={4}
          submitLabel={t(tool.editId ? 'drawing.latex.update' : 'drawing.latex.insert')}
          onClose={() => setTool(null)}
          onSubmit={async (text) => {
            const c = getSceneController(path);
            if (!c) return;
            const existing = tool.editId
              ? c.context().elements.find((e) => e.id === tool.editId)
              : undefined;
            const patch = await latexPatch(text, {
              center: c.viewportCenter(),
              ...(existing ? {} : { color: c.defaultColor() }),
              existing,
            });
            c.apply(patch);
            setTool(null);
          }}
        />
      )}
      {tool?.kind === 'mermaid' && (
        <TextToolDialog
          title={t('drawing.mermaid.title')}
          hint={t('drawing.mermaid.hint')}
          initial={'flowchart TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Done]\n  B -->|no| A'}
          rows={10}
          submitLabel={t('drawing.mermaid.insert')}
          onClose={() => setTool(null)}
          onSubmit={async (text) => {
            const c = getSceneController(path);
            if (!c) return;
            const patch = await mermaidPatch(text, c.viewportCenter(), {
              parse: parseMermaid,
              convert: (skeletons) =>
                ExcalidrawLib.convertToExcalidrawElements(skeletons as never, {
                  regenerateIds: true,
                }),
            });
            c.apply(patch);
            setTool(null);
          }}
        />
      )}
      {exporting && (
        <ExportDialog
          initial={{
            ...defaultExportOptions(useDrawingSettings.getState().settings),
            ...(exportFormat ? { format: exportFormat } : {}),
          }}
          selectionCount={Object.keys(excalidraw?.getAppState().selectedElementIds ?? {}).length}
          frames={framesOf(excalidraw?.getSceneElements() ?? [])}
          onClose={closeExport}
          onExport={(o, action) => void doExport(o, action)}
        />
      )}
    </div>
  );
}
