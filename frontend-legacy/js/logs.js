/**
 * UI для просмотра логов, которые печатает backend.
 */
const Logs = {
    started: false,
    timer: null,
    limit: 200,

    init() {
        if (this.started) return;
        this.started = true;

        this.container = document.getElementById('logs-container');
        this.autoCheckbox = document.getElementById('logs-auto');
        this.refreshBtn = document.getElementById('logs-refresh');

        if (!this.container) return;

        if (this.autoCheckbox) {
            this.autoCheckbox.checked = true;
            this.autoCheckbox.addEventListener('change', () => {
                this.setAuto(this.autoCheckbox.checked);
            });
        }

        if (this.refreshBtn) {
            this.refreshBtn.addEventListener('click', () => this.loadOnce());
        }

        // Сразу грузим и дальше автообновляем.
        this.loadOnce();
        this.setAuto(this.autoCheckbox ? this.autoCheckbox.checked : true);
    },

    setAuto(on) {
        if (on) {
            if (this.timer) return;
            this.timer = setInterval(() => this.loadOnce(), 2000);
            return;
        }
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    },

    async loadOnce() {
        try {
            const { logs } = await API.getLogs(this.limit);
            this.render(logs || []);
        } catch (e) {
            App.toast(e.message || 'Ошибка загрузки логов', 'error');
        }
    },

    render(logs) {
        if (!this.container) return;

        if (!logs.length) {
            this.container.innerHTML = '<div style="opacity:0.7">Логов пока нет</div>';
            return;
        }

        const html = logs.map((l) => {
            const ts = l.ts ? `[${l.ts}]` : '';
            const level = l.level || 'INFO';
            const klass = level === 'ERROR' ? 'log-error' : (level === 'WARN' ? 'log-warn' : 'log-info');
            return `
                <div class="log-line ${klass}">
                    <span class="log-ts">${this.escapeHtml(ts)}</span>
                    <span class="log-level">${this.escapeHtml(level)}</span>
                    <span class="log-msg">${this.escapeHtml(l.message || '')}</span>
                </div>
            `;
        }).join('');

        this.container.innerHTML = html;
        // Листаем вниз к последним событиям.
        this.container.scrollTop = this.container.scrollHeight;
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },
};

