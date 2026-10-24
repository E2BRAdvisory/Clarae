/** Hands a Blob to the browser as a file download (anchor click), then releases the object URL. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Some browsers start the download asynchronously: revoke on the next turn.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
