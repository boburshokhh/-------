module.exports = function errorHandler(err, req, res, next) {
    console.error(`[ERROR] ${new Date().toISOString()}:`, err.message);
    console.error(err.stack);

    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
            error: 'Файл слишком большой',
            details: 'Максимальный размер файла — 10 МБ'
        });
    }

    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({
            error: 'Неверное поле файла',
            details: 'Используйте поле "file" для загрузки'
        });
    }

    if (err.type === 'INVALID_FILE_TYPE') {
        return res.status(415).json({
            error: 'Неподдерживаемый формат файла',
            details: 'Поддерживаются только PDF и DOCX файлы'
        });
    }

    if (err.type === 'PARSE_ERROR') {
        return res.status(422).json({
            error: 'Ошибка обработки документа',
            details: err.message
        });
    }

    if (err.type === 'LLM_ERROR') {
        return res.status(502).json({
            error: 'Ошибка генерации теста',
            details: err.message
        });
    }

    res.status(err.status || 500).json({
        error: 'Внутренняя ошибка сервера',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
};
