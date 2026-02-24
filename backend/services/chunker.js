const { encodingForModel } = require('js-tiktoken');
const config = require('../config');

// Use cl100k_base encoding (compatible with GPT-4/5 family)
let encoder = null;

function getEncoder() {
    if (!encoder) {
        encoder = encodingForModel('gpt-4o');
    }
    return encoder;
}

/**
 * Подсчёт токенов в тексте.
 * @param {string} text
 * @returns {number}
 */
function countTokens(text) {
    return getEncoder().encode(text).length;
}

/**
 * Разбиение текста на чанки с учётом лимита токенов.
 * Делит по абзацам, затем объединяет абзацы в чанки до лимита.
 * Добавляет перекрытие между чанками.
 *
 * @param {string} text - Полный текст документа
 * @returns {Array<{index: number, text: string, tokens: number}>}
 */
function chunkText(text) {
    const maxTokens = config.CHUNK_TOKEN_LIMIT;
    const overlap = config.CHUNK_OVERLAP_TOKENS;

    // Шаг 1: Делим текст на абзацы
    const paragraphs = text
        .split(/\n\n+/)
        .map(p => p.trim())
        .filter(p => p.length > 0);

    if (paragraphs.length === 0) {
        return [];
    }

    const chunks = [];
    let currentParagraphs = [];
    let currentTokens = 0;

    for (const paragraph of paragraphs) {
        const paragraphTokens = countTokens(paragraph);

        // Если один абзац длиннее лимита — делим по предложениям
        if (paragraphTokens > maxTokens) {
            // Сначала сбрасываем текущий чанк
            if (currentParagraphs.length > 0) {
                chunks.push({
                    index: chunks.length,
                    text: currentParagraphs.join('\n\n'),
                    tokens: currentTokens
                });
                currentParagraphs = [];
                currentTokens = 0;
            }

            // Делим большой абзац по предложениям
            const sentences = paragraph.split(/(?<=[.!?。])\s+/);
            let sentBuf = [];
            let sentTokens = 0;

            for (const sentence of sentences) {
                const st = countTokens(sentence);
                if (sentTokens + st > maxTokens && sentBuf.length > 0) {
                    chunks.push({
                        index: chunks.length,
                        text: sentBuf.join(' '),
                        tokens: sentTokens
                    });
                    sentBuf = [];
                    sentTokens = 0;
                }
                sentBuf.push(sentence);
                sentTokens += st;
            }

            if (sentBuf.length > 0) {
                chunks.push({
                    index: chunks.length,
                    text: sentBuf.join(' '),
                    tokens: sentTokens
                });
            }

            continue;
        }

        // Если добавление абзаца выходит за лимит — сбрасываем чанк
        if (currentTokens + paragraphTokens > maxTokens && currentParagraphs.length > 0) {
            chunks.push({
                index: chunks.length,
                text: currentParagraphs.join('\n\n'),
                tokens: currentTokens
            });

            // Перекрытие: берём последние абзацы, но не более overlap токенов
            const overlapParagraphs = [];
            let overlapTokens = 0;
            for (let i = currentParagraphs.length - 1; i >= 0; i--) {
                const pt = countTokens(currentParagraphs[i]);
                if (overlapTokens + pt > overlap) break;
                overlapParagraphs.unshift(currentParagraphs[i]);
                overlapTokens += pt;
            }

            currentParagraphs = overlapParagraphs;
            currentTokens = overlapTokens;
        }

        currentParagraphs.push(paragraph);
        currentTokens += paragraphTokens;
    }

    // Последний чанк
    if (currentParagraphs.length > 0) {
        chunks.push({
            index: chunks.length,
            text: currentParagraphs.join('\n\n'),
            tokens: currentTokens
        });
    }

    return chunks;
}

module.exports = { chunkText, countTokens };
