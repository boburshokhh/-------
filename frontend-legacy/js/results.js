/**
 * Логика страницы результатов
 */
const Results = {
    async loadTestsList() {
        try {
            const { tests } = await API.getTests();
            const listEl = document.getElementById('tests-list');
            const emptyEl = document.getElementById('tests-empty');

            if (tests.length === 0) {
                listEl.innerHTML = '';
                emptyEl.style.display = 'block';
                return;
            }

            emptyEl.style.display = 'none';
            listEl.innerHTML = tests.map(test => `
        <div class="test-card" onclick="window.location.hash='#/quiz/${test.id}'">
          <div class="test-card-header">
            <h3>${this.escapeHtml(test.title)}</h3>
            <span class="test-card-badge">${test.total_questions} вопр.</span>
          </div>
          <div class="test-card-meta">
            <span>📄 ${this.escapeHtml(test.document_name || 'Документ')}</span>
            ${test.page_count ? `<span>📃 ${test.page_count} стр.</span>` : ''}
            <span>🕐 ${this.formatDate(test.created_at)}</span>
          </div>
          <div class="test-card-actions">
            <button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); window.location.hash='#/quiz/${test.id}'">
              Пройти тест
            </button>
            <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); Results.viewTestResults(${test.id})">
              Результаты
            </button>
            <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); Results.deleteTest(${test.id})">
              Удалить
            </button>
          </div>
        </div>
      `).join('');

        } catch (error) {
            App.toast(error.message, 'error');
        }
    },

    async loadResults() {
        try {
            // Получаем все тесты, затем результаты для каждого
            const { tests } = await API.getTests();
            const resultsEl = document.getElementById('results-list');
            const emptyEl = document.getElementById('results-empty');

            const allResults = [];

            for (const test of tests) {
                try {
                    const { results } = await API.getResults(test.id);
                    results.forEach(r => {
                        r.test_title = test.title;
                        r.test_id = test.id;
                    });
                    allResults.push(...results);
                } catch (e) {
                    // Skip
                }
            }

            // Сортировка по дате
            allResults.sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));

            if (allResults.length === 0) {
                resultsEl.innerHTML = '';
                emptyEl.style.display = 'block';
                return;
            }

            emptyEl.style.display = 'none';
            resultsEl.innerHTML = allResults.map(r => `
        <div class="result-row" onclick="window.location.hash='#/result/${r.id}'">
          <div class="result-info">
            <h4>${this.escapeHtml(r.test_title || 'Тест')}</h4>
            <p>${r.user_name || 'Аноним'} • ${this.formatDate(r.completed_at)} • ${r.score}/${r.max_score}</p>
          </div>
          <div class="result-score">
            <div class="score-circle ${this.scoreClass(r.percentage)}">
              ${r.percentage}%
            </div>
          </div>
        </div>
      `).join('');

        } catch (error) {
            App.toast(error.message, 'error');
        }
    },

    async loadResultDetail(resultId) {
        try {
            const data = await API.getResultDetail(resultId);
            const container = document.getElementById('result-detail-container');

            const questionMap = {};
            data.questions.forEach(q => { questionMap[q.id] = q; });

            container.innerHTML = `
        <div class="result-summary">
          <a href="#/tests" class="btn btn-secondary btn-sm" style="margin-bottom:24px">← Назад к тестам</a>
          <h2>${this.escapeHtml(data.testTitle)}</h2>
          <p class="subtitle">${data.userName || 'Аноним'} • ${this.formatDate(data.completedAt)}</p>
          <div class="big-score">${data.percentage}%</div>
          <p class="score-label">${data.score} из ${data.maxScore} правильных ответов</p>
        </div>

        <div class="answer-review">
          ${data.answers.map((a, i) => {
                const q = questionMap[a.questionId] || {};
                return `
              <div class="answer-card ${a.isCorrect ? 'correct' : 'incorrect'}">
                <div class="question-label">Вопрос ${i + 1} • ${this.typeLabel(q.type)}</div>
                <p class="question-text">${this.escapeHtml(q.question || '')}</p>

                <div class="answer-row">
                  <span class="answer-label">Ваш ответ:</span>
                  <span class="${a.isCorrect ? 'answer-correct' : 'answer-wrong'}">
                    ${this.formatAnswer(a.userAnswer, q)}
                  </span>
                </div>

                ${!a.isCorrect ? `
                  <div class="answer-row">
                    <span class="answer-label">Правильный:</span>
                    <span class="answer-correct">${this.formatAnswer(a.correctAnswer, q)}</span>
                  </div>
                ` : ''}

                ${a.explanation ? `
                  <div class="explanation-box">💡 ${this.escapeHtml(a.explanation)}</div>
                ` : ''}
              </div>
            `;
            }).join('')}
        </div>
      `;

        } catch (error) {
            App.toast(error.message, 'error');
            window.location.hash = '#/results';
        }
    },

    async viewTestResults(testId) {
        try {
            const { results } = await API.getResults(testId);
            if (results.length === 0) {
                App.toast('Нет результатов для этого теста', 'info');
                return;
            }
            // Показываем последний результат
            window.location.hash = `#/result/${results[0].id}`;
        } catch (error) {
            App.toast(error.message, 'error');
        }
    },

    async deleteTest(testId) {
        if (!confirm('Удалить тест и все результаты?')) return;

        try {
            await API.deleteTest(testId);
            App.toast('Тест удалён', 'success');
            this.loadTestsList();
        } catch (error) {
            App.toast(error.message, 'error');
        }
    },

    formatAnswer(answer, question) {
        if (answer === null || answer === undefined) return '<em>Нет ответа</em>';

        if (question.type === 'multiple_choice' && typeof answer === 'number') {
            const letter = String.fromCharCode(65 + answer);
            const text = question.options ? question.options[answer] : '';
            return `${letter}) ${this.escapeHtml(text)}`;
        }

        if (question.type === 'true_false') {
            return answer ? '✅ Верно' : '❌ Неверно';
        }

        return this.escapeHtml(String(answer));
    },

    typeLabel(type) {
        const labels = {
            multiple_choice: 'Выбор ответа',
            true_false: 'Верно/Неверно',
            open_ended: 'Открытый вопрос'
        };
        return labels[type] || type;
    },

    scoreClass(percentage) {
        if (percentage >= 70) return 'score-high';
        if (percentage >= 40) return 'score-mid';
        return 'score-low';
    },

    formatDate(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        return d.toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
