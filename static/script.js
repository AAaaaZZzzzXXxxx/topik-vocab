// ═══════════════════════════════════════════════════════════════
// TOPIK 韩语背单词 v5.0 — 纯静态版 (GitHub Pages)
// localStorage 持久化 · SM-2 算法 · Chart.js · TTS
// ═══════════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);

// ─── Global State ─────────────────────────────────────────────
let currentWord = null, isFlipped = false, isAnimating = false;
let currentMode = 'normal', currentTab = 'review';
let cardShownAt = 0;
let appSettings = {};
let chartInstances = {};
let todayStatsCache = {};

// ─── Word Bank State ──────────────────────────────────────────
let currentBrowseUnit = null;
let quickReviewWords = [];
let quickReviewIndex = 0;
let qrIsFlipped = false;
let favFilterOn = false;

// ─── Undo State ───────────────────────────────────────────────
let lastReviewUndo = null;
let undoTimer = null;

// ─── Mistakes Session Tracking ─────────────────────────────────
// Words already processed in the current mistakes review session.
// Cleared when user exits mistakes mode (finishes or switches away).
let mistakesReviewedToday = new Set();

// ─── Short-Term Review Queue (墨墨式忘记处理) ──────────────────
// Words forgotten today reappear after a few other words, mimicking 墨墨's
// "间隔几个单词后再次出现". Each entry: {wordId, remainingGap}.
// remainingGap counts down as the user reviews OTHER (non-short-term) words.
// When remainingGap <= 0, the word gets inserted at the front of the due queue.
const SHORT_TERM_GAP = 9; // reappear after 9 other words
let shortTermQueue = [];   // [{wordId, remainingGap}]

function addToShortTermQueue(wordId) {
    // Replace existing entry for this word (dedup)
    shortTermQueue = shortTermQueue.filter(e => e.wordId !== wordId);
    shortTermQueue.push({ wordId, remainingGap: SHORT_TERM_GAP });
}

function removeFromShortTermQueue(wordId) {
    shortTermQueue = shortTermQueue.filter(e => e.wordId !== wordId);
}

// ─── localStorage Keys ────────────────────────────────────────
const LS = {
    progress: 'topik_progress',
    dailyStats: 'topik_daily_stats',
    checkins: 'topik_checkins',
    settings: 'topik_settings',
    mnemonics: 'topik_mnemonics',
    favorites: 'topik_favorites',
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
    // Only count successful reviews (fuzzy/known) toward "reviewedWords".
    // "忘记" (result=0) increments forgotCount but NOT reviewedWords —
    // a forgotten word hasn't been successfully reviewed yet.
    if (result > 0) s.reviewedWords = (s.reviewedWords || 0) + 1;
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

    // Cache progress to avoid repeated JSON.parse (2931 words × parsing full object = slow on mobile)
    const progressCache = lsGet(LS.progress);

    // Score each word
    const candidates = [];
    for (const w of TOPIK_WORDS) {
        if (!includeLoanwords && w.is_loanword) continue;
        if (!selectedUnits.has(w.unit)) continue;

        const p = progressCache[w.id] || { level: 0, easeFactor: 2.5, intervalDays: 0, nextReview: today, totalReviews: 0, totalCorrect: 0, lastResult: 0, lastReviewed: null, lastForgotDate: null, streakCorrect: 0 };

        if (currentMode === 'mistakes') {
            // Only include words that were marked wrong today AND haven't been
            // processed yet in the current mistakes review session.
            if (p.lastReviewed === today && p.lastResult !== undefined && p.lastResult < 2 && !mistakesReviewedToday.has(w.id)) {
                candidates.push({ ...w, progress: p, priority: p.lastResult });
            }
            continue;
        }

        // Review words (overdue)
        if (p.level > 0 && p.nextReview <= today) {
            candidates.push({ ...w, progress: p, priority: 0 });
        }
        // New words — includes words forgotten today (SM-2 resets them to level 0
        // with nextReview=today; they should reappear so the user can re-practice).
        // Priority 2 = forgotten-today (after genuine new words); priority 1 = genuine new.
        else if (p.level === 0 && p.nextReview <= today && (p.lastReviewed !== today || p.lastForgotDate === today)) {
            const isForgotToday = p.lastForgotDate === today;
            candidates.push({ ...w, progress: p, priority: isForgotToday ? 2 : 1 });
        }
    }

    // Sort: reviews first (0), then genuine new words (1), then forgotten-today re-practice (2)
    candidates.sort((a, b) => a.priority - b.priority);

    // Shuffle new words for interleaved unit learning
    const reviewWords = candidates.filter(c => c.priority === 0);
    let newWords = candidates.filter(c => c.priority === 1);
    let forgotWords = candidates.filter(c => c.priority === 2);
    // Fisher-Yates shuffle on new words
    for (let i = newWords.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newWords[i], newWords[j]] = [newWords[j], newWords[i]];
    }
    // Also shuffle forgotten-today words so they interleave across units
    for (let i = forgotWords.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [forgotWords[i], forgotWords[j]] = [forgotWords[j], forgotWords[i]];
    }

    // ── Prepend short-term review words (墨墨式"间隔几个词后重现") ──
    // Words forgotten earlier today that are due to reappear after a few other words
    const shortTermReady = [];
    const remainingShortTerm = [];
    for (const entry of shortTermQueue) {
        if (entry.remainingGap <= 0) {
            const sw = TOPIK_WORDS.find(w => w.id === entry.wordId);
            if (sw) {
                const sp = progressCache[sw.id] || { level: 0, easeFactor: 2.5, intervalDays: 0, nextReview: today, totalReviews: 0, totalCorrect: 0, lastResult: 0, lastReviewed: null, lastForgotDate: null, streakCorrect: 0 };
                shortTermReady.push({ ...sw, progress: sp, priority: -1, isShortTerm: true });
            }
        } else {
            remainingShortTerm.push(entry);
        }
    }
    // Remove served entries from the queue (they're being returned now)
    shortTermQueue = remainingShortTerm;

    // Apply daily goal in normal mode
    if (currentMode === 'normal' && dailyGoal > 0) {
        const result = [...shortTermReady]; // short-term words always included, don't consume slots
        let reviewSlots = dailyGoal - todayReviewed;
        // Reviews first (overdue) — don't consume slots
        for (const c of reviewWords) {
            if (result.length >= limit) break;
            result.push(c);
        }
        // New words limited by daily goal (shuffled)
        for (const c of newWords) {
            if (result.length >= limit) break;
            if (reviewSlots > 0) {
                result.push(c);
                reviewSlots--;
            }
        }
        // Forgotten-today words — also consume new-word slots (they need re-practice)
        for (const c of forgotWords) {
            if (result.length >= limit) break;
            if (reviewSlots > 0) {
                result.push(c);
                reviewSlots--;
            }
        }
        return result;
    }

    // Prepend short-term words — they appear before ALL regular candidates
    return [...shortTermReady, ...reviewWords, ...newWords, ...forgotWords].slice(0, limit);
}

function getSelectedUnitSet() {
    const settings = getSettings();
    const scopes = (settings.study_scopes || 'beginner,intermediate,advanced').split(',').filter(Boolean);
    const prefixes = { beginner: '初级', intermediate: '中级', advanced: '高级' };
    const result = new Set();
    for (const scope of scopes) {
        const prefix = prefixes[scope];
        if (prefix) {
            TOPIK_WORDS.filter(w => w.unit.startsWith(prefix)).forEach(w => result.add(w.unit));
        }
    }
    return result.size > 0 ? result : new Set(TOPIK_WORDS.map(w => w.unit));
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

// ─── Unit Progress ─────────────────────────────────────────────
function getUnitProgress(unitName) {
    const words = TOPIK_WORDS.filter(w => w.unit === unitName);
    const total = words.length;
    let learned = 0, mastered = 0, totalReviews = 0, totalCorrect = 0;
    for (const w of words) {
        const p = getProgress(w.id);
        if (p.level > 0) learned++;
        if (p.level >= 5) mastered++;
        totalReviews += (p.totalReviews || 0);
        totalCorrect += (p.totalCorrect || 0);
    }
    return {
        total, learned, mastered,
        accuracy: totalReviews > 0 ? Math.round(totalCorrect / totalReviews * 100) : 0,
        totalReviews, totalCorrect
    };
}

function getAllUnitsWithProgress() {
    const units = [...new Set(TOPIK_WORDS.map(w => w.unit))].sort();
    const books = { '初级': [], '中级': [], '高级': [] };
    for (const unit of units) {
        const book = unit.startsWith('高级') ? '高级' : unit.startsWith('中级') ? '中级' : '初级';
        const num = parseInt((unit.match(/\d+/) || ['0'])[0]);
        const progress = getUnitProgress(unit);
        books[book].push({ name: unit, shortName: unit.replace(/^(初级|中级|高级) /, ''), num, ...progress });
    }
    for (const b of Object.keys(books)) books[b].sort((a, b) => a.num - b.num);
    return books;
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
    const defaults = { daily_goal: '50', selected_units: '*', dark_mode: '0', memory_mode: 'ko2cn', pronunciation_speed: '1.0', tts_enabled: '1' };
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

// ─── Favorites ─────────────────────────────────────────────────
function isFavorite(wordId) { return !!(lsGet('topik_favorites')[wordId]); }
function toggleFavorite(wordId) {
    const favs = lsGet('topik_favorites');
    if (favs[wordId]) delete favs[wordId];
    else favs[wordId] = true;
    lsSet('topik_favorites', favs);
    return !!favs[wordId]; // true if now favorited
}
window.toggleStar = function() {
    if (!currentWord) return;
    const nowFav = toggleFavorite(currentWord.id);
    $('starBtn').textContent = nowFav ? '⭐' : '☆';
    if (nowFav) $('starBtn').classList.add('faved'); else $('starBtn').classList.remove('faved');
    showToast(nowFav ? '已收藏 ⭐' : '已取消收藏');
};
window.qrToggleStar = function() {
    if (quickReviewWords.length === 0) return;
    const w = quickReviewWords[quickReviewIndex];
    const nowFav = toggleFavorite(w.id);
    $('qrStarBtn').textContent = nowFav ? '⭐' : '☆';
    if (nowFav) $('qrStarBtn').classList.add('faved'); else $('qrStarBtn').classList.remove('faved');
    showToast(nowFav ? '已收藏 ⭐' : '已取消收藏');
};
function updateStarButton(wordId) {
    const fav = isFavorite(wordId);
    if ($('starBtn')) { $('starBtn').textContent = fav ? '⭐' : '☆'; if (fav) $('starBtn').classList.add('faved'); else $('starBtn').classList.remove('faved'); }
    if ($('qrStarBtn')) { $('qrStarBtn').textContent = fav ? '⭐' : '☆'; if (fav) $('qrStarBtn').classList.add('faved'); else $('qrStarBtn').classList.remove('faved'); }
}

// ═══════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
    appSettings = getSettings();
    applyTheme();
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
    if (tab === 'words') {
        if ($('wordsSearchInput')) $('wordsSearchInput').value = '';
        loadUnitsPage();
    }
    if (tab === 'settings') initSettingsPage();
    if (tab === 'review') initDateHeader();
};

// ═══════════════════════════════════════════════════════════════
// Review Flow (localStorage-based)
// ═══════════════════════════════════════════════════════════════
async function loadNextWord(mode) {
    if (isAnimating) return;
    isAnimating = true;
    // Clear mistakes tracking when switching away from mistakes mode
    if (currentMode === 'mistakes' && mode !== 'mistakes') {
        mistakesReviewedToday = new Set();
    }
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
        exDiv.innerHTML = '<div class="ex-ko-row"><span class="ex-ko">' + esc(exKo) + '</span><button class="ex-tts-btn" onclick="event.stopPropagation();speakExample()" title="朗读例句">🔊</button></div>' + (exZh && exZh !== 'None' && exZh.length > 2 ? '<span class="ex-zh">' + esc(exZh) + '</span>' : '');
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

    updateStarButton(w.id);

    if (appSettings.tts_enabled !== '0' && w.korean) speak(w.korean, 'ko-KR');

    // ── Decrement short-term queue gaps ──────────────────────
    // Each word displayed (even short-term ones) brings other forgotten words
    // closer to reappearing. Only skip decrementing the current word's own gap.
    for (const entry of shortTermQueue) {
        if (entry.wordId !== w.id) {
            entry.remainingGap--;
        }
    }

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
    const today = todayISO();

    // ── Short-term queue management ──────────────────────────
    // Remove from short-term queue on any successful review (fuzzy/known)
    if (result > 0) {
        removeFromShortTermQueue(currentWord.id);
    }

    // ── SM-2: distinguish first-vs-repeat forget ─────────────
    // 墨墨 design: first forget today → full SM-2 reset.
    // Repeated forgets today → only short-term re-queue, DON'T re-penalize long-term schedule.
    const firstForgetToday = (result === 0 && oldP.lastForgotDate !== today);
    let srs, isNewGraduated;

    if (result === 0 && !firstForgetToday) {
        // Non-first forget today: preserve SM-2 long-term state.
        // Only update review metadata — the word stays at its current level/interval.
        srs = {
            level: oldP.level,
            easeFactor: oldP.easeFactor,
            intervalDays: oldP.intervalDays,
            nextReview: oldP.nextReview,
        };
        isNewGraduated = false;
    } else {
        // First forget OR any fuzzy/known: run normal SM-2
        srs = calcSRS(oldP.level, oldP.easeFactor, oldP.intervalDays, result);
        isNewGraduated = prevLevel === 0 && srs.level > 0;
    }

    // Save undo snapshot before mutating
    const oldStatsSnapshot = JSON.stringify(lsGet(LS.dailyStats));
    const wasInShortTermQueue = shortTermQueue.some(e => e.wordId === currentWord.id);
    lastReviewUndo = {
        wordId: currentWord.id,
        oldProgress: { ...oldP },
        oldStatsSnapshot,
        wasNewGraduated: isNewGraduated,
        result: result,
        savedMode: currentMode,
        wasInShortTermQueue,
    };

    const newP = {
        ...oldP,
        level: srs.level,
        easeFactor: srs.easeFactor,
        intervalDays: srs.intervalDays,
        nextReview: srs.nextReview,
        totalReviews: (oldP.totalReviews || 0) + 1,
        totalCorrect: (oldP.totalCorrect || 0) + (result === 2 ? 1 : 0),
        lastResult: result,
        lastReviewed: today,
        lastForgotDate: result === 0 ? today : oldP.lastForgotDate,
        streakCorrect: result === 2 ? (oldP.streakCorrect || 0) + 1 : 0,
    };

    // Track in mistakes session so the word won't reappear in the same mistakes queue
    if (currentMode === 'mistakes') {
        mistakesReviewedToday.add(currentWord.id);
    }

    // ── Short-term re-queue for forgotten words ──────────────
    if (result === 0) {
        addToShortTermQueue(currentWord.id);
    }

    setProgress(currentWord.id, newP);
    updateDailyStats(result, isNewGraduated);

    loadStats();
    isAnimating = false;
    currentWord = null;
    showUndoButton();
    loadNextWord(currentMode);
};

// ─── Undo ───────────────────────────────────────────────────────
function showUndoButton() {
    const btn = $('cardUndoBtn');
    if (!btn) return;
    if (undoTimer) clearTimeout(undoTimer);
    btn.classList.add('show');
    undoTimer = setTimeout(() => {
        btn.classList.remove('show');
        lastReviewUndo = null;
    }, 3000);
}
window.undoReview = function() {
    if (!lastReviewUndo) return;
    const u = lastReviewUndo;
    setProgress(u.wordId, u.oldProgress);
    lsSet(LS.dailyStats, JSON.parse(u.oldStatsSnapshot));
    // Remove from mistakes tracking so the word can reappear in mistakes queue
    if (u.savedMode === 'mistakes') {
        mistakesReviewedToday.delete(u.wordId);
    }
    // Restore short-term queue state: if the word was in the queue before review, re-add it;
    // otherwise remove it (since the review may have added it for result=0)
    if (u.wasInShortTermQueue) {
        // Word was in short-term queue before review — re-add with gap=0 (ready immediately)
        removeFromShortTermQueue(u.wordId);
        shortTermQueue.push({ wordId: u.wordId, remainingGap: 0 });
    } else {
        removeFromShortTermQueue(u.wordId);
    }
    lastReviewUndo = null;
    if (undoTimer) clearTimeout(undoTimer);
    const btn = $('cardUndoBtn'); if (btn) btn.classList.remove('show');
    // Reload the undone word — preserve original mode
    currentMode = u.savedMode || 'normal';
    isFlipped = false;
    loadStats();
    const w = TOPIK_WORDS.find(x => x.id === u.wordId);
    if (w) {
        currentWord = w;
        $('wordCard').style.display = 'block';
        $('cardInner').classList.remove('flipped');
        $('donePanel').classList.remove('show');
        $('reviewButtons').style.display = '';
        // Re-render front
        const memMode = appSettings.memory_mode || 'ko2cn';
        $('cardMainText').textContent = memMode === 'cn2ko' ? w.meaning : w.korean;
        $('cardTag').textContent = w.unit || 'TOPIK';
        // Re-render back (was missing — caused stale card-back bug)
        $('backKorean').textContent = w.korean;
        $('backMeaning').textContent = w.meaning || '（暂无释义）';
        const exKo2 = w.example_ko, exZh2 = w.example_zh;
        const exDiv2 = $('backExamples');
        if (exKo2 && exKo2 !== 'None' && exKo2.length > 2) {
            exDiv2.innerHTML = '<div class="ex-ko-row"><span class="ex-ko">' + esc(exKo2) + '</span><button class="ex-tts-btn" onclick="event.stopPropagation();speakExample()" title="朗读例句">🔊</button></div>' + (exZh2 && exZh2 !== 'None' && exZh2.length > 2 ? '<span class="ex-zh">' + esc(exZh2) + '</span>' : '');
            exDiv2.style.display = 'block';
        } else { exDiv2.innerHTML = ''; exDiv2.style.display = 'none'; }
        const note2 = w.note || '';
        if (note2 && note2.length > 0) { $('noteText').textContent = note2; $('backNote').style.display = 'flex'; }
        else { $('backNote').style.display = 'none'; }
        cardShownAt = performance.now();
        updateStarButton(w.id);
        if (appSettings.tts_enabled !== '0' && w.korean) speak(w.korean, 'ko-KR');
    }
    showToast('已撤销 ↩');
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
    // Show today review button if there are words reviewed
    const reviewed = todayStatsCache.reviewedWords || 0;
    $('btnTodayReview').style.display = reviewed > 0 ? '' : 'none';
    $('todayReviewList').style.display = 'none';
    lastReviewUndo = null;
    if (undoTimer) clearTimeout(undoTimer);
    var _ub = $('cardUndoBtn'); if (_ub) _ub.classList.remove('show');
}

function resetDonePanels() {
    $('donePanel').classList.remove('show');
    $('checkinPanel').classList.remove('show');
    $('doneTitle').textContent = '今日目标完成！';
    $('todayReviewList').style.display = 'none';
    // Note: do NOT hide undo toast here — it has its own 3s timer
}

// ─── Today Review ──────────────────────────────────────────────
function getTodayReviewWords() {
    const today = todayISO();
    const progress = lsGet(LS.progress);
    const words = [];
    for (const w of TOPIK_WORDS) {
        const p = progress[w.id];
        if (p && p.lastReviewed === today) {
            words.push({ ...w, lastResult: p.lastResult });
        }
    }
    // Most recent first
    return words.reverse();
}
// ─── Manual "Today" panel access from review header ──────────
window.showTodayPanel = function() {
    stopSpeech();
    isAnimating = false;
    currentWord = null;
    $('wordCard').style.display = 'none';
    $('reviewButtons').style.display = 'none';
    $('cardInner').classList.remove('flipped');
    isFlipped = false;
    var _ub = $('cardUndoBtn'); if (_ub) _ub.classList.remove('show');
    if (undoTimer) clearTimeout(undoTimer);
    lastReviewUndo = null;
    // Show done panel with today's data
    todayStatsCache = getTodayStats();
    const reviewed = todayStatsCache.reviewedWords || 0;
    $('doneDetail').innerHTML = '今日复习 <strong>' + reviewed + '</strong> 词 · 新学 <strong>' + (todayStatsCache.newWords || 0) + '</strong> 词<br>认识 ' + (todayStatsCache.knownCount || 0) + ' · 模糊 ' + (todayStatsCache.fuzzyCount || 0) + ' · 忘记 ' + (todayStatsCache.forgotCount || 0);
    $('doneTitle').textContent = reviewed > 0 ? '今日学习记录' : '今天还没有学习';
    const goal = parseInt(appSettings.daily_goal) || 0;
    const pct = goal > 0 ? Math.min(100, Math.round(reviewed / goal * 100)) : (reviewed > 0 ? 100 : 0);
    $('ringPct').textContent = pct + '%';
    const circ = 2 * Math.PI * 42;
    $('ringFill').setAttribute('stroke-dasharray', circ + ' ' + circ);
    $('ringFill').setAttribute('stroke-dashoffset', circ * (1 - pct / 100));
    $('donePanel').classList.add('show');
    $('checkinPanel').classList.remove('show');
    $('btnTodayReview').style.display = reviewed > 0 ? '' : 'none';
    $('todayReviewList').style.display = 'none';
    loadStats();
};

window.toggleTodayReview = function() {
    const list = $('todayReviewList');
    if (list.style.display !== 'none') {
        list.style.display = 'none';
        return;
    }
    const words = getTodayReviewWords();
    if (words.length === 0) {
        showToast('今天还没有复习记录');
        return;
    }
    const resultLabels = { 0: '😰', 1: '🤔', 2: '😊' };
    let known = 0, fuzzy = 0, forgot = 0;
    let html = '';
    for (const w of words) {
        if (w.lastResult === 2) known++;
        else if (w.lastResult === 1) fuzzy++;
        else forgot++;
        html += '<div class="tr-item"><span class="tr-korean">' + esc(w.korean) + '</span><span class="tr-meaning">' + esc(w.meaning || '') + '</span><span class="tr-result">' + (resultLabels[w.lastResult] || '') + '</span></div>';
    }
    $('todayReviewList').innerHTML = '<div style="padding:6px 14px;font-size:12px;color:var(--sub);display:flex;gap:14px"><span>😊 ' + known + '</span><span>🤔 ' + fuzzy + '</span><span>😰 ' + forgot + '</span></div>' + html;
    list.style.display = 'block';
};

window.continueStudy = function() { resetDonePanels(); loadNextWord('continue'); };
window.reviewMistakes = function() { mistakesReviewedToday = new Set(); resetDonePanels(); loadNextWord('mistakes'); };

// ─── Test helpers (exposed for integration tests) ──────────────
window.setCurrentMode = function(m) { currentMode = m; };
window.getCurrentMode = function() { return currentMode; };
window.getMistakesReviewed = function() { return mistakesReviewedToday; };
window.clearMistakesReviewed = function() { mistakesReviewedToday = new Set(); };
window.getShortTermQueue = function() { return shortTermQueue; };
window.clearShortTermQueue = function() { shortTermQueue = []; };
window.addToShortTermQueue = addToShortTermQueue;
window.removeFromShortTermQueue = removeFromShortTermQueue;

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
// TTS — Smart voice selection + voice picker + example speech
// ═══════════════════════════════════════════════════════════════
let cachedVoices = [];

function loadVoices() {
    if (!('speechSynthesis' in window)) return;
    cachedVoices = speechSynthesis.getVoices();
    if (cachedVoices.length === 0) {
        // Voices load async — wait for them
        speechSynthesis.onvoiceschanged = () => {
            cachedVoices = speechSynthesis.getVoices();
        };
    }
}

function getBestVoice(lang) {
    // Check saved preference first
    const prefs = getSettings().voice_prefs || {};
    const savedName = prefs[lang];
    if (savedName) {
        const saved = cachedVoices.find(v => v.name === savedName);
        if (saved) return saved;
    }

    // Priority list: best → fallback for Korean
    if (lang === 'ko-KR') {
        const koPriority = ['Google 한국어', 'Microsoft Heami', 'Microsoft Hajin', 'Hyunsun'];
        for (const name of koPriority) {
            const v = cachedVoices.find(v => v.name === name);
            if (v) return v;
        }
    }

    // Priority for Chinese
    if (lang === 'zh-CN') {
        const zhPriority = ['Google 普通话（中国大陆）', 'Microsoft Xiaoxiao', 'Microsoft Yaoyao', 'Tingting'];
        for (const name of zhPriority) {
            const v = cachedVoices.find(v => v.name === name);
            if (v) return v;
        }
    }

    // Fallback: any voice matching the language prefix
    const prefix = lang.split('-')[0];
    return cachedVoices.find(v => v.lang.startsWith(prefix)) || null;
}

function speak(text, lang) {
    if (!('speechSynthesis' in window)) return;
    stopSpeech();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang || 'ko-KR';
    u.rate = parseFloat(appSettings.pronunciation_speed || '1.0');
    const voice = getBestVoice(lang || 'ko-KR');
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
}
function stopSpeech() { if ('speechSynthesis' in window) speechSynthesis.cancel(); }
window.speakWord = function() { if (currentWord && currentWord.korean) speak(currentWord.korean, 'ko-KR'); };

// ─── Example sentence speech ────────────────────────────────────
window.speakExample = function() {
    const el = document.querySelector('#backExamples .ex-ko');
    if (el && el.textContent) speak(el.textContent, 'ko-KR');
};

// ─── Voice selector (rendered in settings) ──────────────────────
function renderVoiceSelector() {
    const container = $('voiceSelector');
    if (!container) return;
    if (!('speechSynthesis' in window)) {
        container.innerHTML = '<p class="sg-desc">你的浏览器不支持语音合成</p>';
        return;
    }
    if (cachedVoices.length === 0) cachedVoices = speechSynthesis.getVoices();
    // Re-check voices (they may have loaded since init)
    if (cachedVoices.length === 0) cachedVoices = speechSynthesis.getVoices();
    const koVoices = cachedVoices.filter(v => v.lang.startsWith('ko'));
    if (koVoices.length === 0) {
        container.innerHTML = '<p class="sg-desc">未检测到韩语语音包。Windows 用户可在 设置→语言→添加韩语语音。</p>';
        return;
    }
    const prefs = getSettings().voice_prefs || {};
    const selectedKo = prefs['ko-KR'] || '';
    let html = '<div class="voice-list">';
    for (const v of koVoices) {
        const isSel = v.name === selectedKo;
        html += '<button class="voice-item' + (isSel ? ' selected' : '') + '" onclick="selectVoice(\'ko-KR\', \'' + esc(v.name) + '\', this)"><span class="voice-name">' + esc(v.name) + '</span><span class="voice-lang">' + esc(v.lang) + '</span></button>';
    }
    html += '</div>';
    if (koVoices.length <= 1) {
        html += '<p class="sg-desc" style="margin-top:6px">仅检测到一个韩语语音。可安装其他语音包获得更好音质。</p>';
    }
    container.innerHTML = html;
}
window.selectVoice = function(lang, name, btn) {
    const prefs = getSettings().voice_prefs || {};
    prefs[lang] = name;
    saveSettings({ voice_prefs: prefs });
    btn.parentElement.querySelectorAll('.voice-item').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    // Test the voice
    speak('안녕하세요', 'ko-KR');
};

// Init voices
loadVoices();
if ('speechSynthesis' in window) {
    speechSynthesis.onvoiceschanged = () => { cachedVoices = speechSynthesis.getVoices(); };
}

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
// Word Bank (单词库) — Unit browsing, detail view, quick review
// ═══════════════════════════════════════════════════════════════
window.toggleBook = function(headerEl) {
    headerEl.parentElement.querySelector('.book-units').classList.toggle('collapsed');
};

// ─── Favorite Filter ───────────────────────────────────────────
window.toggleFavFilter = function() {
    favFilterOn = !favFilterOn;
    const chip = $('favFilterChip');
    if (favFilterOn) { chip.classList.add('active'); chip.textContent = '⭐ 收藏中 (' + Object.keys(lsGet('topik_favorites')).length + ')'; }
    else { chip.classList.remove('active'); chip.textContent = '⭐ 仅看收藏'; }
    // Re-render current view
    const q = ($('wordsSearchInput')?.value || '').trim();
    if (q) searchWords();
    else if (currentBrowseUnit) openUnitDetail(currentBrowseUnit);
    else renderUnitListView();
};

// ─── Unit List View ────────────────────────────────────────────
function renderUnitListView() {
    // If fav filter is on, show flat list of favorited words
    if (favFilterOn) {
        const favIds = Object.keys(lsGet('topik_favorites'));
        const favWords = TOPIK_WORDS.filter(w => favIds.includes(String(w.id)));
        $('wordsTotalCount').textContent = '收藏 ' + favWords.length + ' 词';
        if (favWords.length === 0) {
            $('unitListView').innerHTML = '<div class="loading-text">还没有收藏单词。在复习卡片背面点击 ☆ 即可收藏</div>';
            return;
        }
        let html = '<div style="padding:0 4px"><div class="search-result-header">⭐ 已收藏 ' + favWords.length + ' 个单词</div>';
        for (const w of favWords) html += renderWordRow(w);
        html += '</div>';
        $('unitListView').innerHTML = html;
        return;
    }

    const books = getAllUnitsWithProgress();
    const totalWords = TOPIK_WORDS.length;
    $('wordsTotalCount').textContent = totalWords + ' 词';

    let html = '';
    for (const bookName of ['初级', '中级', '高级']) {
        const units = books[bookName];
        if (!units.length) continue;
        const bookLearned = units.reduce((s, u) => s + u.learned, 0);
        const bookTotal = units.reduce((s, u) => s + u.total, 0);
        html += `<div class="book-block">
            <div class="book-header" onclick="toggleBook(this)">
                <span class="book-name">📘 ${esc(bookName)}</span>
                <span class="book-count">${bookLearned}/${bookTotal} 词已学</span>
                <span class="book-arrow">▾</span>
            </div>
            <div class="book-units">`;
        for (const u of units) {
            const pct = u.total > 0 ? Math.round(u.learned / u.total * 100) : 0;
            html += `<div class="unit-card" onclick="openUnitDetail('${esc(u.name)}')">
                <div class="uc-header">
                    <span class="uc-name">${esc(u.shortName)}</span>
                    <span class="uc-count">${u.learned}/${u.total}</span>
                </div>
                <div class="uc-bar"><div class="uc-bar-fill" style="width:${pct}%"></div></div>
                <div class="uc-sub">${u.mastered > 0 ? '已掌握 ' + u.mastered + ' 词' : ''}${u.accuracy > 0 ? ' · 正确率 ' + u.accuracy + '%' : ''}</div>
            </div>`;
        }
        html += '</div></div>';
    }
    $('unitListView').innerHTML = html || '<div class="loading-text">暂无单词数据</div>';
}

// ─── Unit Detail View ──────────────────────────────────────────
function openUnitDetail(unitName) {
    currentBrowseUnit = unitName;
    $('unitListView').style.display = 'none';
    $('unitDetailView').style.display = 'flex';
    $('quickReviewArea').style.display = 'none';

    let words = TOPIK_WORDS.filter(w => w.unit === unitName);
    if (favFilterOn) {
        const favIds = Object.keys(lsGet('topik_favorites'));
        words = words.filter(w => favIds.includes(String(w.id)));
    }
    const progress = getUnitProgress(unitName);
    const shortName = unitName.replace(/^(初级|中级|高级) /, '');

    $('udTitle').textContent = shortName;
    $('udStatsBar').innerHTML = `<span>📚 ${progress.total} 词</span><span>✅ 已学 ${progress.learned}</span><span>⭐ 掌握 ${progress.mastered}</span>${progress.accuracy > 0 ? `<span>🎯 正确率 ${progress.accuracy}%</span>` : ''}`;

    let html = '';
    for (const w of words) {
        const p = getProgress(w.id);
        const hasEx = w.example_ko && w.example_ko !== 'None' && w.example_ko.length > 2;
        const hasNote = w.note && w.note.length > 0;
        html += `<div class="ud-word-row" onclick="this.classList.toggle('expanded')">
            <div class="uwr-main">
                <div class="uwr-korean">${isFavorite(w.id) ? '⭐ ' : ''}${esc(w.korean)}</div>
                <div class="uwr-meaning">${esc(w.meaning || '')}</div>
                <div class="uwr-meta">
                    <span class="wr-level${p.level === 0 ? ' new' : ''}">Lv${p.level}</span>
                    ${hasNote ? '<span class="wr-mnemonic-dot">💡</span>' : ''}
                </div>
            </div>
            ${hasEx ? `<div class="uwr-examples"><span class="ex-ko">${esc(w.example_ko)}</span><span class="ex-zh">${esc(w.example_zh)}</span></div>` : ''}
        </div>`;
    }
    $('udWordList').innerHTML = html;
}

function closeUnitDetail() {
    currentBrowseUnit = null;
    $('unitDetailView').style.display = 'none';
    $('unitListView').style.display = '';
    $('quickReviewArea').style.display = 'none';
}

// ─── Quick Review ──────────────────────────────────────────────
function startQuickReview() {
    if (!currentBrowseUnit) return;
    quickReviewWords = TOPIK_WORDS.filter(w => w.unit === currentBrowseUnit);
    if (favFilterOn) {
        const favIds = Object.keys(lsGet('topik_favorites'));
        quickReviewWords = quickReviewWords.filter(w => favIds.includes(String(w.id)));
    }
    if (quickReviewWords.length === 0) { showToast('该单元没有可复习的单词'); return; }
    quickReviewIndex = 0;
    qrIsFlipped = false;

    $('unitDetailView').style.display = 'none';
    $('quickReviewArea').style.display = 'flex';
    $('unitListView').style.display = 'none';

    $('qrTitle').textContent = currentBrowseUnit;

    renderQuickReviewWord();
}

// ─── All-Scope Quick Review ────────────────────────────────────
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
window.startAllQuickReview = function() {
    const selectedUnits = getSelectedUnitSet();
    let words = TOPIK_WORDS.filter(w => selectedUnits.has(w.unit));
    if (favFilterOn) {
        const favIds = Object.keys(lsGet('topik_favorites'));
        words = words.filter(w => favIds.includes(String(w.id)));
    }
    if (words.length === 0) { showToast('学习范围内没有可复习的单词'); return; }
    // Shuffle so units are interleaved
    quickReviewWords = shuffle(words);
    quickReviewIndex = 0;
    qrIsFlipped = false;
    currentBrowseUnit = null; // Not in a specific unit

    $('unitListView').style.display = 'none';
    $('unitDetailView').style.display = 'none';
    $('quickReviewArea').style.display = 'flex';

    const scopes = (getSettings().study_scopes || 'beginner,intermediate,advanced').split(',').filter(Boolean);
    const scopeLabel = { beginner: '初级', intermediate: '中级', advanced: '高级' };
    const scopeName = scopes.length === 3 ? '全部单词' : scopes.map(s => scopeLabel[s] || s).join('+');
    $('qrTitle').textContent = scopeName + ' · ' + words.length + '词';

    renderQuickReviewWord();
};

function exitQuickReview() {
    stopSpeech();
    $('quickReviewArea').style.display = 'none';
    // If we came from a specific unit, go back to its detail view
    if (currentBrowseUnit) {
        $('unitDetailView').style.display = 'flex';
    } else {
        // All-scope review or search → back to unit list
        $('unitListView').style.display = '';
        renderUnitListView();
    }
}

function renderQuickReviewWord() {
    if (quickReviewWords.length === 0) return;
    if (!$('qrCardInner')) return; // safety: QR card not in DOM
    const w = quickReviewWords[quickReviewIndex];

    $('qrCardInner').classList.remove('flipped');
    qrIsFlipped = false;

    $('qrCardTag').textContent = w.unit || 'TOPIK';
    $('qrCardMainText').textContent = w.korean;

    $('qrBackKorean').textContent = w.korean;
    $('qrBackMeaning').textContent = w.meaning || '（暂无释义）';

    const exKo = w.example_ko, exZh = w.example_zh;
    const exDiv = $('qrBackExamples');
    if (exKo && exKo !== 'None' && exKo.length > 2) {
        exDiv.innerHTML = '<div class="ex-ko-row"><span class="ex-ko">' + esc(exKo) + '</span><button class="ex-tts-btn" onclick="event.stopPropagation();qrSpeakExample()" title="朗读例句">🔊</button></div>' + (exZh && exZh !== 'None' && exZh.length > 2 ? '<span class="ex-zh">' + esc(exZh) + '</span>' : '');
        exDiv.style.display = 'block';
    } else { exDiv.innerHTML = ''; exDiv.style.display = 'none'; }

    const noteText = w.note || '';
    if (noteText && noteText.length > 0) {
        $('qrNoteText').textContent = noteText;
        $('qrBackNote').style.display = 'flex';
    } else { $('qrBackNote').style.display = 'none'; }

    $('qrCounter').textContent = (quickReviewIndex + 1) + ' / ' + quickReviewWords.length;
    $('qrKnownBtn').style.display = 'none';
    updateStarButton(w.id);

    if (appSettings.tts_enabled !== '0' && w.korean) speak(w.korean, 'ko-KR');
}

function qrFlip() {
    if (quickReviewWords.length === 0) return;
    qrIsFlipped = !qrIsFlipped;
    $('qrCardInner').classList.toggle('flipped', qrIsFlipped);
    stopSpeech();

    if (qrIsFlipped) {
        const w = quickReviewWords[quickReviewIndex];
        const p = getProgress(w.id);
        $('qrKnownBtn').style.display = p.level === 0 ? '' : 'none';
    } else {
        $('qrKnownBtn').style.display = 'none';
    }
}

function qrNext() {
    if (quickReviewIndex < quickReviewWords.length - 1) {
        quickReviewIndex++;
        renderQuickReviewWord();
    }
}

function qrPrev() {
    if (quickReviewIndex > 0) {
        quickReviewIndex--;
        renderQuickReviewWord();
    }
}

function qrMarkKnown() {
    if (quickReviewWords.length === 0) return;
    const w = quickReviewWords[quickReviewIndex];
    const oldP = getProgress(w.id);
    if (oldP.level > 0) return;

    const today = todayISO();
    const next = new Date();
    next.setDate(next.getDate() + 1);
    setProgress(w.id, {
        ...oldP,
        level: 1,
        intervalDays: 1,
        nextReview: next.toISOString().slice(0, 10),
        totalReviews: (oldP.totalReviews || 0) + 1,
        totalCorrect: (oldP.totalCorrect || 0) + 1,
        lastResult: 2,
        lastReviewed: today,
    });

    const allStats = lsGet(LS.dailyStats);
    let s = allStats[today] || { newWords: 0, reviewedWords: 0, knownCount: 0, fuzzyCount: 0, forgotCount: 0 };
    s.reviewedWords = (s.reviewedWords || 0) + 1;
    s.knownCount = (s.knownCount || 0) + 1;
    s.newWords = (s.newWords || 0) + 1;
    allStats[today] = s;
    lsSet(LS.dailyStats, allStats);

    showToast('已标记为认识 ✓');
    $('qrKnownBtn').style.display = 'none';
    loadStats();
}

function qrSpeak() {
    if (quickReviewWords.length > 0 && quickReviewWords[quickReviewIndex].korean) {
        speak(quickReviewWords[quickReviewIndex].korean, 'ko-KR');
    }
}

window.qrSpeakExample = function() {
    if (quickReviewWords.length > 0) {
        const w = quickReviewWords[quickReviewIndex];
        if (w.example_ko && w.example_ko !== 'None') speak(w.example_ko, 'ko-KR');
    }
};

// ─── Load Units Page ───────────────────────────────────────────
async function loadUnitsPage() {
    const q = ($('wordsSearchInput')?.value || '').trim();
    if (q) { searchWords(); return; }
    $('unitListView').style.display = '';
    $('unitDetailView').style.display = 'none';
    $('quickReviewArea').style.display = 'none';
    currentBrowseUnit = null;
    renderUnitListView();
}

// ─── Search ────────────────────────────────────────────────────
let wsTimer;
$('wordsSearchInput')?.addEventListener('input', () => { clearTimeout(wsTimer); wsTimer = setTimeout(searchWords, 400); });
function searchWords() {
    const q = ($('wordsSearchInput')?.value || '').trim().toLowerCase();
    if (!q) { loadUnitsPage(); return; }
    $('unitListView').style.display = '';
    $('unitDetailView').style.display = 'none';
    $('quickReviewArea').style.display = 'none';
    currentBrowseUnit = null;

    let results = TOPIK_WORDS.filter(w =>
        w.korean.includes(q) || w.meaning.includes(q) ||
        (w.example_ko && w.example_ko.includes(q)) ||
        (w.example_zh && w.example_zh.includes(q))
    );
    if (favFilterOn) {
        const favIds = Object.keys(lsGet('topik_favorites'));
        results = results.filter(w => favIds.includes(String(w.id)));
    }

    if (results.length === 0) {
        $('unitListView').innerHTML = '<div class="loading-text">无匹配结果</div>';
        return;
    }

    let html = '<div style="padding:0 4px"><div class="search-result-header">搜索到 ' + results.length + ' 个单词</div>';
    for (const w of results) {
        html += renderWordRow(w);
    }
    html += '</div>';
    $('unitListView').innerHTML = html;
}

function renderWordRow(w) {
    const p = getProgress(w.id);
    const hasEx = w.example_ko && w.example_ko !== 'None' && w.example_ko.length > 2;
    const m = getLocalMnemonic(w.id);
    const fav = isFavorite(w.id);
    return `<div class="word-row" onclick="this.classList.toggle('expanded')"><div class="wr-main"><div class="wr-korean">${fav ? '⭐ ' : ''}${esc(w.korean)}</div><div class="wr-meaning">${esc(w.meaning || '')}</div><div class="wr-meta"><span class="wr-tag">${esc(w.unit || '')}</span><span class="wr-level${p.level === 0 ? ' new' : ''}">Lv${p.level}</span>${m.content ? '<span class="wr-mnemonic-dot">📝</span>' : ''}</div></div>${hasEx ? `<div class="wr-examples"><span class="ex-ko">${esc(w.example_ko)}</span><span class="ex-zh">${esc(w.example_zh)}</span></div>` : ''}</div>`;
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
    // Study scope toggle (multi-select)
    const scopes = (s.study_scopes || 'beginner,intermediate,advanced').split(',').filter(Boolean);
    document.querySelectorAll('#studyScopeToggle .st-btn').forEach(b => {
        b.classList.toggle('active', scopes.includes(b.dataset.value));
    });
    // Voice selector
    renderVoiceSelector();
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
    // Sync iOS status bar / theme-color
    const meta = document.getElementById('metaThemeColor');
    if (meta) meta.content = enabled ? '#1c1c1e' : '#f2f3f7';
    if (currentTab === 'stats') setTimeout(loadAllCharts, 300);
};
window.updateTtsSetting = function(enabled) { appSettings.tts_enabled = enabled ? '1' : '0'; saveSettings({ tts_enabled: enabled ? '1' : '0' }); };
window.updateSpeed = function(v) { $('speedLabel').textContent = parseFloat(v).toFixed(1) + 'x'; appSettings.pronunciation_speed = v; saveSettings({ pronunciation_speed: v }); };
// ─── Study Scope (multi-select toggle) ──────────────────────────
window.toggleStudyScope = function(scope, btn) {
    const s = getSettings();
    let scopes = (s.study_scopes || 'beginner,intermediate,advanced').split(',').filter(Boolean);
    if (scopes.includes(scope)) {
        if (scopes.length <= 1) { showToast('至少保留一个级别'); return; }
        scopes = scopes.filter(x => x !== scope);
        btn.classList.remove('active');
    } else {
        scopes.push(scope);
        btn.classList.add('active');
    }
    saveSettings({ study_scopes: scopes.join(',') });
    const labels = { beginner: '初级', intermediate: '中级', advanced: '高级' };
    const names = scopes.map(s => labels[s] || s).join('+');
    showToast('学习范围：' + names);
};

// ─── Data Backup ───────────────────────────────────────────────
window.exportData = function() {
    const data = {
        version: '5.0',
        exported_at: new Date().toISOString(),
        progress: lsGet(LS.progress),
        dailyStats: lsGet(LS.dailyStats),
        checkins: lsGet(LS.checkins),
        mnemonics: lsGet(LS.mnemonics),
        favorites: lsGet(LS.favorites),
        settings: lsGet(LS.settings),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'topik_backup_' + todayISO() + '.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('数据已导出 ✓');
};

window.importData = function(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            if (!data.progress && !data.settings) throw new Error('无效的备份文件');
            if (!confirm('即将导入备份数据：\n• ' + Object.keys(data.progress || {}).length + ' 条学习记录\n• ' + Object.keys(data.checkins || {}).length + ' 条签到\n\n当前进度将被覆盖，确定继续？')) return;
            if (data.progress) lsSet(LS.progress, data.progress);
            if (data.dailyStats) lsSet(LS.dailyStats, data.dailyStats);
            if (data.checkins) lsSet(LS.checkins, data.checkins);
            if (data.mnemonics) lsSet(LS.mnemonics, data.mnemonics);
            if (data.favorites) lsSet(LS.favorites, data.favorites);
            if (data.settings) lsSet(LS.settings, data.settings);
            showToast('数据已导入 ✓');
            setTimeout(() => location.reload(), 800);
        } catch (err) {
            showToast('导入失败：文件格式不正确');
        }
    };
    reader.readAsText(file);
    input.value = '';
};

window.resetProgress = function() {
    if (!confirm('确定重置所有学习进度？\n\n此操作不可撤销，单词本身不会丢失。')) return;
    if (!confirm('再次确认：所有复习记录、签到、助记都将清除。')) return;
    localStorage.removeItem(LS.progress);
    localStorage.removeItem(LS.dailyStats);
    localStorage.removeItem(LS.checkins);
    localStorage.removeItem(LS.mnemonics);
    localStorage.removeItem(LS.favorites);
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
    const meta = document.getElementById('metaThemeColor');
    if (meta) meta.content = dark ? '#1c1c1e' : '#f2f3f7';
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
