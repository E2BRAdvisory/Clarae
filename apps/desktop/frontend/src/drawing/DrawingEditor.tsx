// The Excalidraw editor tab (M3-WP1). Loaded lazily by DrawingView: it pulls in the whole
// Excalidraw bundle. The file is saved whole 2 s after the last real edit, with the hash of
// the last read as write precondition (same conflict handling as notes).
import '@excalidraw/excalidraw/index.css';
import {
  Excalidraw,
  exportToBlob,
  exportToClipboard,
  exportToSvg,
  restoreElements,
  serializeAsJSON,
} from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, LibraryItems } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { invalidateVault } from '../app/actions';
import { useNoteDocument } from '../editor/useNoteDocument';
import { effectiveTheme, type Theme } from '../app/theme';
import { infoOf, useSync } from '../state/sync';
import { dialog } from '../ui/dialogs';
import {
  exportFileName,
  folderOf,
  isOverLimit,
  parseScene,
  sceneSignature,
  type RawScene,
} from './scene';

const AUTOSAVE_MS = 2000;
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

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

type Format = 'png' | 'svg';

function ExportDialog({
  onClose,
  onExport,
}: {
  onClose: () => void;
  onExport: (o: { format: Format; scale: number; background: boolean; copy: boolean }) => void;
}) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<Format>('png');
  const [scale, setScale] = useState(2);
  const [background, setBackground] = useState(true);
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('drawing.export')}>
        <h2>{t('drawing.export')}</h2>
        <div className="row">
          <label>
            <input
              type="radio"
              name="fmt"
              checked={format === 'png'}
              onChange={() => setFormat('png')}
            />{' '}
            PNG
          </label>
          <label>
            <input
              type="radio"
              name="fmt"
              checked={format === 'svg'}
              onChange={() => setFormat('svg')}
            />{' '}
            SVG
          </label>
        </div>
        {format === 'png' && (
          <div className="row">
            <label htmlFor="export-scale">{t('drawing.scale')}</label>
            <select
              id="export-scale"
              value={scale}
              onChange={(e) => setScale(Number(e.target.value))}
            >
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}x
                </option>
              ))}
            </select>
          </div>
        )}
        <label>
          <input
            type="checkbox"
            checked={background}
            onChange={(e) => setBackground(e.target.checked)}
          />{' '}
          {t('drawing.background')}
        </label>
        <div className="actions">
          <button onClick={onClose}>{t('dialog.cancel')}</button>
          <button onClick={() => onExport({ format, scale, background, copy: true })}>
            {t('drawing.copy')}
          </button>
          <button
            className="primary"
            onClick={() => onExport({ format, scale, background, copy: false })}
          >
            {t('drawing.saveToVault')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DrawingEditor({ vaultId, path }: Props) {
  const { t, i18n } = useTranslation();
  const doc = useNoteDocument(vaultId, path, AUTOSAVE_MS);
  const locked = useSync((s) => infoOf(s, vaultId).locked);
  const theme = useAppTheme();
  const [excalidraw, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [library, setLibrary] = useState<LibraryItems | null>(null);
  const [zen, setZen] = useState(false);
  const [present, setPresent] = useState(false);
  const [exporting, setExporting] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const signature = useRef('');
  const shownVersion = useRef(0);
  const libraryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The library lives in the vault (.nodus/excalidraw-library.json) and syncs with it.
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
    if (doc.status !== 'ready') return { scene: { elements: [], appState: {}, files: {} } };
    try {
      return { scene: parseScene(doc.content) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.status]);

  // A newer version of the file (sync or an external edit): show it in the open editor.
  useEffect(() => {
    if (!excalidraw || doc.status !== 'ready' || doc.version === shownVersion.current) return;
    shownVersion.current = doc.version;
    if (doc.version <= 1) return;
    try {
      const scene = parseScene(doc.content);
      signature.current = sceneSignature(scene.elements, Object.keys(scene.files).length);
      excalidraw.updateScene({
        elements: restoreElements(scene.elements as never, null),
      });
      const files = Object.values(scene.files);
      if (files.length > 0) excalidraw.addFiles(files as never);
    } catch {
      /* an invalid file on disk is reported by the banner below on next load */
    }
  }, [excalidraw, doc.status, doc.version, doc.content]);

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
      if (first) return; // the initial render of the loaded file
      doc.edit(serializeAsJSON(elements as never, appState, files, 'local'));
    },
    [doc],
  );

  const onLibraryChange = useCallback(
    (items: LibraryItems) => {
      clearTimeout(libraryTimer.current);
      libraryTimer.current = setTimeout(() => {
        const body = JSON.stringify({ type: 'excalidrawlib', version: 2, libraryItems: items });
        void api.vault.writeConfig(vaultId, LIBRARY_FILE, body).catch(() => undefined);
      }, 800);
    },
    [vaultId],
  );

  // Presentation mode: read-only, zen and full screen.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    if (present && !document.fullscreenElement)
      void el.requestFullscreen?.().catch(() => undefined);
    if (!present && document.fullscreenElement === el) void document.exitFullscreen?.();
  }, [present]);
  useEffect(() => {
    const off = () => {
      if (!document.fullscreenElement) setPresent(false);
    };
    document.addEventListener('fullscreenchange', off);
    return () => document.removeEventListener('fullscreenchange', off);
  }, []);

  const doExport = async (o: {
    format: Format;
    scale: number;
    background: boolean;
    copy: boolean;
  }) => {
    if (!excalidraw) return;
    setExporting(false);
    try {
      const elements = excalidraw.getSceneElements();
      const appState = {
        ...excalidraw.getAppState(),
        exportBackground: o.background,
        exportScale: o.scale,
      };
      const files = excalidraw.getFiles();
      if (o.copy) {
        await exportToClipboard({
          elements,
          appState,
          files,
          type: o.format === 'png' ? 'png' : 'svg',
        });
        return;
      }
      const name = exportFileName(path, o.format, o.scale);
      const data =
        o.format === 'png'
          ? await blobToBase64(
              await exportToBlob({ elements, appState, files, mimeType: 'image/png' }),
            )
          : btoa(
              unescape(
                encodeURIComponent(
                  new XMLSerializer().serializeToString(
                    await exportToSvg({ elements, appState, files }),
                  ),
                ),
              ),
            );
      const saved = await api.vault.saveAttachment(vaultId, folderOf(path), name, data);
      invalidateVault(vaultId);
      await dialog.alert(t('drawing.export'), t('drawing.exported', { path: saved }));
    } catch (e) {
      await dialog.error(e);
    }
  };

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
  const readOnly = locked || present;

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
          <button onClick={() => setExporting(true)} disabled={locked}>
            {t('drawing.export')}
          </button>
          <button className={zen ? 'active' : ''} aria-pressed={zen} onClick={() => setZen(!zen)}>
            {t('drawing.zen')}
          </button>
          <button onClick={() => setPresent(true)}>{t('drawing.present')}</button>
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
      <div className="drawing-canvas">
        <Excalidraw
          key={path}
          excalidrawAPI={setApi}
          initialData={{
            elements: restoreElements(scene.elements as never, null),
            appState: { ...scene.appState, collaborators: new Map() },
            files: scene.files as never,
            libraryItems: library,
            scrollToContent: true,
          }}
          theme={theme}
          langCode={i18n.language.startsWith('it') ? 'it-IT' : 'en'}
          viewModeEnabled={readOnly}
          zenModeEnabled={zen || present}
          onChange={onChange}
          onLibraryChange={onLibraryChange}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              export: false,
              saveAsImage: false,
              saveToActiveFile: false,
              toggleTheme: false,
            },
          }}
        />
      </div>
      {exporting && (
        <ExportDialog onClose={() => setExporting(false)} onExport={(o) => void doExport(o)} />
      )}
    </div>
  );
}
