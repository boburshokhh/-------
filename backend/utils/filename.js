const path = require('path');

const ALLOWED_EXT = new Set(['.pdf', '.docx']);

/**
 * Убирает path traversal и управляющие символы; оставляет только basename.
 * @param {string} name
 * @returns {string}
 */
function stripDangerousPath(name) {
    if (typeof name !== 'string' || name.length === 0) return '';
    let base = path.basename(String(name).replace(/\\/g, '/'));
    base = base.replace(/\0/g, '');
    return base.trim();
}

/**
 * Пытается декодировать percent-encoding в имени (часть клиентов шлёт так).
 * @param {string} name
 * @returns {string}
 */
function tryDecodePercentEncoding(name) {
    if (!name || !/%[0-9A-Fa-f]{2}/.test(name)) return name;
    try {
        return decodeURIComponent(name);
    } catch {
        return name;
    }
}

/**
 * Типичный mojibake: UTF-8 байты прочитаны как Latin-1.
 * @param {string} name
 * @returns {string}
 */
function fixMojibakeLatin1Utf8(name) {
    if (!name) return name;
    let latin1Decoded;
    try {
        latin1Decoded = Buffer.from(name, 'latin1').toString('utf8');
    } catch {
        return name;
    }

    const score = (s) => {
        if (typeof s !== 'string' || s.length === 0) return -Infinity;
        const repl = (s.match(/\uFFFD/g) || []).length;
        const cyr = (s.match(/[А-Яа-яЁё]/g) || []).length;
        const moj = (s.match(/[ÃÐÑâ€]/g) || []).length;
        return cyr * 10 - repl * 25 - moj * 3;
    };

    return score(latin1Decoded) > score(name) ? latin1Decoded : name;
}

/**
 * Нормализованное имя для отображения и БД (UTF-8, без путей).
 * @param {string} originalname - как пришло от multer
 * @returns {string}
 */
function normalizeDisplayFilename(originalname) {
    let s = stripDangerousPath(originalname);
    s = tryDecodePercentEncoding(s);
    s = fixMojibakeLatin1Utf8(s);
    if (s.length > 240) {
        const ext = path.extname(s);
        const base = path.basename(s, ext).slice(0, 200);
        s = base + ext;
    }
    return s || 'document';
}

/**
 * Разрешённое расширение только из белого списка (защита от .exe и т.п.).
 * @param {string} originalname
 * @param {string} [mimetype]
 * @returns {'.pdf'|'.docx'|null}
 */
function resolveStorageExtension(originalname, mimetype) {
    const ext = path.extname(originalname).toLowerCase();
    if (ALLOWED_EXT.has(ext)) return ext;
    // Расширение есть, но не .pdf/.docx — не подставляем MIME (защита от evil.exe + application/pdf)
    if (ext && ext.length > 0) return null;
    if (mimetype === 'application/pdf') return '.pdf';
    if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return '.docx';
    return null;
}

module.exports = {
    stripDangerousPath,
    normalizeDisplayFilename,
    resolveStorageExtension,
    ALLOWED_EXT,
};
