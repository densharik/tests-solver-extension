// МТИ СИНЕРГИЯ — AI Решатель (Chrome Extension)
// Портирован из Tampermonkey userscript v5
// GM_setValue/getValue → chrome.storage.local
// GM_xmlhttpRequest   → chrome.runtime.sendMessage → service worker fetch

(async function () {
    'use strict';

    const WORKER_URL     = 'https://';
    const AUTO_APPLY     = true;
    const SCRIPT_VERSION = '4.18';

    // ─── Загрузка настроек из chrome.storage.local ────────────────────────────
    const stored = await chrome.storage.local.get(null);

    let userToken      = stored.mti_token          ?? '';
    let userContext    = stored.mti_context         ?? '';
    let userModel      = stored.mti_model           ?? 'claude-sonnet-4-6';
    let userDiscipline = stored.mti_discipline      ?? 'it';
    let userReasoning  = stored.mti_reasoning       ?? false;
    let panelVisible   = stored.mti_panel_visible   ?? true;
    let panelX         = stored.mti_panel_x         ?? null;
    let panelY         = stored.mti_panel_y         ?? null;

    let lastLogId   = null;
    let lastTestLog = null;
    const sentResultHashes = new Set();

    // Map: нормализованный префикс вопроса → { hash, logId }
    // sessionStorage переживает навигацию в рамках вкладки
    let testQuestionMap = new Map();
    try {
        const saved = sessionStorage.getItem('mti_qmap');
        if (saved) testQuestionMap = new Map(JSON.parse(saved));
    } catch {}

    function saveQuestionMap() {
        try { sessionStorage.setItem('mti_qmap', JSON.stringify([...testQuestionMap])); } catch {}
    }
    function clearQuestionMap() {
        testQuestionMap.clear();
        try { sessionStorage.removeItem('mti_qmap'); } catch {}
    }


    // ─── Автопилот ─────────────────────────────────────────────────────────────
    let autopilotActive    = false;
    let autopilotRunsLeft  = 0;
    let autopilotTotalRuns = 5;
    let autopilotWatchdog  = null;
    try {
        autopilotActive    = sessionStorage.getItem('mti_autopilot') === '1';
        autopilotRunsLeft  = parseInt(sessionStorage.getItem('mti_autopilot_left'))  || 0;
        autopilotTotalRuns = parseInt(sessionStorage.getItem('mti_autopilot_total')) || 5;
        if (autopilotRunsLeft <= 0) autopilotActive = false;
    } catch {}

    function saveAutopilotState() {
        try {
            sessionStorage.setItem('mti_autopilot',       autopilotActive   ? '1' : '0');
            sessionStorage.setItem('mti_autopilot_left',  String(autopilotRunsLeft));
            sessionStorage.setItem('mti_autopilot_total', String(autopilotTotalRuns));
        } catch {}
    }

    function stopAutopilot(msg) {
        autopilotActive   = false;
        autopilotRunsLeft = 0;
        clearTimeout(autopilotWatchdog);
        saveAutopilotState();
        updateAutopilotUI();
        if (msg) setStatus(msg, 'done');
    }

    function resetAutopilotWatchdog() {
        if (!autopilotActive) return;
        clearTimeout(autopilotWatchdog);
        autopilotWatchdog = setTimeout(() => {
            if (!autopilotActive) return;
            const inPlayer  = !!document.querySelector('.test-question-text-2');
            const hasResult = !!document.querySelector('.table-list');
            if (!inPlayer && !hasResult) {
                setStatus('🤖 Таймаут — перезагрузка...', 'loading');
                location.reload();
            }
        }, 12000);
    }

    function checkAndClickFinish() {
        const spans = document.querySelectorAll('span');
        for (const s of spans) {
            if (s.style && s.style.color === 'green' && s.textContent.includes('Отвеченный ранее')) {
                const finishBtn = document.querySelector('input.doFinishBtn');
                if (finishBtn) {
                    setStatus('🤖 Все вопросы пройдены, сдаю тест...', 'loading');
                    setTimeout(() => { finishBtn.click(); resetAutopilotWatchdog(); }, 1200);
                    return true;
                }
            }
        }
        return false;
    }

    let autopilotModalObserver = null;
    let autopilotModalClicked  = false;
    function watchForStartModal() {
        if (autopilotModalObserver) return;
        autopilotModalObserver = new MutationObserver(() => {
            if (!autopilotActive || autopilotModalClicked) return;
            const modalBtn = document.querySelector('a.mc-modal-button[onclick*="startTesting"]');
            if (!modalBtn) return;
            autopilotModalClicked = true;
            setTimeout(() => {
                modalBtn.click();
                setStatus('🤖 Загрузка теста...', 'loading');
                clearTimeout(autopilotWatchdog);
                autopilotWatchdog = setTimeout(() => {
                    if (!autopilotActive) return;
                    const inPlayer  = !!document.querySelector('.test-question-text-2');
                    const hasResult = !!document.querySelector('.table-list');
                    if (!inPlayer && !hasResult) {
                        setStatus('🤖 Таймаут — перезагрузка...', 'loading');
                        location.reload();
                    }
                }, 20000);
            }, 800);
        });
        autopilotModalObserver.observe(document.body, { childList: true, subtree: true });
    }

    function resetModalClickedFlag() {
        autopilotModalClicked = false;
    }

    function autopilotClickSend() {
        if (!autopilotActive) return;
        if (checkAndClickFinish()) return;
        const sendBtn = document.querySelector('input.doSendBtn');
        if (sendBtn && !sendBtn.disabled) {
            sendBtn.click();
            resetAutopilotWatchdog();
            setTimeout(() => { if (autopilotActive) checkAndClickFinish(); }, 2000);
        }
    }

    function updateAutopilotUI() {
        const btn      = document.getElementById('ai-solver-autopilot-btn');
        const statusEl = document.getElementById('ai-solver-autopilot-status');
        if (!btn) return;
        if (autopilotActive) {
            const done = autopilotTotalRuns - autopilotRunsLeft;
            btn.textContent       = '⏹ Стоп';
            btn.style.background  = '#5a1a1a';
            btn.style.borderColor = '#8b2a2a';
            btn.style.color       = '#ff8a80';
            statusEl.style.display = 'block';
            statusEl.textContent   = `🤖 Прогон ${done + 1} из ${autopilotTotalRuns} (осталось: ${autopilotRunsLeft})`;
        } else {
            btn.textContent       = '🤖 Автопилот';
            btn.style.background  = '';
            btn.style.borderColor = '';
            btn.style.color       = '';
            statusEl.style.display = 'none';
        }
    }

    // ═══════════════════════════════════════════
    //  UI
    // ═══════════════════════════════════════════
    const panel = document.createElement('div');
    panel.id = 'ai-solver-panel';
    panel.innerHTML = `
        <div id="ai-solver-header">
            <span id="ai-solver-title">🤖 AI Решатель v${SCRIPT_VERSION}</span>
            <div id="ai-solver-controls">
                <span id="ai-solver-credits" title="Осталось решений"></span>
                <button id="ai-solver-rerun" title="Перерешать">↺</button>
                <button id="ai-solver-snap-btn" title="Прикрепить слева от теста">📌</button>
                <button id="ai-solver-settings-btn" title="Настройки">⚙</button>
                <button id="ai-solver-toggle" title="Свернуть">−</button>
            </div>
        </div>
        <div id="ai-solver-body">
            <div id="ai-solver-low-credits" style="display:none">
                ⚠ Мало кредитов! Пополни баланс.
            </div>
            <div id="ai-solver-status">Ожидание вопроса...</div>
            <div id="ai-solver-answer"></div>
            <div id="ai-solver-apply-row" style="display:none">
                <button id="ai-solver-apply-btn">✓ Применить ответ</button>
            </div>
            <div id="ai-solver-websearch-row" style="margin-top:6px;">
                <button id="ai-solver-websearch-btn">🔍 Повторить с веб-поиском</button>
            </div>
            <div id="ai-solver-settings" style="display:none">
                <div class="ai-label">Токен доступа:</div>
                <input id="ai-solver-token-input" type="password" placeholder="Введи токен" value="${userToken}">
                <div class="ai-label" style="margin-top:8px">Контекст (предмет, уточнения):</div>
                <textarea id="ai-solver-context-input" rows="3" placeholder="Например: Менеджмент, управление персоналом">${userContext}</textarea>
                <div class="ai-label" style="margin-top:10px">Модель:</div>
                <div class="ai-toggle-row">
                    <label class="ai-radio-btn"><input type="radio" name="ai-solver-model" id="ai-model-sonnet" value="claude-sonnet-4-6"> Sonnet</label>
                    <label class="ai-radio-btn"><input type="radio" name="ai-solver-model" id="ai-model-haiku" value="claude-haiku-4-5-20251001"> Haiku</label>
                    <label class="ai-radio-btn"><input type="radio" name="ai-solver-model" value="gpt-5.4-mini"> GPT mini</label>
                    <label class="ai-radio-btn"><input type="radio" name="ai-solver-model" value="gpt-5.4-nano"> GPT nano</label>
                </div>
                <div class="ai-label" style="margin-top:10px">Дисциплина:</div>
                <div class="ai-discipline-group">
                    <label><input type="radio" name="ai-solver-discipline" value="it"> IT / Технические</label>
                    <label><input type="radio" name="ai-solver-discipline" value="law"> Право</label>
                    <label><input type="radio" name="ai-solver-discipline" value="econ"> Экономика / Менеджмент / HR</label>
                    <label><input type="radio" name="ai-solver-discipline" value="psy"> Психология</label>
                    <label><input type="radio" name="ai-solver-discipline" value="science"> Математика / Науки</label>
                </div>
                <div class="ai-label" style="margin-top:10px">Обоснование:</div>
                <div class="ai-toggle-row">
                    <label class="ai-switch-wrap">
                        <input type="checkbox" id="ai-solver-reasoning-toggle">
                        <span class="ai-switch"></span>
                        <span class="ai-switch-label">Показывать обоснование выбора</span>
                    </label>
                </div>
                <button id="ai-solver-save-btn" class="ai-btn-green" style="margin-top:10px">💾 Сохранить токен</button>
                <button id="ai-solver-check-balance-btn" class="ai-btn-blue" style="margin-top:6px">📊 Мой баланс</button>
            </div>
            <div id="ai-solver-me" style="display:none; margin-top:8px; font-size:12px; color:#888;"></div>
            <div id="ai-solver-log-row" style="display:none; margin-top:8px;">
                <button id="ai-solver-copy-log-btn">📋 Скопировать логи</button>
            </div>
            <div id="ai-solver-autopilot-row" style="margin-top:8px;">
                <div style="display:flex;gap:6px;align-items:center;">
                    <button id="ai-solver-autopilot-btn">🤖 Автопилот</button>
                    <input id="ai-solver-autopilot-runs" type="number" value="5" min="1" max="30">
                    <span style="font-size:11px;color:#888;">прогонов</span>
                </div>
                <div id="ai-solver-autopilot-status" style="display:none;margin-top:4px;font-size:11px;color:#f0a830;"></div>
            </div>
        </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
        #ai-solver-panel {
            position: fixed; width: 340px;
            background: #1e1e1e; color: #e0e0e0;
            border: 1px solid #444; border-radius: 10px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            z-index: 99999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 13px; user-select: none;
        }
        #ai-solver-header {
            background: #2a2a2a; border-radius: 10px 10px 0 0;
            padding: 8px 12px; display: flex; align-items: center;
            justify-content: space-between; cursor: move;
            border-bottom: 1px solid #444;
        }
        #ai-solver-title { font-weight: bold; font-size: 14px; }
        #ai-solver-controls { display: flex; gap: 4px; align-items: center; }
        #ai-solver-credits {
            font-size: 11px; color: #f0a830; padding: 2px 6px;
            background: #2a2000; border-radius: 3px;
        }
        #ai-solver-credits.critical { color: #f44336; background: #2a0000; }
        #ai-solver-controls button {
            background: #3a3a3a; border: 1px solid #555; color: #ccc;
            border-radius: 4px; width: 26px; height: 26px; cursor: pointer;
            font-size: 14px; line-height: 1; padding: 0;
        }
        #ai-solver-controls button:hover { background: #4a4a4a; color: #fff; }
        #ai-solver-body { padding: 12px; }
        #ai-solver-low-credits {
            background: #2a1200; border: 1px solid #5a2a00; border-radius: 6px;
            padding: 8px 10px; margin-bottom: 8px; font-size: 12px; color: #f0a830;
        }
        #ai-solver-status { font-size: 12px; color: #888; margin-bottom: 8px; }
        #ai-solver-status.loading { color: #f0a830; }
        #ai-solver-status.done    { color: #4caf50; }
        #ai-solver-status.error   { color: #f44336; }
        #ai-solver-status.cached  { color: #5ba3f5; }
        #ai-solver-answer {
            background: #111; border: 1px solid #333; border-radius: 6px;
            padding: 10px; min-height: 60px; max-height: 300px; overflow-y: auto;
            line-height: 1.5; white-space: pre-wrap; word-break: break-word;
            font-size: 13px; user-select: text;
        }
        #ai-solver-apply-row { margin-top: 8px; text-align: right; }
        #ai-solver-apply-btn {
            background: #1a6b3a; border: 1px solid #2d8a50; color: #fff;
            padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;
        }
        #ai-solver-apply-btn:hover { background: #207a42; }
        .ai-label { margin-bottom: 4px; font-size: 12px; color: #aaa; }
        #ai-solver-token-input, #ai-solver-context-input {
            width: 100%; box-sizing: border-box; padding: 5px;
            border: 1px solid #555; background: #1a1a1a; color: #fff;
            border-radius: 4px; font-size: 12px;
        }
        #ai-solver-context-input { resize: vertical; }
        .ai-btn-green {
            margin-top: 8px; width: 100%; padding: 6px;
            background: #2d7a2d; color: #fff; border: none;
            border-radius: 4px; cursor: pointer; font-size: 13px;
        }
        .ai-btn-blue {
            width: 100%; padding: 6px;
            background: #1a3a6b; color: #fff; border: none;
            border-radius: 4px; cursor: pointer; font-size: 13px;
        }
        #ai-solver-websearch-btn {
            width: 100%; padding: 5px;
            background: #1a2a3a; color: #7cb8ff; border: 1px solid #2a4a6a;
            border-radius: 4px; cursor: pointer; font-size: 12px;
        }
        #ai-solver-websearch-btn:hover { background: #1e3a5a; }
        #ai-solver-websearch-btn:disabled { opacity: 0.4; cursor: default; }
        #ai-solver-copy-log-btn {
            width: 100%; padding: 5px;
            background: #1a3a1a; color: #81c784; border: 1px solid #2d6a2d;
            border-radius: 4px; cursor: pointer; font-size: 12px;
        }
        #ai-solver-copy-log-btn:hover { background: #1e4a1e; }
        #ai-solver-copy-log-btn.copied { background: #0d2a0d; color: #4caf50; }
        #ai-solver-autopilot-btn {
            padding: 5px 10px; flex-shrink: 0;
            background: #1a3a1a; color: #81c784; border: 1px solid #2d6a2d;
            border-radius: 4px; cursor: pointer; font-size: 12px;
        }
        #ai-solver-autopilot-btn:hover { background: #1e4a1e; }
        #ai-solver-autopilot-runs {
            width: 44px; padding: 4px; border: 1px solid #555;
            background: #1a1a1a; color: #fff; border-radius: 4px;
            font-size: 12px; text-align: center;
        }
        .ai-highlight-correct {
            background-color: #1a4a1a !important;
            border-color: #2d8a50 !important;
            transition: background-color 0.3s;
        }
        .ai-toggle-row {
            display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
        }
        .ai-radio-btn {
            display: flex; align-items: center; gap: 4px;
            font-size: 12px; color: #ccc; cursor: pointer;
            background: #2a2a2a; border: 1px solid #555; border-radius: 4px;
            padding: 3px 8px;
        }
        .ai-radio-btn input { cursor: pointer; margin: 0; }
        .ai-radio-btn:has(input:checked) { border-color: #5ba3f5; color: #5ba3f5; }
        .ai-discipline-group {
            display: flex; flex-direction: column; gap: 4px; margin-top: 2px;
        }
        .ai-discipline-group label {
            display: flex; align-items: center; gap: 6px;
            font-size: 11px; color: #ccc; cursor: pointer;
        }
        .ai-discipline-group label:has(input:checked) { color: #5ba3f5; }
        .ai-discipline-group input[type=radio] { cursor: pointer; margin: 0; }
        .ai-switch-wrap {
            display: flex; align-items: center; gap: 8px; cursor: pointer;
        }
        .ai-switch-wrap input { display: none; }
        .ai-switch {
            position: relative; display: inline-block;
            width: 32px; height: 18px; flex-shrink: 0;
            background: #444; border-radius: 9px;
            transition: background 0.2s;
        }
        .ai-switch::before {
            content: ''; position: absolute;
            width: 14px; height: 14px; border-radius: 50%;
            background: #aaa; top: 2px; left: 2px;
            transition: transform 0.2s, background 0.2s;
        }
        .ai-switch-wrap input:checked + .ai-switch { background: #1a6b3a; }
        .ai-switch-wrap input:checked + .ai-switch::before { transform: translateX(14px); background: #fff; }
        .ai-switch-label { font-size: 11px; color: #ccc; }
    `;

    document.head.appendChild(style);
    document.body.appendChild(panel);

    // ─── Снап к левому краю #player ───────────────────────────────────────────
    function snapToPlayer() {
        const player = document.getElementById('player');
        if (!player) return false;
        const rect   = player.getBoundingClientRect();
        const gap    = 10;
        const panelW = panel.offsetWidth || 340;
        const x      = Math.max(8, rect.left - panelW - gap);
        const y      = Math.max(60, Math.min(rect.top, window.innerHeight - 120));
        panel.style.right = 'auto';
        panel.style.left  = x + 'px';
        panel.style.top   = y + 'px';
        return true;
    }

    if (panelX !== null && panelY !== null) {
        // Пользователь сам двигал — восстановить сохранённую позицию
        panel.style.right = 'auto';
        panel.style.left  = panelX + 'px';
        panel.style.top   = panelY + 'px';
    } else {
        // По умолчанию — снап слева от теста
        if (!snapToPlayer()) {
            // #player ещё не в DOM — ждём его появления
            panel.style.left = '8px';
            panel.style.top  = '80px';
            const obs = new MutationObserver(() => {
                if (snapToPlayer()) obs.disconnect();
            });
            obs.observe(document.body, { childList: true, subtree: true });
        }
    }

    const bodyEl = document.getElementById('ai-solver-body');
    if (!panelVisible) bodyEl.style.display = 'none';

    // ─── Инициализация UI-элементов ───────────────────────────────────────────
    const modelRadio = document.querySelector(`input[name="ai-solver-model"][value="${userModel}"]`);
    if (modelRadio) modelRadio.checked = true;
    else document.getElementById('ai-model-sonnet').checked = true;

    const discRadio = document.querySelector(`input[name="ai-solver-discipline"][value="${userDiscipline}"]`);
    if (discRadio) discRadio.checked = true;
    else document.querySelector('input[name="ai-solver-discipline"][value="it"]').checked = true;

    document.getElementById('ai-solver-reasoning-toggle').checked = !!userReasoning;

    document.querySelectorAll('input[name="ai-solver-model"]').forEach(el => {
        el.addEventListener('change', () => {
            userModel = el.value;
            chrome.storage.local.set({ mti_model: userModel });
        });
    });
    document.querySelectorAll('input[name="ai-solver-discipline"]').forEach(el => {
        el.addEventListener('change', () => {
            userDiscipline = el.value;
            chrome.storage.local.set({ mti_discipline: userDiscipline });
        });
    });
    document.getElementById('ai-solver-reasoning-toggle').addEventListener('change', function () {
        userReasoning = this.checked;
        chrome.storage.local.set({ mti_reasoning: userReasoning });
    });

    // ═══════════════════════════════════════════
    //  DRAG
    // ═══════════════════════════════════════════
    let dragging = false, dragOffX = 0, dragOffY = 0;
    document.getElementById('ai-solver-header').addEventListener('mousedown', e => {
        dragging = true;
        const r  = panel.getBoundingClientRect();
        dragOffX = e.clientX - r.left;
        dragOffY = e.clientY - r.top;
        e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        panel.style.right = 'auto';
        panel.style.left  = (e.clientX - dragOffX) + 'px';
        panel.style.top   = (e.clientY - dragOffY) + 'px';
    });
    document.addEventListener('mouseup', () => {
        if (dragging) {
            dragging = false;
            chrome.storage.local.set({
                mti_panel_x: parseInt(panel.style.left),
                mti_panel_y: parseInt(panel.style.top),
            });
        }
    });

    // ═══════════════════════════════════════════
    //  КНОПКИ
    // ═══════════════════════════════════════════
    document.getElementById('ai-solver-snap-btn').addEventListener('click', () => {
        snapToPlayer();
        chrome.storage.local.remove(['mti_panel_x', 'mti_panel_y']);
        panelX = null; panelY = null;
    });

    document.getElementById('ai-solver-toggle').addEventListener('click', () => {
        const hidden = bodyEl.style.display === 'none';
        bodyEl.style.display = hidden ? 'block' : 'none';
        document.getElementById('ai-solver-toggle').textContent = hidden ? '−' : '+';
        chrome.storage.local.set({ mti_panel_visible: hidden });
    });

    document.getElementById('ai-solver-settings-btn').addEventListener('click', () => {
        const s = document.getElementById('ai-solver-settings');
        s.style.display = s.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('ai-solver-save-btn').addEventListener('click', () => {
        userToken   = document.getElementById('ai-solver-token-input').value.trim();
        userContext = document.getElementById('ai-solver-context-input').value.trim();
        chrome.storage.local.set({ mti_token: userToken, mti_context: userContext });
        document.getElementById('ai-solver-settings').style.display = 'none';
        setStatus('Сохранено ✓', 'done');
        fetchBalance();
    });

    document.getElementById('ai-solver-check-balance-btn').addEventListener('click', fetchMe);
    document.getElementById('ai-solver-rerun').addEventListener('click', () => processQuestion(false));
    document.getElementById('ai-solver-apply-btn').addEventListener('click', applyAnswer);
    document.getElementById('ai-solver-websearch-btn').addEventListener('click', () => processQuestion(true));
    document.getElementById('ai-solver-copy-log-btn').addEventListener('click', copyLogsToClipboard);

    document.getElementById('ai-solver-autopilot-btn').addEventListener('click', () => {
        if (autopilotActive) {
            stopAutopilot('🤖 Автопилот остановлен');
            return;
        }
        const runsInput = document.getElementById('ai-solver-autopilot-runs');
        const runs = Math.max(1, parseInt(runsInput.value) || 5);
        autopilotTotalRuns = runs;
        autopilotRunsLeft  = runs;
        autopilotActive    = true;
        saveAutopilotState();
        updateAutopilotUI();
        watchForStartModal();

        const startBtn = document.getElementById('startPlayerBtn');
        if (startBtn) {
            setStatus('🤖 Запуск автопилота...', 'loading');
            setTimeout(() => { startBtn.click(); resetAutopilotWatchdog(); }, 500);
        } else if (document.querySelector('.test-question-text-2')) {
            setStatus('🤖 Автопилот активен', 'loading');
            resetAutopilotWatchdog();
        } else {
            setStatus('🤖 Ожидание теста...', 'loading');
            resetAutopilotWatchdog();
        }
    });

    // ═══════════════════════════════════════════
    //  БАЛАНС / ME
    // ═══════════════════════════════════════════
    async function fetchBalance() {
        if (!userToken) return;
        const data = await workerGet(`/balance?token=${encodeURIComponent(userToken)}`);
        if (data.credits !== undefined) updateCreditsDisplay(data.credits, data.low_credits);
    }

    async function fetchMe() {
        if (!userToken) return;
        const data = await workerGet(`/me?token=${encodeURIComponent(userToken)}`);
        if (!data.credits && data.credits !== 0) return;
        updateCreditsDisplay(data.credits, data.low_credits);
        const meEl = document.getElementById('ai-solver-me');
        let html = `<div>Всего использовано: <b>${data.total_used}</b></div>`;
        if (data.last_7_days?.length) {
            html += '<div style="margin-top:4px;color:#555;">За 7 дней:</div>';
            data.last_7_days.forEach(d => {
                html += `<div style="padding-left:8px;">${d.day}: ${d.count} реш.</div>`;
            });
        }
        if (data.expires_at) {
            html += `<div style="margin-top:4px;color:#888;">Истекает: ${data.expires_at.split('T')[0]}</div>`;
        }
        meEl.innerHTML = html;
        meEl.style.display = 'block';
    }

    function updateCreditsDisplay(n, isLow) {
        const el = document.getElementById('ai-solver-credits');
        el.textContent = `${n} реш.`;
        el.className = n <= 3 ? 'critical' : '';
        const banner = document.getElementById('ai-solver-low-credits');
        banner.style.display = (isLow || n <= 3) ? 'block' : 'none';
    }

    // ═══════════════════════════════════════════
    //  ВСПОМОГАТЕЛЬНЫЕ
    // ═══════════════════════════════════════════
    function setStatus(text, cls = '') {
        const el = document.getElementById('ai-solver-status');
        el.textContent = text;
        el.className = cls;
    }

    function setAnswer(html) {
        document.getElementById('ai-solver-answer').innerHTML = html;
    }

    function showApplyBtn(show) {
        document.getElementById('ai-solver-apply-row').style.display = show ? 'block' : 'none';
    }

    function escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function extractFirstJSON(str) {
        const start = str.indexOf('{');
        if (start === -1) return null;
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < str.length; i++) {
            const c = str[i];
            if (esc)              { esc = false; continue; }
            if (c === '\\' && inStr) { esc = true;  continue; }
            if (c === '"')        { inStr = !inStr; continue; }
            if (inStr)            continue;
            if (c === '{')        depth++;
            if (c === '}') { depth--; if (depth === 0) return str.slice(start, i + 1); }
        }
        return null;
    }

    // ═══════════════════════════════════════════
    //  HTTP HELPERS
    //  workerGet/workerPost → service worker → fetch
    //  fetchImageAsBase64   → прямой fetch (same-origin, cookies включены)
    // ═══════════════════════════════════════════
    async function workerGet(path) {
        try {
            const resp = await chrome.runtime.sendMessage({
                action: 'fetch', method: 'GET', url: WORKER_URL + path,
            });
            if (resp && resp.text) return JSON.parse(resp.text);
        } catch {}
        return {};
    }

    async function workerPost(path, data) {
        try {
            const resp = await chrome.runtime.sendMessage({
                action:  'fetch',
                method:  'POST',
                url:     WORKER_URL + path,
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(data),
            });
            return { status: resp.status, data: JSON.parse(resp.text) };
        } catch (e) {
            return { status: 0, data: { error: 'network error' } };
        }
    }

    async function fetchImageAsBase64(url) {
        // Content script работает в контексте страницы — fetch same-origin с куками
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) throw new Error(`img ${resp.status}`);
        const buffer = await resp.arrayBuffer();
        const bytes  = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const base64    = btoa(binary);
        const ct        = resp.headers.get('content-type');
        const mediaType = ct || (url.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg');
        return { media_type: mediaType, data: base64 };
    }

    // ═══════════════════════════════════════════
    //  ОПРЕДЕЛЕНИЕ ТИПА ВОПРОСА
    // ═══════════════════════════════════════════
    function detectType() {
        const player = document.getElementById('player');
        if (!player) return 'unknown';
        if (player.querySelector('#sortable2'))                        return 'sorting';
        if (player.querySelector('#multipleMatchBottom'))              return 'matching_multi';
        if (player.querySelector('.docLeft.ui-sortable'))             return 'matching';
        if (player.querySelector('input[type=radio][name=answers]'))  return 'radio';
        if (player.querySelector('input[type=checkbox]'))             return 'checkbox';
        if (player.querySelector('textarea[name=answers]'))           return 'text';
        return 'unknown';
    }

    // ═══════════════════════════════════════════
    //  ИЗВЛЕЧЕНИЕ ДАННЫХ
    // ═══════════════════════════════════════════
    function extractData() {
        const player = document.getElementById('player');
        if (!player) return null;

        const questionEl = player.querySelector('.test-question-text-2');
        if (!questionEl) return null;

        const question = questionEl.innerText.trim();
        const type     = detectType();
        const data     = { question, type, options: [] };

        const disciplineEl = document.querySelector('h1.player-discipline');
        data.isCompetency  = !!(disciplineEl &&
            disciplineEl.textContent.toLowerCase().includes('компетентностн'));

        data.imageUrls = [];
        questionEl.querySelectorAll('img').forEach(img => {
            if (img.src) data.imageUrls.push(img.src);
        });

        switch (type) {
            case 'radio':
            case 'checkbox': {
                player.querySelectorAll('.test-answers').forEach(el => {
                    const input = el.querySelector('input');
                    const label = el.querySelector('label');
                    if (input && label) {
                        data.options.push({ id: input.value, inputId: input.id, text: label.textContent.trim() });
                    }
                });
                break;
            }
            case 'matching_multi': {
                data.leftItems  = [];
                data.rightItems = [];
                const mmLeft = player.querySelector('div[style*="float: left"][style*="45%"]');
                if (mmLeft) {
                    mmLeft.querySelectorAll('.test-answers').forEach(ta => {
                        const divs = ta.querySelectorAll(':scope > div');
                        if (divs.length >= 2) {
                            const letter = divs[0].textContent.replace(/\./g, '').trim();
                            const text   = divs[1].textContent.trim();
                            if (letter) data.leftItems.push({ letter, text });
                        }
                    });
                }
                const mmRight = player.querySelector('div[style*="float: right"][style*="45%"]');
                if (mmRight) {
                    mmRight.querySelectorAll('.test-answers').forEach(ta => {
                        const divs = ta.querySelectorAll(':scope > div');
                        if (divs.length >= 2) {
                            const letter = divs[0].textContent.replace(/\./g, '').trim();
                            const text   = divs[1].textContent.trim();
                            if (letter) data.rightItems.push({ letter, text });
                        }
                    });
                }
                break;
            }
            case 'matching': {
                data.leftItems  = [];
                data.rightItems = [];
                player.querySelectorAll('div[style*="float: left"] li, div[style*="float:left"] li').forEach(li => {
                    const letter = li.querySelector('p')?.textContent.replace(/\./g, '').trim();
                    const text   = li.querySelector('.test-answers')?.textContent.trim();
                    if (letter && text) data.leftItems.push({ letter, text });
                });
                player.querySelectorAll('div[style*="float: right"] li, div[style*="float:right"] li').forEach(li => {
                    const letter = li.querySelector('p')?.textContent.replace(/\./g, '').trim();
                    const text   = li.querySelector('.test-answers')?.textContent.trim();
                    if (letter && text) data.rightItems.push({ letter, text });
                });
                data.leftDragIds  = {};
                data.rightDragIds = {};
                player.querySelectorAll('.docLeft .dragItem').forEach(el => {
                    data.leftDragIds[el.textContent.trim()] = el.id;
                });
                player.querySelectorAll('.docBottom .dragItem').forEach(el => {
                    data.rightDragIds[el.textContent.trim()] = el.id;
                });
                break;
            }
            case 'sorting': {
                player.querySelectorAll('#sortable2 .test-answers').forEach(el => {
                    const counterEl = el.querySelector('.order-counter');
                    const textEl    = el.querySelector('div[style*="inline-block"][style*="95%"]');
                    const input     = el.querySelector('input[type=hidden]');
                    if (textEl) {
                        data.options.push({
                            order: parseInt(counterEl?.textContent) || data.options.length + 1,
                            text:  textEl.textContent.trim(),
                            id:    input?.value,
                        });
                    }
                });
                break;
            }
        }

        return data;
    }

    // ═══════════════════════════════════════════
    //  ПРОМПТ
    // ═══════════════════════════════════════════
    const DISCIPLINE_ROLES = {
        it:      'Ты эксперт в области информационных технологий, программирования, сетей и Computer Science.',
        law:     'Ты эксперт в области юриспруденции, правоведения и нормативно-правового регулирования.',
        econ:    'Ты эксперт в области экономики, менеджмента, управления персоналом и бизнес-процессов.',
        psy:     'Ты эксперт в области психологии, педагогики и социальных наук.',
        science: 'Ты эксперт в области точных и естественных наук — математики, физики, химии, биологии.',
    };

    function buildCompetencyPrompt(data) {
        let p = 'Ты решаешь компетентностный тест. Дана рабочая ситуация (кейс) с конкретными данными, цифрами и фактами.\n\n';
        p += 'СТРАТЕГИЯ:\n';
        p += '1. Внимательно прочитай весь текст кейса — ответ содержится в условии\n';
        p += '2. Найди конкретные данные: цифры, даты, имена, должности, показатели\n';
        p += '3. Проведи необходимые расчёты на основе данных из условия\n';
        p += '4. Проверь каждый вариант на соответствие данным из кейса\n';
        p += '5. НЕ используй внешние знания — только то, что написано в условии\n';
        p += '6. Остерегайся правдоподобных ловушек: вариант может звучать верно в общем, но противоречить данным кейса\n\n';
        p += `Вопрос/кейс:\n${data.question}\n\n`;

        switch (data.type) {
            case 'text':
                p += 'Тип: свободный текст.\nДай ответ в 1-2 слова (максимум 3). Только пропущенное слово/фразу.\n';
                if (userReasoning) p += 'Включи поле "reasoning" с кратким обоснованием на основе данных кейса.\n';
                p += userReasoning
                    ? 'Верни ТОЛЬКО JSON:\n{"type":"text","answer":"ответ","reasoning":"обоснование"}\n'
                    : 'Верни ТОЛЬКО JSON:\n{"type":"text","answer":"ответ"}\n';
                break;

            case 'radio':
                p += 'Тип: одиночный выбор.\nВарианты:\n';
                data.options.forEach((o, i) => p += `${i + 1}. ${o.text}\n`);
                if (userReasoning) {
                    p += '\nДля КАЖДОГО варианта напиши краткое обоснование (1 предложение) со ссылкой на данные кейса.\n';
                }
                p += 'Верни ТОЛЬКО JSON:\n{"type":"radio","reasoning":{"1":"верно/неверно - причина из кейса","2":"..."},"index":2}\n';
                break;

            case 'checkbox': {
                p += 'Тип: множественный выбор.\nВарианты:\n';
                data.options.forEach((o, i) => p += `${i + 1}. ${o.text}\n`);
                const cbHintComp = data.question.match(/укажите\s+(\d+)\s+вариант/i);
                if (cbHintComp) {
                    p += `\nВНИМАНИЕ: в вопросе указано РОВНО ${cbHintComp[1]} правильных вариантов. Выбери именно ${cbHintComp[1]}.\n`;
                }
                if (userReasoning) {
                    p += '\nДля КАЖДОГО варианта напиши обоснование со ссылкой на конкретные данные из кейса.\n';
                }
                p += 'Верни ТОЛЬКО JSON:\n{"type":"checkbox","reasoning":{"1":"да - соответствует данным кейса","2":"нет - противоречит условию"},"indices":[1,3]}\n';
                break;
            }

            case 'matching_multi':
                p += 'Тип: группировка (каждому левому элементу соответствует НЕСКОЛЬКО правых, без повторений).\nЛевые элементы (группы):\n';
                data.leftItems.forEach(i => p += `${i.letter}. ${i.text}\n`);
                p += '\nПравые элементы (распредели ВСЕ по группам):\n';
                data.rightItems.forEach(i => p += `${i.letter}. ${i.text}\n`);
                if (userReasoning) p += '\nВключи поле "reasoning" с обоснованием группировки на основе кейса.\n';
                p += userReasoning
                    ? 'Верни ТОЛЬКО JSON:\n{"type":"matching_multi","groups":{"A":["C","D"],"B":["E","F"]},"reasoning":"обоснование"}\n'
                    : 'Верни ТОЛЬКО JSON:\n{"type":"matching_multi","groups":{"A":["C","D"],"B":["E","F"]}}\n';
                break;

            case 'matching':
                p += 'Тип: сопоставление.\n';
                if (data.leftItems.length) {
                    p += 'Левая колонка:\n';
                    data.leftItems.forEach(i => p += `${i.letter}. ${i.text}\n`);
                    p += '\nПравая колонка:\n';
                    data.rightItems.forEach(i => p += `${i.letter}. ${i.text}\n`);
                } else {
                    const leftLetters  = Object.keys(data.leftDragIds  || {});
                    const rightLetters = Object.keys(data.rightDragIds || {});
                    p += `Метки левой колонки: ${leftLetters.join(', ')}\n`;
                    p += `Варианты правой колонки: ${rightLetters.join(', ')}\n`;
                    p += 'Описания меток и вариантов содержатся в тексте вопроса выше.\n';
                }
                if (userReasoning) p += '\nВключи поле "reasoning" с обоснованием каждой пары на основе кейса.\n';
                p += userReasoning
                    ? 'Верни ТОЛЬКО JSON:\n{"type":"matching","pairs":[["A","E"],["B","F"]],"reasoning":"обоснование"}\n'
                    : 'Верни ТОЛЬКО JSON:\n{"type":"matching","pairs":[["A","E"],["B","F"]]}\n';
                break;

            case 'sorting':
                p += 'Тип: расположить в правильном порядке.\nЭлементы:\n';
                data.options.forEach(o => p += `${o.order}. ${o.text}\n`);
                if (userReasoning) p += '\nВключи поле "reasoning" с обоснованием порядка на основе кейса.\n';
                p += userReasoning
                    ? 'Верни ТОЛЬКО JSON:\n{"type":"sorting","order":[2,1,3],"reasoning":"обоснование"}\n'
                    : 'Верни ТОЛЬКО JSON:\n{"type":"sorting","order":[2,1,3]}\n';
                break;
        }

        p += '\nВАЖНО: верни ТОЛЬКО JSON, никакого другого текста.';
        return p;
    }

    function buildPrompt(data) {
        if (data.isCompetency) return buildCompetencyPrompt(data);

        const role = DISCIPLINE_ROLES[userDiscipline] || DISCIPLINE_ROLES.it;
        const ctx  = userContext
            ? `Контекст/темы: ${userContext}\n`
            : 'Российский вуз, дистанционное обучение (МТИ/Синергия)\n';

        let p = role + '\n\n' + ctx +
            '\nСТРАТЕГИЯ:\n' +
            '1. Используй web_search для поиска точного ответа\n' +
            '2. Ищи академические источники на русском языке\n' +
            '3. Выбирай ТОЛЬКО варианты, подтверждённые источниками\n' +
            '4. Остерегайся правдоподобных ловушек\n' +
            '5. При множественном выборе: не выбирай если не уверен на 80%+\n\n' +
            `Вопрос: ${data.question}\n\n`;

        switch (data.type) {
            case 'text':
                p += 'Тип: свободный текст.\nДай ответ в 1-2 слова (максимум 3). Только пропущенное слово/фразу.\n';
                p += 'Примеры: "субъекта", "общение", "истощение", "Формальная"\n';
                p += 'Если вопрос содержит "…" (пропуск) — вставь слово в правильном падеже/форме, чтобы предложение читалось грамматически верно.\n';
                if (userReasoning) p += 'Включи поле "reasoning" с кратким обоснованием ответа.\n';
                p += userReasoning
                    ? 'Верни ТОЛЬКО JSON:\n{"type":"text","answer":"ответ","reasoning":"обоснование"}\n'
                    : 'Верни ТОЛЬКО JSON:\n{"type":"text","answer":"ответ"}\n';
                break;

            case 'radio':
                p += 'Тип: одиночный выбор.\nВарианты:\n';
                data.options.forEach((o, i) => p += `${i + 1}. ${o.text}\n`);
                p += '\nВАЖНО для ситуационных вопросов:\n';
                p += '- Отбрось варианты с избеганием проблемы (уход, перекладывание ответственности)\n';
                p += '- Отбрось варианты с крайностями (увольнение, игнорирование, конфронтация)\n';
                p += '- Правильный ответ обычно: конструктивный диалог, обучение, системное решение\n';
                if (userReasoning) {
                    p += '\nДля КАЖДОГО варианта напиши краткое обоснование (1 предложение) почему он верный или неверный.\n';
                }
                p += 'Верни ТОЛЬКО JSON:\n{"type":"radio","reasoning":{"1":"верно/неверно - причина","2":"..."},"index":2}\n';
                break;

            case 'checkbox': {
                p += 'Тип: множественный выбор.\nВарианты:\n';
                data.options.forEach((o, i) => p += `${i + 1}. ${o.text}\n`);
                const cbHint = data.question.match(/укажите\s+(\d+)\s+вариант/i);
                if (cbHint) {
                    p += `\nВНИМАНИЕ: в вопросе указано РОВНО ${cbHint[1]} правильных вариантов. Выбери именно ${cbHint[1]}.\n`;
                }
                p += '\nСТРАТЕГИЯ ДЛЯ МНОЖЕСТВЕННОГО ВЫБОРА:\n';
                p += '1. Сначала определи тему и найди ПЕРВОИСТОЧНИК (учебник, классификацию)\n';
                p += '2. Типичное количество правильных ответов: 2-4 из 5-6 вариантов\n';
                p += '3. Ищи ЗАКРЫТЫЙ СПИСОК — если в источнике перечислено ровно N элементов, выбери именно их\n';
                p += '4. Ловушки: вариант звучит правильно по смыслу, но НЕ входит в конкретную классификацию автора\n';
                p += '5. Если вопрос "К ... относят" — это перечисление из учебника, ищи точный список\n';
                p += '6. НЕ добавляй вариант только потому что он "тоже верный в жизни" — нужно совпадение с источником\n';
                if (userReasoning) {
                    p += '\nДля КАЖДОГО варианта напиши обоснование (1 предложение): входит в список или нет и почему.\n';
                }
                p += 'Верни ТОЛЬКО JSON:\n{"type":"checkbox","reasoning":{"1":"да - входит в классификацию X","2":"нет - не упоминается в источнике"},"indices":[1,3]}\n';
                break;
            }

            case 'matching_multi':
                p += 'Тип: группировка (каждому левому элементу соответствует НЕСКОЛЬКО правых, без повторений).\nЛевые элементы (группы):\n';
                data.leftItems.forEach(i => p += `${i.letter}. ${i.text}\n`);
                p += '\nПравые элементы (распредели ВСЕ по группам):\n';
                data.rightItems.forEach(i => p += `${i.letter}. ${i.text}\n`);
                if (userReasoning) p += '\nВключи поле "reasoning" с кратким обоснованием группировки.\n';
                p += userReasoning
                    ? 'Верни ТОЛЬКО JSON:\n{"type":"matching_multi","groups":{"A":["C","D"],"B":["E","F"]},"reasoning":"обоснование"}\n'
                    : 'Верни ТОЛЬКО JSON:\n{"type":"matching_multi","groups":{"A":["C","D"],"B":["E","F"]}}\n';
                break;

            case 'matching':
                p += 'Тип: сопоставление.\n';
                if (data.leftItems.length) {
                    p += 'Левая колонка:\n';
                    data.leftItems.forEach(i => p += `${i.letter}. ${i.text}\n`);
                    p += '\nПравая колонка:\n';
                    data.rightItems.forEach(i => p += `${i.letter}. ${i.text}\n`);
                } else {
                    const leftLetters  = Object.keys(data.leftDragIds  || {});
                    const rightLetters = Object.keys(data.rightDragIds || {});
                    p += `Метки левой колонки: ${leftLetters.join(', ')}\n`;
                    p += `Варианты правой колонки: ${rightLetters.join(', ')}\n`;
                    p += 'Описания меток и вариантов содержатся в тексте вопроса выше.\n';
                }
                if (userReasoning) p += '\nВключи поле "reasoning" с кратким обоснованием каждой пары.\n';
                p += userReasoning
                    ? 'Верни ТОЛЬКО JSON:\n{"type":"matching","pairs":[["A","E"],["B","F"]],"reasoning":"обоснование"}\n'
                    : 'Верни ТОЛЬКО JSON:\n{"type":"matching","pairs":[["A","E"],["B","F"]]}\n';
                break;

            case 'sorting':
                p += 'Тип: расположить в правильном порядке.\nЭлементы:\n';
                data.options.forEach(o => p += `${o.order}. ${o.text}\n`);
                if (userReasoning) p += '\nВключи поле "reasoning" с обоснованием порядка.\n';
                p += userReasoning
                    ? 'Верни ТОЛЬКО JSON:\n{"type":"sorting","order":[2,1,3],"reasoning":"обоснование"}\n'
                    : 'Верни ТОЛЬКО JSON:\n{"type":"sorting","order":[2,1,3]}\n';
                break;
        }

        p += '\nВАЖНО: верни ТОЛЬКО JSON, никакого другого текста.';
        return p;
    }

    // ═══════════════════════════════════════════
    //  ПЕРЕMAППИНГ КЭШИРОВАННОГО ОТВЕТА
    // ═══════════════════════════════════════════

    // Нормализация текста для сравнения вариантов
    function normalizeOpt(s) {
        return String(s).toLowerCase().trim()
            .replace(/\s+/g, ' ')
            .replace(/[«»""'']/g, '"')
            .replace(/\.$/, '');
    }

    // Поиск варианта по тексту в массиве options (возвращает индекс или -1)
    function findOptIdx(text, opts) {
        const norm = normalizeOpt(text);
        let i = opts.findIndex(o => normalizeOpt(o.text) === norm);
        if (i !== -1) return i;
        // Fallback: один содержит другой
        i = opts.findIndex(o => normalizeOpt(o.text).includes(norm) || norm.includes(normalizeOpt(o.text)));
        return i;
    }

    // Маппит тексты из answer_data → текущие индексы страницы
    // Возвращает null если маппинг не удался (fallback к raw ответу)
    function remapCachedAnswer(answer_data, storedOptions, currentOptions) {
        if (!answer_data || !currentOptions || currentOptions.length === 0) return null;
        try {
            const parsed = typeof answer_data === 'string' ? JSON.parse(answer_data) : answer_data;
            if (!parsed) return null;

            switch (parsed.type) {
                case 'radio': {
                    if (!parsed.selected_text) return null;
                    const i = findOptIdx(parsed.selected_text, currentOptions);
                    if (i === -1) return null;
                    return { ...parsed, index: i + 1 };
                }
                case 'checkbox': {
                    if (!parsed.selected_texts?.length) return null;
                    const indices = [];
                    for (const t of parsed.selected_texts) {
                        const i = findOptIdx(t, currentOptions);
                        if (i === -1) return null; // не найден — fallback к raw
                        indices.push(i + 1);
                    }
                    return { ...parsed, indices };
                }
                case 'sorting': {
                    if (!parsed.ordered_texts?.length) return null;
                    const order = [];
                    for (const t of parsed.ordered_texts) {
                        const i = findOptIdx(t, currentOptions);
                        if (i === -1) return null;
                        order.push(currentOptions[i].order);
                    }
                    return { ...parsed, order };
                }
                default:
                    return null; // matching/matching_multi не требуют ремаппинга
            }
        } catch {
            return null;
        }
    }

    // Определяет ожидаемое количество вариантов из текста вопроса (для checkbox)
    function detectExpectedCount(questionText) {
        const wordMap = { 'два': 2, 'две': 2, 'три': 3, 'четыре': 4, 'пять': 5, 'шесть': 6 };
        const m = questionText.match(/(?:укажите|выберите|выбери|отметьте)\s+(\d+|два|две|три|четыре|пять|шесть)\s+вариант/i);
        if (!m) return null;
        const val = m[1];
        return /^\d+$/.test(val) ? parseInt(val) : (wordMap[val.toLowerCase()] || null);
    }

    // ═══════════════════════════════════════════
    //  ВЫЗОВ WORKER
    // ═══════════════════════════════════════════
    async function callWorker(data, useWebSearch = false, images = []) {
        if (!userToken) throw new Error('Токен не задан');

        const subject = detectDisciplineFromBreadcrumbs() || null;

        // Определяем ожидаемое количество вариантов для checkbox
        const expected_count = data.type === 'checkbox' ? detectExpectedCount(data.question) : null;

        const payload = {
            token:         userToken,
            prompt:        buildPrompt(data),
            question_type: data.type,
            question_text: data.question,
            subject,
            use_web_search: useWebSearch,
            model:          userModel,
            images,
            options_texts:  (data.options    || []).map(o => o.text),
            left_texts:     (data.leftItems  || []).map(o => o.text),
            right_texts:    (data.rightItems || []).map(o => o.text),
            image_count:    images.length,
            expected_count,
        };

        const { status, data: result } = await workerPost('/solve', payload);

        if (status === 401) throw new Error('Недействительный токен');
        if (status === 402) throw new Error('Кредиты закончились. Обратитесь к продавцу.');
        if (status === 429) {
            const retryMs = result.retry_after_ms || 3000;
            setStatus(`⏳ Подождите ${Math.ceil(retryMs / 1000)}с...`, 'loading');
            await new Promise(r => setTimeout(r, retryMs));
            return callWorker(data, useWebSearch, images);
        }
        if (result.error) throw new Error(result.error);

        if (result.credits !== undefined) {
            updateCreditsDisplay(result.credits, result.credits <= 3);
        }

        lastLogId = result.log_id;
        if (result.cache_hash && data.question) {
            const prefix = data.question.toLowerCase().trim()
                .replace(/\s+/g, ' ').substring(0, 80);
            testQuestionMap.set(prefix, { hash: result.cache_hash, logId: result.log_id });
            saveQuestionMap();
        }

        const jsonStr = extractFirstJSON(result.answer || '');
        if (!jsonStr) return { parsed: null, cached: false };
        let parsed = JSON.parse(jsonStr);

        // Пробуем переmаппить кэшированный ответ (тексты → текущие индексы страницы)
        if (result.cached && result.answer_data && data.options?.length) {
            const remapped = remapCachedAnswer(result.answer_data, result.stored_options, data.options);
            if (remapped) {
                console.log('[MTI] remapCachedAnswer: успешно', remapped);
                parsed = remapped;
            }
        }

        return { parsed, cached: !!result.cached };
    }

    // ═══════════════════════════════════════════
    //  МОДУЛЬ СБОРА ЛОГОВ
    // ═══════════════════════════════════════════
    const DISCIPLINE_LABELS = {
        it:      'IT / Технические',
        law:     'Право',
        econ:    'Экономика / Менеджмент / HR',
        psy:     'Психология',
        science: 'Математика / Науки',
    };

    const MODEL_LABELS = {
        'claude-sonnet-4-6':         'Sonnet',
        'claude-haiku-4-5-20251001': 'Haiku',
        'gpt-5.4-mini':              'GPT mini',
        'gpt-5.4-nano':              'GPT nano',
    };

    function detectMaxAttempts() {
        const items = document.querySelectorAll('.item');
        for (const item of items) {
            if (item.textContent.includes('Максимально допустимое количество попыток')) {
                const n = parseInt(item.querySelector('.title')?.textContent.trim());
                if (!isNaN(n)) return n;
            }
        }
        return null;
    }

    function detectIsCompetency() {
        const el = document.querySelector('h1.player-discipline');
        return !!(el && el.textContent.toLowerCase().includes('компетентностн'));
    }

    function detectDisciplineFromBreadcrumbs() {
        const crumbs = document.querySelectorAll('#breadcrumbs a');
        for (let i = 0; i < crumbs.length - 1; i++) {
            if (crumbs[i].textContent.trim() === 'Учебный план') {
                return crumbs[i + 1].textContent.trim();
            }
        }
        return '';
    }

    function openAndParseStatPopup() {
        return new Promise(resolve => {
            const links = document.querySelectorAll('a#statistic');
            const link  = links[links.length - 1];
            if (!link) return resolve(null);

            const observer = new MutationObserver(() => {
                const popup = document.querySelector('.newPopup.statistic');
                if (!popup || popup.style.display === 'none') return;
                const tbody = popup.querySelector('table.table-corpus tbody');
                if (!tbody) return;
                observer.disconnect();

                const rows = tbody.querySelectorAll('tr');
                let text   = 'Результат попытки теста\n#\tВопрос\tОтвет\tСтатус\n';
                const structured = [];

                rows.forEach(tr => {
                    const cells = tr.querySelectorAll('td');
                    if (cells.length < 4) return;
                    const num    = cells[0].textContent.trim();
                    const q      = cells[1].textContent.trim().replace(/\s+/g, ' ');
                    const a      = cells[2].innerHTML
                        .replace(/<hr\s*\/?>/gi, '\n')
                        .replace(/<[^>]+>/g, '')
                        .trim()
                        .replace(/\s+/g, ' ');
                    const status = cells[3].textContent.trim();
                    text += `${num}\t${q}\t${a}\t${status}\n`;
                    structured.push({ question: q, isCorrect: status === 'Верно' });
                });

                const closeBtn = popup.querySelector('#popupCloseBtn');
                if (closeBtn) closeBtn.click();

                resolve({ text: text.trim(), structured });
            });
            observer.observe(document.body, {
                childList: true, subtree: true, attributes: true, attributeFilter: ['style'],
            });

            setTimeout(() => { observer.disconnect(); resolve(null); }, 5000);
            link.click();
        });
    }

    function detectDuration() {
        const row = document.querySelector('.table-list tbody tr:last-child');
        if (!row) return '';
        const cells = row.querySelectorAll('td');
        return cells[2]?.textContent.trim() || '';
    }

    async function collectAndShowLog(correct, total) {
        const logRow = document.getElementById('ai-solver-log-row');
        const btn    = document.getElementById('ai-solver-copy-log-btn');

        btn.textContent = '⏳ Загрузка ответов...';
        btn.disabled    = true;
        logRow.style.display = 'block';

        const popupResult    = await openAndParseStatPopup();
        const resultsText    = popupResult?.text || '';
        const structured     = popupResult?.structured || [];
        const maxAttempts    = detectMaxAttempts();
        const isIntermediate = maxAttempts !== null && maxAttempts > 50;
        const isCompetency   = detectIsCompetency();
        const discipline     = DISCIPLINE_LABELS[userDiscipline] || userDiscipline;
        const modelLabel     = MODEL_LABELS[userModel] || userModel;
        const reasoning      = userReasoning ? 'TRUE' : 'FALSE';
        const testDiscipline = detectDisciplineFromBreadcrumbs();
        const duration       = detectDuration();

        lastTestLog = [
            '',                                 // A: аккаунт (manual)
            '',                                 // B: номер теста (manual)
            String(total),                      // C: кол-во вопросов
            discipline,                         // D: дисциплина
            String(correct),                    // E: правильных
            resultsText,                        // F: раздел ответов
            modelLabel,                         // G: модель
            isIntermediate ? 'TRUE' : 'FALSE',  // H: промежуточный
            reasoning,                          // I: обоснование
            testDiscipline,                     // J: название дисциплины теста
            isCompetency ? 'TRUE' : 'FALSE',    // K: компетентностный
            '',                                 // L: комментарий (manual)
            duration,                           // M: длительность
        ];

        // Батч-верификация кэша
        if (userToken && structured.length > 0 && testQuestionMap.size > 0) {
            const batchResults = [];
            for (const row of structured) {
                const prefix  = row.question.toLowerCase().trim()
                    .replace(/\s+/g, ' ').substring(0, 80);
                const tracked = testQuestionMap.get(prefix);
                if (tracked) {
                    batchResults.push({
                        cache_hash: tracked.hash,
                        log_id:     tracked.logId,
                        is_correct: row.isCorrect,
                    });
                }
            }
            if (batchResults.length > 0) {
                workerPost('/results', { token: userToken, results: batchResults });
                clearQuestionMap();
            }
        }

        btn.textContent = '📋 Скопировать логи';
        btn.disabled    = false;

        // Автопилот: запуск следующего прогона
        if (autopilotActive) {
            autopilotRunsLeft = Math.max(0, autopilotRunsLeft - 1);
            saveAutopilotState();
            if (autopilotRunsLeft > 0) {
                const done = autopilotTotalRuns - autopilotRunsLeft;
                updateAutopilotUI();
                setStatus(`🤖 Прогон ${done} завершён — след. через 3с...`, 'loading');
                setTimeout(() => {
                    const startBtn = document.getElementById('startPlayerBtn');
                    if (startBtn) { startBtn.click(); resetAutopilotWatchdog(); }
                    else { location.reload(); }
                }, 3000);
            } else {
                stopAutopilot('🤖 Все прогоны завершены!');
            }
        }
    }

    function copyLogsToClipboard() {
        if (!lastTestLog) return;
        const tsv = lastTestLog.map(cell => {
            if (cell.includes('\t') || cell.includes('\n') || cell.includes('"')) {
                return '"' + cell.replace(/"/g, '""') + '"';
            }
            return cell;
        }).join('\t');

        navigator.clipboard.writeText(tsv).then(() => {
            const btn = document.getElementById('ai-solver-copy-log-btn');
            btn.textContent = '✓ Скопировано!';
            btn.classList.add('copied');
            setTimeout(() => {
                btn.textContent = '📋 Скопировать логи';
                btn.classList.remove('copied');
            }, 2000);
        }).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = tsv;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        });
    }

    // ═══════════════════════════════════════════
    //  ИТОГОВАЯ СТРАНИЦА ТЕСТА
    // ═══════════════════════════════════════════
    function checkResultsPage() {
        const table = document.querySelector('.table-list');
        if (!table) return;

        const testName = document.querySelector('h1')?.textContent.trim() || null;
        let lastCorrect = null, lastTotal = null, gotNew = false;

        for (const tbody of table.querySelectorAll('tbody')) {
            const tds = tbody.querySelectorAll('tr td');
            if (tds.length < 5) continue;

            const startTime   = tds[1]?.textContent.trim() || '';
            const duration    = tds[2]?.textContent.trim() || '';
            const score       = tds[3]?.textContent.trim() || '';
            const correctText = tds[4]?.textContent.trim() || '';

            const match = correctText.match(/(\d+)\s+из\s+(\d+)/);
            if (!match) continue;

            const resultHash = `${testName}:${startTime}:${duration}:${score}:${correctText}`;
            if (sentResultHashes.has(resultHash)) continue;
            sentResultHashes.add(resultHash);

            const correct = parseInt(match[1]);
            const total   = parseInt(match[2]);

            lastCorrect = correct;
            lastTotal   = total;
            gotNew      = true;

            if (userToken) {
                workerPost('/test_result', {
                    token:       userToken,
                    test_name:   testName,
                    correct,
                    total,
                    model:       userModel,
                    start_time:  startTime,
                    duration,
                    score,
                    result_hash: resultHash,
                });
            }
        }

        if (!gotNew) return;

        const correct = lastCorrect, total = lastTotal;
        const pct = Math.round(correct / total * 100);

        setStatus('✓ Тест завершён', 'done');
        setAnswer(
            `<div style="color:#7cb8ff;margin-bottom:8px;font-size:12px;">📊 ИТОГ ТЕСТА</div>` +
            `<div style="font-size:22px;font-weight:bold;color:${pct >= 80 ? '#4caf50' : '#f0a830'};">${correct} / ${total}</div>` +
            `<div style="color:#888;font-size:12px;margin-top:4px;">${pct}% правильных ответов</div>` +
            (pct >= 80
                ? `<div style="color:#4caf50;margin-top:6px;">✓ Тест сдан</div>`
                : `<div style="color:#f0a830;margin-top:6px;">⚠ Результат ниже 80%</div>`)
        );
        showApplyBtn(false);
        collectAndShowLog(correct, total);
    }

    document.addEventListener('submit', e => {
        if (e.target?.id === 'player-assessments-form') {
            lastQuestionText = '';
        }
    }, true);

    let lastKnownRowCount    = 0;
    let checkResultsTimeout  = null;

    function watchTableForNewRows(table) {
        lastKnownRowCount = table.querySelectorAll('tbody tr').length;
        new MutationObserver(() => {
            const rows = table.querySelectorAll('tbody tr');
            if (rows.length > lastKnownRowCount) {
                lastKnownRowCount = rows.length;
                clearTimeout(checkResultsTimeout);
                checkResultsTimeout = setTimeout(checkResultsPage, 800);
            }
        }).observe(table, { childList: true, subtree: true });
    }

    function waitForResults() {
        const table = document.querySelector('.table-list');
        if (table) {
            checkResultsPage();
            watchTableForNewRows(table);
            return;
        }
        const observer = new MutationObserver(() => {
            const t = document.querySelector('.table-list');
            if (t) {
                observer.disconnect();
                checkResultsPage();
                watchTableForNewRows(t);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    waitForResults();

    // ═══════════════════════════════════════════
    //  ПРИМЕНЕНИЕ ОТВЕТА
    // ═══════════════════════════════════════════
    let lastData   = null;
    let lastParsed = null;

    function applyAnswer() {
        if (!lastData || !lastParsed) return;
        const { data, parsed } = { data: lastData, parsed: lastParsed };
        const player = document.getElementById('player');

        switch (data.type) {
            case 'text': {
                const ta = player.querySelector('textarea[name=answers]');
                if (ta && parsed.answer) {
                    ta.value = parsed.answer;
                    ta.dispatchEvent(new Event('input',  { bubbles: true }));
                    ta.dispatchEvent(new Event('change', { bubbles: true }));
                }
                break;
            }
            case 'radio': {
                player.querySelectorAll('.test-answers').forEach(el => el.classList.remove('ai-highlight-correct'));
                const opt = data.options[(parsed.index || 1) - 1];
                if (opt) {
                    const input = document.getElementById(opt.inputId);
                    if (input) {
                        input.click();
                        input.closest('.test-answers').classList.add('ai-highlight-correct');
                    }
                }
                break;
            }
            case 'checkbox': {
                player.querySelectorAll('.test-answers').forEach(el => el.classList.remove('ai-highlight-correct'));
                const indices = new Set((parsed.indices || []).map(i => i - 1));
                data.options.forEach((opt, i) => {
                    if (indices.has(i)) {
                        const input = document.getElementById(opt.inputId);
                        if (input) {
                            if (!input.checked) input.click();
                            input.closest('.test-answers').classList.add('ai-highlight-correct');
                        }
                    }
                });
                break;
            }
            case 'matching':
                autoFillMatching(parsed.pairs || [], data);
                break;
            case 'matching_multi':
                autoFillMatchingMulti(parsed.groups || {}, data);
                break;
        }
    }

    // ═══════════════════════════════════════════
    //  DRAG-AND-DROP СОПОСТАВЛЕНИЕ
    // ═══════════════════════════════════════════
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function fireMouseEvent(el, type, x, y) {
        el.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, view: window,
            clientX: x, clientY: y, screenX: x, screenY: y,
        }));
    }

    async function simulateDragDrop(srcEl, dstEl) {
        srcEl.scrollIntoView({ block: 'center' });
        await sleep(80);
        const s  = srcEl.getBoundingClientRect();
        const d  = dstEl.getBoundingClientRect();
        const x1 = s.left + s.width  / 2, y1 = s.top + s.height / 2;
        const x2 = d.left + d.width  / 2, y2 = d.top + d.height / 2;

        fireMouseEvent(srcEl, 'mousedown', x1, y1);
        await sleep(50);
        fireMouseEvent(document.body, 'mousemove', x1 + 2, y1 + 2);
        await sleep(30);
        for (let i = 1; i <= 10; i++) {
            fireMouseEvent(document.body, 'mousemove', x1 + (x2 - x1) * i / 10, y1 + (y2 - y1) * i / 10);
            await sleep(20);
        }
        fireMouseEvent(dstEl, 'mousemove', x2, y2);
        await sleep(50);
        fireMouseEvent(dstEl, 'mouseup', x2, y2);
        await sleep(150);
    }

    async function autoFillMatching(pairs, data) {
        const player = document.getElementById('player');
        if (!player || !pairs.length) return;

        setStatus('⏳ Расставляю пары...', 'loading');

        for (const [leftLetter, rightLetter] of pairs) {
            // Перечитываем DOM каждую итерацию — после drop состояние меняется
            const leftEls = Array.from(player.querySelectorAll('.docLeft .dragItem'));
            const leftIdx = leftEls.findIndex(el => el.textContent.trim() === leftLetter);
            if (leftIdx === -1) continue;

            const targets = Array.from(player.querySelectorAll('.docRight .dragTarget'));
            const target  = targets[leftIdx];
            if (!target) continue;

            // Пропускаем уже заполненные слоты
            if (target.classList.contains('used')) continue;

            // Ищем исходный dragItem в docBottom (только видимые)
            let dragItem = Array.from(player.querySelectorAll('.docBottom .dragItem'))
                .find(el => el.textContent.trim() === rightLetter && el.style.display !== 'none');

            // Fallback: по сохранённому ID
            if (!dragItem && data.rightDragIds?.[rightLetter]) {
                const el = document.getElementById(data.rightDragIds[rightLetter]);
                if (el && el.style.display !== 'none') dragItem = el;
            }

            if (!dragItem) continue;

            await simulateDragDrop(dragItem, target);
            await sleep(300);
        }

        setStatus('✓ Сопоставление выставлено', 'done');
    }

    async function autoFillMatchingMulti(groups, data) {
        const player = document.getElementById('player');
        if (!player || !Object.keys(groups).length) return;

        const dropZones = {};
        player.querySelectorAll('#multipleMatchBottom tbody tr').forEach(tr => {
            const leftLi = tr.querySelector('td.matchLeft li');
            const dropUl = tr.querySelector('td.matchRight ul.matchRightSort');
            if (leftLi && dropUl) dropZones[leftLi.textContent.trim()] = dropUl;
        });

        const dragItems = {};
        player.querySelectorAll('#answerChoises li.dragItem').forEach(li => {
            dragItems[li.textContent.trim()] = li;
        });

        setStatus('⏳ Расставляю группы...', 'loading');

        for (const [leftLetter, rightLetters] of Object.entries(groups)) {
            const dropZone = dropZones[leftLetter];
            if (!dropZone) continue;
            for (const rightLetter of rightLetters) {
                const dragItem = dragItems[rightLetter];
                if (!dragItem) continue;
                await simulateDragDrop(dragItem, dropZone);
            }
        }

        setStatus('✓ Группировка выставлена', 'done');
    }

    // ═══════════════════════════════════════════
    //  ФОРМАТИРОВАНИЕ ОТВЕТА
    // ═══════════════════════════════════════════
    function formatAnswer(parsed, data, cached) {
        if (!parsed) return '<em style="color:#888">Не удалось распознать ответ</em>';

        const cacheTag = cached
            ? '<span style="font-size:10px;color:#5ba3f5;margin-left:6px;">📦 из кэша</span>'
            : '';

        switch (parsed.type) {
            case 'text':
                return `<div style="color:#7cb8ff;margin-bottom:4px;font-size:11px;">📝 ТЕКСТОВЫЙ ОТВЕТ${cacheTag}</div>${escHtml(parsed.answer || '')}`;

            case 'radio': {
                const ci = (parsed.index || 1) - 1;
                let html = `<div style="color:#7cb8ff;margin-bottom:6px;font-size:11px;">🔘 ОДИНОЧНЫЙ ВЫБОР${cacheTag}</div>`;
                data.options.forEach((opt, i) => {
                    const ok = i === ci;
                    html += `<div style="${ok ? 'color:#4caf50;font-weight:bold;' : 'color:#888;'}margin:2px 0;">${ok ? '✓ ' : '  '}${escHtml(opt.text)}</div>`;
                });
                return html;
            }

            case 'checkbox': {
                const cs = new Set((parsed.indices || []).map(i => i - 1));
                let html = `<div style="color:#7cb8ff;margin-bottom:6px;font-size:11px;">☑ МНОЖЕСТВЕННЫЙ ВЫБОР${cacheTag}</div>`;
                data.options.forEach((opt, i) => {
                    const ok = cs.has(i);
                    html += `<div style="${ok ? 'color:#4caf50;font-weight:bold;' : 'color:#888;'}margin:2px 0;">${ok ? '✓ ' : '  '}${escHtml(opt.text)}</div>`;
                });
                return html;
            }

            case 'matching': {
                let html = `<div style="color:#7cb8ff;margin-bottom:6px;font-size:11px;">🔗 СОПОСТАВЛЕНИЕ${cacheTag}</div>`;
                (parsed.pairs || []).forEach(([l, r]) => {
                    const lt = data.leftItems.find(i => i.letter === l)?.text || l;
                    const rt = data.rightItems.find(i => i.letter === r)?.text || r;
                    html += `<div style="margin:3px 0;"><span style="color:#f0a830;">${l} → ${r}</span></div>`;
                    html += `<div style="color:#aaa;font-size:11px;margin-bottom:4px;padding-left:8px;">${escHtml(lt)} ↔ ${escHtml(rt)}</div>`;
                });
                return html;
            }

            case 'matching_multi': {
                let html = `<div style="color:#7cb8ff;margin-bottom:6px;font-size:11px;">🔗 ГРУППИРОВКА${cacheTag}</div>`;
                for (const [leftLetter, rightLetters] of Object.entries(parsed.groups || {})) {
                    const lt = data.leftItems.find(i => i.letter === leftLetter)?.text || leftLetter;
                    html += `<div style="margin:4px 0;"><span style="color:#f0a830;font-weight:bold;">${leftLetter}. ${escHtml(lt)}</span></div>`;
                    (rightLetters || []).forEach(r => {
                        const rt = data.rightItems.find(i => i.letter === r)?.text || r;
                        html += `<div style="color:#aaa;font-size:11px;margin-bottom:2px;padding-left:12px;">→ ${r}. ${escHtml(rt)}</div>`;
                    });
                }
                return html;
            }

            case 'sorting': {
                let html = `<div style="color:#7cb8ff;margin-bottom:6px;font-size:11px;">🔢 ПРАВИЛЬНЫЙ ПОРЯДОК${cacheTag}</div>`;
                (parsed.order || []).forEach((num, idx) => {
                    const item = data.options.find(o => o.order === num);
                    html += `<div style="margin:2px 0;"><span style="color:#f0a830;">${idx + 1}.</span> ${escHtml(item?.text || `Элемент ${num}`)}</div>`;
                });
                return html;
            }

            default:
                return escHtml(JSON.stringify(parsed, null, 2));
        }
    }

    // ═══════════════════════════════════════════
    //  ОСНОВНАЯ ФУНКЦИЯ
    // ═══════════════════════════════════════════
    async function processQuestion(useWebSearch = false) {
        if (!userToken) {
            setStatus('⚠ Введи токен (кнопка ⚙)', 'error');
            setAnswer('<span style="color:#f44336;">Нажми ⚙ и введи свой токен</span>');
            showApplyBtn(false);
            document.getElementById('ai-solver-settings').style.display = 'block';
            return;
        }

        const data = extractData();
        if (!data || data.type === 'unknown') {
            setStatus('Вопрос не найден', '');
            setAnswer('<span style="color:#888;">Не удалось определить вопрос на странице</span>');
            showApplyBtn(false);
            return;
        }

        let images = [];
        if (data.imageUrls && data.imageUrls.length > 0) {
            setStatus('⏳ Загрузка картинок...', 'loading');
            try {
                images = await Promise.all(data.imageUrls.map(fetchImageAsBase64));
            } catch (e) {
                console.warn('Image fetch failed:', e);
            }
        }

        const typeLabel = {
            text: 'текстовый', radio: 'одиночный', checkbox: 'множественный',
            matching: 'сопоставление', sorting: 'сортировка', matching_multi: 'группировка',
        }[data.type] || data.type;

        const imgLabel = images.length ? ', 📷' : '';
        const prefix   = data.isCompetency ? 'кейс, ' : '';
        setStatus(`⏳ Запрос к AI (${prefix}${typeLabel}${imgLabel})...`, 'loading');
        setAnswer('');
        showApplyBtn(false);
        document.getElementById('ai-solver-me').style.display = 'none';

        const wsBtn = document.getElementById('ai-solver-websearch-btn');
        wsBtn.disabled = true;

        try {
            const { parsed, cached } = await callWorker(data, useWebSearch, images);
            wsBtn.disabled = false;

            if (useWebSearch && parsed) setStatus('🔍 Ответ с веб-поиском', 'done');

            lastData   = data;
            lastParsed = parsed;

            const statusText = cached ? '📦 Из кэша' : '✓ Ответ получен';
            setStatus(statusText, cached ? 'cached' : 'done');
            setAnswer(formatAnswer(parsed, data, cached));

            let applyPromise = Promise.resolve();
            if (AUTO_APPLY && parsed) {
                if (['text', 'radio', 'checkbox'].includes(data.type)) {
                    applyAnswer();
                } else if (data.type === 'matching') {
                    applyPromise = autoFillMatching(parsed.pairs || [], data);
                } else if (data.type === 'matching_multi') {
                    applyPromise = autoFillMatchingMulti(parsed.groups || {}, data);
                } else if (data.type === 'sorting') {
                    applyAnswer();
                }
                showApplyBtn(true);
            } else {
                showApplyBtn(!!parsed);
            }

            if (autopilotActive && parsed) {
                applyPromise.then(() => setTimeout(autopilotClickSend, 2000));
            }
        } catch (err) {
            wsBtn.disabled = false;
            setStatus('Ошибка: ' + err.message, 'error');
            setAnswer(`<span style="color:#f44336;">${escHtml(err.message)}</span>`);
        }
    }

    // ═══════════════════════════════════════════
    //  НАБЛЮДАТЕЛЬ
    // ═══════════════════════════════════════════
    let processTimeout   = null;
    let lastQuestionText = '';

    function scheduleProcess() {
        clearTimeout(processTimeout);
        processTimeout = setTimeout(() => {
            if (autopilotModalClicked) resetModalClickedFlag();
            if (autopilotActive && checkAndClickFinish()) return;

            const data = extractData();
            if (!data) return;
            if (data.question === lastQuestionText) return;
            lastQuestionText = data.question;
            processQuestion();
        }, 600);
    }

    function waitForPlayer() {
        const player = document.getElementById('player');
        if (player) {
            new MutationObserver(() => {
                if (player.querySelector('.test-question-text-2')) scheduleProcess();
            }).observe(player, { childList: true, subtree: true });

            if (player.querySelector('.test-question-text-2')) scheduleProcess();
        } else {
            setTimeout(waitForPlayer, 300);
        }
    }

    // Автопилот: при загрузке страницы восстанавливаем состояние
    if (autopilotActive) {
        updateAutopilotUI();
        watchForStartModal();
        const startBtnOnLoad = document.getElementById('startPlayerBtn');
        if (startBtnOnLoad) {
            setStatus('🤖 Запуск следующего прогона...', 'loading');
            setTimeout(() => { startBtnOnLoad.click(); resetAutopilotWatchdog(); }, 1500);
        } else {
            resetAutopilotWatchdog();
        }
    }

    waitForPlayer();

    if (userToken) fetchBalance();

})();
