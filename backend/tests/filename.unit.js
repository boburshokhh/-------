/**
 * Запуск: node tests/filename.unit.js
 */
const assert = require('assert');
const {
    stripDangerousPath,
    normalizeDisplayFilename,
    resolveStorageExtension,
} = require('../utils/filename');

assert.strictEqual(stripDangerousPath('../../../etc/passwd'), 'passwd');
assert.strictEqual(stripDangerousPath('folder\\..\\x.pdf'), 'x.pdf');

const cyrUtf8 = 'Отчёт_№1.pdf';
assert.strictEqual(normalizeDisplayFilename(cyrUtf8), cyrUtf8);

// Типичный mojibake UTF-8 как Latin-1 (первые байты «Отчёт» → кракозябры)
const mojibake = Buffer.from('Отчёт.pdf', 'utf8').toString('latin1');
const fixed = normalizeDisplayFilename(mojibake);
assert.ok(fixed.includes('Отч') || fixed.includes('ёт'), `expected cyrillic fix, got ${fixed}`);

assert.strictEqual(resolveStorageExtension('a.PDF', 'application/pdf'), '.pdf');
assert.strictEqual(
    resolveStorageExtension('x', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    '.docx',
);
assert.strictEqual(resolveStorageExtension('evil.exe', 'application/pdf'), null);

console.log('filename.unit.js: OK');
