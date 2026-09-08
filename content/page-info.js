/**
 * Page Info Module — "Am I in the right place?"
 *
 * Adds an ℹ️ button to the floating Error Guard badge.
 * On click, scrapes the current page's context (URL, title, meta, headings,
 * footer text, visible body copy) and fires ONE Gemini call that returns a
 * structured analysis:
 *   - What this website / page is
 *   - Whether it appears to be a legitimate government / official portal
 *   - What the form on this page is asking for (or what to do here)
 *   - What documents / information the user should have ready
 *   - Any warnings or red flags
 *
 * Results are cached per URL so the panel opens instantly on second click.
 * Respects the active language from the Translator module.
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

  var PANEL_ID = 'eg-pageinfo-panel';
  var BTN_ID = 'eg-pageinfo-btn';

  // ─── State ────────────────────────────────────────────────────────────────

  // Cache per full URL — different pages on the same site may be different forms
  var _cache = new Map();   // url → { info, timestamp }
  var _panelEl = null;
  var _isOpen = false;
  var _isFetching = false;

  // ─── Helpers ──────────────────────────────────────────────────────────────

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

  function getActiveLangName() {
    return (window.ErrorGuard && window.ErrorGuard.Translator &&
      typeof window.ErrorGuard.Translator.getActiveLangName === 'function')
      ? window.ErrorGuard.Translator.getActiveLangName()
      : 'English';
  }

  function getActiveLang() {
    return (window.ErrorGuard && window.ErrorGuard.Translator &&
      typeof window.ErrorGuard.Translator.getActiveLang === 'function')
      ? window.ErrorGuard.Translator.getActiveLang()
      : 'en';
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Page Context Scraper ─────────────────────────────────────────────────

  function scrapePageContext() {
    var url = location.href;
    var hostname = location.hostname;
    var pageTitle = document.title || '';

    // Meta description
    var metaDesc = (document.querySelector('meta[name="description"]') ||
      document.querySelector('meta[property="og:description"]'));
    var description = metaDesc ? (metaDesc.getAttribute('content') || '').trim() : '';

    // Headings (page structure)
    var headings = Array.from(document.querySelectorAll('h1, h2, h3, legend'))
      .map(function (h) { return h.innerText.trim(); })
      .filter(function (t) { return t.length > 1 && t.length < 200; })
      .slice(0, 8)
      .join(' | ');

    // Footer / copyright text (hints at official body)
    var footer = document.querySelector('footer, .footer, #footer, [class*="footer"], [id*="footer"]');
    var footerText = footer
      ? footer.innerText.replace(/\s+/g, ' ').trim().slice(0, 300)
      : '';

    // Any visible government / ministry logos or seals (via alt text)
    var imgAlts = Array.from(document.querySelectorAll('img[alt]'))
      .map(function (img) { return img.getAttribute('alt').trim(); })
      .filter(function (alt) { return alt.length > 3 && alt.length < 120; })
      .slice(0, 10)
      .join(', ');

    // Intro / about text from the page (first significant paragraph)
    var introText = '';
    var paras = Array.from(document.querySelectorAll('main p, .content p, #content p, article p, p'))
      .filter(function (p) {
        if (p.closest('#error-guard-badge, #error-guard-drawer, [class*="eg-"]')) return false;
        return p.innerText.trim().length > 40;
      });
    if (paras.length > 0) {
      introText = paras.slice(0, 3).map(function (p) {
        return p.innerText.replace(/\s+/g, ' ').trim().slice(0, 200);
      }).join(' ... ');
    }

    // Form summary already computed by FieldHelper (reuse if available)
    var formSummaryFromCache = '';
    if (window.ErrorGuard && window.ErrorGuard._pageInfoFormSummary) {
      formSummaryFromCache = window.ErrorGuard._pageInfoFormSummary;
    }

    return {
      url, hostname, pageTitle, description,
      headings, footerText, imgAlts, introText, formSummaryFromCache
    };
  }

  // ─── Gemini Call ─────────────────────────────────────────────────────────

  /**
   * Calls Gemini with full page context.
   * Returns a parsed info object or throws.
   */
  async function callGeminiPageInfo(ctx) {
    var apiKey = await getApiKey();
    var lang = getActiveLangName();
    var isEnglish = (getActiveLang() === 'en');
    var langNote = isEnglish
      ? 'Respond in English.'
      : 'Respond in ' + lang + ' for all text fields except "legitimacyBadge" which must stay in English.';

    var prompt =
      'You are an expert on Indian government and scholarship websites. ' +
      'Analyze the following webpage context and help the user understand where they are and what they need to do.\n\n' +
      'Page URL: ' + ctx.url + '\n' +
      'Domain: ' + ctx.hostname + '\n' +
      'Page Title: "' + ctx.pageTitle + '"\n' +
      (ctx.description ? 'Meta Description: "' + ctx.description + '"\n' : '') +
      (ctx.headings ? 'Page Headings: "' + ctx.headings + '"\n' : '') +
      (ctx.introText ? 'Page Text Excerpt: "' + ctx.introText + '"\n' : '') +
      (ctx.footerText ? 'Footer Text: "' + ctx.footerText.slice(0, 200) + '"\n' : '') +
      (ctx.imgAlts ? 'Logo/Image Labels: "' + ctx.imgAlts + '"\n' : '') +
      (ctx.formSummaryFromCache ? 'Form Summary (pre-computed): "' + ctx.formSummaryFromCache + '"\n' : '') +
      '\n' +
      'Based on the above, provide a structured analysis. ' + langNote + '\n\n' +
      'Return ONLY a valid JSON object with NO markdown or code fences:\n' +
      '{\n' +
      '  "siteName": "Short name of the website or ministry",\n' +
      '  "siteDescription": "One sentence describing what this website is for",\n' +
      '  "isOfficialGovt": true or false,\n' +
      '  "legitimacyBadge": one of: "OFFICIAL_GOVT" | "OFFICIAL_EDU" | "OFFICIAL_BANK" | "UNVERIFIED" | "SUSPICIOUS",\n' +
      '  "legitimacyNote": "One sentence explaining your legitimacy assessment",\n' +
      '  "currentPagePurpose": "What is the user supposed to do on this specific page?",\n' +
      '  "formPurpose": "What is the form on this page asking the user to apply for / submit?",\n' +
      '  "requiredDocuments": ["list", "of", "documents", "user", "needs"],\n' +
      '  "requiredInfo": ["list", "of", "info", "like", "Aadhaar number", "bank account", "etc"],\n' +
      '  "tips": ["One practical tip for filling this form correctly"],\n' +
      '  "warnings": ["Any red flags or things the user should be careful about"],\n' +
      '  "confidence": "HIGH" | "MEDIUM" | "LOW"\n' +
      '}\n' +
      'If information is not available for a field, use an empty string or empty array. Be concise — max 20 words per string value.';

    var payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
    };

    var lastError = null;
    for (var i = 0; i < GEMINI_MODELS.length; i++) {
      try {
        var res = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/' +
          GEMINI_MODELS[i] + ':generateContent?key=' + apiKey,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
        );
        if (!res.ok) {
          var e = await res.json().catch(function () { return {}; });
          throw new Error(e.error?.message || 'HTTP ' + res.status);
        }
        var data = await res.json();
        var text = (data.candidates?.[0]?.content?.parts || [])
          .filter(function (p) { return !p.thought && p.text; })
          .map(function (p) { return p.text.trim(); })
          .join(' ').trim()
          .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

        var parsed = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) return parsed;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('Could not analyze this page. Please try again.');
  }

  // ─── Panel Rendering ──────────────────────────────────────────────────────

  function getLegitimacyConfig(badge) {
    switch (badge) {
      case 'OFFICIAL_GOVT': return { icon: '🏛️', label: 'Official Government Portal', cls: 'eg-pi-legit-govt' };
      case 'OFFICIAL_EDU': return { icon: '🎓', label: 'Official Educational Institution', cls: 'eg-pi-legit-edu' };
      case 'OFFICIAL_BANK': return { icon: '🏦', label: 'Official Banking / Financial Portal', cls: 'eg-pi-legit-bank' };
      case 'SUSPICIOUS': return { icon: '🚨', label: 'Suspicious — Proceed with Caution', cls: 'eg-pi-legit-suspicious' };
      default: return { icon: '❓', label: 'Cannot Verify Official Status', cls: 'eg-pi-legit-unverified' };
    }
  }

  function renderList(items) {
    if (!items || !items.length) return '';
    return '<ul class="eg-pi-list">' +
      items.map(function (item) {
        return '<li class="eg-pi-list-item"><span class="eg-pi-bullet">▸</span>' + escapeHtml(item) + '</li>';
      }).join('') +
      '</ul>';
  }

  function renderPanel(info) {
    var legit = getLegitimacyConfig(info.legitimacyBadge);
    var hasWarnings = info.warnings && info.warnings.length > 0 && info.warnings[0];
    var hasDocs = info.requiredDocuments && info.requiredDocuments.length > 0 && info.requiredDocuments[0];
    var hasInfo = info.requiredInfo && info.requiredInfo.length > 0 && info.requiredInfo[0];
    var hasTips = info.tips && info.tips.length > 0 && info.tips[0];

    return (
      '<div class="eg-pi-header">' +
      '<div class="eg-pi-header-left">' +
      '<span class="eg-pi-site-icon">' + legit.icon + '</span>' +
      '<div class="eg-pi-header-text">' +
      '<strong class="eg-pi-site-name">' + escapeHtml(info.siteName || document.title) + '</strong>' +
      '<span class="eg-pi-url">' + escapeHtml(location.hostname) + '</span>' +
      '</div>' +
      '</div>' +
      '<button type="button" class="eg-pi-close-btn" id="egPageInfoClose" aria-label="Close">✕</button>' +
      '</div>' +

      '<div class="eg-pi-body">' +
      // Legitimacy badge
      '<div class="eg-pi-legit-badge ' + legit.cls + '">' +
      '<span>' + legit.icon + ' ' + escapeHtml(legit.label) + '</span>' +
      (info.legitimacyNote ? '<p class="eg-pi-legit-note">' + escapeHtml(info.legitimacyNote) + '</p>' : '') +
      '</div>' +

      // What this page is for
      (info.currentPagePurpose || info.siteDescription ? (
        '<div class="eg-pi-section">' +
        '<h4 class="eg-pi-section-title">📍 What this page is</h4>' +
        '<p class="eg-pi-section-text">' + escapeHtml(info.currentPagePurpose || info.siteDescription) + '</p>' +
        '</div>'
      ) : '') +

      // Form purpose
      (info.formPurpose ? (
        '<div class="eg-pi-section">' +
        '<h4 class="eg-pi-section-title">📋 What the form is for</h4>' +
        '<p class="eg-pi-section-text">' + escapeHtml(info.formPurpose) + '</p>' +
        '</div>'
      ) : '') +

      // Required documents
      (hasDocs ? (
        '<div class="eg-pi-section">' +
        '<h4 class="eg-pi-section-title">📄 Documents you\'ll need</h4>' +
        renderList(info.requiredDocuments) +
        '</div>'
      ) : '') +

      // Required info
      (hasInfo ? (
        '<div class="eg-pi-section">' +
        '<h4 class="eg-pi-section-title">📝 Information you\'ll need</h4>' +
        renderList(info.requiredInfo) +
        '</div>'
      ) : '') +

      // Tips
      (hasTips ? (
        '<div class="eg-pi-section">' +
        '<h4 class="eg-pi-section-title">💡 Tips</h4>' +
        renderList(info.tips) +
        '</div>'
      ) : '') +

      // Warnings
      (hasWarnings ? (
        '<div class="eg-pi-warnings">' +
        '<h4 class="eg-pi-section-title eg-pi-warn-title">⚠️ Warnings</h4>' +
        renderList(info.warnings) +
        '</div>'
      ) : '') +
      '</div>' +

      '<div class="eg-pi-footer">' +
      '<span class="eg-pi-confidence eg-pi-conf-' + (info.confidence || 'MEDIUM').toLowerCase() + '">' +
      ' AI confidence: ' + (info.confidence || 'MEDIUM') +
      '</span>' +
      '<button type="button" class="eg-pi-retry-btn" id="egPageInfoRetry">↻ Refresh</button>' +
      '</div>'
    );
  }

  function renderLoading() {
    return (
      '<div class="eg-pi-loading">' +
      '<div class="eg-pi-spinner"></div>' +
      '<strong class="eg-pi-loading-title">Analyzing this page…</strong>' +
      '<p class="eg-pi-loading-sub">Gemini AI is checking what this page is and what you\'ll need.</p>' +
      '</div>'
    );
  }

  function renderError(msg) {
    return (
      '<div class="eg-pi-header">' +
      '<span class="eg-pi-site-icon">⚠️</span>' +
      '<div class="eg-pi-header-text">' +
      '<strong class="eg-pi-site-name">Analysis Failed</strong>' +
      '<span class="eg-pi-url">' + escapeHtml(location.hostname) + '</span>' +
      '</div>' +
      '<button type="button" class="eg-pi-close-btn" id="egPageInfoClose" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="eg-pi-body">' +
      '<div class="eg-pi-error-box">' +
      '<p class="eg-pi-error-msg">' + escapeHtml(msg) + '</p>' +
      '<button type="button" class="eg-pi-retry-btn eg-pi-retry-big" id="egPageInfoRetry">↻ Try Again</button>' +
      '</div>' +
      '</div>'
    );
  }

  // ─── Panel Lifecycle ──────────────────────────────────────────────────────

  function positionPanel() {
    if (!_panelEl) return;
    var badge = document.getElementById('error-guard-badge');
    var btn = document.getElementById(BTN_ID);
    var anchor = btn || badge;
    if (!anchor) return;

    var rect = anchor.getBoundingClientRect();
    var badgeRect = badge ? badge.getBoundingClientRect() : rect;

    // Position panel directly to the left of the side-tab badge with 12px margin
    var rightOffset = window.innerWidth - badgeRect.left + 12;
    _panelEl.style.right = rightOffset + 'px';
    _panelEl.style.bottom = 'auto'; // Clear bottom property

    // Reset max-height before measuring to get true natural height
    var viewportH = window.innerHeight;
    _panelEl.style.maxHeight = (viewportH - 32) + 'px';

    // Measure panel height
    var panelHeight = _panelEl.offsetHeight || 520;
    var targetTop = rect.top + (rect.height / 2) - (panelHeight / 2);

    // Keep panel strictly inside visible viewport (minimum 16px from top and bottom)
    var minTop = 16;
    var maxTop = viewportH - panelHeight - 16;
    if (maxTop < minTop) {
      targetTop = minTop;
    } else {
      targetTop = Math.max(minTop, Math.min(targetTop, maxTop));
    }

    _panelEl.style.top = targetTop + 'px';

    // Set strict maxHeight so panel bottom never goes beyond viewport
    var maxAllowed = viewportH - targetTop - 16;
    _panelEl.style.maxHeight = maxAllowed + 'px';
  }

  function attachPanelListeners() {
    var closeBtn = document.getElementById('egPageInfoClose');
    if (closeBtn) closeBtn.addEventListener('click', closePanel);

    var retryBtn = document.getElementById('egPageInfoRetry');
    if (retryBtn) retryBtn.addEventListener('click', function () {
      // Force re-fetch by clearing this URL's cache
      _cache.delete(location.href);
      showPanel();
    });

    if (_panelEl && !_panelEl._wheelAttached) {
      _panelEl._wheelAttached = true;
      _panelEl.addEventListener('wheel', function (e) {
        var body = _panelEl.querySelector('.eg-pi-body');
        if (body && !body.contains(e.target)) {
          body.scrollTop += e.deltaY;
        }
      }, { passive: true });
    }
  }

  function openPanel(html) {
    if (!_panelEl) {
      _panelEl = document.createElement('div');
      _panelEl.id = PANEL_ID;
      _panelEl.className = 'eg-pageinfo-panel';
      document.body.appendChild(_panelEl);
    }
    _panelEl.innerHTML = html;
    _panelEl.style.display = 'flex';
    positionPanel();
    attachPanelListeners();
    _isOpen = true;
    updateBtnState();
  }

  function closePanel() {
    if (_panelEl) {
      _panelEl.style.display = 'none';
      _panelEl.innerHTML = '';
    }
    _isOpen = false;
    updateBtnState();
  }

  function togglePanel() {
    if (_isOpen) { closePanel(); return; }
    showPanel();
  }

  async function showPanel() {
    // Check cache first (5-minute TTL)
    var cached = _cache.get(location.href);
    if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
      openPanel(renderPanel(cached.info));
      return;
    }

    if (_isFetching) return;
    _isFetching = true;

    // Show loading state immediately
    openPanel(renderLoading());

    try {
      var ctx = scrapePageContext();
      var info = await callGeminiPageInfo(ctx);
      _cache.set(location.href, { info: info, timestamp: Date.now() });
      // Re-open with real content and re-calculate position
      if (_panelEl) {
        _panelEl.innerHTML = renderPanel(info);
        positionPanel();
        attachPanelListeners();
      }
    } catch (err) {
      if (_panelEl) {
        _panelEl.innerHTML = renderError(err.message || 'Could not connect to Gemini AI.');
        positionPanel();
        attachPanelListeners();
      }
    } finally {
      _isFetching = false;
    }
  }

  // ─── Button ───────────────────────────────────────────────────────────────

  function updateBtnState() {
    var btn = document.getElementById(BTN_ID);
    if (!btn) return;
    if (_isOpen) {
      btn.classList.add('eg-pi-btn-active');
      btn.title = 'Close page info';
    } else {
      btn.classList.remove('eg-pi-btn-active');
      btn.title = 'What is this page? Am I in the right place?';
    }
  }

  function injectInfoButton() {
    if (document.getElementById(BTN_ID)) return;

    var badge = document.getElementById('error-guard-badge');
    if (!badge) { setTimeout(injectInfoButton, 600); return; }

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = BTN_ID;
    btn.className = 'eg-pageinfo-btn';
    btn.setAttribute('title', 'What is this page? Am I in the right place?');
    btn.setAttribute('aria-label', 'Analyze this page');
    btn.innerHTML = '<span class="eg-tab-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></span><span class="eg-tab-label">Info</span>';

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      togglePanel();
    });

    // Insert before the translate button (or before refresh if translate not present)
    var badgeContent = badge.querySelector('.eg-badge-content');
    if (badgeContent) {
      var translateBtn = badge.querySelector('#eg-translate-btn');
      var refreshBtn = badge.querySelector('#egBadgeRefresh');
      var anchor = translateBtn || refreshBtn;
      if (anchor) badgeContent.insertBefore(btn, anchor);
      else badgeContent.appendChild(btn);
    }

    // Close panel if user clicks outside
    document.addEventListener('click', function (e) {
      if (!_isOpen) return;
      if (_panelEl && _panelEl.contains(e.target)) return;
      if (e.target.id === BTN_ID || btn.contains(e.target)) return;
      closePanel();
    }, true);

    // Reposition on scroll / resize
    window.addEventListener('scroll', function () { if (_isOpen) positionPanel(); }, { passive: true });
    window.addEventListener('resize', function () { if (_isOpen) positionPanel(); }, { passive: true });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  window.ErrorGuard.PageInfo = {
    init: function () {
      setTimeout(injectInfoButton, 500);
    }
  };

})();
