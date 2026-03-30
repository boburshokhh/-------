const config = require('../../config');

const PROCEDURAL_MARKERS = [
    /(?:^|\n)\s*(?:шаг|этап)\s*\d+/im,
    /(?:^|\n)\s*step\s*\d+/im,
    /(?:^|\n)\s*\d+[\.\)]\s+[А-ЯA-Z]/m,
    /(?:^|\n)\s*[-•►▸]\s+\S/m,
    /процедура|procedure|инструкция|instruction/i,
    /порядок\s+(?:действий|выполнения|работ)/i,
    /последовательность\s+(?:действий|операций)/i,
];

const WARNING_MARKERS = [
    /(?:ВНИМАНИЕ|ОСТОРОЖНО|ПРЕДУПРЕЖДЕНИЕ|ЗАПРЕЩАЕТСЯ|ОПАСНО)/,
    /(?:WARNING|CAUTION|DANGER|NOTICE|NOTE:)/i,
    /(?:не\s+допускается|строго\s+запрещ)/i,
    /(?:категорически|обязательно)\s/i,
];

const TROUBLESHOOTING_MARKERS = [
    /(?:неисправност|диагностик|устранени|поиск\s+(?:и\s+)?устранени)/i,
    /(?:troubleshoot|diagnos|fault|malfunction)/i,
    /(?:если\s+.*(?:не\s+работает|ошибка|сбой|отказ))/i,
    /(?:причина|symptom|solution|решение)\s*[:—–-]/i,
    /(?:при\s+.*(?:обнаружен|выявлен|возникн))/i,
];

const PARAMETER_MARKERS = [
    /\b\d+[\.,]\d*\s*(?:мм|см|м|кг|г|°[CС]|[кmМ][Вв]т|[AА]|[Вv]|бар|атм|МПа|PSI|RPM|rpm)\b/,
    /(?:not?\s+(?:less|more)\s+than|не\s+(?:менее|более))\s+\d+/i,
    /(?:диапазон|range|допуск|tolerance)\s*[:—–-]/i,
    /(?:номинал|nominal|макс|max|мин|min)\s*[:—–.]/i,
    /\b(?:ТУ|ГОСТ|ISO|DIN|ASTM|IEC)\s*\d+/,
];

/**
 * @param {string} text
 * @returns {{ profile: 'declarative'|'technical_procedural'|'mixed', signals: string[] }}
 */
function detectFactProfile(text) {
    if (!text || typeof text !== 'string') {
        return { profile: 'declarative', signals: [] };
    }
    const sample = text.slice(0, 2000);
    const signals = [];

    let proceduralScore = 0;
    let technicalScore = 0;

    if (PROCEDURAL_MARKERS.some(re => re.test(sample))) {
        proceduralScore += 2;
        signals.push('procedural_structure');
    }

    if (WARNING_MARKERS.some(re => re.test(sample))) {
        technicalScore += 1;
        signals.push('warning_content');
    }

    if (TROUBLESHOOTING_MARKERS.some(re => re.test(sample))) {
        technicalScore += 2;
        signals.push('troubleshooting_content');
    }

    if (PARAMETER_MARKERS.some(re => re.test(sample))) {
        technicalScore += 1;
        signals.push('parameter_content');
    }

    const conditionAction = (sample.match(/(?:если\s|при\s|в случае\s|when\s|if\s)/gi) || []).length;
    if (conditionAction >= 2) {
        proceduralScore += 1;
        signals.push(`condition_action(${conditionAction})`);
    }

    const imperatives = (sample.match(/(?:(?:^|\.\s+)(?:установите|проверьте|подключите|отключите|откройте|закройте|замените|снимите|нажмите|убедитесь|выполните|перезапустите|очистите|промойте|затяните|ослабьте))/gim) || []).length;
    if (imperatives >= 2) {
        proceduralScore += 2;
        signals.push(`imperatives(${imperatives})`);
    }

    const totalScore = proceduralScore + technicalScore;

    if (totalScore >= 3) {
        return { profile: 'technical_procedural', signals };
    }
    if (totalScore >= 1) {
        return { profile: 'mixed', signals };
    }
    return { profile: 'declarative', signals };
}

function isTechnicallyMeaningful(line) {
    const t = line.trim();
    if (t.length < 8) return false;

    if (/^\s*(?:\d+[.\)]\s|[-•►▸]\s)/.test(t)) return true;

    if (/^(?:ВНИМАНИЕ|ОСТОРОЖНО|ПРЕДУПРЕЖДЕНИЕ|ЗАПРЕЩАЕТСЯ|ОПАСНО|WARNING|CAUTION|DANGER|NOTE|NOTICE)\s*[:!]/i.test(t)) return true;

    if (/^(?:если|при |в случае|when |if )/i.test(t)) return true;

    if (/\b\d+[\.,]?\d*\s*(?:мм|см|м|кг|°[CС]|бар|[Вv]|[AА]|МПа|PSI)\b/.test(t)) return true;

    if (/^(?:установите|проверьте|подключите|отключите|откройте|закройте|замените|снимите|нажмите|убедитесь|выполните|перезапустите|очистите|промойте|затяните|ослабьте)/i.test(t)) return true;

    return false;
}

/**
 * @param {string} chunkTextStr
 * @param {string} [factProfile]
 * @returns {string[]}
 */
function extractiveSummary(chunkTextStr, factProfile) {
    const maxSentences = config.SUMMARY_EXTRACTIVE_SENTENCES || 5;
    const profile = factProfile || 'declarative';

    const raw = chunkTextStr
        .replace(/\r\n/g, '\n')
        .split(/(?<=[.!?…])[\s\n]+|\n{2,}/)
        .map(s => s.trim())
        .filter(s => s.length > 10);

    if (profile === 'declarative') {
        const meaningful = raw.filter(s => s.length >= 40);
        const pool = meaningful.length >= 2 ? meaningful : raw.filter(s => s.length > 20);
        return pool.slice(0, maxSentences);
    }

    const lineBasedSplits = chunkTextStr
        .split(/\n/)
        .map(s => s.trim())
        .filter(s => s.length >= 10);

    const allCandidates = new Map();
    for (const s of [...raw, ...lineBasedSplits]) {
        const key = s.slice(0, 80).toLowerCase();
        if (!allCandidates.has(key)) allCandidates.set(key, s);
    }
    const candidates = [...allCandidates.values()];

    const scored = candidates.map(s => {
        let score = 0;
        const technical = isTechnicallyMeaningful(s);
        if (technical) score += 10;

        if (s.length >= 60) score += 3;
        else if (s.length >= 40) score += 2;
        else if (s.length >= 20) score += 1;

        if (/\d/.test(s)) score += 1;

        if (WARNING_MARKERS.some(re => re.test(s))) score += 5;

        if (/(?:если|при |в случае|when |if )/i.test(s)) score += 3;

        return { text: s, score, technical };
    });

    scored.sort((a, b) => b.score - a.score);

    const technicalOnes = scored.filter(s => s.technical);
    const remaining = scored.filter(s => !s.technical);

    const result = [];
    for (const item of technicalOnes) {
        if (result.length >= maxSentences * 2) break;
        result.push(item.text);
    }
    for (const item of remaining) {
        if (result.length >= maxSentences * 2) break;
        if (item.score >= 1) result.push(item.text);
    }

    return result.slice(0, Math.min(maxSentences * 2, 12));
}

/**
 * Stored extractive facts from DB, or compute from chunk text if missing (legacy rows).
 * @param {unknown} stored
 * @param {string} text
 * @returns {string[]}
 */
function coerceExtractiveFacts(stored, text) {
    if (Array.isArray(stored) && stored.length > 0) {
        return stored.map(s => String(s)).filter(Boolean);
    }
    if (typeof text !== 'string' || !text.trim()) return [];
    const { profile } = detectFactProfile(text);
    return extractiveSummary(text, profile);
}

module.exports = {
    detectFactProfile,
    extractiveSummary,
    coerceExtractiveFacts,
    WARNING_MARKERS,
};
