/**
 * services/generator.js
 *
 * Тонкая обёртка — сохраняет прежний публичный API.
 * Вся логика пайплайна перенесена в:
 *   services/pipeline/testGeneratorFlow.js
 *
 * Экспортируемые имена (не менялись):
 *   generateTest        — основная функция генерации теста
 *   detectLanguage      — определение языка документа
 *   scoreEvidenceQuality — оценка качества доказательств
 *   BLOOM_LEVELS        — массив уровней Bloom's Taxonomy
 */

'use strict';

const { runTestGeneratorFlow }       = require('./pipeline/testGeneratorFlow');
const { detectLanguage }             = require('./nlp/languagePredictor');
const { scoreEvidenceQuality }       = require('./nlp/scoring');

const BLOOM_LEVELS = ['remember', 'understand', 'apply', 'analyze'];

/**
 * Генерирует тест по документу.
 *
 * @param {string}   fullText       — полный текст документа
 * @param {string}   docName        — имя файла (используется в заголовке теста)
 * @param {object[]} indexedChunks  — проиндексированные чанки (из indexer.js)
 * @param {function} onProgress     — колбэк прогресса
 * @param {object}   opts           — опции: model, traceId, documentId, sessionId, extractionQuality
 * @returns {Promise<{ title, questions, generationMetrics, runId }>}
 */
async function generateTest(fullText, docName, indexedChunks, onProgress, opts = {}) {
    return runTestGeneratorFlow(fullText, docName, indexedChunks, onProgress, opts);
}

module.exports = { generateTest, detectLanguage, scoreEvidenceQuality, BLOOM_LEVELS };
