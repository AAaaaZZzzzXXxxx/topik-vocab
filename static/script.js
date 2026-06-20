// ═══════════════════════════════════════════════════════════════
// TOPIK 韩语背单词 v5.0 — 纯静态版 (GitHub Pages)
// localStorage 持久化 · SM-2 算法 · Chart.js · TTS · 手势球
// ═══════════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);

// ─── Global State ─────────────────────────────────────────────
let currentWord = null, isFlipped = false, isAnimating = false;
let currentMode = 'normal', currentTab = 'review';
let cardShownAt = 0;
let appSettings = {};
let chartInstances = {};
let todayStatsCache = {};

// ─── localStorage Keys ────────────────────────────────────────
const LS = {
    progress: 'topik_progress',
    dailyStats: 'topik_daily_stats',
    checkins: 'topik_checkins',
    settings: 'topik_settings',
    mnemonics: 'topik_mnemonics',
};

function lsGet(key) {
    try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (e) { return {}; }
}
function lsSet(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
}

// ─── Today ────────────────────────────────────────────────────
function todayISO() { return new Date().toISOString().slice(0, 10); }

// ─── SM-2 Algorithm (ported from srs.py) ──────────────────────
function calcSRS(level, easeFactor, intervalDays, result) {
    const qMap = { 0: 0, 1: 3, 2: 5 };
    const q = qMap[result];
    let newLevel, newInterval, newEF;

    if (q < 2) {
        newLevel = 0;
        newInterval = 0;
        newEF = Math.max(1.3, easeFactor - 0.2);
    } else {
        if (level === 0) { newLevel = 1; newInterval = 1; }
        else if (level === 1) { newLevel = 2; newInterval = 1; }
        else { newLevel = level + 1; newInterval = Math.max(1, Math.round(intervalDays * easeFactor)); }
        const efDelta = q >= 4 ? 0.1 : -0.15;
        newEF = Math.max(1.3, easeFactor + efDelta);
    }

    const next = new Date();
    next.setDate(next.getDate() + newInterval);
    return { level: newLevel, easeFactor: newEF, intervalDays: newInterval, nextReview: next.toISOString().slice(0, 10) };
}

// ─── Progress Helpers ─────────────────────────────────────────
function getProgress(wordId) {
    const all = lsGet(LS.progress);
    return all[wordId] || { level: 0, easeFactor: 2.5, intervalDays: 0, nextReview: todayISO(), totalReviews: 0, totalCorrect: 0, lastResult: 0, lastReviewed: null, lastForgotDate: null, streakCorrect: 0 };
}

function setProgress(wordId, p) {
    const all = lsGet(LS.progress);
    all[wordId] = p;
    lsSet(LS.progress, all);
}

function updateDailyStats(result, isNewWordGraduated) {
    const all = lsGet(LS.dailyStats);
    const today = todayISO();
    let s = all[today] || { newWords: 0, reviewedWords: 0, knownCount: 0, fuzzyCount: 0, forgotCount: 0 };
    s.reviewedWords = (s.reviewedWords || 0) + 1;
    if (result === 2) s.knownCount = (s.knownCount || 0) + 1;
    if (result === 1) s.fuzzyCount = (s.fuzzyCount || 0) + 1;
    if (result === 0) s.forgotCount = (s.forgotCount || 0) + 1;
    if (isNewWordGraduated) s.newWords = (s.newWords || 0) + 1;
    all[today] = s;
    lsSet(LS.dailyStats, all);
}

// ─── Due Words Query ──────────────────────────────────────────
function getDueWords(limit = 30) {
    const today = todayISO();
    const settings = getSettings();
    const dailyGoal = parseInt(settings.daily_goal) || 50;
    const selectedUnits = getSelectedUnitSet();
    const includeLoanwords = settings.include_loanwords !== '0';

    // Today's review count
    const dailyStats = lsGet(LS.dailyStats);
    const todayStats = dailyStats[today] || {};
    const todayReviewed = todayStats.reviewedWords || 0;

    // Score each word
    const candidates = [];
    for (const w of TOPIK_WORDS) {
        if (!includeLoanwords && w.is_loanword) continue;
        if (selectedUnits.size > 0 && selectedUnits.size < 40 && !selectedUnits.has(w.unit)) continue;

        const p = getProgress(w.id);

        if (currentMode === 'mistakes') {
            if (p.lastReviewed === today && p.lastResult !== undefined && p.lastResult < 2) {
                candidates.push({ ...w, progress: p, priority: p.lastResult });
            }
            continue;
        }

        // Review words (overdue)
        if (p.level > 0 && p.nextReview <= today) {
            candidates.push({ ...w, progress: p, priority: 0 });
        }
        // New words
        else if (p.level === 0 && p.nextReview <= today && p.lastReviewed !== today) {
            candidates.push({ ...w, progress: p, priority: 1 });
        }
    }

    // Sort: reviews first, then new words
    candidates.sort((a, b) => a.priority - b.priority);

    // Apply daily goal in normal mode
    if (currentMode === 'normal' && dailyGoal > 0) {
        const result = [];
        let reviewSlots = dailyGoal - todayReviewed;
        for (const c of candidates) {
            if (result.length >= limit) break;
            if (c.priority === 0) {
                // Reviews bypass the daily goal (must review overdue words)
                result.push(c);
            } else if (reviewSlots > 0) {
                result.push(c);
                reviewSlots--;
            }
        }
        return result;
    }

    return candidates.slice(0, limit);
}

function getSelectedUnitSet() {
    const sel = (getSettings().selected_units || '*').trim();
    if (sel === '*' || !sel) {
        return new Set(TOPIK_WORDS.map(w => w.unit));
    }
    return new Set(sel.split(',').map(s => s.trim()));
}

function getTodayMistakeCount() {
    const today = todayISO();
    const progress = lsGet(LS.progress);
    let count = 0;
    for (const [id, p] of Object.entries(progress)) {
        if (p.lastReviewed === today && p.lastResult !== undefined && p.lastResult < 2) count++;
    }
    return count;
}

// ─── Stats ────────────────────────────────────────────────────
function getOverallStats() {
    let totalCorrect = 0, totalReviews = 0, learned = 0, mastered = 0;
    const progress = lsGet(LS.progress);
    for (const p of Object.values(progress)) {
        totalReviews += (p.totalReviews || 0);
        totalCorrect += (p.totalCorrect || 0);
        if (p.level > 0) learned++;
        if (p.level >= 5) mastered++;
    }
    const total = TOPIK_WORDS.length;
    return {
        total_words: total, learned_words: learned, mastered_words: mastered,
        unlearned_words: total - learned, total_reviews: totalReviews,
        total_correct: totalCorrect,
        accuracy: totalReviews > 0 ? Math.round(totalCorrect / totalReviews * 100 * 10) / 10 : 0,
    };
}

function getTodayStats() {
    const today = todayISO();
    const dailyStats = lsGet(LS.dailyStats);
    return dailyStats[today] || { date: today, newWords: 0, reviewedWords: 0, knownCount: 0, fuzzyCount: 0, forgotCount: 0 };
}

function getStreak() {
    const checkins = lsGet(LS.checkins);
    const dates = Object.keys(checkins).sort().reverse();
    if (dates.length === 0) return 0;
    let streak = 0;
    const today = new Date();
    let check = new Date(today);
    for (const d of dates) {
        const cd = new Date(d);
        if (cd.toISOString().slice(0, 10) === check.toISOString().slice(0, 10)) {
            streak++;
            check.setDate(check.getDate() - 1);
        } else if (cd.toISOString().slice(0, 10) === new Date(check.getTime() - 86400000).toISOString().slice(0, 10)) {
            streak++;
            check = cd;
        } else {
            break;
        }
    }
    return streak;
}

// ─── Chart Data ───────────────────────────────────────────────
function getForgettingCurveData() {
    // Simplified: use SM-2 theoretical curve + actual review history
    const history = [];
    const progress = lsGet(LS.progress);
    for (const p of Object.values(progress)) {
        if (p.intervalDays > 0 && p.lastResult !== undefined) {
            history.push({ interval: p.intervalDays, correct: p.lastResult === 2 });
        }
    }
    const BUCKETS = [1, 2, 3, 5, 7, 14, 21, 30];
    const labels = ['1天', '2天', '3天', '5天', '7天', '14天', '21天', '30天'];

    if (history.length < 10) {
        return { labels, data: [90, 85, 78, 68, 60, 50, 42, 35], estimated: true };
    }

    const data = BUCKETS.map(b => {
        const matches = history.filter(h => h.interval >= b * 0.7 && h.interval <= b * 1.5);
        if (matches.length < 3) return null;
        return Math.round(matches.filter(m => m.correct).length / matches.length * 100);
    });

    // Fill nulls
    let last = 90;
    const filled = data.map(v => { if (v !== null) { last = v; return v; } return Math.max(0, last - 5); });
    return { labels, data: filled, estimated: history.length < 30 };
}

function getLearningStatusData() {
    const today = new Date();
    const dailyStats = lsGet(LS.dailyStats);
    const pastDates = [], pastReviews = [];
    for (let i = 29; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const ds = d.toISOString().slice(0, 10);
        pastDates.push(`${d.getMonth() + 1}/${d.getDate()}`);
        pastReviews.push((dailyStats[ds] || {}).reviewedWords || 0);
    }

    const futureDates = [], futureReviews = [];
    const progress = lsGet(LS.progress);
    for (let i = 1; i <= 7; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() + i);
        const ds = d.toISOString().slice(0, 10);
        futureDates.push(`${d.getMonth() + 1}/${d.getDate()}`);
        let count = 0;
        for (const p of Object.values(progress)) {
            if (p.nextReview === ds) count++;
        }
        futureReviews.push(count);
    }
    return { past_dates: pastDates, past_reviews: pastReviews, future_dates: futureDates, future_reviews: futureReviews };
}

function getMasteryDistributionData() {
    const dist = [0, 0, 0, 0, 0, 0, 0, 0]; // Lv0-Lv7+
    const progress = lsGet(LS.progress);
    for (const p of Object.values(progress)) {
        const bucket = Math.min(7, p.level || 0);
        dist[bucket]++;
    }
    return { labels: ['Lv0','Lv1','Lv2','Lv3','Lv4','Lv5','Lv6','Lv7+'], counts: dist };
}

// ─── Settings ─────────────────────────────────────────────────
function getSettings() {
    const defaults = { daily_goal: '50', selected_units: '*', dark_mode: '0', memory_mode: 'ko2cn', gesture_ball: '1', pronunciation_speed: '1.0', tts_enabled: '1' };
    return { ...defaults, ...lsGet(LS.settings) };
}

function saveSettings(updates) {
    const current = getSettings();
    Object.assign(current, updates);
    lsSet(LS.settings, current);
    appSettings = current;
}

// ─── Checkin ──────────────────────────────────────────────────
function doLocalCheckin() {
    const today = todayISO();
    const stats = getTodayStats();
    if ((stats.reviewedWords || 0) < 10) return false;
    const checkins = lsGet(LS.checkins);
    checkins[today] = stats.reviewedWords;
    lsSet(LS.checkins, checkins);
    return true;
}

function getCheckinsForMonth(month) {
    const checkins = lsGet(LS.checkins);
    const result = [];
    for (const [date, count] of Object.entries(checkins)) {
        if (date.startsWith(month)) result.push({ date, reviewed_count: count });
    }
    return result;
}

// ─── Mnemonics ────────────────────────────────────────────────
function getLocalMnemonic(wordId) { return (lsGet(LS.mnemonics)[wordId]) || { content: '' }; }
function setLocalMnemonic(wordId, content) {
    const all = lsGet(LS.mnemonics);
    all[wordId] = { content, updated_at: todayISO() };
    lsSet(LS.mnemonics, all);
}

// ═══════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
    appSettings = getSettings();
    applyTheme();
    initGestureBall();
    setupKeyboard();

    if (localStorage.getItem('topik_guided_v5')) {
        $('guideOverlay').classList.add('hidden');
    } else {
        $('guideBtn').onclick = () => {
            $('guideOverlay').classList.add('hidden');
            localStorage.setItem('topik_guided_v5', '1');
        };
    }

    $('wordCard').style.display = 'block';
    resetDonePanels();
    loadStats();
    loadNextWord('normal');
    initDateHeader();
});

function initDateHeader() {
    const n = new Date();
    $('headerDate').textContent = (n.getMonth() + 1) + '月' + n.getDate() + '日 周' + ['日','一','二','三','四','五','六'][n.getDay()];
}

// ═══════════════════════════════════════════════════════════════
// Tab Switching
// ═══════════════════════════════════════════════════════════════
window.switchTab = function(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
    $('tab-' + tab).classList.add('active');
    document.querySelectorAll('.bn-item').forEach(b => b.classList.remove('active'));
    document.querySelector(`.bn-item[data-tab="${tab}"]`).classList.add('active');
    if (tab === 'stats') loadStatsPage();
    if (tab === 'words') loadUnitsPage();
    if (tab === 'settings') initSettingsPage();
    if (tab === 'review') initDateHeader();
    updateGestureBallVisibility();
};

// ═══════════════════════════════════════════════════════════════
// Review Flow (localStorage-based)
// ═══════════════════════════════════════════════════════════════
async function loadNextWord(mode) {
    if (isAnimating) return;
    isAnimating = true;
    currentMode = mode;

    const queue = getDueWords(30);
    if (queue.length === 0) {
        if (mode === 'normal') showDonePanel();
        else { showDonePanel(); $('doneTitle').textContent = mode === 'mistakes' ? '错题复习完毕' : '没有更多单词了'; }
        isAnimating = false;
        return;
    }

    const w = queue[0];
    currentWord = w;
    const prog = w.progress || {};

    // Instantly flip to front (no animation) to prevent flash
    $('cardInner').style.transition = 'none';
    $('cardInner').classList.remove('flipped');
    isFlipped = false;
    void $('cardInner').offsetHeight;

    // Render front
    const memMode = appSettings.memory_mode || 'ko2cn';
    if (memMode === 'cn2ko') {
        $('cardMainText').textContent = w.meaning;
    } else {
        $('cardMainText').textContent = w.korean;
    }
    $('cardTag').textContent = w.unit || 'TOPIK';

    // Render back
    $('backKorean').textContent = w.korean;
    $('backMeaning').textContent = w.meaning || '（暂无释义）';

    const exKo = w.example_ko, exZh = w.example_zh;
    const exDiv = $('backExamples');
    if (exKo && exKo !== 'None' && exKo.length > 2) {
        exDiv.innerHTML = '<span class="ex-ko">' + esc(exKo) + '</span>' + (exZh && exZh !== 'None' && exZh.length > 2 ? '<span class="ex-zh">' + esc(exZh) + '</span>' : '');
        exDiv.style.display = 'block';
    } else { exDiv.innerHTML = ''; exDiv.style.display = 'none'; }

    // Note (词源)
    const noteText = w.note || '';
    if (noteText && noteText.length > 0) {
        $('noteText').textContent = noteText;
        $('backNote').style.display = 'flex';
    } else { $('backNote').style.display = 'none'; }

    // Mnemonic
    const m = getLocalMnemonic(w.id);
    const mc = m.content || '';
    $('mnContent').textContent = mc || '暂无笔记，点击 ✎ 添加';
    $('mnContent').style.color = mc ? '' : 'var(--hint)';
    $('mnEditor').style.display = 'none';
    $('mnContent').style.display = '';
    $('mnEditBtn').style.display = '';

    // Meta
    $('backReviewCount').textContent = '复习 ' + (prog.totalReviews || 0) + ' 次';
    $('backLevel').textContent = 'Lv ' + (prog.level || 0);

    // Restore transition
    $('cardInner').style.transition = '';
    $('wordCard').style.display = 'block';
    $('backEditSection').style.display = 'none';
    resetDonePanels();
    $('reviewButtons').style.display = '';
    cardShownAt = performance.now();

    $('modeBadge').style.display = mode !== 'normal' ? 'inline-block' : 'none';
    $('modeBadge').textContent = mode === 'continue' ? '加量' : mode === 'mistakes' ? '错题' : '';

    if (appSettings.tts_enabled !== '0' && w.korean) speak(w.korean, 'ko-KR');

    isAnimating = false;
}

function flipToFront() { isFlipped = false; $('cardInner').classList.remove('flipped'); }
function toggleFlip() {
    if (!currentWord || isAnimating) return;
    if ($('mnEditor').style.display !== 'none') return;
    isFlipped = !isFlipped;
    $('cardInner').classList.toggle('flipped', isFlipped);
    stopSpeech();
}

$('wordCard').addEventListener('click', e => {
    if (!currentWord || isAnimating) return;
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('textarea')) return;
    toggleFlip();
});

window.review = function(result) {
    if (!currentWord || isAnimating) return;
    isAnimating = true;
    const responseTime = Math.round(performance.now() - cardShownAt);

    const oldP = getProgress(currentWord.id);
    const prevLevel = oldP.level;
    const srs = calcSRS(oldP.level, oldP.easeFactor, oldP.intervalDays, result);
    const isNewGraduated = prevLevel === 0 && srs.level > 0;

    const newP = {
        ...oldP,
        level: srs.level,
        easeFactor: srs.easeFactor,
        intervalDays: srs.intervalDays,
        nextReview: srs.nextReview,
        totalReviews: (oldP.totalReviews || 0) + 1,
        totalCorrect: (oldP.totalCorrect || 0) + (result === 2 ? 1 : 0),
        lastResult: result,
        lastReviewed: todayISO(),
        lastForgotDate: result === 0 ? todayISO() : oldP.lastForgotDate,
        streakCorrect: result === 2 ? (oldP.streakCorrect || 0) + 1 : 0,
    };
    setProgress(currentWord.id, newP);
    updateDailyStats(result, isNewGraduated);

    loadStats();
    isAnimating = false;
    currentWord = null;
    loadNextWord(currentMode);
};

// ─── Done / Checkin ───────────────────────────────────────────
function showDonePanel() {
    $('wordCard').style.display = 'none';
    $('reviewButtons').style.display = 'none';
    $('donePanel').classList.add('show');
    todayStatsCache = getTodayStats();
    $('doneDetail').innerHTML = '今日复习 <strong>' + (todayStatsCache.reviewedWords || 0) + '</strong> 词 · 新学 <strong>' + (todayStatsCache.newWords || 0) + '</strong> 词<br>认识 ' + (todayStatsCache.knownCount || 0) + ' · 模糊 ' + (todayStatsCache.fuzzyCount || 0) + ' · 忘记 ' + (todayStatsCache.forgotCount || 0);
    $('ringPct').textContent = '100%';
    const circ = 2 * Math.PI * 42;
    $('ringFill').setAttribute('stroke-dasharray', `${circ} ${circ}`);
    $('ringFill').setAttribute('stroke-dashoffset', '0');
}

function resetDonePanels() {
    $('donePanel').classList.remove('show');
    $('checkinPanel').classList.remove('show');
    $('doneTitle').textContent = '今日目标完成！';
}

window.continueStudy = function() { resetDonePanels(); loadNextWord('continue'); };
window.reviewMistakes = function() { resetDonePanels(); loadNextWord('mistakes'); };

window.doCheckin = function() {
    if (!doLocalCheckin()) { showToast('今日复习不足10词，无法签到'); return; }
    $('donePanel').classList.remove('show');
    $('checkinPanel').classList.add('show');
    $('checkinStreak').textContent = getStreak();
    $('wordCard').style.display = 'none';
    $('reviewButtons').style.display = 'none';
};

window.closeCheckin = function() {
    $('checkinPanel').classList.remove('show');
    $('wordCard').style.display = 'block';
    $('reviewButtons').style.display = '';
    loadNextWord('continue');
};

// ─── Edit Meaning ─────────────────────────────────────────────
window.editMeaning = function(e) {
    if (e) e.stopPropagation();
    $('editInput').value = currentWord.meaning || '';
    $('backEditSection').style.display = 'flex';
    $('editInput').focus();
};
window.saveMeaning = function() {
    const v = $('editInput').value.trim();
    if (!v || !currentWord) return;
    const w = TOPIK_WORDS.find(w => w.id === currentWord.id);
    if (w) w.meaning = v;
    currentWord.meaning = v;
    $('backMeaning').textContent = v;
    $('backEditSection').style.display = 'none';
};

// ═══════════════════════════════════════════════════════════════
// TTS
// ═══════════════════════════════════════════════════════════════
function speak(text, lang) {
    if (!('speechSynthesis' in window)) return;
    stopSpeech();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang || 'ko-KR';
    u.rate = parseFloat(appSettings.pronunciation_speed || '1.0');
    const voices = speechSynthesis.getVoices();
    const match = voices.find(v => v.lang.startsWith(lang?.split('-')[0] || 'ko'));
    if (match) u.voice = match;
    speechSynthesis.speak(u);
}
function stopSpeech() { if ('speechSynthesis' in window) speechSynthesis.cancel(); }
window.speakWord = function() { if (currentWord && currentWord.korean) speak(currentWord.korean, 'ko-KR'); };
if ('speechSynthesis' in window) { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices(); }

// ═══════════════════════════════════════════════════════════════
// Mnemonics (localStorage)
// ═══════════════════════════════════════════════════════════════
window.editMnemonic = function() {
    const cur = $('mnContent').textContent;
    $('mnTextarea').value = cur === '暂无笔记，点击 ✎ 添加' ? '' : cur;
    $('mnEditor').style.display = 'block';
    $('mnContent').style.display = 'none';
    $('mnEditBtn').style.display = 'none';
    $('mnTextarea').focus();
};
window.cancelMnemonic = function() {
    $('mnEditor').style.display = 'none';
    $('mnContent').style.display = '';
    $('mnEditBtn').style.display = '';
};
window.saveMnemonic = function() {
    const content = $('mnTextarea').value.trim();
    setLocalMnemonic(currentWord.id, content);
    $('mnContent').textContent = content || '暂无笔记，点击 ✎ 添加';
    $('mnContent').style.color = content ? '' : 'var(--hint)';
    $('mnEditor').style.display = 'none';
    $('mnContent').style.display = '';
    $('mnEditBtn').style.display = '';
    if (content) showToast('助记已保存 ✓');
};

// ═══════════════════════════════════════════════════════════════
// Stats
// ═══════════════════════════════════════════════════════════════
function loadStats() {
    todayStatsCache = getTodayStats();
    $('hsReviewed').textContent = todayStatsCache.reviewedWords || 0;
    $('hsNew').textContent = todayStatsCache.newWords || 0;
    $('mistakeCount').textContent = getTodayMistakeCount();
    const goal = parseInt(appSettings.daily_goal) || 0;
    const done = todayStatsCache.reviewedWords || 0;
    const pct = goal > 0 ? Math.min(100, Math.round(done / goal * 100)) : 0;
    $('ringPct').textContent = pct + '%';
    const circ = 2 * Math.PI * 42;
    $('ringFill').setAttribute('stroke-dasharray', `${circ} ${circ}`);
    $('ringFill').setAttribute('stroke-dashoffset', circ * (1 - pct / 100));
}

function loadStatsPage() {
    try {
        const t = getTodayStats();
        const o = getOverallStats();
        $('streakNum').textContent = getStreak();
        $('stReviewed').textContent = t.reviewedWords || 0;
        $('stNew').textContent = t.newWords || 0;
        $('stAccuracy').textContent = (o.accuracy || 0) + '%';
        $('stTotal').textContent = o.total_words;
        $('stLearned').textContent = o.learned_words;
        $('stMastered').textContent = o.mastered_words;
        $('stUnlearned').textContent = o.unlearned_words;
        loadAllCharts();
        renderCalendar();
    } catch (e) { console.error('loadStatsPage:', e); }
}

function loadAllCharts() {
    renderForgettingCurve(getForgettingCurveData());
    renderLearningStatus(getLearningStatusData());
    renderMasteryDistribution(getMasteryDistributionData());
}

function getChartColors() {
    const style = getComputedStyle(document.documentElement);
    return {
        text: style.getPropertyValue('--sub').trim(),
        border: style.getPropertyValue('--border').trim(),
        primary: style.getPropertyValue('--primary').trim(),
        success: style.getPropertyValue('--success').trim(),
        warning: style.getPropertyValue('--warning').trim(),
        primaryBg: style.getPropertyValue('--primary-bg').trim(),
    };
}

function destroyChart(key) { if (chartInstances[key]) { chartInstances[key].destroy(); chartInstances[key] = null; } }

function renderForgettingCurve(data) {
    destroyChart('forgetting');
    const c = getChartColors();
    const ctx = $('forgettingCurveChart').getContext('2d');
    chartInstances.forgetting = new Chart(ctx, { type: 'line', data: { labels: data.labels, datasets: [{ label: '记忆保持率', data: data.data, borderColor: c.primary, backgroundColor: c.primaryBg, borderWidth: 2.5, fill: true, tension: 0.3, pointRadius: 4, pointBackgroundColor: c.primary }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { color: c.border }, ticks: { color: c.text, font: { size: 11 } } }, y: { min: 0, max: 100, grid: { color: c.border }, ticks: { color: c.text, font: { size: 11 }, callback: v => v + '%' } } } } });
    $('forgettingNote').textContent = data.estimated ? '基于 SM-2 算法估算' : '';
}

function renderLearningStatus(data) {
    destroyChart('learningStatus');
    const c = getChartColors();
    const ctx = $('learningStatusChart').getContext('2d');
    chartInstances.learningStatus = new Chart(ctx, { type: 'bar', data: { labels: [...data.past_dates, ...data.future_dates], datasets: [{ label: '复习', data: [...data.past_reviews, ...Array(data.future_reviews.length).fill(null)], backgroundColor: c.primary + '99', borderColor: c.primary, borderWidth: 1, borderRadius: 4 }, { label: '预测', data: [...Array(data.past_reviews.length).fill(null), ...data.future_reviews], backgroundColor: c.warning + '44', borderColor: c.warning, borderWidth: 1.5, borderDash: [4, 4], borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 16, color: c.text, font: { size: 11 }, usePointStyle: true } } }, scales: { x: { grid: { display: false }, ticks: { color: c.text, font: { size: 10 }, maxTicksLimit: 15 } }, y: { grid: { color: c.border }, ticks: { color: c.text, font: { size: 11 }, stepSize: 1 } } } } });
}

function renderMasteryDistribution(data) {
    destroyChart('mastery');
    const c = getChartColors();
    const ctx = $('masteryDistChart').getContext('2d');
    const colors = data.labels.map((_, i) => { const r = Math.round(255 * (1 - i / 7)); const g = Math.round(50 + 205 * i / 7); return `rgba(${r},${g},${50 + 10 * i / 7},0.75)`; });
    chartInstances.mastery = new Chart(ctx, { type: 'bar', data: { labels: data.labels, datasets: [{ label: '单词数', data: data.counts, backgroundColor: colors, borderRadius: 4 }] }, options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { color: c.border }, ticks: { color: c.text, font: { size: 11 }, stepSize: 1 } }, y: { grid: { display: false }, ticks: { color: c.text, font: { size: 11 } } } } } });
}

// ─── Calendar ─────────────────────────────────────────────────
let calMonth = new Date().getMonth(), calYear = new Date().getFullYear();
function renderCalendar() {
    const container = $('checkinCalendar'); if (!container) return;
    const months = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
    const ym = `${calYear}-${String(calMonth + 1).padStart(2, '0')}`;
    const co = getCheckinsForMonth(ym);
    const checkedSet = new Set(co.map(c => c.date));
    const today = todayISO();
    const firstDay = new Date(calYear, calMonth, 1).getDay();
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    let html = `<div class="cal-header"><button class="cal-nav" onclick="calMonth--;if(calMonth<0){calMonth=11;calYear--;}renderCalendar()">◀</button><span class="cal-title">${calYear}年 ${months[calMonth]}</span><button class="cal-nav" onclick="calMonth++;if(calMonth>11){calMonth=0;calYear++;}renderCalendar()">▶</button></div><div class="cal-grid">`;
    ['日','一','二','三','四','五','六'].forEach(d => html += `<div class="cal-dow">${d}</div>`);
    for (let i = 0; i < firstDay; i++) html += '<div></div>';
    for (let d = 1; d <= daysInMonth; d++) {
        const ds = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const cls = checkedSet.has(ds) ? 'cal-day checked' : (ds === today ? 'cal-day today' : 'cal-day');
        html += `<div class="${cls}">${d}</div>`;
    }
    html += '</div>';
    container.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════
// Word Selection (选词)
// ═══════════════════════════════════════════════════════════════
function groupUnitsByBook(unitNames) {
    const counts = {};
    for (const w of TOPIK_WORDS) { counts[w.unit] = (counts[w.unit] || 0) + 1; }
    const books = { '初级': [], '中级': [] };
    for (const unit of unitNames) {
        const book = unit.startsWith('中级') ? '中级' : '初级';
        const num = parseInt((unit.match(/\d+/) || ['0'])[0]);
        books[book].push({ unit, count: counts[unit] || 0, num });
    }
    for (const b of Object.keys(books)) books[b].sort((a, b) => a.num - b.num);
    return books;
}

function renderBookSections(containerId, books, selectedSet, isSettings) {
    const container = $(containerId); if (!container) return;
    let html = '';
    for (const bookName of ['初级', '中级']) {
        const units = books[bookName];
        if (!units.length) continue;
        const allSelected = units.every(u => selectedSet.has(u.unit));
        html += `<div class="book-block"><div class="book-header" onclick="toggleBook(this)"><span class="book-name">📘 ${esc(bookName)}</span><span class="book-count">${units.length} 单元 · ${units.reduce((s,u) => s + u.count, 0)} 词</span><span class="book-check">${allSelected ? '✓' : ''}</span></div><div class="book-units">`;
        for (const u of units) {
            const isSel = selectedSet.has(u.unit);
            const short = u.unit.replace(/^(初级|中级) /, '');
            html += `<div class="unit-item${isSel ? ' selected' : ''}" data-unit="${esc(u.unit)}" onclick="event.stopPropagation();${isSettings ? 'toggleUnitInSettings(this)' : 'toggleWordUnit(this)'}"><div class="unit-item-left"><div class="unit-name">${esc(short)}</div><div class="unit-word-count">${u.count} 词</div></div><div class="unit-check">✓</div></div>`;
        }
        html += '</div></div>';
    }
    container.innerHTML = html;
}

window.toggleBook = function(headerEl) {
    headerEl.parentElement.querySelector('.book-units').classList.toggle('collapsed');
};

window.toggleWordUnit = function(el) {
    el.classList.toggle('selected');
    saveUnitSelectionFromDOM();
    updateUnitListSummary();
};

window.toggleUnitInSettings = function(el) {
    el.classList.toggle('selected');
    const block = el.closest('.book-block');
    const allSel = [...block.querySelectorAll('.unit-item')].every(u => u.classList.contains('selected'));
    block.querySelector('.book-check').textContent = allSel ? '✓' : '';
    saveUnitSelectionFromDOM();
};

function saveUnitSelectionFromDOM() {
    const selected = [...document.querySelectorAll('#bookSections .unit-item.selected, #settingsBookSections .unit-item.selected')].map(e => e.dataset.unit);
    const allUnitNames = [...new Set(TOPIK_WORDS.map(w => w.unit))];
    const val = selected.length >= allUnitNames.length ? '*' : selected.join(',');
    saveSettings({ selected_units: val });
}

function updateUnitListSummary() {
    const n = document.querySelectorAll('#bookSections .unit-item.selected').length;
    $('unitListSummary').textContent = `已选 ${n} / 40 个单元`;
}

async function loadUnitsPage() {
    const units = [...new Set(TOPIK_WORDS.map(w => w.unit))].sort();
    const total = TOPIK_WORDS.length;
    $('wordsTotalCount').textContent = total + ' 词';
    const sel = (getSettings().selected_units || '*').trim();
    const selectedSet = sel === '*' || !sel ? new Set(units) : new Set(sel.split(',').map(s => s.trim()));
    const books = groupUnitsByBook(units);
    renderBookSections('bookSections', books, selectedSet, false);
    updateUnitListSummary();
}

// Search
let wsTimer;
$('wordsSearchInput')?.addEventListener('input', () => { clearTimeout(wsTimer); wsTimer = setTimeout(searchWords, 400); });
function searchWords() {
    const q = ($('wordsSearchInput')?.value || '').trim().toLowerCase();
    if (!q) { loadUnitsPage(); return; }
    const results = TOPIK_WORDS.filter(w => w.korean.includes(q) || w.meaning.includes(q));
    const container = $('bookSections');
    container.innerHTML = results.length ? '<div style="padding:0 20px">' + results.map(w => renderWordRow(w)).join('') + '</div>' : '<div class="loading-text">无匹配结果</div>';
    $('unitListSummary').textContent = `搜索到 ${results.length} 个单词`;
}

function renderWordRow(w) {
    const p = getProgress(w.id);
    const hasEx = w.example_ko && w.example_ko !== 'None' && w.example_ko.length > 2;
    const m = getLocalMnemonic(w.id);
    return `<div class="word-row" onclick="this.classList.toggle('expanded')"><div class="wr-main"><div class="wr-korean">${esc(w.korean)}</div><div class="wr-meaning">${esc(w.meaning || '')}</div><div class="wr-meta"><span class="wr-tag">${esc(w.unit || '')}</span><span class="wr-level${p.level === 0 ? ' new' : ''}">Lv${p.level}</span>${m.content ? '<span class="wr-mnemonic-dot">📝</span>' : ''}</div></div>${hasEx ? `<div class="wr-examples"><span class="ex-ko">${esc(w.example_ko)}</span><span class="ex-zh">${esc(w.example_zh)}</span></div>` : ''}</div>`;
}

// ═══════════════════════════════════════════════════════════════
// Settings Page
// ═══════════════════════════════════════════════════════════════
function initSettingsPage() {
    const s = getSettings();
    const goal = parseInt(s.daily_goal) || 50;
    $('setDailyGoal').value = goal;
    $('setDailyGoalLabel').textContent = goal === 0 ? '不限' : goal;
    document.querySelectorAll('#memoryModeToggle .st-btn').forEach(b => b.classList.toggle('active', b.dataset.value === (s.memory_mode || 'ko2cn')));
    $('darkModeToggle').checked = s.dark_mode === '1';
    $('ttsToggle').checked = s.tts_enabled !== '0';
    $('speedSlider').value = parseFloat(s.pronunciation_speed || '1.0');
    $('speedLabel').textContent = parseFloat(s.pronunciation_speed || '1.0').toFixed(1) + 'x';
    $('gestureBallToggle').checked = s.gesture_ball !== '0';
    initUnitGrid();
}

window.updateDailyGoal = function(v) { $('setDailyGoalLabel').textContent = v === '0' ? '不限' : v; saveSettings({ daily_goal: v }); };
window.setMemoryMode = function(mode, btn) {
    document.querySelectorAll('#memoryModeToggle .st-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    appSettings.memory_mode = mode;
    saveSettings({ memory_mode: mode });
    showToast(mode === 'ko2cn' ? '已切换为 韩→中' : '已切换为 中→韩');
};
window.toggleDarkMode = function(enabled) {
    document.documentElement.setAttribute('data-theme', enabled ? 'dark' : 'light');
    appSettings.dark_mode = enabled ? '1' : '0';
    saveSettings({ dark_mode: enabled ? '1' : '0' });
    if (currentTab === 'stats') setTimeout(loadAllCharts, 300);
};
window.updateTtsSetting = function(enabled) { appSettings.tts_enabled = enabled ? '1' : '0'; saveSettings({ tts_enabled: enabled ? '1' : '0' }); };
window.updateSpeed = function(v) { $('speedLabel').textContent = parseFloat(v).toFixed(1) + 'x'; appSettings.pronunciation_speed = v; saveSettings({ pronunciation_speed: v }); };
window.toggleGestureBall = function(enabled) { appSettings.gesture_ball = enabled ? '1' : '0'; saveSettings({ gesture_ball: enabled ? '1' : '0' }); updateGestureBallVisibility(); };

function initUnitGrid() {
    const units = [...new Set(TOPIK_WORDS.map(w => w.unit))].sort();
    const sel = (getSettings().selected_units || '*').trim();
    const selectedSet = sel === '*' || !sel ? new Set(units) : new Set(sel.split(',').map(s => s.trim()));
    const books = groupUnitsByBook(units);
    renderBookSections('settingsBookSections', books, selectedSet, true);
}

window.selectAllUnits = function() {
    document.querySelectorAll('#settingsBookSections .unit-item').forEach(e => e.classList.add('selected'));
    document.querySelectorAll('#settingsBookSections .book-check').forEach(e => e.textContent = '✓');
    saveSettings({ selected_units: '*' });
};
window.deselectAllUnits = function() {
    document.querySelectorAll('#settingsBookSections .unit-item').forEach(e => e.classList.remove('selected'));
    document.querySelectorAll('#settingsBookSections .book-check').forEach(e => e.textContent = '');
    saveSettings({ selected_units: '' });
};
window.resetProgress = function() {
    if (!confirm('确定重置所有学习进度？\n\n此操作不可撤销，单词本身不会丢失。')) return;
    if (!confirm('再次确认：所有复习记录、签到、助记都将清除。')) return;
    localStorage.removeItem(LS.progress);
    localStorage.removeItem(LS.dailyStats);
    localStorage.removeItem(LS.checkins);
    localStorage.removeItem(LS.mnemonics);
    showToast('进度已重置');
    location.reload();
};

// ═══════════════════════════════════════════════════════════════
// Theme
// ═══════════════════════════════════════════════════════════════
function applyTheme() {
    const dark = appSettings.dark_mode === '1';
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    if ($('darkModeToggle')) $('darkModeToggle').checked = dark;
}

// ═══════════════════════════════════════════════════════════════
// Gesture Ball
// ═══════════════════════════════════════════════════════════════
let gbDragging = false, gbStartX = 0, gbStartY = 0, gbOrigX = 0, gbOrigY = 0, gbMenuOpen = false;

function initGestureBall() {
    const ball = $('gestureBall'), main = ball.querySelector('.gb-main');
    main.addEventListener('pointerdown', e => {
        if (gbMenuOpen) { closeGbMenu(); return; }
        gbDragging = true; gbStartX = e.clientX; gbStartY = e.clientY;
        const rect = ball.getBoundingClientRect();
        gbOrigX = rect.left; gbOrigY = rect.top;
        ball.style.transition = 'none';
        main.setPointerCapture(e.pointerId);
    });
    window.addEventListener('pointermove', e => {
        if (!gbDragging) return;
        const dx = e.clientX - gbStartX, dy = e.clientY - gbStartY;
        ball.style.left = Math.max(8, Math.min(window.innerWidth - 60, gbOrigX + dx)) + 'px';
        ball.style.top = Math.max(60, Math.min(window.innerHeight - 160, gbOrigY + dy)) + 'px';
        ball.style.right = 'auto'; ball.style.bottom = 'auto';
    });
    window.addEventListener('pointerup', e => {
        if (!gbDragging) return; gbDragging = false; ball.style.transition = '';
        if (Math.abs(e.clientX - gbStartX) < 8 && Math.abs(e.clientY - gbStartY) < 8) toggleGbMenu();
    });
    document.addEventListener('click', e => { if (gbMenuOpen && !ball.contains(e.target)) closeGbMenu(); });
}

function toggleGbMenu() { gbMenuOpen = !gbMenuOpen; $('gbMenu').style.display = gbMenuOpen ? 'flex' : 'none'; }
function closeGbMenu() { gbMenuOpen = false; $('gbMenu').style.display = 'none'; }
window.gestureBallAction = function(action) {
    closeGbMenu();
    if (action === 'speak') { if (currentWord && currentWord.korean) speak(currentWord.korean, 'ko-KR'); }
    else if (action === 'flip') toggleFlip();
    else if (action === 'known') review(2);
};
function updateGestureBallVisibility() {
    $('gestureBall').style.display = (appSettings.gesture_ball !== '0' && currentTab === 'review') ? 'block' : 'none';
}

// ═══════════════════════════════════════════════════════════════
// Keyboard
// ═══════════════════════════════════════════════════════════════
function setupKeyboard() {
    document.addEventListener('keydown', e => {
        if (currentTab !== 'review' || isAnimating || !currentWord) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        switch (e.key) {
            case ' ': e.preventDefault(); toggleFlip(); break;
            case '1': review(0); break;
            case '2': review(1); break;
            case '3': review(2); break;
            case 'Enter':
                if ($('mnEditor').style.display !== 'none') { e.preventDefault(); saveMnemonic(); }
                else if ($('backEditSection').style.display === 'flex') { e.preventDefault(); saveMeaning(); }
                break;
            case 'Escape':
                if ($('mnEditor').style.display !== 'none') cancelMnemonic();
                else if ($('backEditSection').style.display === 'flex') $('backEditSection').style.display = 'none';
                break;
        }
    });
}

// ═══════════════════════════════════════════════════════════════
// Toast
// ═══════════════════════════════════════════════════════════════
function showToast(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 2500);
}

// ═══════════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════════
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
