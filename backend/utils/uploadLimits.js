'use strict';

/**
 * Единственные жёсткие лимиты загрузки документов для генерации тестов.
 * Фиксированы: 100 страниц и 100 МБ (не настраиваются ниже/выше через .env).
 */
const DOCUMENT_UPLOAD_MAX_PAGES = 100;
const DOCUMENT_UPLOAD_MAX_FILE_MB = 100;
const DOCUMENT_UPLOAD_MAX_FILE_BYTES = DOCUMENT_UPLOAD_MAX_FILE_MB * 1024 * 1024;

module.exports = {
    DOCUMENT_UPLOAD_MAX_PAGES,
    DOCUMENT_UPLOAD_MAX_FILE_MB,
    DOCUMENT_UPLOAD_MAX_FILE_BYTES,
};
