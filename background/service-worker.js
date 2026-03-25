// Service Worker — проксирует fetch-запросы от content script к Worker API
// Content script не может напрямую делать cross-origin fetch из-за CORS.
// Service worker делает запросы от имени расширения — CORS не применяется.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action !== 'fetch') return false;

    const opts = { method: message.method || 'GET' };
    if (message.headers) opts.headers = message.headers;
    if (message.body)    opts.body    = message.body;

    fetch(message.url, opts)
        .then(async r => {
            const text = await r.text();
            sendResponse({ status: r.status, text });
        })
        .catch(e => sendResponse({ status: 0, text: '{}', error: e.message }));

    return true; // держим канал открытым для async-ответа
});
