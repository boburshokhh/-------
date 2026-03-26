/**
 * API клиент для общения с backend
 */
export const API = {
    BASE: '/api',

    async upload(
        file: File,
        opts?: { modelId?: string | null; jobId?: string | null },
    ) {
        const formData = new FormData();
        formData.append('file', file);
        const modelId = opts?.modelId;
        if (modelId) formData.append('model', modelId);

        const headers: Record<string, string> = {};
        if (opts?.jobId) headers['X-Job-Id'] = opts.jobId;

        const response = await fetch(`${this.BASE}/upload`, {
            method: 'POST',
            body: formData,
            headers,
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.details || data.error || 'Ошибка загрузки');
        return data;
    },

    async getJobProgress(jobId: string) {
        const response = await fetch(`${this.BASE}/jobs/${encodeURIComponent(jobId)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Прогресс недоступен');
        return data as {
            ok: boolean;
            jobId: string;
            phase: string;
            stage: string;
            percent: number;
            detail: string;
            updatedAt?: number;
        };
    },

    async getModels() {
        try {
            const response = await fetch(`${this.BASE}/models`);
            const data = await response.json();
            if (!response.ok) return { models: [], defaultModel: '' };
            return data;
        } catch (e) {
            return { models: [], defaultModel: '' };
        }
    },

    async getTests() {
        const response = await fetch(`${this.BASE}/tests`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.details || data.error || 'Ошибка получения тестов');
        return data;
    },

    async getTest(id: string | number) {
        const response = await fetch(`${this.BASE}/tests/${id}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.details || data.error || 'Тест не найден');
        return data;
    },

    async deleteTest(id: string | number) {
        const response = await fetch(`${this.BASE}/tests/${id}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.details || data.error || 'Ошибка удаления');
        return data;
    },

    async submitResults(testId: string | number, userName: string, answers: any) {
        const response = await fetch(`${this.BASE}/results`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ testId, userName, answers })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.details || data.error || 'Ошибка сохранения');
        return data;
    },

    async getResults(testId: string | number) {
        const response = await fetch(`${this.BASE}/results/${testId}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.details || data.error || 'Ошибка получения результатов');
        return data;
    },

    async getResultDetail(id: string | number) {
        const response = await fetch(`${this.BASE}/results/detail/${id}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.details || data.error || 'Результат не найден');
        return data;
    },

    async getLogs(limit: number = 200) {
        const response = await fetch(`${this.BASE}/logs?limit=${encodeURIComponent(limit)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.details || data.error || 'Ошибка получения логов');
        return data;
    }
};
