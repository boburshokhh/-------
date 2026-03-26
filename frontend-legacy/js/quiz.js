/**
 * Логика прохождения теста
 */
const Quiz = {
    testData: null,
    currentIndex: 0,
    answers: {},

    async load(testId) {
        try {
            this.testData = await API.getTest(testId);
            this.currentIndex = 0;
            this.answers = {};
            this.render();
        } catch (error) {
            App.toast(error.message, 'error');
            window.location.hash = '#/tests';
        }
    },

    render() {
        const container = document.getElementById('quiz-container');
        const q = this.testData.questions[this.currentIndex];
        const total = this.testData.questions.length;
        const progress = ((this.currentIndex + 1) / total) * 100;

        const typeLabels = {
            multiple_choice: 'Выбор ответа',
            true_false: 'Верно / Неверно',
            open_ended: 'Открытый вопрос'
        };

        let answerHTML = '';

        switch (q.type) {
            case 'multiple_choice':
                answerHTML = `
          <div class="options-list">
            ${q.options.map((opt, i) => `
              <button class="option-btn ${this.answers[q.id] === i ? 'selected' : ''}"
                      onclick="Quiz.selectOption(${q.id}, ${i})">
                <span class="option-marker">${String.fromCharCode(65 + i)}</span>
                <span>${this.escapeHtml(opt)}</span>
              </button>
            `).join('')}
          </div>
        `;
                break;

            case 'true_false':
                answerHTML = `
          <div class="tf-options">
            <button class="tf-btn ${this.answers[q.id] === true ? 'selected' : ''}"
                    onclick="Quiz.selectTF(${q.id}, true)">✅ Верно</button>
            <button class="tf-btn ${this.answers[q.id] === false ? 'selected' : ''}"
                    onclick="Quiz.selectTF(${q.id}, false)">❌ Неверно</button>
          </div>
        `;
                break;

            case 'open_ended':
                answerHTML = `
          <textarea class="open-answer" id="open-answer-${q.id}"
                    placeholder="Введите ваш ответ..."
                    oninput="Quiz.setOpenAnswer(${q.id})">${this.answers[q.id] || ''}</textarea>
        `;
                break;
        }

        container.innerHTML = `
      <div class="quiz-header">
        <h2>${this.escapeHtml(this.testData.title)}</h2>
        <div class="quiz-progress-info">
          <span>Вопрос ${this.currentIndex + 1} из ${total}</span>
          <span>${this.countAnswered()} из ${total} отвечено</span>
        </div>
        <div class="quiz-progress-bar">
          <div class="quiz-progress-bar-fill" style="width: ${progress}%"></div>
        </div>
      </div>

      <div class="question-card">
        <span class="question-type-badge ${q.type}">${typeLabels[q.type]}</span>
        <p class="question-text">${this.escapeHtml(q.question)}</p>
        ${answerHTML}
      </div>

      <div class="quiz-nav">
        <button class="btn btn-secondary" onclick="Quiz.prev()" ${this.currentIndex === 0 ? 'disabled' : ''}>
          ← Назад
        </button>
        ${this.currentIndex < total - 1 ? `
          <button class="btn btn-primary" onclick="Quiz.next()">
            Далее →
          </button>
        ` : `
          <button class="btn btn-primary btn-lg" onclick="Quiz.submit()" id="submit-btn">
            ✓ Завершить тест
          </button>
        `}
      </div>
    `;
    },

    selectOption(questionId, optionIndex) {
        this.answers[questionId] = optionIndex;
        this.render();
    },

    selectTF(questionId, value) {
        this.answers[questionId] = value;
        this.render();
    },

    setOpenAnswer(questionId) {
        const el = document.getElementById(`open-answer-${questionId}`);
        if (el) {
            this.answers[questionId] = el.value;
        }
    },

    next() {
        if (this.currentIndex < this.testData.questions.length - 1) {
            this.currentIndex++;
            this.render();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    },

    prev() {
        if (this.currentIndex > 0) {
            this.currentIndex--;
            this.render();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    },

    countAnswered() {
        return Object.keys(this.answers).filter(k => this.answers[k] !== null && this.answers[k] !== undefined && this.answers[k] !== '').length;
    },

    async submit() {
        const answered = this.countAnswered();
        const total = this.testData.questions.length;

        if (answered < total) {
            if (!confirm(`Вы ответили на ${answered} из ${total} вопросов. Завершить тест?`)) {
                return;
            }
        }

        const btn = document.getElementById('submit-btn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Отправка...';
        }

        try {
            // Формируем массив ответов
            const answersArray = this.testData.questions.map(q => ({
                questionId: q.id,
                answer: this.answers[q.id] !== undefined ? this.answers[q.id] : null
            }));

            const result = await API.submitResults(this.testData.id, null, answersArray);

            App.toast(`Тест завершён! Результат: ${result.percentage}%`, 'success');
            window.location.hash = `#/result/${result.resultId}`;

        } catch (error) {
            App.toast(error.message, 'error');
            if (btn) {
                btn.disabled = false;
                btn.textContent = '✓ Завершить тест';
            }
        }
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
};
