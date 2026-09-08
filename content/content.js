/**
 * Main Content Script Orchestrator
 * Connects detector, validators, file watcher, OCR pipeline, matcher,
 * submission guard interceptor, and overlay UI.
 */

(function () {
  const {
    Logger,
    Normalize,
    Storage,
    RuleEngine,
    Detector,
    FormValidator,
    FileValidator,
    ImageQuality,
    OcrEngine,
    DocumentParser,
    Matcher,
    ErrorEngine,
    Overlay
  } = window.ErrorGuard;

  // Each upload control owns its own file, read result and validation state.
  // A page-level singleton made upload #2 reuse upload #1's parsed document.
  const uploadStates = new Map();
  let uploadRunSequence = 0;
  let activeUploadRun = 0;
  let extractedDocData = null;
  let latestReport = null;
  let debounceTimer = null;
  let userHasCheckedErrors = false;

  function uploadSlotKey(input) {
    return input?.id || input?.name || `upload_${Array.from(document.querySelectorAll('input[type="file"]')).indexOf(input)}`;
  }

  function uploadSlotText(input) {
    if (!input) return '';
    const bits = [input.id, input.name, input.getAttribute('aria-label'), input.getAttribute('title'), input.dataset?.expectedDocument];
    if (input.id) bits.push(document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent);
    const block = input.closest('.doc-upload-block, .form-group, .field, section, li, td');
    if (block) bits.push(block.querySelector('.doc-label, label, legend, h1, h2, h3, h4, strong')?.textContent);
    return bits.filter(Boolean).join(' ').toLowerCase();
  }

  function expectedDocumentTypes(input) {
    const profileSlots = RuleEngine.getProfile()?.documentSlots || {};
    const configured = profileSlots[uploadSlotKey(input)] || profileSlots[input?.name];
    if (configured) return (Array.isArray(configured) ? configured : [configured]).map(v => String(v).toUpperCase());
    const declared = input?.dataset?.expectedDocument;
    if (declared) return declared.split(',').map(v => v.trim().toUpperCase()).filter(Boolean);
    const text = uploadSlotText(input);
    if (/pan\b|permanent account/.test(text)) return ['PAN'];
    if (/aadhaar|aadhar|uidai/.test(text)) return ['AADHAAR'];
    if (/income/.test(text) && /certificate|cert/.test(text)) return ['INCOME_CERTIFICATE', 'CERTIFICATE'];
    if (/caste|community/.test(text) && /certificate|cert/.test(text)) return ['CASTE_CERTIFICATE', 'CERTIFICATE'];
    if (/marksheet|mark sheet|academic memo/.test(text)) return ['MARKSHEET'];
    if (/certificate|cert/.test(text)) return ['CERTIFICATE', 'INCOME_CERTIFICATE', 'CASTE_CERTIFICATE'];
    return [];
  }

  function normalizedDocumentType(type, data) {
    const text = String(data?.raw || '').toLowerCase();
    if (/income\s+certificate|annual\s+income/.test(text)) return 'INCOME_CERTIFICATE';
    if (/caste\s+certificate|community\s+certificate/.test(text)) return 'CASTE_CERTIFICATE';
    if (/marksheet|mark\s+sheet|memorandum\s+of\s+marks/.test(text)) return 'MARKSHEET';
    const value = String(type || data?.docType || 'UNKNOWN').toUpperCase();
    if (value !== 'CERTIFICATE') return value;
    return value;
  }

  function typeIssueFor(input, data, confidence) {
    const expected = expectedDocumentTypes(input);
    if (!expected.length) return null;
    const actual = normalizedDocumentType(data?.docType, data);
    const raw = String(data?.raw || '').toLowerCase();
    const hasExplicitTypeEvidence =
      (actual === 'PAN' && (/income\s*tax\s*department|permanent\s+account\s+number/.test(raw) || /\b[A-Z]{5}[0-9]{4}[A-Z]\b/.test(data?.raw || ''))) ||
      (actual === 'AADHAAR' && (/aadhaar|aadhar|unique\s+identification\s+authority|uidai/.test(raw))) ||
      (actual === 'INCOME_CERTIFICATE' && /income\s+certificate|annual\s+income/.test(raw)) ||
      (actual === 'CASTE_CERTIFICATE' && /caste\s+certificate|community\s+certificate/.test(raw)) ||
      (actual === 'MARKSHEET' && /marksheet|mark\s+sheet|memorandum\s+of\s+marks/.test(raw));
    const score = hasExplicitTypeEvidence ? Math.max(Number(confidence) || 0, 0.9) : (Number.isFinite(confidence) ? confidence : 0);
    if (actual === 'UNKNOWN' || actual === 'GENERIC' || score < 0.6) {
      return {
        code: 'DOCUMENT_TYPE_UNCERTAIN', severity: 'WARNING', field: uploadSlotKey(input),
        element: input, expectedTypes: expected, actualType: actual, score,
        message: `Could not confidently confirm that this is the required ${expected.join(' or ').replace(/_/g, ' ')}.`,
        fix: 'Check the selected document and replace it if it is not the document requested by this upload field.'
      };
    }
    const compatible = expected.includes(actual) || (actual.endsWith('_CERTIFICATE') && expected.includes('CERTIFICATE'));
    if (compatible) return null;
    return {
      code: 'WRONG_DOCUMENT_TYPE', severity: 'BLOCKING', field: uploadSlotKey(input),
      element: input, expectedTypes: expected, actualType: actual, score,
      message: `Wrong document: this upload requires ${expected.join(' or ').replace(/_/g, ' ')}, but the selected file was identified as ${actual.replace(/_/g, ' ')}.`,
      fix: `Replace this file with the required ${expected[0].replace(/_/g, ' ')}.`
    };
  }

  function currentUploadStates() {
    return Array.from(uploadStates.values()).filter(state => state.file && state.input?.files?.[0] === state.file);
  }

  function documentFor(type) {
    const states = currentUploadStates().filter(state => state.status === 'ready' && state.data && state.typeIssue?.severity !== 'BLOCKING');
    if (type === 'PAN') return states.find(state => normalizedDocumentType(state.data.docType, state.data) === 'PAN')?.data || null;
    if (type === 'AADHAAR') return states.find(state => normalizedDocumentType(state.data.docType, state.data) === 'AADHAAR')?.data || null;
    if (type === 'CERTIFICATE') return states.find(state => normalizedDocumentType(state.data.docType, state.data).includes('CERTIFICATE'))?.data || null;
    return states.find(state => ['AADHAAR', 'PAN'].includes(normalizedDocumentType(state.data.docType, state.data)))?.data || states[0]?.data || null;
  }

  async function init() {
    Logger.info('ContentScript', 'Pre-Submission Error Guard initializing on page...');

    // 1. Initialize Portal Profile
    const profile = await RuleEngine.init();
    Logger.info('ContentScript', `Loaded rules profile: ${profile.name}`);

    // 2. Initialize In-Page UI Overlay
    Overlay.init();
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['EG_AI_AUTOFILL_MODE'], (res) => {
        if (res && typeof res.EG_AI_AUTOFILL_MODE !== 'undefined') {
          Overlay.setMode(res.EG_AI_AUTOFILL_MODE);
        }
      });
    }

    // 3. Initial Scan and Listener Attachments (Silent evaluation - do NOT show red alerts on blank form)
    runEvaluation({ showAlerts: false });
    attachListeners();
    // AI Field Explainer — inject focus-based help buttons
    if (window.ErrorGuard && window.ErrorGuard.FieldHelper) {
      setTimeout(function () {
        window.ErrorGuard.FieldHelper.injectHelpButtons();
      }, 300);
    }
    // Form Translator — inject 🌐 button into the badge and restore saved language
    if (window.ErrorGuard && window.ErrorGuard.Translator) {
      window.ErrorGuard.Translator.init();
    }
    // Page Info — inject ℹ️ button into the badge
    if (window.ErrorGuard && window.ErrorGuard.PageInfo) {
      window.ErrorGuard.PageInfo.init();
    }

    // 4. Listen for Extension Popup Messages
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'GET_STATUS') {
          sendResponse(latestReport);
        } else if (request.action === 'TRIGGER_RESCAN') {
          userHasCheckedErrors = true;
          runEvaluation({ showAlerts: true }).then(rep => sendResponse(rep));
          return true; // async
        } else if (request.action === 'SET_MODE') {
          if (typeof Overlay !== 'undefined' && Overlay.setMode) {
            Overlay.setMode(request.aiAutoFillMode);
          }
          sendResponse({ success: true, aiAutoFillMode: request.aiAutoFillMode });
        }
      });
    }
  }

  function attachListeners() {
    // Monitor form input events
    document.addEventListener('input', handleFieldInput, true);
    document.addEventListener('change', handleFieldChange, true);

    // Submission Guard: Capture submit events at the window level (capturing phase)
    window.addEventListener('submit', handleFormSubmit, true);
    window.addEventListener('click', handleSubmitButtonClick, true);

    // MutationObserver to detect dynamically inserted form fields
    // Error Guard inserts its own nodes (inline messages, badge, drawer) into the
    // page. Reacting to those would re-run the evaluation, which re-inserts them
    // again — an endless loop that made the inline suggestions flicker. So only
    // changes to the page's own content are considered.
    const isOurNode = (node) => {
      if (!node || node.nodeType !== 1) return false;
      if (node.id && node.id.startsWith('eg-')) return true;
      if (node.classList && Array.from(node.classList).some(c => c.startsWith('eg-'))) return true;
      return typeof node.closest === 'function' && !!node.closest(
        '.eg-inline-tooltip, .eg-drawer, .eg-floating-badge, .eg-field-navigator,' +
        ' .eg-autofill-banner, .eg-ai-loading-banner, .eg-modal-overlay, #error-guard-badge'
      );
    };
    const observer = new MutationObserver((mutations) => {
      const pageChanged = mutations.some(m => {
        if (isOurNode(m.target)) return false;
        const added = Array.from(m.addedNodes).some(n => !isOurNode(n));
        const removed = Array.from(m.removedNodes).some(n => !isOurNode(n));
        return added || removed;
      });
      if (!pageChanged) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runEvaluation({ showAlerts: userHasCheckedErrors }), 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function handleFieldInput(e) {
    const target = e.target;
    if (target.matches('input, select, textarea')) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runEvaluation({ showAlerts: userHasCheckedErrors }), 250);
    }
  }

  async function handleFieldChange(e) {
    const target = e.target;
    if (target.type === 'file') {
      if (target.files && target.files[0]) {
        Logger.info('ContentScript', `File selected: ${target.files[0].name} (${target.files[0].size} bytes)`);
        // Pass the file input element so we can scrape the correct parent form
        await processUploadedFile(target.files[0], target);
      } else {
        uploadStates.delete(target);
        extractedDocData = documentFor('IDENTITY');
        Overlay.hideAutoFillBanner();
        Overlay.hideWrongDocBanner();
        Overlay.clearAiLoading();
        await runEvaluation({ showAlerts: userHasCheckedErrors });
      }
    } else if (target.matches('input, select, textarea')) {
      await runEvaluation({ showAlerts: userHasCheckedErrors });
    }
  }

  /**
   * Checks whether a form control has already been filled/selected by the user
   */
  function isElementFilled(el) {
    if (!el) return false;
    if (el.tagName === 'SELECT') {
      if (el.selectedIndex < 0) return false;
      const opt = el.options[el.selectedIndex];
      if (!opt || opt.disabled) return false;
      const val = (opt.value || '').trim().toLowerCase();
      const txt = (opt.text || opt.textContent || '').trim().toLowerCase();
      if (!val || val === '0' || val === '-1' || val === 'none' || val === 'select' || val === 'choose' || val === 'default' || val === '--select--') {
        return false;
      }
      if (el.selectedIndex === 0 && (txt.includes('select') || txt.includes('choose') || txt.includes('--') || txt === '')) {
        return false;
      }
      return true;
    }
    if (el.type === 'radio' || el.type === 'checkbox') {
      return el.checked;
    }
    return typeof el.value === 'string' && el.value.trim().length > 0;
  }

  /**
   * Intelligently selects the matching option in a <select> element,
   * with special awareness for Gender options (Male/Female/Transgender, M/F, 1/2, Hindi/regional).
   */
  function fillSelect(selectEl, value, semanticType = null) {
    if (!selectEl || !selectEl.options || selectEl.options.length === 0) return false;
    const valStr = String(value == null ? '' : value).trim();
    if (!valStr) return false;
    const valLower = valStr.toLowerCase();
    const isGender = semanticType === 'GENDER' ||
      /gender|\bsex\b/i.test(selectEl.name || selectEl.id || '') ||
      ['male', 'female', 'transgender', 'm', 'f'].includes(valLower);

    let matchedOpt = null;

    if (isGender) {
      if (valLower === 'male' || valLower === 'm') {
        for (const opt of selectEl.options) {
          const oVal = (opt.value || '').trim().toLowerCase();
          const oTxt = (opt.text || opt.textContent || '').trim().toLowerCase();
          if (oVal === 'male' || oTxt === 'male') { matchedOpt = opt; break; }
          if (/\bmale\b/i.test(oTxt) && !/female/i.test(oTxt)) { matchedOpt = opt; break; }
          if (/\bmale\b/i.test(oVal) && !/female/i.test(oVal)) { matchedOpt = opt; break; }
          if (oVal === 'm' || oTxt === 'm') { matchedOpt = opt; break; }
          if (oVal === '1' && (oTxt.includes('male') || oTxt.includes('पुरुष') || !oTxt.includes('female'))) { matchedOpt = opt; break; }
          if (oTxt.includes('पुरुष') || oVal.includes('पुरुष')) { matchedOpt = opt; break; }
        }
      } else if (valLower === 'female' || valLower === 'f') {
        for (const opt of selectEl.options) {
          const oVal = (opt.value || '').trim().toLowerCase();
          const oTxt = (opt.text || opt.textContent || '').trim().toLowerCase();
          if (oVal === 'female' || oTxt === 'female') { matchedOpt = opt; break; }
          if (/female/i.test(oTxt) || /female/i.test(oVal)) { matchedOpt = opt; break; }
          if (oVal === 'f' || oTxt === 'f') { matchedOpt = opt; break; }
          if (oVal === '2' && (oTxt.includes('female') || oTxt.includes('महिला') || !oTxt.includes('male'))) { matchedOpt = opt; break; }
          if (oTxt.includes('महिला') || oVal.includes('महिला')) { matchedOpt = opt; break; }
        }
      } else if (valLower.includes('trans')) {
        for (const opt of selectEl.options) {
          const oVal = (opt.value || '').trim().toLowerCase();
          const oTxt = (opt.text || opt.textContent || '').trim().toLowerCase();
          if (oVal.includes('trans') || oTxt.includes('trans') || oVal === '3') { matchedOpt = opt; break; }
        }
      }
    }

    // Generic fallback for any <select> if not matched by gender logic
    if (!matchedOpt) {
      for (const opt of selectEl.options) {
        if ((opt.value || '').trim().toLowerCase() === valLower) { matchedOpt = opt; break; }
      }
    }
    if (!matchedOpt) {
      for (const opt of selectEl.options) {
        if ((opt.text || opt.textContent || '').trim().toLowerCase() === valLower) { matchedOpt = opt; break; }
      }
    }
    if (!matchedOpt) {
      for (const opt of selectEl.options) {
        const oVal = (opt.value || '').trim().toLowerCase();
        const oTxt = (opt.text || opt.textContent || '').trim().toLowerCase();
        if (oVal && valLower.includes(oVal) && oVal.length >= 2) { matchedOpt = opt; break; }
        if (oTxt && (oTxt.includes(valLower) || valLower.includes(oTxt)) && oTxt.length >= 2) { matchedOpt = opt; break; }
      }
    }

    if (!matchedOpt) return false;

    matchedOpt.selected = true;
    selectEl.selectedIndex = matchedOpt.index;

    // React/Angular setter support
    const prototype = Object.getPrototypeOf(selectEl);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(selectEl, matchedOpt.value);
    } else {
      selectEl.value = matchedOpt.value;
    }

    selectEl.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    selectEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    return true;
  }

  /**
   * Sets the matching radio button in a radio group
   */
  function fillRadioGroup(radioElOrName, value) {
    let radios = [];
    if (typeof radioElOrName === 'string') {
      try {
        radios = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(radioElOrName)}"]`));
      } catch (e) {
        radios = Array.from(document.querySelectorAll(`input[type="radio"][name="${radioElOrName}"]`));
      }
    } else if (radioElOrName && radioElOrName.name) {
      try {
        radios = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(radioElOrName.name)}"]`));
      } catch (e) {
        radios = [radioElOrName];
      }
    } else if (radioElOrName) {
      radios = [radioElOrName];
    }
    if (radios.length === 0) return false;

    const valLower = String(value == null ? '' : value).trim().toLowerCase();

    for (const r of radios) {
      const rVal = (r.value || '').trim().toLowerCase();
      let rLabel = '';
      if (r.id) {
        try {
          const lbl = document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
          if (lbl) rLabel = lbl.textContent.trim().toLowerCase();
        } catch (e) {}
      }
      if (!rLabel && r.parentElement) {
        rLabel = r.parentElement.textContent.trim().toLowerCase();
      }

      let isMatch = false;
      if (valLower === 'male' || valLower === 'm') {
        isMatch = (rVal === 'male' || rVal === 'm' || rVal === '1' ||
                   (/\bmale\b/i.test(rLabel) && !/female/i.test(rLabel)));
      } else if (valLower === 'female' || valLower === 'f') {
        isMatch = (rVal === 'female' || rVal === 'f' || rVal === '2' ||
                   /female/i.test(rLabel));
      } else if (valLower.includes('trans')) {
        isMatch = rVal.includes('trans') || rLabel.includes('trans') || rVal === '3';
      } else {
        isMatch = (rVal === valLower || rLabel.includes(valLower));
      }

      if (isMatch) {
        r.checked = true;
        r.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        r.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        r.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        return true;
      }
    }
    return false;
  }

  /**
   * Sets value on an <input> or <textarea> with React/Angular/native setter support
   */
  function setInputValue(el, value) {
    if (!el) return false;
    const strVal = String(value == null ? '' : value);
    const prototype = Object.getPrototypeOf(el);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, strVal);
    } else {
      el.value = strVal;
    }
    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    return true;
  }

  /**
   * General element filler supporting text, select, radio, checkbox
   */
  function fillElement(el, value, semanticType = null) {
    if (!el || value === null || value === undefined || value === '') return false;

    if (el.tagName === 'SELECT') {
      return fillSelect(el, value, semanticType);
    }

    if (el.type === 'radio') {
      return fillRadioGroup(el, value);
    }

    if (el.type === 'checkbox') {
      const shouldCheck = Boolean(value) && String(value).toLowerCase() !== 'false' && String(value) !== '0';
      el.checked = shouldCheck;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    return setInputValue(el, value);
  }

  /**
   * Helper to find a form control associated with a given label string
   */
  function findFieldByLabel(labelText) {
    if (!labelText || typeof document === 'undefined') return null;
    const cleanLabel = String(labelText).replace(/[*:\s]+/g, ' ').trim().toLowerCase();
    if (!cleanLabel) return null;

    const allLabels = Array.from(document.querySelectorAll('label'));
    for (const lbl of allLabels) {
      const txt = lbl.innerText.replace(/[*:\s]+/g, ' ').trim().toLowerCase();
      if (txt === cleanLabel || txt.includes(cleanLabel) || cleanLabel.includes(txt)) {
        if (lbl.htmlFor) {
          const target = document.getElementById(lbl.htmlFor);
          if (target) return target;
        }
        const inside = lbl.querySelector('select, input, textarea');
        if (inside) return inside;
        const parent = lbl.closest('.form-group, .form-row, .field, div, tr, td');
        if (parent) {
          const inParent = parent.querySelector('select, input:not([type=hidden]), textarea');
          if (inParent && inParent !== lbl) return inParent;
        }
      }
    }
    return null;
  }

  /**
   * Scrapes the form that contains the given file input element.
   * Falls back to the largest form on the page if no parent form is found.
   * Returns a JSON array of field descriptors for Gemini to map against.
   */
  function scrapeTargetForm(fileInputEl) {
    // Strategy 1: walk up to the closest <form> from the file input
    let formEl = fileInputEl ? fileInputEl.closest('form') : null;

    // Strategy 2: pick the form with the most fillable fields
    if (!formEl) {
      const allForms = Array.from(document.querySelectorAll('form'));
      if (allForms.length === 1) {
        formEl = allForms[0];
      } else if (allForms.length > 1) {
        formEl = allForms.reduce((best, f) => {
          const count = f.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea').length;
          const bestCount = best ? best.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea').length : 0;
          return count > bestCount ? f : best;
        }, null);
      }
    }

    // Strategy 3: scan entire document if still nothing found
    const container = formEl || document.body;
    const inputs = container.querySelectorAll(
      'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),' +
      'select, textarea'
    );

    const fields = [];
    const seenRadioNames = new Set();
    let posIndex = 0;

    for (const el of inputs) {
      // Skip file inputs themselves (no text value to fill)
      if (el.type === 'file') continue;
      // Skip checkboxes for now (handled separately by existing validator)
      if (el.type === 'checkbox') continue;

      // Group and represent radio buttons
      if (el.type === 'radio') {
        const radioName = el.name;
        if (!radioName || seenRadioNames.has(radioName)) continue;
        seenRadioNames.add(radioName);

        let groupLabel = '';
        const fieldset = el.closest('fieldset');
        if (fieldset) {
          const legend = fieldset.querySelector('legend');
          if (legend) groupLabel = legend.innerText.replace(/\*/g, '').trim();
        }
        if (!groupLabel) {
          const group = el.closest('div, li, td, .form-group, .field, tr');
          if (group) {
            const lbl = group.querySelector('label, .label, .control-label, strong, b');
            if (lbl) groupLabel = lbl.innerText.replace(/\*/g, '').trim();
          }
        }
        let checkedRadio = null;
        try {
          checkedRadio = container.querySelector(`input[type="radio"][name="${CSS.escape(radioName)}"]:checked`);
        } catch (e) {
          checkedRadio = container.querySelector(`input[type="radio"][name="${radioName}"]:checked`);
        }

        fields.push({
          fieldKey: radioName,
          id: el.id || null,
          name: radioName,
          type: 'radio',
          label: groupLabel || radioName,
          placeholder: null,
          currentValue: checkedRadio ? checkedRadio.value : ''
        });
        continue;
      }

      // Derive a stable fieldKey: prefer id, then name, then positional fallback
      const fieldKey = el.id || el.name || `field_${posIndex++}`;
      try {
        el.setAttribute('data-eg-field-key', fieldKey);
      } catch (e) {}

      // Find the associated label text
      let label = '';
      if (el.id) {
        const labelEl = document.querySelector(`label[for="${el.id}"]`);
        if (labelEl) label = labelEl.innerText.replace(/\*/g, '').trim();
      }
      if (!label) {
        // Look for a label wrapping or immediately preceding the input
        const parentLabel = el.closest('label');
        if (parentLabel) label = parentLabel.innerText.replace(/\*/g, '').trim();
      }
      if (!label) {
        // Check nearest sibling/parent label within a form-group div
        const group = el.closest('div, li, td, .form-group, .field');
        if (group) {
          const siblingLabel = group.querySelector('label');
          if (siblingLabel) label = siblingLabel.innerText.replace(/\*/g, '').trim();
        }
      }

      const currentVal = isElementFilled(el) ? (el.value || '').trim() : '';

      fields.push({
        fieldKey,
        id: el.id || null,
        name: el.name || null,
        type: el.type || el.tagName.toLowerCase(),
        label: label || el.placeholder || fieldKey,
        placeholder: el.placeholder || null,
        currentValue: currentVal
      });
    }

    Logger.info('ContentScript', `Form scraped: ${fields.length} fillable fields found`, fields.map(f => f.fieldKey));
    return fields;
  }

  // Fields that were auto-filled from a less-certain reading and need confirmation.
  let reviewFillNotices = [];

  async function processUploadedFile(file, fileInputEl) {
    const runToken = ++uploadRunSequence;
    activeUploadRun = runToken;
    const previous = uploadStates.get(fileInputEl);
    const generation = (previous?.generation || 0) + 1;
    const state = {
      input: fileInputEl, key: uploadSlotKey(fileInputEl), file, generation,
      status: 'reading', data: null, match: null, fileIssues: [], qualityIssues: [], typeIssue: null
    };
    uploadStates.set(fileInputEl, state);
    reviewFillNotices = reviewFillNotices.filter(notice => notice.uploadKey !== state.key);
    Overlay.hideAutoFillBanner();
    Overlay.hideWrongDocBanner();
    Overlay.clearAiLoading();
    const fileRules = RuleEngine.getFileRules();

    // 1. Fast File Validation (Size, MIME, Extension)
    const attachUploadContext = (issue) => ({
      ...issue,
      field: issue.field || state.key,
      element: issue.element || fileInputEl
    });
    const fileIssues = FileValidator.validate(file, fileRules).map(attachUploadContext);

    // 2. Image Quality & Blur Checks (Canvas API)
    const qualityIssues = (await ImageQuality.analyze(file, fileRules)).map(attachUploadContext);
    if (uploadStates.get(fileInputEl)?.generation !== generation) return;
    state.fileIssues = fileIssues;
    state.qualityIssues = qualityIssues;

    // Hard stop: a blurry or otherwise invalid file is never sent to the
    // on-device reader — reading an unreadable image can only produce
    // misleading values. Report it, end the loading state, and stop here.
    const blockingFileIssue = [...fileIssues, ...qualityIssues]
      .find(issue => issue.severity === 'BLOCKING');
    if (blockingFileIssue) {
      state.status = 'failed';
      Logger.warn('ContentScript', `Upload blocked before reading: ${blockingFileIssue.code}`);
      try {
        await runEvaluation({ showAlerts: true });
      } finally {
        if (uploadStates.get(fileInputEl)?.generation === generation && activeUploadRun === runToken) {
          Overlay.clearAiLoading();
        }
      }
      return;
    }

    // 3. Scrape the target form so the on-device matcher knows the real fields
    const formSchema = scrapeTargetForm(fileInputEl);
    console.log('[ErrorGuard] Form schema scraped for on-device mapping:', formSchema);

    // 4. Read the document on this device (no upload, no API key)
    Overlay.setAiProgress(6, 'Reading document on this device...');
    let ocrResult = { text: '', confidence: 0 };
    let aiFieldMap = null; // { fieldKey: value } produced locally

    try {
      ocrResult = await OcrEngine.extractText(
        file,
        (percent, msg) => {
          if (uploadStates.get(fileInputEl)?.generation === generation && activeUploadRun === runToken) {
            Overlay.setAiProgress(percent, msg);
          }
        },
        formSchema
      );
    } catch (err) {
      Logger.warn('ContentScript', 'On-device reading issue', err);
    }

    if (uploadStates.get(fileInputEl)?.generation !== generation) return;
    state.status = 'validating';
    const fillMap = (ocrResult && ocrResult.match &&
      (ocrResult.match.fillMap || ocrResult.match.fieldMap)) || null;
    if (fillMap && Object.keys(fillMap).length > 0) {
      aiFieldMap = fillMap;
      Logger.info('ContentScript', 'On-device form mapping ready', {
        fields: Object.keys(aiFieldMap).length,
        needsReview: ocrResult.match.reviewCount,
        conflicts: ocrResult.match.conflictCount
      });
      if (ocrResult.match.conflictCount) {
        Logger.warn('ContentScript',
          `${ocrResult.match.conflictCount} value(s) disagree with what is already typed — left untouched for review.`);
      }
    }

    // 5. Structured document data (from the local pipeline's own field candidates)
    const parsedData = DocumentParser.parse(ocrResult.text, ocrResult.docFields);
    parsedData.ocrConfidence = ocrResult.confidence;
    parsedData.classificationConfidence = ocrResult.docFields?.classificationConfidence ?? 0;
    parsedData.onDevice = ocrResult.onDevice !== false;
    parsedData.docType = normalizedDocumentType(parsedData.docType, parsedData);
    if (ocrResult.warning) Logger.warn('ContentScript', ocrResult.warning);
    state.data = parsedData;
    state.match = ocrResult.match || null;
    state.typeIssue = typeIssueFor(fileInputEl, parsedData, parsedData.classificationConfidence);
    state.status = ocrResult.text || ocrResult.docFields ? 'ready' : 'failed';
    extractedDocData = documentFor('IDENTITY') || parsedData;

    console.log('================== [ErrorGuard OCR] RAW TEXT START ==================');
    console.log(parsedData?.raw || ocrResult.text || '(No text extracted)');
    console.log('================== [ErrorGuard OCR] RAW TEXT END ====================');
    console.log('[ErrorGuard] Parsed Document Structure:', parsedData);

    // Augment form mapping if document has a phone number
    if (parsedData.phone) {
      let targetKey = 'phone';
      let targetLabel = 'Mobile Number';
      if (Array.isArray(formSchema)) {
        const phoneField = formSchema.find(f =>
          f.type === 'tel' ||
          /(phone|mobile|contact|telephone|cell|మొబైల్|ఫోన్)/i.test(`${f.fieldKey || ''} ${f.name || ''} ${f.id || ''} ${f.label || ''} ${f.placeholder || ''}`)
        );
        if (phoneField) {
          targetKey = phoneField.fieldKey;
          targetLabel = phoneField.label || 'Mobile Number';
        }
      }
      if (!aiFieldMap) aiFieldMap = {};
      aiFieldMap[targetKey] = parsedData.phone;
      if (!ocrResult.match) ocrResult.match = { fillMap: {}, rows: [] };
      if (!ocrResult.match.fillMap) ocrResult.match.fillMap = {};
      ocrResult.match.fillMap[targetKey] = parsedData.phone;
      if (!Array.isArray(ocrResult.match.rows)) ocrResult.match.rows = [];
      const existingRow = ocrResult.match.rows.find(r => r.fieldKey === targetKey || r.semanticType === 'PHONE');
      if (!existingRow) {
        ocrResult.match.rows.push({
          fieldKey: targetKey,
          label: targetLabel,
          value: parsedData.phone,
          fillable: true,
          needsReview: false,
          conflict: false,
          confidence: 0.95,
          semanticType: 'PHONE'
        });
      } else if (!existingRow.value) {
        existingRow.value = parsedData.phone;
        existingRow.fillable = true;
        existingRow.semanticType = 'PHONE';
      }
    }

    if (state.typeIssue?.severity === 'BLOCKING') {
      aiFieldMap = null;
    }

    // 6. Show Auto-Fill Banner
    if (aiFieldMap) {
      // Build a synthetic docData from the AI field map so the banner's
      // guard check (docData.name / docData.dob / docData.certificateNo / docData.gender / docData.phone) passes.
      // The banner needs at least one non-null value to render.
      const bannerDocData = {
        name: aiFieldMap.fullName || parsedData.name || null,
        dob: aiFieldMap.dob || parsedData.dob || null,
        gender: aiFieldMap.gender || parsedData.gender || null,
        phone: (aiFieldMap && (aiFieldMap.phone || aiFieldMap.mobile)) || parsedData.phone || null,
        certificateNo: (aiFieldMap && (aiFieldMap.aadhaarNumber || aiFieldMap.panNumber || aiFieldMap.certificateNo)) || parsedData.certificateNo || null,
        docType: parsedData.docType || 'DOCUMENT'
      };

      const hasAnyData = bannerDocData.name || bannerDocData.dob || bannerDocData.certificateNo || bannerDocData.gender || bannerDocData.phone;
      if (hasAnyData) {
        // The preview is built from the very rows that will be written, so what the
        // banner promises and what auto-fill does can never disagree.
        const rows = (ocrResult.match && Array.isArray(ocrResult.match.rows)) ? ocrResult.match.rows : [];
        const previewItems = rows
          .filter(row => row.fillable || row.conflict || row.value)
          .map(row => ({
            fieldKey: row.fieldKey,
            label: row.label || row.fieldKey,
            value: row.value,
            needsReview: !!row.needsReview,
            conflict: !!row.conflict,
            confidence: row.confidence
          }));
        Overlay.showAutoFillBanner(
          bannerDocData,
          (excludedKeys) => applyFieldMap(ocrResult.match || { fillMap: aiFieldMap }, excludedKeys),
          null,
          previewItems
        );
      }
    } else {
      // Legacy fallback path: use parsed doc data + semantic matching
      const currentScan = Detector.scan();
      const hasBlanks = currentScan.fields.some(f =>
        f.semantic &&
        (f.semantic.type === 'FULL_NAME' || f.semantic.type === 'DOB' || f.semantic.type === 'CERTIFICATE_NUMBER' || f.semantic.type === 'GENDER' || f.semantic.type === 'PHONE') &&
        !isElementFilled(f.field)
      );
      if (!state.typeIssue || state.typeIssue.severity !== 'BLOCKING') {
        if (hasBlanks && (parsedData.name || parsedData.dob || parsedData.certificateNo || parsedData.gender || parsedData.phone)) {
          Overlay.showAutoFillBanner(parsedData, (excludedKeys) => applyAutoFill(parsedData, excludedKeys));
        }
      }
    }

    // 7. Complete evaluation with newly extracted document data
    try {
      await runEvaluation({ showAlerts: userHasCheckedErrors });
    } finally {
      if (uploadStates.get(fileInputEl)?.generation === generation && activeUploadRun === runToken) {
        Overlay.setAiReady(parsedData);
        if (state.typeIssue?.severity === 'BLOCKING') {
          Overlay.showWrongDocBanner({
            expectedType: state.typeIssue.expectedTypes[0], actualType: state.typeIssue.actualType,
            fileInputEl, fileName: file.name,
            onReplace: () => fileInputEl.click()
          });
        }
      }
    }
    if (uploadStates.get(fileInputEl)?.generation !== generation) return;
  }

  /**
   * Apply AI-generated field map directly by element id/name, data attribute, label, or semantic fallback.
   * Uses robust fillElement with framework & case-insensitive select/radio support.
   * @param {Object} match - match object with { fillMap, rows, reviewMap } or raw field map
   */
  function applyFieldMap(match, excludedKeys = null) {
    if (!match) return;
    const excluded = excludedKeys instanceof Set ? excludedKeys : new Set(Array.isArray(excludedKeys) ? excludedKeys : []);
    const isExcluded = (key, row) => {
      if (!key) return false;
      if (excluded.has(key) || excluded.has(key.toLowerCase())) return true;
      if (row) {
        if (row.fieldKey && (excluded.has(row.fieldKey) || excluded.has(row.fieldKey.toLowerCase()))) return true;
        if (row.label && (excluded.has(row.label) || excluded.has(row.label.toLowerCase()))) return true;
        if (row.semanticType && (excluded.has(row.semanticType) || excluded.has(row.semanticType.toLowerCase()))) return true;
      }
      return false;
    };

    // Accept either the full match result or a plain { fieldKey: value } map.
    const isResult = typeof match === 'object' && (match.fillMap || match.rows);
    const fillMap = isResult ? (match.fillMap || match.fieldMap || {}) : match;
    const reviewMap = (isResult && match.reviewMap) || {};
    const rows = (isResult && Array.isArray(match.rows)) ? match.rows : [];
    const rowFor = (key) => rows.find(r => r.fieldKey === key) || null;

    let filledCount = 0;
    let reviewCount = 0;
    reviewFillNotices = [];

    // Combine fillMap keys and any rows that have a value
    const entriesToProcess = { ...fillMap };
    for (const r of rows) {
      if (r && r.fieldKey && r.value && entriesToProcess[r.fieldKey] === undefined) {
        entriesToProcess[r.fieldKey] = r.value;
      }
    }

    for (const [fieldKey, value] of Object.entries(entriesToProcess)) {
      if (value === null || value === undefined || value === '') continue;

      const row = rowFor(fieldKey);
      if (isExcluded(fieldKey, row)) continue;

      const isGender = (row && row.semanticType === 'GENDER') ||
        /gender|\bsex\b/i.test(fieldKey) ||
        (row && row.label && /gender|\bsex\b/i.test(row.label)) ||
        ['MALE', 'FEMALE', 'TRANSGENDER'].includes(String(value).trim().toUpperCase());

      if (isGender && (excluded.has('gender') || excluded.has('Gender') || excluded.has('GENDER') || excluded.has('sex') || excluded.has('Sex'))) {
        continue;
      }

      const isPhone = (row && row.semanticType === 'PHONE') ||
        /phone|mobile|contact|telephone|cell/i.test(fieldKey) ||
        (row && row.label && /phone|mobile|contact|telephone|cell/i.test(row.label));

      if (isPhone && (excluded.has('phone') || excluded.has('mobile') || excluded.has('Phone') || excluded.has('Mobile') || excluded.has('PHONE') || excluded.has('MOBILE'))) {
        continue;
      }

      // 1. Try getElementById first (most reliable)
      let el = document.getElementById(fieldKey);

      // 2. Try name attribute
      if (!el) {
        try {
          el = document.querySelector(`[name="${CSS.escape(fieldKey)}"]`);
        } catch (e) {
          el = document.querySelector(`[name="${fieldKey}"]`);
        }
      }

      // 3. Try data-eg-field-key set during scrapeTargetForm
      if (!el) {
        try {
          el = document.querySelector(`[data-eg-field-key="${CSS.escape(fieldKey)}"]`);
        } catch (e) {
          el = document.querySelector(`[data-eg-field-key="${fieldKey}"]`);
        }
      }

      // 4. Try finding by row label
      if (!el && row && row.label) {
        el = findFieldByLabel(row.label);
      }

      // 5. Gender-specific fallback search if not found
      if (!el && isGender) {
        el = document.querySelector('select[name*="gender" i], select[id*="gender" i], select[name*="sex" i], select[id*="sex" i]') ||
             document.querySelector('input[name*="gender" i]:not([type=radio]), input[id*="gender" i]:not([type=radio])');
        if (!el) {
          const radio = document.querySelector('input[type="radio"][name*="gender" i], input[type="radio"][name*="sex" i]');
          if (radio) {
            if (fillRadioGroup(radio, value)) {
              filledCount++;
            }
            continue;
          }
        }
      }

      // 5b. Phone-specific fallback search if not found
      if (!el && isPhone) {
        el = document.querySelector('input[type="tel"], input[name*="phone" i], input[name*="mobile" i], input[id*="phone" i], input[id*="mobile" i], input[name*="contact" i], input[id*="contact" i]');
      }

      // 6. Radio group by name fallback
      if (!el) {
        const radios = document.querySelectorAll(`input[type="radio"][name="${fieldKey}"]`);
        if (radios.length > 0) {
          if (fillRadioGroup(fieldKey, value)) {
            filledCount++;
          }
          continue;
        }
      }

      if (!el) continue;

      // Don't overwrite a field the user has genuinely already filled
      if (isElementFilled(el)) continue;

      const semanticType = row?.semanticType || (isGender ? 'GENDER' : (isPhone ? 'PHONE' : null));
      const success = fillElement(el, value, semanticType);
      if (success) {
        filledCount++;
      }

      // Less-certain readings are still filled (the user asked for it) but flagged.
      if (Object.prototype.hasOwnProperty.call(reviewMap, fieldKey) || (row && row.needsReview)) {
        const pct = row && typeof row.confidence === 'number'
          ? `${Math.round(row.confidence * 100)}%` : 'low';
        reviewCount++;
        reviewFillNotices.push({
          code: 'AUTOFILL_NEEDS_REVIEW',
          severity: 'WARNING',
          field: fieldKey,
          elementId: el.id || null,
          message: `Filled "${value}" from your document, but this reading is only ${pct} certain. Please confirm it against the original document before submitting.`,
          documentValue: value,
          score: row && typeof row.confidence === 'number' ? row.confidence : undefined,
          uploadKey: null,
          fix: 'Compare this value with your document and correct it if the reading is wrong.'
        });
      }
    }

    Logger.info('ContentScript', `On-device field map applied: ${filledCount} filled, ${reviewCount} need review`);
    runEvaluation({ showAlerts: userHasCheckedErrors });
  }

  function applyAutoFill(data, excludedKeys = null) {
    if (!data) return;
    const excluded = excludedKeys instanceof Set ? excludedKeys : new Set(Array.isArray(excludedKeys) ? excludedKeys : []);
    const isExcluded = (keys) => keys.some(k => k && (excluded.has(k) || excluded.has(k.toLowerCase()) || excluded.has(k.toUpperCase())));

    const scanResult = Detector.scan();
    let genderFilled = false;
    let phoneFilled = false;

    for (const item of scanResult.fields) {
      if (!item.semantic) continue;
      const sType = item.semantic.type;

      // Don't overwrite a field already filled
      if (isElementFilled(item.field)) continue;

      // FULL_NAME: fill applicant name only — never touch FATHER_NAME fields
      if (sType === 'FULL_NAME' && data.name && !isExcluded(['name', 'fullName', 'FULL_NAME', 'Name', item.field.id, item.field.name])) {
        fillElement(item.field, data.name, 'FULL_NAME');
      }

      // FATHER_NAME / MOTHER_NAME: skip auto-fill — Aadhaar/PAN does not
      // contain parent names in a reliably extractable structured form.
      if (sType === 'FATHER_NAME' || sType === 'MOTHER_NAME') continue;

      if (sType === 'DOB' && data.dob && !isExcluded(['dob', 'DOB', 'dateOfBirth', 'Date of Birth', item.field.id, item.field.name])) {
        const iso = Normalize.date(data.dob);
        const dobVal = item.field.type === 'date' ? (iso || data.dob) : data.dob;
        fillElement(item.field, dobVal, 'DOB');
      }

      if (sType === 'GENDER' && data.gender && !isExcluded(['gender', 'GENDER', 'Gender', 'sex', 'Sex', item.field.id, item.field.name])) {
        fillElement(item.field, data.gender, 'GENDER');
        genderFilled = true;
      }

      if (sType === 'PHONE' && data.phone && !isExcluded(['phone', 'mobile', 'PHONE', 'MOBILE', 'Phone', 'Mobile', item.field.id, item.field.name])) {
        fillElement(item.field, data.phone, 'PHONE');
        phoneFilled = true;
      }

      // CERTIFICATE_NUMBER: only fill when the document is genuinely a
      // certificate — never when it is an Aadhaar or PAN card.
      const isCertDoc = data.docType && !['AADHAAR', 'PAN'].includes(data.docType.toUpperCase());
      if (sType === 'CERTIFICATE_NUMBER' && data.certificateNo && isCertDoc && !isExcluded(['certificateNo', 'CERTIFICATE_NUMBER', 'Certificate No.', item.field.id, item.field.name])) {
        fillElement(item.field, data.certificateNo, 'CERTIFICATE_NUMBER');
      }

      if (sType === 'AADHAAR_NUMBER' && (data.aadhaarNo || (data.docType === 'AADHAAR' && data.certificateNo)) && !isExcluded(['aadhaarNo', 'aadhaarNumber', 'AADHAAR_NUMBER', 'Aadhaar No.', item.field.id, item.field.name])) {
        fillElement(item.field, data.aadhaarNo || data.certificateNo, 'AADHAAR_NUMBER');
      }

      if (sType === 'PAN_NUMBER' && (data.panNo || (data.docType === 'PAN' && data.certificateNo)) && !isExcluded(['panNo', 'panNumber', 'PAN_NUMBER', 'PAN', item.field.id, item.field.name])) {
        fillElement(item.field, data.panNo || data.certificateNo, 'PAN_NUMBER');
      }
    }

    // Gender fallback in case Detector didn't classify the field
    if (data.gender && !genderFilled && !isExcluded(['gender', 'GENDER', 'Gender', 'sex', 'Sex'])) {
      const genderEl = document.querySelector('select[name*="gender" i], select[id*="gender" i], select[name*="sex" i], select[id*="sex" i], input[name*="gender" i]:not([type=radio]), input[id*="gender" i]:not([type=radio])');
      if (genderEl && !isElementFilled(genderEl)) {
        fillElement(genderEl, data.gender, 'GENDER');
      } else {
        const radio = document.querySelector('input[type="radio"][name*="gender" i], input[type="radio"][name*="sex" i]');
        if (radio) {
          fillRadioGroup(radio, data.gender);
        }
      }
    }

    // Phone fallback in case Detector didn't classify the field
    if (data.phone && !phoneFilled && !isExcluded(['phone', 'mobile', 'PHONE', 'MOBILE', 'Phone', 'Mobile'])) {
      const phoneEl = document.querySelector('input[type="tel"], input[name*="phone" i], input[name*="mobile" i], input[id*="phone" i], input[id*="mobile" i], input[name*="contact" i], input[id*="contact" i]');
      if (phoneEl && !isElementFilled(phoneEl)) {
        fillElement(phoneEl, data.phone, 'PHONE');
      }
    }

    runEvaluation({ showAlerts: userHasCheckedErrors });
  }

  // Expose global re-evaluation trigger for manual refresh & on-demand inspection
  window.ErrorGuard.reEvaluate = async function (opts = {}) {
    const showAlerts = (opts && opts.showAlerts !== undefined) ? opts.showAlerts : true;
    if (showAlerts) userHasCheckedErrors = true;
    Logger.info('ContentScript', 'Manual re-scan triggered by user.', { showAlerts });
    return await runEvaluation({ showAlerts, openDrawer: opts && opts.openDrawer });
  };

  async function runEvaluation(options = {}) {
    let cachedFileIssues = null;
    let cachedQualityIssues = null;
    let showAlerts = userHasCheckedErrors;
    let openDrawer = false;

    if (Array.isArray(options)) {
      cachedFileIssues = options;
      cachedQualityIssues = arguments[1] || null;
    } else if (typeof options === 'object' && options !== null) {
      if (options.showAlerts !== undefined) showAlerts = options.showAlerts;
      if (options.openDrawer !== undefined) openDrawer = options.openDrawer;
      cachedFileIssues = options.cachedFileIssues || null;
      cachedQualityIssues = options.cachedQualityIssues || null;
    }

    const scanResult = Detector.scan();
    const profile = RuleEngine.getProfile();
    const fileRules = RuleEngine.getFileRules();

    // Extract Form Key-Value Map
    const formData = {};
    let hasFileInput = false;
    for (const item of scanResult.fields) {
      const val = item.value;
      if (item.semantic) {
        if (item.semantic.type === 'FULL_NAME') formData.full_name = val;
        if (item.semantic.type === 'DOB') formData.dob = val;
        if (item.semantic.type === 'CERTIFICATE_NUMBER') formData.certificate_no = val;
        if (item.semantic.type === 'AADHAAR_NUMBER') formData.aadhaar_no = val;
        if (item.semantic.type === 'PAN_NUMBER') formData.pan_no = val;
        if (item.semantic.type === 'EMAIL') formData.email = val;
        if (item.semantic.type === 'PHONE') formData.phone = val;
        if (item.semantic.type === 'DECLARATION') formData.declaration = item.field.checked;
        if (item.semantic.type === 'FILE_UPLOAD' || (item.field.getAttribute && item.field.getAttribute('type') === 'file')) {
          hasFileInput = true;
        }
      }
      if (item.field.id && val) formData[item.field.id] = val;
      else if (item.field.name && val) formData[item.field.name] = val;
    }
    const activeUploads = currentUploadStates();
    formData.hasFile = activeUploads.length > 0;
    formData.hasFileInput = hasFileInput;

    // 1. Form Level Validation
    const formIssues = FormValidator.validate(scanResult.fields, profile);

    // 2. File Level Validation
    let fileIssues = [];
    let qualityIssues = [];
    if (activeUploads.length) {
      fileIssues = cachedFileIssues || activeUploads.flatMap(state => state.fileIssues || []);
      qualityIssues = cachedQualityIssues || activeUploads.flatMap(state => state.qualityIssues || []);
    }

    // 3. Form <-> Document Cross Verification
    const crossCheckIssues = [];
    const identityDoc = documentFor('IDENTITY');
    const aadhaarDoc = documentFor('AADHAAR');
    const panDoc = documentFor('PAN');
    const certificateDoc = documentFor('CERTIFICATE');
    extractedDocData = identityDoc || aadhaarDoc || panDoc || certificateDoc;
    const typeIssues = activeUploads.map(state => state.typeIssue).filter(Boolean);
    crossCheckIssues.push(...typeIssues);
    if (activeUploads.length && extractedDocData) {
      const crossChecks = RuleEngine.getCrossChecks();
      const rawText = extractedDocData.raw || '';
      const hasRecognizedText = rawText.trim().length >= 10;

      // Check A: Full Name Cross Check
      if (crossChecks.verifyName && formData.full_name) {
        if (extractedDocData.name) {
          const nameComparison = Matcher.compareNames(formData.full_name, extractedDocData.name);
          if (!nameComparison.match) {
            // Also check if form name is elsewhere in document before flagging
            const fullTextSearch = Matcher.searchNameInDocument(formData.full_name, rawText, extractedDocData.lines);
            if (!fullTextSearch.match) {
              const isReview = nameComparison.decision === 'REVIEW' || fullTextSearch.decision === 'REVIEW';
              crossCheckIssues.push({
                code: 'NAME_MISMATCH',
                field: 'FULL_NAME',
                severity: isReview ? 'WARNING' : 'BLOCKING',
                message: isReview
                  ? `Possible name spelling difference: Form says "${formData.full_name}", document shows "${extractedDocData.name}".`
                  : `Name mismatch: Form specifies "${formData.full_name}", but certificate/ID shows "${extractedDocData.name}".`,
                formValue: formData.full_name,
                documentValue: extractedDocData.name,
                score: nameComparison.score || fullTextSearch.score,
                fix: 'Ensure your entered name matches the spelling on your certificate or ID card exactly.'
              });
            }
          }
        } else if (hasRecognizedText) {
          // No explicit name field detected, search full text
          const fullTextSearch = Matcher.searchNameInDocument(formData.full_name, rawText, extractedDocData.lines);
          if (!fullTextSearch.match) {
            const isReview = fullTextSearch.decision === 'REVIEW';
            crossCheckIssues.push({
              code: 'NAME_MISMATCH',
              field: 'FULL_NAME',
              severity: isReview ? 'WARNING' : 'BLOCKING',
              message: isReview
                ? `Possible name spelling difference: Form says "${formData.full_name}", nearest document text says "${fullTextSearch.matchedLine || ''}".`
                : `Name mismatch: Applicant name "${formData.full_name}" was not found on the uploaded document.`,
              formValue: formData.full_name,
              documentValue: fullTextSearch.matchedLine || null,
              score: fullTextSearch.score,
              fix: 'Upload the document belonging to the applicant or correct the name in the form.'
            });
          }
        }
      }

      // Check B: Date of Birth Cross Check
      if (crossChecks.verifyDob && formData.dob) {
        if (extractedDocData.dob) {
          const dobComparison = Matcher.compareDob(formData.dob, extractedDocData.dob);
          if (!dobComparison.match) {
            // Check if form DOB is elsewhere in raw text
            const dobSearch = Matcher.searchDobInDocument(formData.dob, rawText);
            if (!dobSearch.match) {
              crossCheckIssues.push({
                code: 'DOB_MISMATCH',
                field: 'DOB',
                severity: 'BLOCKING',
                message: dobComparison.reason,
                formValue: formData.dob,
                documentValue: extractedDocData.dob,
                fix: 'Check the date of birth on your original certificate/ID card and correct the form.'
              });
            }
          }
        } else if (hasRecognizedText) {
          const dobSearch = Matcher.searchDobInDocument(formData.dob, rawText);
          if (!dobSearch.match) {
            crossCheckIssues.push({
              code: 'DOB_MISMATCH',
              field: 'DOB',
              severity: 'BLOCKING',
              message: dobSearch.reason,
              formValue: formData.dob,
              documentValue: null,
              fix: 'Verify the date of birth on the uploaded document.'
            });
          }
        }
      }

      // Check C: Certificate / ID Number Cross Check
      if (crossChecks.verifyCertificateNo && formData.certificate_no) {
        const docId = certificateDoc?.certificateNo;
        if (docId) {
          const certComp = Matcher.compareIdentifier(formData.certificate_no, docId);
          if (!certComp.match) {
            // Check if normalized ID exists in full text
            const normFormId = Normalize.identifier(formData.certificate_no);
            const normRaw = Normalize.identifier(rawText);
            if (!normRaw.includes(normFormId)) {
              crossCheckIssues.push({
                code: 'IDENTIFIER_MISMATCH',
                field: 'CERTIFICATE_NUMBER',
                severity: 'BLOCKING',
                message: `Identifier mismatch: Form has "${formData.certificate_no}", document shows "${docId}".`,
                fix: 'Double check the certificate or ID number on the document.'
              });
            }
          }
        } else if (hasRecognizedText) {
          const normFormId = Normalize.identifier(formData.certificate_no);
          const normRaw = Normalize.identifier(rawText);
          if (!normRaw.includes(normFormId)) {
            crossCheckIssues.push({
              code: 'IDENTIFIER_MISMATCH',
              field: 'CERTIFICATE_NUMBER',
              severity: 'BLOCKING',
              message: `Certificate/ID number "${formData.certificate_no}" was not found on the uploaded document.`,
              fix: 'Double check the document number entered in the form.'
            });
          }
        }
      }

      // Check C1: Aadhaar Number Cross-Check
      if (formData.aadhaar_no) {
        const docAadhaar = aadhaarDoc?.aadhaarNo || (aadhaarDoc?.docType === 'AADHAAR' ? aadhaarDoc.certificateNo : null);
        if (docAadhaar) {
          const certComp = Matcher.compareIdentifier(formData.aadhaar_no, docAadhaar);
          if (!certComp.match) {
            const normAadhaar = Normalize.identifier(formData.aadhaar_no);
            const normDocAadhaar = Normalize.identifier(docAadhaar);
            if (normAadhaar !== normDocAadhaar) {
              crossCheckIssues.push({
                code: 'IDENTIFIER_MISMATCH',
                field: 'AADHAAR_NUMBER',
                severity: 'BLOCKING',
                message: `Aadhaar Number mismatch: Form specifies "${formData.aadhaar_no}", but verified Aadhaar document has "${docAadhaar}".`,
                formValue: formData.aadhaar_no,
                documentValue: docAadhaar,
                fix: 'Enter the 12-digit Aadhaar number matching your uploaded Aadhaar card.'
              });
            }
          }
        }
      }

      // Check C2: PAN Card Number Cross-Check
      if (formData.pan_no) {
        const docPan = panDoc?.panNo || (panDoc?.docType === 'PAN' ? panDoc.certificateNo : null);
        if (docPan) {
          const certComp = Matcher.compareIdentifier(formData.pan_no, docPan);
          if (!certComp.match) {
            const normPan = Normalize.identifier(formData.pan_no);
            const normDocPan = Normalize.identifier(docPan);
            if (normPan !== normDocPan) {
              crossCheckIssues.push({
                code: 'IDENTIFIER_MISMATCH',
                field: 'PAN_NUMBER',
                severity: 'BLOCKING',
                message: `PAN mismatch: Form specifies "${formData.pan_no}", but verified PAN document shows "${docPan}".`,
                formValue: formData.pan_no,
                documentValue: docPan,
                fix: 'Enter the 10-character PAN number matching your uploaded PAN card.'
              });
            }
          }
        }
      }

      // Check D: Unreadable Document Check
      if (activeUploads.some(state => state.file.type?.startsWith('image/')) && rawText.trim().length < 5) {
        qualityIssues.push({
          code: 'DOCUMENT_LOW_QUALITY',
          severity: 'WARNING',
          message: 'Could not extract text clearly from this document. Please ensure the scan is clear, well-lit, and in focus.',
          fix: 'Upload a clearer or higher-resolution scan of your official document.'
        });
      }
    }

    // 3b. Values auto-filled from an uncertain reading, still awaiting confirmation
    for (const notice of reviewFillNotices) {
      const el = (notice.elementId && document.getElementById(notice.elementId)) ||
        document.querySelector(`[name="${notice.field}"]`);
      if (!el) continue;
      // Once the user edits the value, the note is no longer about their input.
      if (el.value && el.value.trim() === String(notice.documentValue).trim()) {
        crossCheckIssues.push(notice);
      }
    }

    // 4. Aggregate via Error Engine
    latestReport = ErrorEngine.aggregate({
      formIssues,
      fileIssues,
      qualityIssues,
      crossCheckIssues,
      extractedData: extractedDocData,
      formData
    });

    // 5. Update In-Page UI Overlay
    Overlay.update(latestReport, { showAlerts, openDrawer });


    // 5b. Show 1-Click Auto-Correct Chips for Mismatches (only when error alerts are requested)
    Overlay.clearAutoCorrectChips();
    if (showAlerts && extractedDocData) {
      for (const issue of crossCheckIssues) {
        if (issue.code === 'NAME_MISMATCH' && extractedDocData.name) {
          const nameField = scanResult.fields.find(f => f.semantic?.type === 'FULL_NAME');
          if (nameField && nameField.field) {
            Overlay.showAutoCorrectChip(nameField.field, extractedDocData.name, () => {
              nameField.field.value = extractedDocData.name;
              nameField.field.dispatchEvent(new Event('input', { bubbles: true }));
              nameField.field.dispatchEvent(new Event('change', { bubbles: true }));
              runEvaluation({ showAlerts: true });
            });
          }
        }
        if (issue.code === 'DOB_MISMATCH' && extractedDocData.dob) {
          const dobField = scanResult.fields.find(f => f.semantic?.type === 'DOB');
          if (dobField && dobField.field) {
            const iso = Normalize.date(extractedDocData.dob);
            const targetVal = dobField.field.type === 'date' ? (iso || extractedDocData.dob) : extractedDocData.dob;
            Overlay.showAutoCorrectChip(dobField.field, targetVal, () => {
              dobField.field.value = targetVal;
              dobField.field.dispatchEvent(new Event('input', { bubbles: true }));
              dobField.field.dispatchEvent(new Event('change', { bubbles: true }));
              runEvaluation({ showAlerts: true });
            });
          }
        }
      }
    }

    // 6. Persist to Chrome Storage for Popup
    await Storage.set('ACTIVE_GUARD_REPORT', latestReport);

    return latestReport;
  }

  // Pre-Submission Interceptor
  async function handleFormSubmit(e) {
    // Completely ignore any form events originating inside Error Guard's UI
    if (e.target && e.target.closest && e.target.closest('#error-guard-drawer, #error-guard-badge, #error-guard-modal, #eg-autofill-banner, #eg-wrongdoc-banner, #eg-blur-banner, [class*="eg-"], [id*="eg"]')) {
      return;
    }

    userHasCheckedErrors = true;
    // Run evaluation right before submitting with visual alerts active
    const report = await runEvaluation({ showAlerts: true });

    if (report.issues.blocking.length > 0) {
      Logger.warn('SubmissionGuard', 'Blocked form submission due to blocking errors', report.issues.blocking);
      e.preventDefault();
      e.stopImmediatePropagation();
      Overlay.showPreSubmitModal(report);
      return false;
    }

    Logger.info('SubmissionGuard', 'Submission allowed: all checks passed.');
    return true;
  }

  async function handleSubmitButtonClick(e) {
    // 1. Completely ignore clicks originating from any Error Guard UI overlay, drawer, badge, or toolbar
    if (e.target && e.target.closest && e.target.closest('#error-guard-drawer, #error-guard-badge, #error-guard-modal, #eg-autofill-banner, #eg-wrongdoc-banner, #eg-blur-banner, [class*="eg-"], [id*="eg"]')) {
      return;
    }

    const btn = e.target.closest('button, input[type="submit"], [role="button"], a.btn, a.button');
    if (!btn) return;

    if (btn.closest('#error-guard-drawer, #error-guard-badge, #error-guard-modal, #eg-autofill-banner, #eg-wrongdoc-banner, #eg-blur-banner, [class*="eg-"], [id*="eg"]')) {
      return;
    }

    const btnText = (btn.textContent || btn.value || '').toLowerCase().trim();
    const isSubmitOrLogin = btn.type === 'submit' ||
      btnText.includes('submit') || btnText.includes('apply') || btnText.includes('proceed') ||
      btnText.includes('log in') || btnText.includes('login') || btnText.includes('sign in') ||
      btnText.includes('signin') || btnText.includes('continue');

    if (isSubmitOrLogin) {
      userHasCheckedErrors = true;
      const report = await runEvaluation({ showAlerts: true });
      if (report.issues.blocking.length > 0) {
        Logger.warn('SubmissionGuard', 'Blocked submit/login button click', report.issues.blocking);
        e.preventDefault();
        e.stopImmediatePropagation();
        Overlay.showPreSubmitModal(report);
      }
    }
  }

  // Run when document is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
