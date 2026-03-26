/**
 * Запуск: node tests/extractionQuality.unit.js
 */
const assert = require('assert');
const { scoreExtraction } = require('../utils/extractionQuality');

const good = scoreExtraction({
    text: 'а'.repeat(2000),
    pageCount: 2,
    method: 'pdf-parse',
    warnings: [],
});
assert.ok(good.score > 0.5);
assert.strictEqual(good.lowQuality, false);

const bad = scoreExtraction({
    text: 'x'.repeat(40),
    pageCount: 5,
    method: 'pdf-parse',
    warnings: [],
});
assert.ok(bad.lowQuality === true);

const repl = scoreExtraction({
    text: '\uFFFD'.repeat(20) + 'word'.repeat(100),
    pageCount: 1,
    method: 'pdf-parse',
    warnings: [],
});
assert.ok(repl.score < good.score);

console.log('extractionQuality.unit.js: OK');
