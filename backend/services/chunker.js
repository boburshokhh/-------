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

// ─── Section-aware helpers ─────────────────────────────────────────────────

/**
 * Определяет, является ли строка заголовком раздела/секции.
 * Учитывает нумерованные разделы, ключевые слова, известные имена секций
 * и строки в верхнем регистре (не более 6 слов).
 */
function isHeadingLine(line) {
    const t = line.trim();
    if (!t || t.length < 3 || t.length > 120) return false;
    // Строки с обычной знаковой пунктуацией в конце — не заголовок
    if (/[,;:]$/.test(t)) return false;

    // § 1, § 1.2
    if (/^§\s*\d+/.test(t)) return true;

    // "1.", "1.1 Название", "1.1.2 Название" — нумерованный раздел
    if (/^(\d+\.)+\s+\S{2,}/.test(t)) return true;

    // "Глава 1", "Раздел 2", "Chapter 3", "Section IV" и т.п.
    if (/^(Глава|Раздел|Тема|Chapter|Section|Part|Unit|Параграф|Appendix|Приложение)\s+[\dIVX]/i.test(t)) return true;

    // Известные самостоятельные названия разделов
    if (/^(Введение|Заключение|Выводы|Список\s+литературы|Содержание|Оглавление|Предисловие|Аннотация|Abstract|Introduction|Conclusion|References|Bibliography)\.?$/i.test(t)) return true;

    // Строка полностью в верхнем регистре: 1–6 слов, ≤60 символов, без точки/? в конце
    const words = t.split(/\s+/).filter(Boolean);
    if (
        words.length >= 1 &&
        words.length <= 6 &&
        t.length <= 60 &&
        t === t.toUpperCase() &&
        /[A-ZА-ЯЁ]/.test(t) &&
        !/[.!?]$/.test(t)
    ) return true;

    return false;
}

/**
 * Разбивает текст на логические секции по найденным заголовкам.
 * Возвращает массив {section, heading, text, startChar}.
 *
 * @param {string} text - Полный текст документа
 * @returns {Array<{section: string, heading: string|null, text: string, startChar: number}>}
 */
function splitIntoSections(text) {
    const lines = text.split('\n');
    const sections = [];

    let currentSection = 'Документ';
    let currentHeading = null;
    let sectionLines = [];
    let charPos = 0;
    let sectionStartChar = 0;

    for (const line of lines) {
        const lineLen = line.length + 1; // +1 для \n

        if (isHeadingLine(line)) {
            // Сбрасываем накопленное в секцию
            const accumulated = sectionLines.join('\n').trim();
            if (accumulated.length > 0) {
                sections.push({
                    section: currentSection,
                    heading: currentHeading,
                    text: accumulated,
                    startChar: sectionStartChar,
                });
            }
            // Начинаем новую секцию
            currentSection = line.trim();
            currentHeading = line.trim();
            sectionLines = [];
            sectionStartChar = charPos + lineLen;
        } else {
            sectionLines.push(line);
        }

        charPos += lineLen;
    }

    // Последняя секция
    const remaining = sectionLines.join('\n').trim();
    if (remaining.length > 0) {
        sections.push({
            section: currentSection,
            heading: currentHeading,
            text: remaining,
            startChar: sectionStartChar,
        });
    }

    // Нет заголовков — весь текст как одна секция
    if (sections.length === 0) {
        sections.push({
            section: 'Документ',
            heading: null,
            text: text.trim(),
            startChar: 0,
        });
    }

    return sections;
}

// ─── Основная функция чанкинга ─────────────────────────────────────────────

/**
 * Разбивает текст на чанки с учётом разделов документа.
 * Каждый чанк содержит метаданные: page, section, heading.
 *
 * Page вычисляется приблизительно по позиции символа (2500 символов ≈ 1 страница).
 *
 * @param {string} text - Полный текст документа
 * @returns {Array<{index, text, tokens, page, section, heading}>}
 */
function chunkText(text) {
    const maxTokens = config.CHUNK_TOKEN_LIMIT;
    const overlap  = config.CHUNK_OVERLAP_TOKENS;
    const CHARS_PER_PAGE = 2500; // приблизительно

    const sections  = splitIntoSections(text);
    const allChunks = [];

    for (const section of sections) {
        const paragraphs = section.text
            .split(/\n\n+/)
            .map(p => p.trim())
            .filter(p => p.length > 0);

        if (paragraphs.length === 0) continue;

        const approxPage = Math.max(1, Math.ceil((section.startChar + 1) / CHARS_PER_PAGE));

        let currentParagraphs = [];
        let currentTokens = 0;

        const flush = () => {
            if (currentParagraphs.length === 0) return;
            allChunks.push({
                index: allChunks.length,
                text:  currentParagraphs.join('\n\n'),
                tokens: currentTokens,
                page:   approxPage,
                section: section.section,
                heading: section.heading,
            });
            currentParagraphs = [];
            currentTokens = 0;
        };

        for (const paragraph of paragraphs) {
            const pTokens = countTokens(paragraph);

            // Абзац сам по себе длиннее лимита — делим по предложениям
            if (pTokens > maxTokens) {
                flush();
                const sentences = paragraph.split(/(?<=[.!?。])\s+/);
                let sentBuf = [];
                let sentTokens = 0;

                for (const sentence of sentences) {
                    const st = countTokens(sentence);
                    if (sentTokens + st > maxTokens && sentBuf.length > 0) {
                        allChunks.push({
                            index:   allChunks.length,
                            text:    sentBuf.join(' '),
                            tokens:  sentTokens,
                            page:    approxPage,
                            section: section.section,
                            heading: section.heading,
                        });
                        sentBuf    = [];
                        sentTokens = 0;
                    }
                    sentBuf.push(sentence);
                    sentTokens += st;
                }
                if (sentBuf.length > 0) {
                    allChunks.push({
                        index:   allChunks.length,
                        text:    sentBuf.join(' '),
                        tokens:  sentTokens,
                        page:    approxPage,
                        section: section.section,
                        heading: section.heading,
                    });
                }
                continue;
            }

            // Добавление абзаца выходит за лимит — сбрасываем с перекрытием
            if (currentTokens + pTokens > maxTokens && currentParagraphs.length > 0) {
                // Сохраняем текущий чанк
                allChunks.push({
                    index:   allChunks.length,
                    text:    currentParagraphs.join('\n\n'),
                    tokens:  currentTokens,
                    page:    approxPage,
                    section: section.section,
                    heading: section.heading,
                });

                // Перекрытие: берём последние абзацы, не превышая overlap
                const overlapParagraphs = [];
                let overlapTokens = 0;
                for (let i = currentParagraphs.length - 1; i >= 0; i--) {
                    const pt = countTokens(currentParagraphs[i]);
                    if (overlapTokens + pt > overlap) break;
                    overlapParagraphs.unshift(currentParagraphs[i]);
                    overlapTokens += pt;
                }

                currentParagraphs = overlapParagraphs;
                currentTokens     = overlapTokens;
            }

            currentParagraphs.push(paragraph);
            currentTokens += pTokens;
        }

        flush();
    }

    return allChunks;
}

module.exports = { chunkText, countTokens };
