/**
 * AI Field Explainer - Field Helper Module (100% Browser-Direct / Serverless)
 *
 * Strategy:
 *   1. On page load, scrape all form fields and fire ONE Gemini API call.
 *   2. Gemini returns a JSON map of { fieldKey: explanation } for every field.
 *   3. All explanations are stored in _cache before the user clicks anything.
 *   4. When the user clicks the ? button, the explanation is shown INSTANTLY
 *      from cache — zero additional network round-trips.
 *   5. If the page-load prefetch failed, clicking ? falls back to the original
 *      per-field API call so the user always gets an answer.
 *   6. A MutationObserver watches for dynamically injected form fields (AJAX /
 *      multi-step forms) and re-triggers the prefetch for any new fieldKeys.
 */

(function () {
  window.ErrorGuard = window.ErrorGuard || {};

  var TOOLTIP_CLASS = 'eg-help-tooltip';
  var BTN_ID = 'eg-help-floating-btn';
  var _cache = new Map();          // fieldKey → { explanation, timestamp }
  var _activeField = null;
  var _hideTimer = null;
  var _prefetchDone = false;       // true once the page-load prefetch resolves
  var _prefetchPending = false;    // guard against concurrent prefetch runs
  var _knownFieldKeys = new Set(); // tracks keys already sent to Gemini

  // Embedded default API key (fallback if none saved in extension settings)
  var DEFAULT_API_KEY = '';

  // High-quota, fast models ordered by reliability
  var GEMINI_MODELS = [
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-flash-latest'
  ];

  var FIELD_SELECTOR =
    'input:not([type=hidden]):not([type=submit]):not([type=button])' +
    ':not([type=reset]):not([type=image]):not([type=file]):not([type=checkbox])' +
    ':not([type=radio]), select, textarea';

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function fieldKey(el) {
    return el.id || el.name || el.placeholder || el.getAttribute('aria-label') || el.tagName + '_' + Date.now();
  }

  function getFieldLabel(el) {
    if (el.id) {
      var lbl = document.querySelector('label[for="' + el.id + '"]');
      if (lbl) return lbl.innerText.replace(/[*:]/g, '').trim();
    }
    var wrapLbl = el.closest('label');
    if (wrapLbl) return wrapLbl.innerText.replace(/[*:]/g, '').trim();
    var group = el.closest('div, li, td, .form-group, .field-group, .field');
    if (group) {
      var sib = group.querySelector('label, .label, .form-label, legend');
      if (sib) return sib.innerText.replace(/[*:]/g, '').trim();
    }
    return el.getAttribute('aria-label') || el.placeholder || el.name || el.id || 'this field';
  }

  function buildFieldContext(el) {
    var parts = [];
    if (el.placeholder) parts.push('Placeholder: "' + el.placeholder + '"');
    if (el.name) parts.push('Field name: "' + el.name + '"');
    var headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, legend'));
    var rect = el.getBoundingClientRect();
    var nearestHeading = null, nearestDist = Infinity;
    headings.forEach(function (h) {
      var hr = h.getBoundingClientRect();
      if (hr.bottom <= rect.top) {
        var dist = rect.top - hr.bottom;
        if (dist < nearestDist) { nearestDist = dist; nearestHeading = h; }
      }
    });
    if (nearestHeading) parts.push('Nearby section: "' + nearestHeading.innerText.trim().slice(0, 60) + '"');
    return parts.join('. ') || 'No additional context.';
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── API key getter ────────────────────────────────────────────────────────

  async function getApiKey() {
    var apiKey = DEFAULT_API_KEY;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        var stored = await new Promise(function (resolve) {
          chrome.storage.local.get(['google_gemini_api_key'], resolve);
        });
        if (stored && stored.google_gemini_api_key) {
          apiKey = stored.google_gemini_api_key.trim();
        }
      }
    } catch (e) { /* use default */ }
    return apiKey;
  }

  /**
   * Returns the language code the user has active in the Translator module
   * (e.g. 'te', 'hi', 'en'). Falls back to 'en' if Translator isn't loaded.
   */
  function getActiveLang() {
    return (window.ErrorGuard && window.ErrorGuard.Translator &&
      typeof window.ErrorGuard.Translator.getActiveLang === 'function')
      ? window.ErrorGuard.Translator.getActiveLang()
      : 'en';
  }

  function getActiveLangName() {
    return (window.ErrorGuard && window.ErrorGuard.Translator &&
      typeof window.ErrorGuard.Translator.getActiveLangName === 'function')
      ? window.ErrorGuard.Translator.getActiveLangName()
      : 'English';
  }

  // ─── Page Scraper ─────────────────────────────────────────────────────────

  /**
   * Scrapes every visible form field on the page and returns a structured
   * array for the prefetch prompt. Also returns page-level context.
   */
  function scrapePageForPrefetch() {
    var pageTitle = document.title || 'Government / Scholarship Application Form';
    var hostname = location.hostname || '';

    // Collect top-level page headings for context
    var headings = Array.from(document.querySelectorAll('h1, h2, h3, legend'))
      .map(function (h) { return h.innerText.trim(); })
      .filter(function (t) { return t.length > 0; })
      .slice(0, 6)
      .join(' | ');

    // Collect all visible fillable fields
    var allFields = Array.from(document.querySelectorAll(FIELD_SELECTOR))
      .filter(function (el) {
        // Skip fields inside our own UI
        if (el.closest('#error-guard-drawer')) return false;
        if (el.id === BTN_ID) return false;
        return true;
      });

    var fieldDescriptors = [];
    allFields.forEach(function (el) {
      var key = fieldKey(el);
      var label = getFieldLabel(el);
      var descriptor = {
        fieldKey: key,
        label: label,
        type: el.type || el.tagName.toLowerCase(),
        placeholder: el.placeholder || null,
        name: el.name || null
      };
      fieldDescriptors.push(descriptor);
    });

    return { pageTitle, hostname, headings, fieldDescriptors };
  }

  // ─── Batch Gemini Call (Prefetch) ─────────────────────────────────────────

  /**
   * Makes a SINGLE Gemini call for all fields on the page.
   * Returns a parsed object: { _formSummary, [fieldKey]: explanation, ... }
   * Throws on total failure.
   */
  async function callPrefetchAllFields(pageContext) {
    var apiKey = await getApiKey();
    if (!apiKey) {
      throw new Error('No Gemini API Key found. Please save your API Key in the extension popup settings.');
    }
    var { pageTitle, hostname, headings, fieldDescriptors } = pageContext;

    // Build a compact field list for the prompt
    var fieldListJson = JSON.stringify(
      fieldDescriptors.map(function (f) {
        return { fieldKey: f.fieldKey, label: f.label, type: f.type, placeholder: f.placeholder };
      }),
      null, 2
    );

    var activeLangName = getActiveLangName();
    var isEnglish = (getActiveLang() === 'en');
    var langInstruction = isEnglish
      ? ''
      : '  - Write ALL explanations in ' + activeLangName + '. Do not use English for the explanation text.\n';

    var prompt =
      'You are an assistant helping a user fill an official Indian government or scholarship application form.\n\n' +
      'Page Title: "' + pageTitle + '"\n' +
      'Website: ' + hostname + '\n' +
      (headings ? 'Page Headings: "' + headings + '"\n' : '') +
      '\n' +
      'Below is a JSON array of ALL form fields on this page:\n' +
      fieldListJson + '\n\n' +
      'For EACH field, write a concise explanation (max 60 words) telling the user:\n' +
      '  - Exactly what to type (be specific and practical)\n' +
      '  - The correct format or a realistic example (e.g. DD/MM/YYYY, 12-digit number, ABCDE1234F)\n' +
      '  - One common mistake to avoid, if relevant\n\n' +
      'Rules:\n' +
      '  - No bullet points, no JSON keys, no headings inside each explanation.\n' +
      '  - If it is an Indian government term, briefly explain what it is.\n' +
      '  - Keep each explanation under 60 words.\n' +
      '  - Do NOT start any explanation with "This field".\n' +
      langInstruction +
      '\n' +
      'Also write one sentence in "_formSummary" describing what this entire form is used for' +
      (isEnglish ? '' : ' (in ' + activeLangName + ')') + '.\n\n' +
      'Respond with ONLY a valid JSON object in EXACTLY this format (no markdown, no code fences):\n' +
      '{\n' +
      '  "_formSummary": "One sentence about the form.",\n' +
      '  "<fieldKey1>": "Explanation for field 1.",\n' +
      '  "<fieldKey2>": "Explanation for field 2.",\n' +
      '  ...\n' +
      '}\n' +
      'Use each field\'s "fieldKey" value as the JSON key. Output ONLY the JSON, nothing else.';


    var payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 }
    };

    var lastError = null;

    for (var i = 0; i < GEMINI_MODELS.length; i++) {
      var modelName = GEMINI_MODELS[i];
      try {
        var endpoint =
          'https://generativelanguage.googleapis.com/v1beta/models/' +
          modelName + ':generateContent?key=' + apiKey;

        var res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          var errData = await res.json().catch(function () { return {}; });
          throw new Error(errData.error?.message || ('HTTP ' + res.status));
        }

        var data = await res.json();
        var parts = data.candidates?.[0]?.content?.parts || [];
        var textParts = parts
          .filter(function (p) { return !p.thought && p.text; })
          .map(function (p) { return p.text.trim(); });
        var rawText = textParts.join(' ').trim();

        // Strip accidental markdown code fences
        rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

        var parsed = JSON.parse(rawText);
        if (typeof parsed === 'object' && parsed !== null) {
          return parsed; // Success!
        }
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('Prefetch failed: could not get batch explanation from Gemini AI.');
  }

  // ─── Per-field Fallback Call (original behaviour) ─────────────────────────

  /**
   * Used only when the page-load prefetch failed or the field wasn't included.
   * Identical logic to the original callExplainField().
   */
  async function callExplainField(fieldLabel, fieldContext) {
    var apiKey = await getApiKey();
    if (!apiKey) {
      throw new Error('No Gemini API Key found. Please save your API Key in the extension popup settings.');
    }
    var pageTitle = document.title || 'Government / Scholarship Application Form';
    var activeLangName = getActiveLangName();
    var isEnglish = (getActiveLang() === 'en');
    var langRule = isEnglish
      ? '- Plain English only, 2-3 sentences total.\n'
      : '- Write your reply in ' + activeLangName + ' only. Do not use English. 2-3 sentences total.\n';

    var prompt =
      'You are an assistant helping a user fill an official Indian government or scholarship application form. The user clicked on a form field and wants to know exactly what to enter.\n\n' +
      'Form Page: ' + pageTitle + '\n' +
      'Field Label: "' + fieldLabel + '"\n' +
      'Additional Context: ' + (fieldContext || 'No extra context available.') + '\n\n' +
      'Tell the user:\n' +
      '1. Exactly what to type here (be specific and practical)\n' +
      '2. The correct format or a realistic example (e.g. DD/MM/YYYY, 12-digit number, ABCDE1234F)\n' +
      '3. One common mistake to avoid, if any\n\n' +
      'Rules:\n' +
      langRule +
      '- If it is an Indian government term, briefly explain what it is.\n' +
      '- Give a realistic example value where helpful.\n' +
      '- Keep the reply under 75 words.\n' +
      '- Do NOT use bullet points, JSON, or headings. Write as natural flowing sentences.\n' +
      '- Do NOT start with "This field".\n\n' +
      'Reply with ONLY the explanation text.';


    var payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1000 }
    };

    var lastError = null;

    for (var i = 0; i < GEMINI_MODELS.length; i++) {
      var modelName = GEMINI_MODELS[i];
      try {
        var endpoint =
          'https://generativelanguage.googleapis.com/v1beta/models/' +
          modelName + ':generateContent?key=' + apiKey;

        var res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          var errData = await res.json().catch(function () { return {}; });
          throw new Error(errData.error?.message || ('HTTP ' + res.status));
        }

        var data = await res.json();
        var parts = data.candidates?.[0]?.content?.parts || [];
        var textParts = parts
          .filter(function (p) { return !p.thought && p.text; })
          .map(function (p) { return p.text.trim(); });
        var rawText = textParts.join(' ').trim();
        var finishReason = data.candidates?.[0]?.finishReason || 'UNKNOWN';

        if (rawText && rawText.length >= 35 && finishReason !== 'MAX_TOKENS') {
          return rawText; // Success!
        }
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('Could not get explanation from Gemini AI.');
  }

  // ─── Prefetch Orchestrator ────────────────────────────────────────────────

  /**
   * Called once on page load (and again when new fields appear).
   * Fires a single Gemini request and populates _cache for every field.
   * New fieldKeys not yet in _knownFieldKeys are sent to Gemini.
   */
  async function prefetchFieldExplanations() {
    if (_prefetchPending) return; // already in-flight
    _prefetchPending = true;

    try {
      var pageContext = scrapePageForPrefetch();

      // Only send fields we haven't already cached
      var newFields = pageContext.fieldDescriptors.filter(function (f) {
        return !_knownFieldKeys.has(f.fieldKey) && !_cache.has(f.fieldKey);
      });

      if (newFields.length === 0) {
        _prefetchDone = true;
        return; // nothing new to fetch
      }

      // Update page context to only include new fields
      var contextForNewFields = Object.assign({}, pageContext, { fieldDescriptors: newFields });

      var result = await callPrefetchAllFields(contextForNewFields);

      // Populate cache from the batch response
      var now = Date.now();
      newFields.forEach(function (f) {
        var explanation = result[f.fieldKey];
        if (explanation && typeof explanation === 'string' && explanation.trim().length > 10) {
          _cache.set(f.fieldKey, { explanation: explanation.trim(), timestamp: now, source: 'prefetch' });
        }
        // Track this key regardless so we don't re-request it on the next observer tick
        _knownFieldKeys.add(f.fieldKey);
      });

      // Cache the form summary under a special key
      if (result._formSummary) {
        _cache.set('_formSummary', { explanation: result._formSummary, timestamp: now, source: 'prefetch' });
      }

      _prefetchDone = true;
    } catch (err) {
      // Prefetch failed silently — per-field fallback will handle individual clicks
      _prefetchDone = true; // mark done so handleHelpClick knows to use fallback
    } finally {
      _prefetchPending = false;
    }
  }

  // ─── Button & Tooltip UI ──────────────────────────────────────────────────

  function getOrCreateBtn() {
    var btn = document.getElementById(BTN_ID);
    if (btn) return btn;
    btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.className = 'eg-help-btn';
    btn.setAttribute('aria-label', 'Ask AI to explain this field');
    btn.setAttribute('title', 'Ask AI: What is this field asking for?');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="12" r="10"/>' +
      '<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>' +
      '<circle cx="12" cy="17" r="0.5" fill="currentColor" stroke="none"/>' +
      '</svg>';
    document.body.appendChild(btn);
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      if (_activeField) handleHelpClick(_activeField, btn);
    });
    return btn;
  }

  function positionBtn(fieldEl) {
    var btn = getOrCreateBtn();
    var rect = fieldEl.getBoundingClientRect();
    btn.style.top = (rect.top + rect.height / 2 - 11) + 'px';
    btn.style.left = (rect.right + 6) + 'px';
    btn.classList.add('eg-help-btn-visible');
  }

  function hideBtn() {
    var btn = document.getElementById(BTN_ID);
    if (btn) {
      btn.classList.remove('eg-help-btn-visible');
      btn.classList.remove('eg-help-btn-active');
    }
  }

  function getOrCreateTooltip(fieldEl, key) {
    var safeKey = key.replace(/"/g, '');
    var existing = document.querySelector('.' + TOOLTIP_CLASS + '[data-for-key="' + safeKey + '"]');
    if (existing) return { el: existing, isNew: false };
    var tooltip = document.createElement('div');
    tooltip.className = TOOLTIP_CLASS;
    tooltip.setAttribute('data-for-key', safeKey);
    tooltip.setAttribute('role', 'status');
    tooltip.setAttribute('aria-live', 'polite');
    var group = fieldEl.closest('.form-group, .field-group, .field, li, td') || fieldEl.parentElement;
    (group || fieldEl).insertAdjacentElement('afterend', tooltip);
    return { el: tooltip, isNew: true };
  }

  function showLoading(tooltip) {
    tooltip.className = TOOLTIP_CLASS + ' eg-help-loading';
    tooltip.innerHTML =
      '<div class="eg-help-inner">' +
      '<span class="eg-help-icon">&#129302;</span>' +
      '<div class="eg-help-content">' +
      '<div class="eg-help-dots"><span></span><span></span><span></span></div>' +
      '<p class="eg-help-label">Asking Gemini AI&hellip;</p>' +
      '</div>' +
      '<button type="button" class="eg-help-dismiss" title="Dismiss" aria-label="Close">&#10005;</button>' +
      '</div>';
    var dismissBtn = tooltip.querySelector('.eg-help-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        tooltip.remove();
        var btn = document.getElementById(BTN_ID);
        if (btn) btn.classList.remove('eg-help-btn-active');
      });
    }
  }

  function showResult(tooltip, explanation) {
    tooltip.className = TOOLTIP_CLASS + ' eg-help-ready';
    tooltip.innerHTML =
      '<div class="eg-help-inner">' +
      '<span class="eg-help-icon">&#129302;</span>' +
      '<div class="eg-help-content">' +
      '<p class="eg-help-tag">AI Field Explainer</p>' +
      '<p class="eg-help-text">' + escapeHtml(explanation) + '</p>' +
      '</div>' +
      '<button type="button" class="eg-help-dismiss" title="Dismiss" aria-label="Close">&#10005;</button>' +
      '</div>';
    var dismissBtn = tooltip.querySelector('.eg-help-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        tooltip.remove();
        var btn = document.getElementById(BTN_ID);
        if (btn) btn.classList.remove('eg-help-btn-active');
      });
    }
  }

  function showError(tooltip, message) {
    tooltip.className = TOOLTIP_CLASS + ' eg-help-error';
    tooltip.innerHTML =
      '<div class="eg-help-inner">' +
      '<span class="eg-help-icon">&#9888;&#65039;</span>' +
      '<div class="eg-help-content">' +
      '<p class="eg-help-text">' + escapeHtml(message) + '</p>' +
      '</div>' +
      '<button type="button" class="eg-help-dismiss" aria-label="Close">&#10005;</button>' +
      '</div>';
    var dismissBtn = tooltip.querySelector('.eg-help-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        tooltip.remove();
        var btn = document.getElementById(BTN_ID);
        if (btn) btn.classList.remove('eg-help-btn-active');
      });
    }
  }

  // ─── Help Click Handler ────────────────────────────────────────────────────

  async function handleHelpClick(fieldEl, btn) {
    var key = fieldKey(fieldEl);
    var safeKey = key.replace(/"/g, '');

    // Toggle off if already showing
    var existing = document.querySelector('.' + TOOLTIP_CLASS + '[data-for-key="' + safeKey + '"]');
    if (existing) {
      existing.remove();
      btn.classList.remove('eg-help-btn-active');
      return;
    }

    btn.classList.add('eg-help-btn-active');
    var pair = getOrCreateTooltip(fieldEl, key);
    var tooltip = pair.el;

    // Immediately show loading state for clear visual feedback
    showLoading(tooltip);

    var MIN_LOADING_TIME = 950; // ~1 second for smooth user experience

    // ── Path A: Cache hit (prefetch already done) — display loading for ~1s for UX ──
    var cached = _cache.get(key);
    if (cached && (Date.now() - cached.timestamp < 10 * 60 * 1000)) {
      await new Promise(function (resolve) { setTimeout(resolve, MIN_LOADING_TIME); });
      if (document.body.contains(tooltip)) {
        showResult(tooltip, cached.explanation);
      }
      return;
    }

    // ── Path B: Prefetch still in-flight — wait briefly then check cache ──
    if (_prefetchPending) {
      var prefetchStart = Date.now();
      var waited = 0;
      await new Promise(function (resolve) {
        var poll = setInterval(function () {
          waited += 150;
          var hit = _cache.get(key);
          if (hit || !_prefetchPending || waited >= 8000) {
            clearInterval(poll);
            resolve();
          }
        }, 150);
      });
      // Re-check after waiting
      cached = _cache.get(key);
      if (cached && (Date.now() - cached.timestamp < 10 * 60 * 1000)) {
        var elapsed = Date.now() - prefetchStart;
        if (elapsed < MIN_LOADING_TIME) {
          await new Promise(function (resolve) { setTimeout(resolve, MIN_LOADING_TIME - elapsed); });
        }
        if (document.body.contains(tooltip)) {
          showResult(tooltip, cached.explanation);
        }
        return;
      }
    }

    // ── Path C: Prefetch failed / field not included — per-field fallback ──
    try {
      var callStart = Date.now();
      var label = getFieldLabel(fieldEl);
      var context = buildFieldContext(fieldEl);
      var explanation = await callExplainField(label, context);
      _cache.set(key, { explanation: explanation, timestamp: Date.now(), source: 'fallback' });
      var elapsed = Date.now() - callStart;
      if (elapsed < MIN_LOADING_TIME) {
        await new Promise(function (resolve) { setTimeout(resolve, MIN_LOADING_TIME - elapsed); });
      }
      if (document.body.contains(tooltip)) {
        showResult(tooltip, explanation);
      }
    } catch (err) {
      if (document.body.contains(tooltip)) {
        showError(tooltip, err.message || 'AI explanation failed. Please try again.');
      }
      btn.classList.remove('eg-help-btn-active');
    }
  }

  // ─── Focus / Scroll Listeners ─────────────────────────────────────────────

  var _listenersAttached = false;
  var _mutationObserver = null;
  var _prefetchDebounce = null;

  window.ErrorGuard.FieldHelper = {
    injectHelpButtons: function () {
      // Ensure the button exists in the DOM
      getOrCreateBtn();

      // Only attach listeners once
      if (_listenersAttached) return;
      _listenersAttached = true;

      document.addEventListener('focusin', function (e) {
        var el = e.target;
        if (!el.matches(FIELD_SELECTOR)) return;
        if (el.closest('#error-guard-drawer')) return;
        if (el.id === BTN_ID) return;
        clearTimeout(_hideTimer);
        _activeField = el;
        positionBtn(el);
      }, true);

      document.addEventListener('focusout', function (e) {
        var el = e.target;
        if (!el.matches(FIELD_SELECTOR)) return;
        if (el.closest('#error-guard-drawer')) return;
        _hideTimer = setTimeout(function () {
          _activeField = null;
          hideBtn();
        }, 200);
      }, true);

      window.addEventListener('scroll', function () {
        if (_activeField) positionBtn(_activeField);
      }, { passive: true });

      window.addEventListener('resize', function () {
        if (_activeField) positionBtn(_activeField);
      }, { passive: true });

      // ── Page-load prefetch: fire immediately ──
      prefetchFieldExplanations();

      // ── MutationObserver: re-prefetch when new fields appear (AJAX / multi-step) ──
      _mutationObserver = new MutationObserver(function (mutations) {
        var hasNewFields = mutations.some(function (m) {
          return Array.from(m.addedNodes).some(function (n) {
            if (n.nodeType !== 1) return false;
            // Ignore our own nodes
            if (n.id && n.id.startsWith('eg-')) return false;
            if (n.classList && Array.from(n.classList).some(function (c) { return c.startsWith('eg-'); })) return false;
            // Check if the added node contains any new form fields
            return n.matches && (n.matches(FIELD_SELECTOR) || n.querySelector(FIELD_SELECTOR));
          });
        });

        if (!hasNewFields) return;

        // Debounce to avoid firing on every keystroke-driven DOM update
        clearTimeout(_prefetchDebounce);
        _prefetchDebounce = setTimeout(function () {
          prefetchFieldExplanations();
        }, 1200);
      });

      _mutationObserver.observe(document.body, { childList: true, subtree: true });
    },

    clearAllTooltips: function () {
      document.querySelectorAll('.' + TOOLTIP_CLASS).forEach(function (t) { t.remove(); });
    },

    /**
     * Called by Translator when the user switches language.
     * Clears the explanation cache and re-runs the prefetch so the
     * next batch of explanations comes back in the new language.
     */
    resetForLanguage: function () {
      _cache.clear();
      _knownFieldKeys.clear();
      _prefetchDone = false;
      _prefetchPending = false;
      prefetchFieldExplanations();
    }
  };

})();