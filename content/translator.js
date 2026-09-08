/**
 * AI Translator Module — Form Page Translation
 *
 * Translates all visible text on a form page (labels, headings, button text,
 * placeholders) into the user's chosen Indian language using Gemini AI.
 *
 * Architecture:
 *  - Adds a 🌐 language button to the floating Error Guard badge
 *  - On language select: scrapes text nodes → single Gemini batch call → swaps DOM
 *  - Stores original text so the page can be restored to English at any time
 *  - Persists chosen language to chrome.storage.local
 *  - Shows loading / error banners inline (matching existing eg- UI patterns)
 */

(function () {
  window.ErrorGuard = window.ErrorGuard || {};

  // ─── Constants ────────────────────────────────────────────────────────────

  var DEFAULT_API_KEY = '';

  var GEMINI_MODELS = [
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-flash-latest'
  ];

  // Per-origin map: { 'hostname': 'langCode' } — so each site remembers independently
  var STORAGE_KEY = 'EG_TRANSLATE_LANG_MAP';
  var BANNER_ID = 'eg-translate-banner';
  var BTN_ID = 'eg-translate-btn';

  var LANGUAGES = [
    { code: 'hi', label: 'हिन्दी', name: 'Hindi' },
    { code: 'ta', label: 'தமிழ்', name: 'Tamil' },
    { code: 'te', label: 'తెలుగు', name: 'Telugu' },
    { code: 'kn', label: 'ಕನ್ನಡ', name: 'Kannada' },
    { code: 'ml', label: 'മലയാളം', name: 'Malayalam' },
    { code: 'mr', label: 'मराठी', name: 'Marathi' },
    { code: 'bn', label: 'বাংলা', name: 'Bengali' },
    { code: 'gu', label: 'ગુજરાતી', name: 'Gujarati' },
    { code: 'pa', label: 'ਪੰਜਾਬੀ', name: 'Punjabi' },
    { code: 'or', label: 'ଓଡ଼ିଆ', name: 'Odia' },
    { code: 'en', label: 'English', name: 'English (Original)' }
  ];

  // ─── State ────────────────────────────────────────────────────────────────

  var _currentLang = 'en';   // active language code
  var _isTranslating = false;
  // Map of original text → translated text, keyed by language code
  var _translationCache = {};
  // DOM nodes and their original/translated text saved for in-place swap
  // Entry: { node: TextNode|Element, original: string, attr?: string }
  var _swappedNodes = [];
  var _dropdownEl = null;
  var _dropdownOpen = false;

  // ─── API Key ──────────────────────────────────────────────────────────────

  async function getApiKey() {
    var key = DEFAULT_API_KEY;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        var stored = await new Promise(function (res) {
          chrome.storage.local.get(['google_gemini_api_key'], res);
        });
        if (stored && stored.google_gemini_api_key) key = stored.google_gemini_api_key.trim();
      }
    } catch (_) { }
    return key;
  }

  // ─── Text Collector ───────────────────────────────────────────────────────

  /**
   * Walks the live DOM and collects all translatable text pieces.
   * Returns an array of { id, text, node, attr? } descriptors.
   * IDs are stable integers used as keys in the Gemini JSON response.
   */
  function collectTextUnits() {
    var units = [];
    var idxCounter = 0;

    // Selectors that carry user-visible text we want to translate.
    // Include extension UI elements (eg-*) so error messages and AI text also get translated.
    var LABEL_SELECTORS = [
      'label', 'legend', 'h1', 'h2', 'h3', 'h4', 'h5',
      'button', 'a',
      '.form-label', '.field-label', '.label',
      'th', 'caption',
      'p', 'span', 'li', 'td', 'div'
    ].join(', ');

    // Skip truly non-translatable nodes:
    //   - scripts, styles, hidden elements
    //   - the translator's OWN controls (dropdown, banner, translate btn)
    //     so we don't get into an infinite loop of translating our own UI
    var TRANSLATOR_OWN_IDS = new Set([BTN_ID, BANNER_ID, 'eg-translate-dropdown']);
    function shouldSkipNode(el) {
      if (!el || el.nodeType !== 1) return true;
      var tag = el.tagName;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'CANVAS', 'INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return true;
      // Skip the translator's own UI but NOT the rest of the extension UI
      if (el.id && TRANSLATOR_OWN_IDS.has(el.id)) return true;
      if (el.classList && Array.from(el.classList).some(function (c) { return c.startsWith('eg-tr-'); })) return true;
      var cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
      return false;
    }

    // Collect inline text from a single element (only its own text, not children)
    function addDirectText(el) {
      var children = Array.from(el.childNodes);
      children.forEach(function (child) {
        if (child.nodeType === Node.TEXT_NODE) {
          var raw = child.textContent;
          var trimmed = raw.trim();
          // Skip numbers-only, single chars, empty strings
          if (trimmed.length < 2 || /^\d[\d\s.,/-]*$/.test(trimmed)) return;
          units.push({ id: idxCounter++, text: trimmed, node: child, attr: null });
        }
      });
    }

    // Collect placeholder text
    function addPlaceholders(el) {
      var ph = el.getAttribute('placeholder');
      if (ph && ph.trim().length > 1) {
        units.push({ id: idxCounter++, text: ph.trim(), node: el, attr: 'placeholder' });
      }
    }

    var visited = new Set();
    var candidates = Array.from(document.querySelectorAll(LABEL_SELECTORS));

    candidates.forEach(function (el) {
      if (shouldSkipNode(el)) return;
      if (visited.has(el)) return;
      visited.add(el);
      addDirectText(el);
    });

    // Placeholders on inputs/textareas
    Array.from(document.querySelectorAll('input[placeholder], textarea[placeholder]')).forEach(function (el) {
      if (shouldSkipNode(el)) return;
      addPlaceholders(el);
    });

    // Deduplicate by text content — same string only needs one Gemini translation
    var seen = new Map(); // text → first unit
    units.forEach(function (u) {
      if (!seen.has(u.text)) seen.set(u.text, u.id);
    });

    return { units, uniqueTexts: Array.from(seen.entries()) }; // [[text, id], ...]
  }

  // ─── Gemini Batch Translate ───────────────────────────────────────────────

  /**
   * Sends up to `texts` strings to Gemini and gets back a JSON map { id: translatedText }.
   */
  async function callGeminiTranslate(uniqueTexts, targetLangName) {
    var apiKey = await getApiKey();

    var inputJson = JSON.stringify(
      uniqueTexts.map(function (entry) { return { id: entry[1], text: entry[0] }; }),
      null, 2
    );

    var prompt =
      'You are a professional translator. Translate the following UI text strings from English into ' + targetLangName + '.\n\n' +
      'These strings are from an Indian government or scholarship application form. ' +
      'Preserve the meaning accurately. Keep translations concise — do not add words that were not in the original.\n\n' +
      'Input JSON:\n' + inputJson + '\n\n' +
      'Rules:\n' +
      '  - Return ONLY a valid JSON object mapping each "id" (integer) to its translated string.\n' +
      '  - If a string is a proper noun (e.g. "Aadhaar", "PAN", "OBC", "SEBC") keep it as-is.\n' +
      '  - If a string is already in ' + targetLangName + ', keep it unchanged.\n' +
      '  - Do NOT include any markdown, code fences, or explanation. Output ONLY the JSON.\n\n' +
      'Output format example:\n' +
      '{ "0": "translated text", "1": "another translation", ... }';

    var payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
    };

    var lastError = null;

    for (var i = 0; i < GEMINI_MODELS.length; i++) {
      try {
        var endpoint =
          'https://generativelanguage.googleapis.com/v1beta/models/' +
          GEMINI_MODELS[i] + ':generateContent?key=' + apiKey;

        var res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          var err = await res.json().catch(function () { return {}; });
          throw new Error(err.error?.message || 'HTTP ' + res.status);
        }

        var data = await res.json();
        var parts = (data.candidates?.[0]?.content?.parts || [])
          .filter(function (p) { return !p.thought && p.text; })
          .map(function (p) { return p.text.trim(); });
        var raw = parts.join(' ').trim()
          .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

        var parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) return parsed;
      } catch (e) {
        lastError = e;
      }
    }

    throw lastError || new Error('Translation failed. Please try again.');
  }

  // ─── DOM Swap ─────────────────────────────────────────────────────────────

  /**
   * Applies translated text to all collected units.
   * Saves originals for later restore.
   */
  function applyTranslation(units, translationMap) {
    // translationMap: { id(int/string): translated }
    // Build lookup by id
    var byId = {};
    Object.keys(translationMap).forEach(function (k) { byId[parseInt(k, 10)] = translationMap[k]; });

    // Build dedup lookup: text → translation (for units sharing text)
    var byText = {};
    units.forEach(function (u) {
      var t = byId[u.id];
      if (t) byText[u.text] = t;
    });

    _swappedNodes = [];

    units.forEach(function (u) {
      var translation = byId[u.id] || byText[u.text];
      if (!translation || translation === u.text) return;

      if (u.attr === 'placeholder') {
        var original = u.node.getAttribute('placeholder');
        _swappedNodes.push({ node: u.node, original: original, attr: 'placeholder' });
        u.node.setAttribute('placeholder', translation);
      } else if (u.node.nodeType === Node.TEXT_NODE) {
        var originalText = u.node.textContent;
        _swappedNodes.push({ node: u.node, original: originalText, attr: null });
        // Preserve leading/trailing whitespace that was in the original node
        var leading = originalText.match(/^\s*/)[0];
        var trailing = originalText.match(/\s*$/)[0];
        u.node.textContent = leading + translation + trailing;
      }
    });
  }

  /**
   * Restores the page to its original English text.
   */
  function restoreOriginal() {
    _swappedNodes.forEach(function (entry) {
      try {
        if (entry.attr === 'placeholder') {
          entry.node.setAttribute('placeholder', entry.original);
        } else if (entry.node.nodeType === Node.TEXT_NODE) {
          entry.node.textContent = entry.original;
        }
      } catch (_) { }
    });
    _swappedNodes = [];
  }

  // ─── UI — Loading / Error Banners ─────────────────────────────────────────

  function removeBanner() {
    var old = document.getElementById(BANNER_ID);
    if (old) old.remove();
  }

  function showLoadingBanner(langName) {
    removeBanner();
    var banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.className = 'eg-translate-banner eg-translate-loading';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.innerHTML =
      '<div class="eg-tr-inner">' +
      '<div class="eg-tr-spinner"></div>' +
      '<div class="eg-tr-body">' +
      '<strong class="eg-tr-title">Translating form…</strong>' +
      '<p class="eg-tr-sub">Gemini AI is translating this page into <em>' + langName + '</em>. This takes a few seconds.</p>' +
      '</div>' +
      '</div>';
    document.body.appendChild(banner);
  }

  function showSuccessBanner(langName) {
    removeBanner();
    var banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.className = 'eg-translate-banner eg-translate-success';
    banner.setAttribute('role', 'status');
    banner.innerHTML =
      '<div class="eg-tr-inner">' +
      '<span class="eg-tr-icon">🌐</span>' +
      '<div class="eg-tr-body">' +
      '<strong class="eg-tr-title">Translated to ' + langName + '</strong>' +
      '<p class="eg-tr-sub">All form labels have been translated. Your inputs are unchanged.</p>' +
      '</div>' +
      '<button type="button" class="eg-tr-close eg-tr-restore-btn" id="egTranslateRestoreInline" title="Restore English">Restore English</button>' +
      '<button type="button" class="eg-tr-close" id="egTranslateDismissBanner" aria-label="Close">✕</button>' +
      '</div>';
    document.body.appendChild(banner);

    document.getElementById('egTranslateDismissBanner').addEventListener('click', function () {
      removeBanner();
    });
    document.getElementById('egTranslateRestoreInline').addEventListener('click', function () {
      setLanguage('en');
    });

    // Auto-dismiss after 6 seconds
    setTimeout(function () {
      var b = document.getElementById(BANNER_ID);
      if (b && b.classList.contains('eg-translate-success')) {
        b.classList.add('eg-translate-fade-out');
        setTimeout(removeBanner, 400);
      }
    }, 6000);
  }

  function showErrorBanner(message) {
    removeBanner();
    var banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.className = 'eg-translate-banner eg-translate-error';
    banner.setAttribute('role', 'alert');
    banner.innerHTML =
      '<div class="eg-tr-inner">' +
      '<span class="eg-tr-icon">⚠️</span>' +
      '<div class="eg-tr-body">' +
      '<strong class="eg-tr-title">Translation failed</strong>' +
      '<p class="eg-tr-sub">' + escapeHtml(message) + '</p>' +
      '</div>' +
      '<button type="button" class="eg-tr-close" id="egTranslateErrClose" aria-label="Close">✕</button>' +
      '</div>';
    document.body.appendChild(banner);
    document.getElementById('egTranslateErrClose').addEventListener('click', removeBanner);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Language Dropdown ────────────────────────────────────────────────────

  function buildDropdown(btn) {
    if (_dropdownEl) { closeDropdown(); return; }

    _dropdownOpen = true;
    var dropdown = document.createElement('div');
    dropdown.id = 'eg-translate-dropdown';
    dropdown.className = 'eg-tr-dropdown';
    dropdown.setAttribute('role', 'listbox');
    dropdown.setAttribute('aria-label', 'Select language');

    var header = document.createElement('div');
    header.className = 'eg-tr-dropdown-header';
    header.innerHTML = '<span>🌐 Translate Form</span>';
    dropdown.appendChild(header);

    LANGUAGES.forEach(function (lang) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'eg-tr-lang-item' + (lang.code === _currentLang ? ' eg-tr-lang-active' : '');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', lang.code === _currentLang ? 'true' : 'false');
      item.innerHTML =
        '<span class="eg-tr-lang-script">' + lang.label + '</span>' +
        '<span class="eg-tr-lang-name">' + lang.name + '</span>' +
        (lang.code === _currentLang ? '<span class="eg-tr-lang-check">✓</span>' : '');
      item.addEventListener('click', function () {
        closeDropdown();
        setLanguage(lang.code);
      });
      dropdown.appendChild(item);
    });

    // Position dropdown to the left of the side-tab button
    document.body.appendChild(dropdown);
    _dropdownEl = dropdown;

    // Position it
    var rect = btn.getBoundingClientRect();
    var badge = document.getElementById('error-guard-badge');
    var badgeRect = badge ? badge.getBoundingClientRect() : rect;

    dropdown.style.right = (window.innerWidth - badgeRect.left + 12) + 'px';
    dropdown.style.bottom = 'auto';

    var ddHeight = dropdown.offsetHeight || 280;
    var targetTop = rect.top + (rect.height / 2) - (ddHeight / 2);
    targetTop = Math.max(16, Math.min(targetTop, window.innerHeight - ddHeight - 16));
    dropdown.style.top = targetTop + 'px';

    // Close on outside click
    setTimeout(function () {
      document.addEventListener('click', onOutsideClick, true);
    }, 0);
  }

  function closeDropdown() {
    if (_dropdownEl) {
      _dropdownEl.remove();
      _dropdownEl = null;
    }
    _dropdownOpen = false;
    document.removeEventListener('click', onOutsideClick, true);
  }

  function onOutsideClick(e) {
    if (_dropdownEl && !_dropdownEl.contains(e.target) && e.target.id !== BTN_ID) {
      closeDropdown();
    }
  }

  // ─── Core Translation Flow ────────────────────────────────────────────────

  async function setLanguage(langCode) {
    if (_isTranslating) return;

    var lang = LANGUAGES.find(function (l) { return l.code === langCode; });
    if (!lang) return;

    // Restore to English first (whether switching to English or a new language)
    if (_currentLang !== 'en') {
      restoreOriginal();
    }

    _currentLang = langCode;
    updateBtnState();

    // Persist choice per-origin so other sites are NOT affected
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([STORAGE_KEY], function (res) {
          var map = (res && res[STORAGE_KEY]) || {};
          map[location.hostname] = langCode;
          chrome.storage.local.set({ [STORAGE_KEY]: map });
        });
      }
    } catch (_) { }

    // Clear field-helper explanation cache and any open tooltips so they
    // will be re-fetched in the new language when the user clicks next time
    if (window.ErrorGuard && window.ErrorGuard.FieldHelper) {
      if (typeof window.ErrorGuard.FieldHelper.clearAllTooltips === 'function') {
        window.ErrorGuard.FieldHelper.clearAllTooltips();
      }
      if (typeof window.ErrorGuard.FieldHelper.resetForLanguage === 'function') {
        // Small delay so translation finishes painting before the prefetch fires
        setTimeout(function () {
          window.ErrorGuard.FieldHelper.resetForLanguage();
        }, 800);
      }
    }

    if (langCode === 'en') {
      removeBanner();
      updateBtnState();
      return;
    }

    _isTranslating = true;
    updateBtnState();
    showLoadingBanner(lang.name);

    try {
      // Check cache first
      if (!_translationCache[langCode]) {
        var { units, uniqueTexts } = collectTextUnits();

        if (uniqueTexts.length === 0) {
          removeBanner();
          _isTranslating = false;
          updateBtnState();
          return;
        }

        // Batch translate — split into chunks of 80 to avoid token limits
        var CHUNK = 80;
        var merged = {};
        for (var i = 0; i < uniqueTexts.length; i += CHUNK) {
          var chunk = uniqueTexts.slice(i, i + CHUNK);
          var partial = await callGeminiTranslate(chunk, lang.name);
          Object.assign(merged, partial);
        }

        _translationCache[langCode] = { map: merged, units: units };
      }

      var cached = _translationCache[langCode];
      // Re-collect units because DOM may have changed
      var freshUnits = collectTextUnits().units;
      applyTranslation(freshUnits, cached.map);
      showSuccessBanner(lang.name);
    } catch (err) {
      _currentLang = 'en'; // reset to avoid stuck state
      updateBtnState();
      showErrorBanner(err.message || 'Could not connect to Gemini AI. Check your API key and internet connection.');
    } finally {
      _isTranslating = false;
      updateBtnState();
    }
  }

  // ─── Translate Button in Badge ────────────────────────────────────────────

  function injectTranslateButton() {
    // Avoid duplicate injection
    if (document.getElementById(BTN_ID)) return;

    var badge = document.getElementById('error-guard-badge');
    if (!badge) {
      // Badge not ready yet — retry shortly
      setTimeout(injectTranslateButton, 600);
      return;
    }

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = BTN_ID;
    btn.className = 'eg-translate-btn';
    btn.setAttribute('title', 'Translate this form');
    btn.setAttribute('aria-label', 'Translate form to your language');
    btn.innerHTML = '<span class="eg-tab-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></span><span class="eg-tab-label">Translate</span>';

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      buildDropdown(btn);
    });

    // Insert before the refresh button (last button in badge content)
    var badgeContent = badge.querySelector('.eg-badge-content');
    if (badgeContent) {
      var refreshBtn = badge.querySelector('#egBadgeRefresh');
      if (refreshBtn) {
        badgeContent.insertBefore(btn, refreshBtn);
      } else {
        badgeContent.appendChild(btn);
      }
    }
  }

  function updateBtnState() {
    var btn = document.getElementById(BTN_ID);
    if (!btn) return;

    if (_isTranslating) {
      btn.classList.add('eg-tr-btn-loading');
      btn.innerHTML = '<span class="eg-tab-icon"><span class="eg-tr-btn-spinner"></span></span><span class="eg-tab-label">...</span>';
      btn.disabled = true;
    } else if (_currentLang !== 'en') {
      btn.classList.remove('eg-tr-btn-loading');
      btn.innerHTML = '<span class="eg-tab-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></span><span class="eg-tab-label">Translate</span>';
      btn.disabled = false;
      btn.title = 'Translated to ' + (LANGUAGES.find(function (l) { return l.code === _currentLang; })?.name || _currentLang) + ' — click to change';
      btn.classList.add('eg-tr-btn-active');
    } else {
      btn.classList.remove('eg-tr-btn-loading', 'eg-tr-btn-active');
      btn.innerHTML = '<span class="eg-tab-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></span><span class="eg-tab-label">Translate</span>';
      btn.disabled = false;
      btn.title = 'Translate this form';
    }
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  window.ErrorGuard.Translator = {
    init: function () {
      // Wait for badge to be injected by overlay.js
      setTimeout(injectTranslateButton, 400);

      // Restore the language saved for THIS site (per-origin) on page load
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get([STORAGE_KEY], function (res) {
            var map = (res && res[STORAGE_KEY]) || {};
            var saved = map[location.hostname];
            if (saved && saved !== 'en') {
              // Small delay so the page is fully painted
              setTimeout(function () { setLanguage(saved); }, 1200);
            }
          });
        }
      } catch (_) { }
    },

    /** Returns the current active language code (e.g. 'te', 'hi', 'en'). */
    getActiveLang: function () { return _currentLang; },

    /** Returns the current active language display name (e.g. 'Telugu'). */
    getActiveLangName: function () {
      var lang = LANGUAGES.find(function (l) { return l.code === _currentLang; });
      return lang ? lang.name : 'English';
    }
  };

})();
