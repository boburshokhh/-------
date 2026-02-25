/**
 * API клиент для общения с backend
 */
const API = {
    BASE: '/api',

    async upload(file, modelId = null) {
        const formData = new FormData();
        formData.append('file', file);
        if (modelId) formData.append('model', modelId);

        const response = await fetch(`${this.BASE}/upload`, {
            method: 'POST',
            body: formData
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.details || data.error || 'Ошибка загрузки');
        return data;
    },

    async getModels() {
        const response = await fetch(`${this.BASE}/models`);
        const data = await response.json();
        if (!response.ok) return { models: [], defaultModel: '' };
        return data;
    },

    async getTests() {
        const response = await fetch(`${this.BASE}/tests`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.details || data.error || 'Ошибка получения тестов');
        return data;
    },

    async getTest(id) {
        const response = await fetch(`${this.BASE}/tests/${id}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.details || data.error || 'Тест не найден');
        return data;
    },

    async deleteTest(id) {
        const response = await fetch(`${this.BASE}/tests/${id}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.details || data.error || 'Ошибка удаления');
        return data;
    },

    async submitResults(testId, userName, answers) {
        const response = await fetch(`${this.BASE}/results`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ testId, userName, answers })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.details || data.error || 'Ошибка сохранения');
        return data;
    },

    async getResults(testId) {
        const response = await fetch(`${this.BASE}/results/${testId}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.details || data.error || 'Ошибка получения результатов');
        return data;
    },

    async getResultDetail(id) {
        const response = await fetch(`${this.BASE}/results/detail/${id}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.details || data.error || 'Результат не найден');
        return data;
    },

    async healthCheck() {
        const response = await fetch(`${this.BASE}/health`);
        return response.json();
    }
};
