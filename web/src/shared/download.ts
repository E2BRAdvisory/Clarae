/** How long a download's object URL stays valid: browsers may read a large Blob well after the click. */
export const REVOKE_AFTER_MS = 60_000;

/**
 * Hands a Blob to the browser as a file download (a hidden anchor clicked once). The object URL is
 * revoked after REVOKE_AFTER_MS, not at once: some browsers start reading the Blob asynchronously, and a
 * URL revoked too early fails large downloads. Used by the console (exports, audit CSV) and by the
 * workbench page (files the core hands over).
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
}
