/**
 * Storage Wrapper for Chrome Extension
 * Provides unified interface to chrome.storage.local
 */

(function () {
  window.ErrorGuard = window.ErrorGuard || {};

  window.ErrorGuard.Storage = {
    _isContextValid() {
      try {
        // Accessing chrome.runtime.id throws if the context is invalidated
        return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && !!chrome.runtime.id;
      } catch (e) {
        return false;
      }
    },

    async set(key, value) {
      return new Promise((resolve) => {
        if (this._isContextValid()) {
          try {
            chrome.storage.local.set({ [key]: value }, resolve);
          } catch (e) {
            resolve(); // context invalidated mid-call
          }
        } else {
          try {
            localStorage.setItem(key, JSON.stringify(value));
          } catch (e) {}
          resolve();
        }
      });
    },

    async get(key) {
      return new Promise((resolve) => {
        if (this._isContextValid()) {
          try {
            chrome.storage.local.get([key], (result) => {
              resolve(result ? result[key] : null);
            });
          } catch (e) {
            resolve(null);
          }
        } else {
          try {
            const val = localStorage.getItem(key);
            resolve(val ? JSON.parse(val) : null);
          } catch (e) {
            resolve(null);
          }
        }
      });
    },

    async remove(key) {
      return new Promise((resolve) => {
        if (this._isContextValid()) {
          try {
            chrome.storage.local.remove([key], resolve);
          } catch (e) {
            resolve();
          }
        } else {
          try {
            localStorage.removeItem(key);
          } catch (e) {}
          resolve();
        }
      });
    },

    // ─── Dedicated Google API Key Management ───
    async getGoogleApiKey() {
      return (await this.get('google_gemini_api_key')) || '';
    },

    async setGoogleApiKey(key) {
      return await this.set('google_gemini_api_key', (key || '').trim());
    },

    async removeGoogleApiKey() {
      return await this.remove('google_gemini_api_key');
    },

    // ─── Extension Mode Management ───
    // false = Manual Guard (default), true = AI Auto-Fill
    async getAiAutoFillMode() {
      const val = await this.get('EG_AI_AUTOFILL_MODE');
      return val === true;
    },

    async setAiAutoFillMode(enabled) {
      return await this.set('EG_AI_AUTOFILL_MODE', !!enabled);
    }
  };

  /**
   * Helper to perform backend fetch via background service worker,
   * completely bypassing webpage CORS, loopback, and Private Network Access restrictions.
   */
  window.ErrorGuard.backendFetch = async function (url, options = {}) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      return new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({
            action: 'FETCH_BACKEND',
            url,
            method: options.method || 'GET',
            headers: options.headers,
            body: options.body ? (typeof options.body === 'string' ? JSON.parse(options.body) : options.body) : undefined
          }, (res) => {
            if (chrome.runtime.lastError || !res) {
              fetch(url, options).then(resolve).catch(() => resolve({ ok: false, status: 0 }));
            } else {
              resolve({
                ok: !!res.ok,
                status: res.status || (res.ok ? 200 : 500),
                json: async () => res.data,
                text: async () => typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
              });
            }
          });
        } catch (e) {
          fetch(url, options).then(resolve).catch(() => resolve({ ok: false, status: 0 }));
        }
      });
    }
    return fetch(url, options).catch(() => ({ ok: false, status: 0 }));
  };
})();
