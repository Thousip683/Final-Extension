/**
 * Popup Dashboard Controller
 * Reads validation state from storage/content-script and renders the applicant health overview.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const scoreText = document.getElementById('scoreText');
  const circleProgress = document.getElementById('circleProgress');
  const statusPill = document.getElementById('statusPill');
  const statusHeadline = document.getElementById('statusHeadline');
  const statusDesc = document.getElementById('statusDesc');
  const refreshBtn = document.getElementById('refreshBtn');

  // Checklist row elements
  const chkForm = document.getElementById('chkForm');
  const chkDocUploaded = document.getElementById('chkDocUploaded');
  const chkDocSize = document.getElementById('chkDocSize');
  const chkNameMatch = document.getElementById('chkNameMatch');
  const chkDobMatch = document.getElementById('chkDobMatch');

  // Issues elements
  const issuesContainer = document.getElementById('issuesContainer');
  const issuesCountBadge = document.getElementById('issuesCountBadge');

  function isRestrictedUrl(url) {
    if (!url) return true;
    return (
      url.startsWith('chrome://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('edge://') ||
      url.startsWith('devtools://') ||
      url.startsWith('about:') ||
      url.startsWith('view-source:')
    );
  }

  async function loadStatus() {
    // 1. Try reading from chrome.storage.local
    let report = null;
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        const res = await new Promise(r => chrome.storage.local.get(['ACTIVE_GUARD_REPORT'], r));
        report = res ? res.ACTIVE_GUARD_REPORT : null;
      } catch (e) {}
    }

    // 2. Also query active tab for latest state
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      try {
        const tabs = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
        const activeTab = tabs && tabs[0];

        if (activeTab?.id && !isRestrictedUrl(activeTab.url)) {
          const liveReport = await new Promise((resolve) => {
            chrome.tabs.sendMessage(activeTab.id, { action: 'GET_STATUS' }, (res) => {
              if (chrome.runtime.lastError) {
                // Explicitly check to suppress "Could not establish connection" unchecked error
                resolve(null);
                return;
              }
              resolve(res);
            });
          });

          if (liveReport) {
            renderReport(liveReport);
            return;
          }
        }
      } catch (e) {}
    }

    if (report) {
      renderReport(report);
    } else {
      renderEmptyState();
    }
  }

  function renderReport(report) {
    if (!report) return renderEmptyState();

    const { isReady, healthScore, issues, checklist } = report;

    // 1. Health Score Gauge
    scoreText.textContent = `${healthScore}%`;
    circleProgress.setAttribute('stroke-dasharray', `${healthScore}, 100`);
    circleProgress.className = `circle ${isReady ? 'ready' : 'not-ready'}`;

    // 2. Status Pill & Headline
    if (isReady) {
      statusPill.textContent = 'READY TO SUBMIT';
      statusPill.className = 'hero-status-pill pill-ready';
      statusHeadline.textContent = 'Application Ready';
      statusDesc.textContent = 'All mandatory fields, documents, and identity checks have passed.';
    } else {
      const blockingCount = issues.blocking ? issues.blocking.length : 0;
      statusPill.textContent = `${blockingCount} ACTION REQUIRED`;
      statusPill.className = 'hero-status-pill pill-not-ready';
      statusHeadline.textContent = 'Application Not Ready';
      statusDesc.textContent = `${blockingCount} critical issue(s) will block successful submission.`;
    }

    // 3. Checklist Items
    if (checklist) {
      updateCheckItem(chkForm, checklist.form?.valid);
      updateCheckItem(chkDocUploaded, checklist.document?.uploaded);
      updateCheckItem(chkDocSize, checklist.document?.sizeValid);
      updateCheckItem(chkNameMatch, checklist.verification?.nameMatch);
      updateCheckItem(chkDobMatch, checklist.verification?.dobMatch);
    }

    // 4. Issues List
    const allIssues = issues?.all || [];
    issuesCountBadge.textContent = allIssues.length;

    if (allIssues.length === 0) {
      issuesContainer.innerHTML = `
        <div class="empty-issues">
          <span class="empty-icon">🎉</span>
          <p>No issues detected! Your application is in full compliance with portal rules.</p>
        </div>
      `;
    } else {
      let issuesHtml = '';
      for (const issue of allIssues) {
        const isBlocking = issue.severity === 'BLOCKING';
        issuesHtml += `
          <div class="popup-issue-card ${isBlocking ? 'popup-issue-blocking' : 'popup-issue-warning'}">
            <div class="issue-top">
              <span class="issue-sev">${isBlocking ? 'BLOCKING' : 'WARNING'}</span>
              <span class="issue-code">${issue.code}</span>
            </div>
            <p class="issue-msg">${issue.message}</p>
            ${issue.fix ? `<div class="issue-fix">Fix: ${issue.fix}</div>` : ''}
          </div>
        `;
      }
      issuesContainer.innerHTML = issuesHtml;
    }
  }

  function updateCheckItem(element, state) {
    if (!element) return;
    const icon = element.querySelector('.chk-icon');
    if (state === true) {
      icon.textContent = '✓';
      element.dataset.state = 'valid';
    } else if (state === false) {
      icon.textContent = '×';
      element.dataset.state = 'invalid';
    } else {
      icon.textContent = '○';
      element.dataset.state = 'pending';
    }
  }

  function renderEmptyState() {
    scoreText.textContent = '--%';
    circleProgress.setAttribute('stroke-dasharray', '0, 100');
    statusPill.textContent = 'NO ACTIVE FORM';
    statusHeadline.textContent = 'Standby Mode';
    statusDesc.textContent = 'Navigate to a supported portal or open the scholarship demo portal to scan.';
    issuesContainer.innerHTML = `
      <div class="empty-issues">
          <span class="empty-icon">—</span>
        <p>Open the demo application portal to begin automated pre-submission checking.</p>
      </div>
    `;
  }

  // Refresh / Rescan Button
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.style.transform = 'rotate(180deg)';
    setTimeout(() => refreshBtn.style.transform = '', 300);

    if (typeof chrome !== 'undefined' && chrome.tabs) {
      try {
        const tabs = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
        const activeTab = tabs && tabs[0];
        if (activeTab?.id && !isRestrictedUrl(activeTab.url)) {
          const report = await new Promise((resolve) => {
            chrome.tabs.sendMessage(activeTab.id, { action: 'TRIGGER_RESCAN' }, (res) => {
              if (chrome.runtime.lastError) {
                // Silently consume to suppress unchecked error
                resolve(null);
                return;
              }
              resolve(res);
            });
          });
          if (report) {
            renderReport(report);
            return;
          }
        }
      } catch (e) {}
    }
    loadStatus();
  });

  // ─── AI Vision Settings Controller (Safely guarded if card is present) ───
  const apiKeyInput = document.getElementById('geminiApiKeyInput');
  const toggleKeyBtn = document.getElementById('toggleKeyVisibility');
  const saveKeyBtn = document.getElementById('saveKeyBtn');
  const removeKeyBtn = document.getElementById('removeKeyBtn');
  const aiStatusPill = document.getElementById('aiStatusPill');
  const aiKeyFeedback = document.getElementById('aiKeyFeedback');

  if (apiKeyInput && toggleKeyBtn && saveKeyBtn && removeKeyBtn) {
    function showAiFeedback(msg, type = 'success') {
      if (!aiKeyFeedback) return;
      aiKeyFeedback.textContent = msg;
      aiKeyFeedback.className = `ai-feedback ${type}`;
      aiKeyFeedback.classList.remove('hidden');
      setTimeout(() => {
        aiKeyFeedback.classList.add('hidden');
      }, 4000);
    }

    async function loadAiSettings() {
      let key = '';
      if (window.ErrorGuard && window.ErrorGuard.Storage) {
        key = await window.ErrorGuard.Storage.getGoogleApiKey();
      } else if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const res = await new Promise(r => chrome.storage.local.get(['google_gemini_api_key'], r));
        key = res?.google_gemini_api_key || '';
      }

      if (key && key.trim()) {
        apiKeyInput.value = key.trim();
        if (aiStatusPill) {
          aiStatusPill.textContent = '🟢 Gemini Active';
          aiStatusPill.className = 'ai-status-pill pill-active';
        }
      } else {
        apiKeyInput.value = '';
        if (aiStatusPill) {
          aiStatusPill.textContent = 'Offline Mode';
          aiStatusPill.className = 'ai-status-pill pill-offline';
        }
      }
    }

    // Toggle Visibility
    toggleKeyBtn.addEventListener('click', () => {
      apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
      toggleKeyBtn.textContent = apiKeyInput.type === 'password' ? '👁️' : '🔒';
    });

    // Save & Test Key
    saveKeyBtn.addEventListener('click', async () => {
      const rawVal = apiKeyInput.value.trim();
      if (!rawVal) {
        showAiFeedback('Please enter an API key.', 'error');
        return;
      }

      saveKeyBtn.disabled = true;
      saveKeyBtn.textContent = 'Testing...';

      try {
        let testRes = { valid: true };
        if (window.ErrorGuard && window.ErrorGuard.GoogleVision) {
          testRes = await window.ErrorGuard.GoogleVision.testApiKey(rawVal);
        }

        if (testRes.valid) {
          if (window.ErrorGuard && window.ErrorGuard.Storage) {
            await window.ErrorGuard.Storage.setGoogleApiKey(rawVal);
          } else if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            await new Promise(r => chrome.storage.local.set({ google_gemini_api_key: rawVal }, r));
          }

          if (aiStatusPill) {
            aiStatusPill.textContent = '🟢 Gemini Active';
            aiStatusPill.className = 'ai-status-pill pill-active';
          }
          showAiFeedback('✅ Google Gemini Vision connected & saved!', 'success');
        } else {
          showAiFeedback(`❌ Invalid Key: ${testRes.message}`, 'error');
        }
      } catch (err) {
        showAiFeedback(`Error: ${err.message}`, 'error');
      } finally {
        saveKeyBtn.disabled = false;
        saveKeyBtn.textContent = '⚡ Connect & Save';
      }
    });

    // Remove Key
    removeKeyBtn.addEventListener('click', async () => {
      if (window.ErrorGuard && window.ErrorGuard.Storage) {
        await window.ErrorGuard.Storage.removeGoogleApiKey();
      } else if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await new Promise(r => chrome.storage.local.remove(['google_gemini_api_key'], r));
      }

      apiKeyInput.value = '';
      if (aiStatusPill) {
        aiStatusPill.textContent = 'Offline Mode';
        aiStatusPill.className = 'ai-status-pill pill-offline';
      }
      showAiFeedback('API key removed. Using offline Tesseract OCR.', 'success');
    });

    loadAiSettings();
  }

  // ─── Mode Toggle Controller ───
  const modeCard = document.getElementById('modeCard');
  const modeIcon = document.getElementById('modeIcon');
  const modeBadge = document.getElementById('modeBadge');
  const modeDesc = document.getElementById('modeDesc');
  const modeToggleBtn = document.getElementById('modeToggleBtn');
  const modeToggleBtnIcon = document.getElementById('modeToggleBtnIcon');
  const modeToggleBtnText = document.getElementById('modeToggleBtnText');

  function applyModeUI(isAiMode) {
    if (!modeCard) return;
    if (isAiMode) {
      modeCard.classList.add('mode-ai-active');
      if (modeIcon) modeIcon.textContent = '🤖';
      if (modeBadge) { modeBadge.textContent = 'AI Auto-Fill'; modeBadge.className = 'mode-badge badge-ai'; }
      if (modeDesc) modeDesc.innerHTML = 'AI reads your uploaded documents and <strong>auto-fills matching fields</strong>. Inline highlights and auto-correct chips are active.';
      if (modeToggleBtn) modeToggleBtn.className = 'mode-toggle-btn btn-switch-manual';
      if (modeToggleBtnIcon) modeToggleBtnIcon.textContent = '📋';
      if (modeToggleBtnText) modeToggleBtnText.textContent = 'Switch to Manual Guard';
    } else {
      modeCard.classList.remove('mode-ai-active');
      if (modeIcon) modeIcon.textContent = '📋';
      if (modeBadge) { modeBadge.textContent = 'Manual Guard'; modeBadge.className = 'mode-badge'; }
      if (modeDesc) modeDesc.innerHTML = 'Fill out your form, upload documents, then click <strong>"Check for Errors"</strong> to review issues in the sidebar only.';
      if (modeToggleBtn) modeToggleBtn.className = 'mode-toggle-btn';
      if (modeToggleBtnIcon) modeToggleBtnIcon.textContent = '🤖';
      if (modeToggleBtnText) modeToggleBtnText.textContent = 'Switch to AI Auto-Fill';
    }
  }

  async function loadMode() {
    let isAiMode = false;
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        const res = await new Promise(r => chrome.storage.local.get(['EG_AI_AUTOFILL_MODE'], r));
        isAiMode = res?.EG_AI_AUTOFILL_MODE === true;
      } catch (e) {}
    }
    applyModeUI(isAiMode);
    return isAiMode;
  }

  if (modeToggleBtn) {
    modeToggleBtn.addEventListener('click', async () => {
      let currentIsAi = false;
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
          const res = await new Promise(r => chrome.storage.local.get(['EG_AI_AUTOFILL_MODE'], r));
          currentIsAi = res?.EG_AI_AUTOFILL_MODE === true;
        } catch (e) {}
      }
      const newMode = !currentIsAi;

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
          await new Promise(r => chrome.storage.local.set({ EG_AI_AUTOFILL_MODE: newMode }, r));
        } catch (e) {}
      }

      applyModeUI(newMode);

      if (typeof chrome !== 'undefined' && chrome.tabs) {
        try {
          const tabs = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
          const activeTab = tabs && tabs[0];
          if (activeTab?.id && !isRestrictedUrl(activeTab.url)) {
            chrome.tabs.sendMessage(activeTab.id, { action: 'SET_MODE', aiAutoFillMode: newMode }, () => {
              if (chrome.runtime.lastError) {} // silence error safely
            });
          }
        } catch (e) {}
      }
    });
  }

  loadMode();

  // Initial load
  loadStatus();
});
