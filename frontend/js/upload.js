/**
 * Логика страницы загрузки документов
 */
const Upload = {
    init() {
        const dropZone = document.getElementById('drop-zone');
        const fileInput = document.getElementById('file-input');

        // Click to upload
        dropZone.addEventListener('click', () => fileInput.click());

        // File selected
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.handleFile(e.target.files[0]);
            }
        });

        // Drag & Drop
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('drag-over');
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('drag-over');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');

            const file = e.dataTransfer.files[0];
            if (file) {
                this.handleFile(file);
            }
        });
    },

    async handleFile(file) {
        // Валидация на клиенте
        const allowedTypes = [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ];

        if (!allowedTypes.includes(file.type)) {
            App.toast('Неподдерживаемый формат. Используйте PDF или DOCX.', 'error');
            return;
        }

        if (file.size > 10 * 1024 * 1024) {
            App.toast('Файл слишком большой (максимум 10 МБ)', 'error');
            return;
        }

        // Показываем прогресс
        this.showProgress('Загрузка файла...', `${file.name} (${this.formatSize(file.size)})`);

        try {
            // Обновляем прогресс
            this.updateProgress('Обработка документа и генерация теста...', 'ИИ анализирует текст, это может занять 1–2 минуты', 30);

            const result = await API.upload(file);

            this.updateProgress('Тест готов!', `${result.totalQuestions} вопросов создано`, 100);

            setTimeout(() => {
                this.hideProgress();
                App.toast(`Тест создан: ${result.totalQuestions} вопросов`, 'success');
                // Переходим к тесту
                window.location.hash = `#/quiz/${result.testId}`;
            }, 1000);

        } catch (error) {
            this.hideProgress();
            App.toast(error.message || 'Ошибка при обработке файла', 'error');
        }

        // Сбрасываем input
        document.getElementById('file-input').value = '';
    },

    showProgress(title, detail) {
        const el = document.getElementById('generation-progress');
        el.style.display = 'block';
        document.getElementById('progress-title').textContent = title;
        document.getElementById('progress-detail').textContent = detail;
        document.getElementById('progress-bar').style.width = '10%';
    },

    updateProgress(title, detail, percent) {
        document.getElementById('progress-title').textContent = title;
        document.getElementById('progress-detail').textContent = detail;
        document.getElementById('progress-bar').style.width = percent + '%';
    },

    hideProgress() {
        document.getElementById('generation-progress').style.display = 'none';
        document.getElementById('progress-bar').style.width = '0%';
    },

    formatSize(bytes) {
        if (bytes < 1024) return bytes + ' Б';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
        return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
    }
};
