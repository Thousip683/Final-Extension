/**
 * Offscreen bridge.
 *
 * Owns the sandboxed reader frame and relays read requests from the service
 * worker to it. Everything stays inside the extension: no fetch, no upload.
 */

const FRAME_URL = chrome.runtime.getURL("sandbox/sandbox.html");
const BASE_URL = chrome.runtime.getURL("");

const frame = document.createElement("iframe");
frame.src = FRAME_URL;
frame.style.display = "none";
document.body.appendChild(frame);

let frameReady = false;
const readyWaiters = [];
/** requestId -> { resolve, requestId } */
const pending = new Map();

function waitForFrame() {
  if (frameReady) return Promise.resolve();
  return new Promise((resolve) => readyWaiters.push(resolve));
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;

  if (message.type === "EG_SANDBOX_READY") {
    frameReady = true;
    while (readyWaiters.length) readyWaiters.shift()();
    return;
  }

  if (message.type === "EG_SANDBOX_PROGRESS") {
    chrome.runtime
      .sendMessage({
        type: "EG_READ_PROGRESS",
        requestId: message.requestId,
        percent: message.percent,
        message: message.message,
      })
      .catch(() => {});
    return;
  }

  if (message.type === "EG_SANDBOX_RESULT") {
    const entry = pending.get(message.requestId);
    if (entry) {
      pending.delete(message.requestId);
      entry({
        ok: message.ok,
        read: message.read,
        match: message.match,
        error: message.error,
      });
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "EG_OFFSCREEN_READ") return undefined;

  const { requestId, base64, mimeType, fileName, formFields } = message;

  (async () => {
    try {
      await waitForFrame();

      const binary = atob(base64 || "");
      const view = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) view[i] = binary.charCodeAt(i);

      const result = await new Promise((resolve) => {
        pending.set(requestId, resolve);
        frame.contentWindow.postMessage(
          {
            type: "EG_SANDBOX_READ",
            requestId,
            bytes: view.buffer,
            mimeType,
            fileName,
            formFields: formFields || [],
            baseUrl: BASE_URL,
          },
          "*",
          [view.buffer],
        );
      });

      sendResponse(result);
    } catch (error) {
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : String(error),
      });
    }
  })();

  return true; // async response
});

chrome.runtime.sendMessage({ type: "EG_OFFSCREEN_READY" }).catch(() => {});
