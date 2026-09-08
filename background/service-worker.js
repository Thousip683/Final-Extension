/**
 * Background Service Worker
 * Manages extension lifecycle, coordinates popup <-> tab messaging, and hosts
 * the bridge to the offscreen on-device document reader.
 */

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const OFFSCREEN_IDLE_MS = 5 * 60 * 1000; // release the models after 5 idle minutes

let offscreenCreating = null;
let offscreenIdleTimer = null;
/** requestId -> tabId, so progress updates go back to the right page. */
const progressTargets = new Map();

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[ErrorGuard::Background] Pre-Submission Error Guard installed.', details.reason);
});

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
    });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['WORKERS', 'BLOBS'],
    justification:
      'Runs the bundled PP-OCRv6 document reader locally (needs canvas, Web Workers and WebAssembly).'
  });
  try {
    await offscreenCreating;
  } catch (err) {
    // "Only a single offscreen document may be created" — another call won the race.
    if (!String(err && err.message).includes('single offscreen')) throw err;
  } finally {
    offscreenCreating = null;
  }
}

function scheduleOffscreenRelease() {
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(async () => {
    try {
      if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
    } catch (e) {
      /* already gone */
    }
  }, OFFSCREEN_IDLE_MS);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── On-device document reading ──────────────────────────────────────
  if (message && message.type === 'EG_READ_DOCUMENT') {
    const requestId = message.requestId || `eg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (sender.tab && sender.tab.id) progressTargets.set(requestId, sender.tab.id);

    (async () => {
      try {
        await ensureOffscreenDocument();
        const response = await chrome.runtime.sendMessage({
          type: 'EG_OFFSCREEN_READ',
          requestId,
          base64: message.base64,
          mimeType: message.mimeType,
          fileName: message.fileName,
          formFields: message.formFields || []
        });
        sendResponse(response || { ok: false, error: 'The on-device reader did not respond.' });
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      } finally {
        progressTargets.delete(requestId);
        scheduleOffscreenRelease();
      }
    })();
    return true;
  }

  // Progress relay: offscreen document -> originating tab
  if (message && message.type === 'EG_READ_PROGRESS') {
    const tabId = progressTargets.get(message.requestId);
    if (tabId) {
      chrome.tabs.sendMessage(tabId, message).catch(() => {});
    }
    return false;
  }

  if (message && message.type === 'EG_OFFSCREEN_READY') return false;

  // Relay message from popup to active tab
  if (message.target === 'TAB' && message.action) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
          sendResponse(response);
        });
      } else {
        sendResponse(null);
      }
    });
    return true;
  }

  // Optional cloud AI path only. Never used unless the user turns it on.
  if (message.action === 'FETCH_BACKEND') {
    const { url, method, headers, body } = message;
    fetch(url, {
      method: method || 'GET',
      headers: headers || { 'Content-Type': 'application/json' },
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
    })
      .then(async (res) => {
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch (e) { data = text; }
        sendResponse({ ok: res.ok, status: res.status, data });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  return undefined;
});
