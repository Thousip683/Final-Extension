/**
 * Local Pipeline Client (content-script side)
 *
 * Sends the picked file to the extension's own offscreen reader and returns the
 * structured result. The bytes travel only inside the extension — no fetch, no
 * upload, no API key.
 */

(function () {
  window.ErrorGuard = window.ErrorGuard || {};

  const progressHandlers = new Map();

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== 'EG_READ_PROGRESS') return;
      const handler = progressHandlers.get(message.requestId);
      if (handler) handler(message.percent, message.message);
    });
  }

  window.ErrorGuard.LocalPipeline = {
    available() {
      try {
        return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
      } catch (e) {
        return false;
      }
    },

    /**
     * Reads a document fully on-device.
     * @param {File|Blob} file
     * @param {Array} formFields - descriptors from the page's form (optional)
     * @param {function(number,string)} onProgress
     * @returns {Promise<{ok:boolean, read?:Object, match?:Object, error?:string}>}
     */
    async read(file, formFields = [], onProgress = () => {}) {
      if (!file) return { ok: false, error: 'No file was provided.' };
      if (!this.available()) {
        return { ok: false, error: 'Extension context unavailable — reload the page.' };
      }

      const requestId = `eg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      progressHandlers.set(requestId, onProgress);

      try {
        onProgress(4, 'Preparing document for on-device reading...');
        // Extension messaging is JSON-only, so the bytes travel as base64.
        // They still never leave the browser.
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
          reader.onerror = () => reject(new Error('Could not read the selected file.'));
          reader.readAsDataURL(file);
        });

        const response = await chrome.runtime.sendMessage({
          type: 'EG_READ_DOCUMENT',
          requestId,
          base64,
          mimeType: file.type || '',
          fileName: file.name || '',
          formFields
        });

        if (!response) return { ok: false, error: 'The on-device reader did not respond.' };
        return response;
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      } finally {
        progressHandlers.delete(requestId);
      }
    }
  };
})();
