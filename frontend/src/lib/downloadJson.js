function sanitizeFilePart(value, fallback = 'export') {
  const text = String(value || '').trim() || fallback;
  return text
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim() || fallback;
}

export function buildTestExportFilename(payload, fallbackId) {
  const id = payload?.test?.id ?? fallbackId ?? 'test';
  const title = sanitizeFilePart(payload?.test?.title, 'test');
  return `test-${id}-${title}.json`;
}

export function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = sanitizeFilePart(filename, 'export.json').endsWith('.json')
    ? sanitizeFilePart(filename, 'export.json')
    : `${sanitizeFilePart(filename, 'export')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
