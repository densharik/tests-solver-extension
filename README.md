# LMS Test Solver — Chrome Extension

Chrome extension that automatically solves online tests on Synergy LMS using AI (Claude / GPT).

## How it works

When a test page (`/assessments/...`) is opened, a floating panel appears. It reads the question and answer options from the DOM, sends them to a backend, receives a JSON response and applies the answer automatically — clicks the correct option, fills in text, or drags elements for matching questions.

## Supported question types

- **radio** — single correct answer
- **checkbox** — multiple correct answers
- **text** — free text input (fill in the blank)
- **matching** — drag-and-drop pairing of two columns
- **matching_multi** — distribute items into groups
- **sorting** — arrange items in the correct order

## Architecture

### Chrome Extension (`content/content.js`)
- Injected into LMS test pages
- Renders a draggable floating panel
- Parses question DOM: detects type, extracts text and options
- Encodes images from questions as base64 and includes them in the prompt
- Sends request to backend via service worker (CORS proxy)
- Applies the answer returned as JSON
- After test completion: parses results table, sends stats to backend

Settings stored in `chrome.storage.local`: token, subject context, selected model, discipline, panel position.

### Backend — Cloudflare Worker
- Validates token and rate limit
- Routes prompt to Claude API (Anthropic) or OpenAI API based on selected model
- Optionally enables web search (`web_search_20250305`) for factual questions
- Logs each request; refunds credit on API error

### Database — Cloudflare D1 (SQLite)
- `tokens` — access tokens with credit balance and expiry
- `usage_log` — request log (token, timestamp, question type, model)
- `question_cache` — verified question/answer cache
- `test_results` — per-test outcome stats

## Features

**Autopilot** — fully automated loop: start test → answer all questions → submit → repeat N times. Includes a watchdog timer for hang detection.

**Model selection** — Claude Sonnet, Claude Haiku, GPT mini, GPT nano.

**Discipline prompts** — system prompt adapts by subject area (IT, Law, Economics, Psychology, Math/Sciences).

**Competency tests** — separate prompt logic for case-based questions.

**Web search** — retry with web search enabled to improve accuracy on factual questions.

**TSV log** — after each test, generates a TSV line (for Google Sheets) with question count, correct answers, discipline, model, duration, and per-question breakdown.

## Stats

Collected across 85 test runs, 1036 questions total:

| Metric | Value |
|--------|-------|
| Overall accuracy | 74% |
| Tests scored 90%+ | 23% |
| Tests scored 100% | 6 |

Top subject areas: Economics/Management (47%), Law (15%), Psychology (15%).

## Installation

1. Open `chrome://extensions/` → enable Developer mode
2. Click "Load unpacked" → select this folder
3. Open extension settings, enter your access token

## Deployment (backend)

```bash
wrangler deploy -c wrangler_v5.toml
wrangler secret put CLAUDE_API_KEY
wrangler secret put OPENAI_API_KEY
wrangler secret put ADMIN_KEY
wrangler d1 execute mti-db --file=schema_v5.sql --remote
```
