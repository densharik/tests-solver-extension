# MTI Solver — Chrome Extension

Решатель тестов МТИ/Синергия на базе Claude / GPT. Портирован из Tampermonkey userscript v5.

**Текущая версия:** 4.11
**Платформа:** Chrome Extension, Manifest V3
**Worker:** Cloudflare Worker + D1 SQLite

---

## Структура проекта

```
mti-solver-extension/
├── manifest.json               # MV3 конфиг: permissions, content_scripts, SW
├── background/
│   └── service-worker.js       # Единственная задача: fetch-прокси для content script
├── content/
│   └── content.js              # Весь UI + логика (~1200 строк, async IIFE)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── PROJECT.md                  # Этот файл
```

---

## Архитектура

### Два процесса расширения

```
┌─────────────────────────────────────┐
│  Страница LMS (lms.synergy.ru)      │
│                                     │
│  content/content.js                 │
│  ├── UI панель (DOM injection)      │
│  ├── DOM парсинг вопросов           │
│  ├── Логика ответов                 │
│  └── chrome.runtime.sendMessage ──┐ │
└──────────────────────────────────-│-┘
                                    │  sendMessage / sendResponse
┌───────────────────────────────────▼-┐
│  background/service-worker.js       │
│  └── fetch(WORKER_URL, ...)         │
│       ↕ HTTP                        │
│  mti-solver-v5.danildev.workers.dev │
└─────────────────────────────────────┘
```

**Почему нельзя fetch прямо из content script?**
Content script может делать fetch, но к cross-origin URL — CORS заблокирует (Worker не возвращает CORS-заголовки). Service worker расширения не подчиняется CORS — делает запросы как нативное приложение.

**Исключение — изображения вопросов:**
`fetchImageAsBase64()` использует `fetch(url, {credentials:'include'})` прямо из content script. Это работает потому что изображения на `lms.synergy.ru` — same-origin относительно страницы, где запущен content script. Куки сессии включаются автоматически.

---

## Хранилище настроек

| Ключ | Тип | Описание |
|------|-----|----------|
| `mti_token` | string | Токен доступа к Worker |
| `mti_context` | string | Контекст/подсказки для AI |
| `mti_model` | string | ID модели (`claude-sonnet-4-6` и др.) |
| `mti_discipline` | string | Дисциплина (`it`, `law`, `econ`, `psy`, `science`) |
| `mti_reasoning` | bool | Показывать обоснование |
| `mti_panel_visible` | bool | Панель развёрнута/свёрнута |
| `mti_panel_x` | int | X позиция панели |
| `mti_panel_y` | int | Y позиция панели |

Читаются **один раз** при старте через `chrome.storage.local.get(null)` в async IIFE.
Пишутся через `chrome.storage.local.set({key: value})` — fire-and-forget, синхронно не блокируют UI.

**Сессионное хранилище** (`sessionStorage`) — переживает навигацию внутри вкладки, но не закрытие:
- `mti_qmap` — Map вопрос→хэш для верификации кэша после теста
- `mti_autopilot`, `mti_autopilot_left`, `mti_autopilot_total` — состояние автопилота

---

## Worker API

**Base URL:** `https://mti-solver-v5.danildev.workers.dev`

| Метод | Путь | Назначение |
|-------|------|-----------|
| POST | `/solve` | Решить вопрос (списывает 1 кредит) |
| GET | `/balance` | Текущий баланс кредитов |
| GET | `/me` | Баланс + история за 7 дней |
| POST | `/result` | Отметить правильность одного ответа |
| POST | `/results` | Батч-верификация после теста |
| POST | `/test_result` | Сохранить итог теста |

**Аутентификация:** заголовок `X-Token` или query-параметр `?token=...`

### Формат `/solve` запроса

```json
{
  "token": "uuid-токен",
  "prompt": "готовый промпт для Claude",
  "question_type": "radio|checkbox|text|matching|matching_multi|sorting",
  "question_text": "текст вопроса",
  "subject": "Название дисциплины из хлебных крошек",
  "use_web_search": false,
  "model": "claude-sonnet-4-6",
  "images": [{"media_type": "image/png", "data": "base64..."}],
  "options_texts": ["вариант 1", "вариант 2"],
  "left_texts": [],
  "right_texts": [],
  "image_count": 0
}
```

### Форматы ответа Claude (JSON без обёртки)

```json
// radio
{"type":"radio","reasoning":{"1":"...","2":"..."},"index":2}

// checkbox
{"type":"checkbox","reasoning":{"1":"..."},"indices":[1,3]}

// text
{"type":"text","answer":"слово"}

// matching
{"type":"matching","pairs":[["A","E"],["B","F"]]}

// matching_multi
{"type":"matching_multi","groups":{"A":["C","D"],"B":["E","F"]}}

// sorting
{"type":"sorting","order":[2,1,3]}
```

---

## Логика content.js

### Жизненный цикл запроса

```
waitForPlayer()
  └── MutationObserver на #player
        └── scheduleProcess() (debounce 600ms)
              └── extractData()
                    └── processQuestion()
                          ├── fetchImageAsBase64() (если есть картинки)
                          ├── callWorker()
                          │     ├── buildPrompt()
                          │     ├── workerPost('/solve') → sendMessage → SW fetch
                          │     └── extractFirstJSON(response)
                          ├── formatAnswer()
                          ├── applyAnswer() / autoFillMatching() / autoFillMatchingMulti()
                          └── autopilotClickSend() (если автопилот)
```

### Типы вопросов и их обработка

| Тип | DOM-детектор | Применение ответа |
|-----|-------------|-------------------|
| `radio` | `input[type=radio][name=answers]` | `input.click()` |
| `checkbox` | `input[type=checkbox]` | `input.click()` для каждого выбранного |
| `text` | `textarea[name=answers]` | `ta.value = answer` + dispatch events |
| `matching` | `.docLeft.ui-sortable` | jQuery trigger `drop` → fallback DOM |
| `matching_multi` | `#multipleMatchBottom` | `simulateDragDrop()` с mouse events |
| `sorting` | `#sortable2` | `applyAnswer()` (TODO: реализовать drag) |

### Ключевые функции

| Функция | Строки | Что делает |
|---------|--------|-----------|
| `detectType()` | ~15 | Определяет тип вопроса по DOM |
| `extractData()` | ~100 | Парсит вопрос, варианты, картинки |
| `buildPrompt(data)` | ~190 | Строит промпт (2 пути: обычный / компетентностный) |
| `callWorker(data, ws, imgs)` | ~60 | HTTP → Worker, retry на 429, парсинг JSON |
| `applyAnswer()` | ~55 | Кликает/заполняет правильные варианты |
| `autoFillMatching(pairs, data)` | ~60 | Расставляет пары drag-and-drop |
| `autoFillMatchingMulti(groups)` | ~35 | Групповой drag-and-drop |
| `formatAnswer(parsed, data)` | ~70 | Рендерит ответ в HTML для панели |
| `processQuestion(useWS)` | ~65 | Оркестратор всего цикла |
| `collectAndShowLog(c, t)` | ~80 | Парсит попап результатов, батч-верификация |

---

## Автопилот

Состояние хранится в `sessionStorage` — переживает редиректы после сдачи теста.

```
Старт автопилота
  ├── watchForStartModal() — Observer на кнопку «Перейти к тесту»
  ├── Клик «Начать тест» (startPlayerBtn)
  │
  ├── [после каждого вопроса]
  │     processQuestion() → applyAnswer() → 2с → autopilotClickSend()
  │       ├── checkAndClickFinish() — ищет span[color=green] «Отвеченный ранее»
  │       └── input.doSendBtn.click()
  │
  ├── [после завершения теста]
  │     collectAndShowLog() → 3с → startPlayerBtn.click() / location.reload()
  │     autopilotRunsLeft--
  │
  └── [когда руnsLeft = 0] → stopAutopilot()
```

**Watchdog:** если 12с нет ни вопроса ни результатов → `location.reload()`

---

## Добавление нового типа вопроса

Нужно изменить код в **5 местах**:

1. **`detectType()`** — добавить DOM-детектор, вернуть новый ключ типа
2. **`extractData()`** — добавить `case 'новый_тип':` с парсингом DOM
3. **`buildPrompt()` / `buildCompetencyPrompt()`** — добавить `case 'новый_тип':` с форматом JSON-ответа
4. **`applyAnswer()`** — добавить `case 'новый_тип':` с логикой клика/заполнения
5. **`formatAnswer()`** — добавить `case 'новый_тип':` с HTML-представлением

---

## Добавление новой модели

В `content.js`:
1. Добавить `<label>` в HTML-шаблон панели (в секцию `.ai-toggle-row`)
2. Добавить запись в `MODEL_LABELS` (для логов)

В `worker_v5.js` (Cloudflare Worker):
3. Добавить роутинг в `handleSolve()` — условие по `model` → нужный API-клиент

---

## Добавление новой настройки

1. Добавить HTML-элемент в шаблон панели (`panel.innerHTML`)
2. Инициализировать из `stored`:
   ```js
   let myOption = stored.mti_myoption ?? defaultValue;
   ```
3. Добавить обработчик изменения с сохранением:
   ```js
   element.addEventListener('change', () => {
       myOption = element.value;
       chrome.storage.local.set({ mti_myoption: myOption });
   });
   ```
4. Использовать `myOption` в нужных функциях

---

## Установка для разработки

1. Открыть `chrome://extensions/`
2. Включить **Режим разработчика** (правый верхний угол)
3. Нажать **«Загрузить распакованное»** → выбрать папку `mti-solver-extension/`
4. Перейти на страницу теста `*/assessments/*`

**Перезагрузка после изменений:**
- Изменения в `content.js` → обновить расширение на `chrome://extensions/` (кнопка ↺) → перезагрузить страницу теста
- Изменения в `service-worker.js` → только обновить расширение

**Отладка:**
- Content script: F12 на странице теста → Console
- Service worker: `chrome://extensions/` → «Инспектировать» у расширения → вкладка Service Worker

---

## Версионирование

- **Мажорная версия** (4.x) — меняет пользователь вручную
- **Минорная** (+0.1) — при каждой итерации изменений

При изменениях обновить:
1. `SCRIPT_VERSION` в `content.js` (строка `const SCRIPT_VERSION = '4.11'`)
2. `"version"` в `manifest.json`
3. `CHANGELOG.md` в папке проекта

---

## Известные ограничения

| Проблема | Статус |
|----------|--------|
| CSS не изолирован (нет Shadow DOM) — может конфликтовать с LMS | Работает на практике, рефакторинг по необходимости |
| `sorting` — применение ответа через `applyAnswer()` не реализовано полноценно | Надо добавить drag-сортировку как в matching |
| Иконки — синие заглушки | Заменить на нормальные PNG при необходимости |
| Нет popup с настройками | Настройки встроены в панель контент-скрипта |

---

## Связанные файлы (вне расширения)

| Файл | Назначение |
|------|-----------|
| `../worker_v5.js` | Cloudflare Worker — бэкенд |
| `../schema_v5.sql` | Схема D1 SQLite |
| `../wrangler_v5.toml` | Конфиг деплоя |
| `../admin.sh` | Управление токенами через wrangler CLI |
| `../CHANGELOG.md` | История изменений userscript + worker |
