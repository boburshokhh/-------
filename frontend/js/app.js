/**
 * SPA маршрутизатор и основное приложение
 */
const App = {
    init() {
        Upload.init();
        this.router();
        window.addEventListener('hashchange', () => this.router());
    },

    router() {
        const hash = window.location.hash || '#/';
        const parts = hash.replace('#/', '').split('/');
        const page = parts[0] || '';
        const param = parts[1] || null;

        // Скрываем все страницы
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

        // Обновляем nav
        document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));

        switch (page) {
            case '':
            case 'upload':
                this.showPage('page-upload', 'upload');
                break;

            case 'tests':
                this.showPage('page-tests', 'tests');
                Results.loadTestsList();
                break;

            case 'quiz':
                if (param) {
                    this.showPage('page-quiz', 'tests');
                    Quiz.load(parseInt(param));
                } else {
                    window.location.hash = '#/tests';
                }
                break;

            case 'results':
                this.showPage('page-results', 'results');
                Results.loadResults();
                break;

            case 'result':
                if (param) {
                    this.showPage('page-result-detail', 'results');
                    Results.loadResultDetail(parseInt(param));
                } else {
                    window.location.hash = '#/results';
                }
                break;

            default:
                this.showPage('page-upload', 'upload');
        }
    },

    showPage(pageId, navKey) {
        const page = document.getElementById(pageId);
        if (page) page.classList.add('active');

        const navLink = document.querySelector(`.nav-link[data-page="${navKey}"]`);
        if (navLink) navLink.classList.add('active');
    },

    toast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(100px)';
            toast.style.transition = '0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }
};

// Запуск приложения
document.addEventListener('DOMContentLoaded', () => App.init());
