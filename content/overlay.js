/**
 * In-Page UI Overlay
 * Manages floating guard badge, field-level error highlights,
 * and the pre-submission blocking dialog.
 * Phases 11 & 12 of Build Guide.
 */

(function () {
  window.ErrorGuard = window.ErrorGuard || {};

  class OverlayManager {
    constructor() {
      this.badgeEl = null;
      this.modalEl = null;
      this.drawerEl = null;
      this.highlightedElements = new Set();
      this.currentReport = null;
      this.userHasCheckedErrors = false;
      this.isAiProcessing = false;
      this.aiProgressPercent = 0;
      this.aiProgressMsg = '';
      this.aiDocumentReady = false;
      this.lastAiDocData = null;
      this.aiAutoFillMode = false; // false = Manual Guard, true = AI Auto-Fill
      this.hasForm = true;
      this.onProceedSubmit = null;
      this.currentNavIndex = -1;
    }

    setOnProceedSubmit(callback) {
      this.onProceedSubmit = callback;
    }

    /**
     * Called by content.js when the mode changes (from popup toggle or storage).
     * Mode is still tracked internally for drawer rendering.
     */
    setMode(isAiMode) {
      this.aiAutoFillMode = !!isAiMode;
      // Badge no longer shows status text — nothing to update here
    }

    init() {
      if (document.getElementById('error-guard-badge')) return;

      // 1. Floating Badge
      this.badgeEl = document.createElement('div');
      this.badgeEl.id = 'error-guard-badge';
      this.badgeEl.className = 'eg-floating-badge eg-idle';
      this.badgeEl.innerHTML = `
        <div class="eg-badge-content">
          <div class="eg-badge-brand">
            <span class="eg-tab-icon">
              <svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            </span>
            <span class="eg-tab-label">Guard</span>
          </div>
          <button
            type="button"
            class="eg-badge-check-btn"
            id="egBadgeCheckBtn"
            data-tooltip="Check for Errors"
            title="Inspect Form for Pre-Submission Errors"
          >
            <span class="eg-tab-icon">
              <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </span>
            <span class="eg-tab-label">Check</span>
          </button>
        </div>
      `;
      document.body.appendChild(this.badgeEl);


      const checkBtn = document.getElementById('egBadgeCheckBtn');
      if (checkBtn) {
        checkBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          this.userHasCheckedErrors = true;
          if (window.ErrorGuard && window.ErrorGuard.reEvaluate) {
            await window.ErrorGuard.reEvaluate({ showAlerts: true, openDrawer: true });
          }
        });
      }

      this.badgeEl.addEventListener('click', (e) => {
        if (e.target.closest('#egBadgeCheckBtn')) return;
        if (!this.hasForm) {
          this.toggleStandbyPopover();
          return;
        }
        this.userHasCheckedErrors = true;
        if (window.ErrorGuard && window.ErrorGuard.reEvaluate) {
          window.ErrorGuard.reEvaluate({ showAlerts: true, openDrawer: true });
        } else {
          this.toggleDrawer();
        }
      });

      const handleRefreshClick = async (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        const icon = btn.querySelector('.eg-refresh-icon');
        if (icon) {
          icon.classList.add('eg-spinning');
        } else {
          btn.classList.add('eg-spinning');
        }
        btn.style.pointerEvents = 'none';
        try {
          this.userHasCheckedErrors = true;
          if (window.ErrorGuard && window.ErrorGuard.reEvaluate) {
            await window.ErrorGuard.reEvaluate({ showAlerts: true });
          }
        } finally {
          setTimeout(() => {
            if (icon) icon.classList.remove('eg-spinning');
            btn.classList.remove('eg-spinning');
            btn.style.pointerEvents = '';
          }, 450);
        }
      };


      // 2. Slide-out Quick Drawer
      this.drawerEl = document.createElement('div');
      this.drawerEl.id = 'error-guard-drawer';
      this.drawerEl.className = 'eg-drawer eg-drawer-closed';
      this.drawerEl.innerHTML = `
        <div class="eg-drawer-header">
          <div class="eg-drawer-title">
            <span>🛡️ Pre-Submission Error Guard</span>
          </div>
          <div class="eg-drawer-header-actions">
            <button type="button" class="eg-drawer-refresh-btn" id="egDrawerRefresh" title="Re-scan Form">
              <span class="eg-refresh-icon">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
                </svg>
              </span>
              <span class="eg-refresh-text">Refresh</span>
            </button>
            <button type="button" class="eg-drawer-close" id="egDrawerClose" title="Close Drawer" aria-label="Close">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
        <div class="eg-field-navigator" id="egFieldNavigator">
          <div class="eg-nav-info">
            <span class="eg-nav-icon">🧭</span>
            <div class="eg-nav-text">
              <span class="eg-nav-label" id="egNavLabel">Field Navigator</span>
              <span class="eg-nav-counter" id="egNavCounter">0 of 0 fields</span>
            </div>
          </div>
          <div class="eg-nav-buttons">
            <button type="button" class="eg-nav-btn" id="egNavPrevBtn" title="Jump to Previous Field" disabled>
              ◀ Prev
            </button>
            <button type="button" class="eg-nav-btn" id="egNavNextBtn" title="Jump to Next Field" disabled>
              Next ▶
            </button>
          </div>
        </div>
        <div class="eg-drawer-body" id="egDrawerBody">
          <!-- Populated dynamically -->
        </div>
      `;
      document.body.appendChild(this.drawerEl);

      document.getElementById('egDrawerRefresh').addEventListener('click', handleRefreshClick);

      document.getElementById('egDrawerClose').addEventListener('click', () => {
        this.closeDrawer();
      });

      document.getElementById('egNavPrevBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.navigatePreviousField();
      });

      document.getElementById('egNavNextBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.navigateNextField();
      });

      document.addEventListener('focusin', (e) => {
        if (!e.target) return;
        if (e.target.closest && e.target.closest('#error-guard-drawer, #error-guard-badge, #error-guard-modal, #eg-autofill-banner, #eg-wrongdoc-banner, #eg-blur-banner')) {
          return;
        }
        const fields = this.getVisibleFormFields();
        const idx = fields.indexOf(e.target);
        if (idx !== -1) {
          this.currentNavIndex = idx;
          this.updateFieldNavigator();
        }
      });

      // 3. Pre-Submit Interception Modal
      this.modalEl = document.createElement('div');
      this.modalEl.id = 'error-guard-modal';
      this.modalEl.className = 'eg-modal-overlay eg-modal-hidden';
      this.modalEl.innerHTML = `
        <div class="eg-modal-box">
          <div class="eg-modal-header">
            <div class="eg-modal-title">
              <span class="eg-modal-shield"> </span>
              <div>
                <h3>Submission Blocked by Error Guard</h3>
                <p>Avoidable errors detected in your application before submission.</p>
              </div>
            </div>
            <button type="button" class="eg-modal-close" id="egModalClose">✕</button>
          </div>
          <div class="eg-modal-body" id="egModalIssues">
            <!-- Issues list -->
          </div>
          <div class="eg-modal-footer">
            <button type="button" class="eg-btn eg-btn-secondary" id="egModalReviewBtn">
              🔍 Review & Fix Errors
            </button>
            <button type="button" class="eg-btn eg-btn-override" id="egModalProceedBtn">
              ⚠️ Proceed & Submit Anyway →
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(this.modalEl);

      document.getElementById('egModalClose').addEventListener('click', () => {
        this.hideModal();
      });

      document.getElementById('egModalReviewBtn').addEventListener('click', () => {
        this.hideModal();
        this.openDrawer();
      });

      document.getElementById('egModalProceedBtn').addEventListener('click', () => {
        this.hideModal();
        if (typeof this.onProceedSubmit === 'function') {
          this.onProceedSubmit();
        }
      });
    }

    setAiProgress(percent, msg) {
      this.isAiProcessing = true;
      this.aiProgressPercent = Math.max(this.aiProgressPercent && this.aiProgressPercent < 100 ? this.aiProgressPercent : 0, percent || 0);
      if (msg) this.aiProgressMsg = msg;
      if (!this.badgeEl) this.init();

      this.updateProgressUI(this.aiProgressPercent, this.aiProgressMsg);

      if (this.aiProgressPercent < 100) {
        this.startProgressTicker();
      } else {
        this.stopProgressTicker();
      }
    }

    startProgressTicker() {
      if (this.aiProgressTimer) return;
      this.aiProgressTimer = setInterval(() => {
        if (!this.isAiProcessing || this.aiProgressPercent >= 96) {
          return;
        }

        // Increment naturally: faster early on, pacing down near 95%
        const remaining = 96 - this.aiProgressPercent;
        const step = remaining > 35 ? 2 : (remaining > 10 ? 1 : (Math.random() > 0.4 ? 1 : 0));
        this.aiProgressPercent += step;

        let dynamicMsg = this.aiProgressMsg;
        if (this.aiProgressPercent >= 25 && this.aiProgressPercent < 50) {
          dynamicMsg = 'Reading document text & layout on this device...';
        } else if (this.aiProgressPercent >= 50 && this.aiProgressPercent < 72) {
          dynamicMsg = 'Extracting applicant particulars & identification numbers...';
        } else if (this.aiProgressPercent >= 72 && this.aiProgressPercent < 88) {
          dynamicMsg = 'Matching extracted details with application form fields...';
        } else if (this.aiProgressPercent >= 88) {
          dynamicMsg = 'Finalizing field matches & quality checks...';
        }

        this.updateProgressUI(this.aiProgressPercent, dynamicMsg);
      }, 150);
    }

    stopProgressTicker() {
      if (this.aiProgressTimer) {
        clearInterval(this.aiProgressTimer);
        this.aiProgressTimer = null;
      }
    }

    updateProgressUI(percent, msg) {
      const badgeStatus = document.getElementById('egBadgeStatus');
      if (badgeStatus) {
        badgeStatus.innerHTML = `<span class="eg-ai-pulse">🔒</span> Reading on device... ${percent}%`;
      }
      if (this.badgeEl) {
        this.badgeEl.className = 'eg-floating-badge eg-ai-analyzing';
      }
      const checkBtn = document.getElementById('egBadgeCheckBtn');
      if (checkBtn) checkBtn.style.display = 'none';

      // Live update the drawer loading screen if open
      if (this.drawerEl && this.drawerEl.classList.contains('eg-drawer-open')) {
        const drawerScore = document.getElementById('egDrawerScore');
        if (drawerScore) {
          drawerScore.textContent = `Reading ${percent}%`;
          drawerScore.className = 'eg-health-tag eg-tag-ai';
        }
        const barFill = this.drawerEl.querySelector('.eg-loading-bar-fill');
        if (barFill) barFill.style.width = `${percent}%`;
        const percentText = this.drawerEl.querySelector('.eg-loading-percent');
        if (percentText) percentText.textContent = `${percent}% Completed`;
        const subtext = this.drawerEl.querySelector('.eg-drawer-loading-subtext');
        if (subtext && msg) subtext.textContent = msg;
      }

      // Live update floating loading banner so the user clearly sees increasing numbers
      this.showAiLoadingBanner(percent, msg);
    }

    setAiReady(docData) {
      this.stopProgressTicker();
      this.isAiProcessing = false;
      this.aiProgressPercent = 0;
      this.aiProgressMsg = '';
      this.aiDocumentReady = true;
      this.lastAiDocData = docData;
      this.hideAiLoadingBanner();
      if (!this.badgeEl) this.init();
      const checkBtn = document.getElementById('egBadgeCheckBtn');
      if (checkBtn && !this.userHasCheckedErrors) checkBtn.style.display = 'inline-flex';
      const badgeStatus = document.getElementById('egBadgeStatus');
      if (!this.userHasCheckedErrors) {
        if (badgeStatus) {
          badgeStatus.innerHTML = this.aiAutoFillMode
            ? `✓ Document read • Click Auto-Fill`
            : `✓ Document read • Click Check`;
        }
        if (this.badgeEl) {
          this.badgeEl.className = 'eg-floating-badge eg-ai-ready';
        }
      }
      // Reading is finished: if the drawer is open it must stop showing the
      // "100% Complete / waiting" loading box and paint the real audit now.
      this.refreshOpenDrawer();
    }

    refreshOpenDrawer() {
      if (!this.drawerEl || !this.drawerEl.classList.contains('eg-drawer-open')) return;
      if (this.currentReport) {
        this.renderDrawerContent(this.currentReport, this.userHasCheckedErrors);
      }
      const drawerScore = document.getElementById('egDrawerScore');
      if (drawerScore && this.aiDocumentReady) {
        drawerScore.textContent = 'Document read ✓';
        drawerScore.className = 'eg-health-tag eg-tag-ready';
      }
    }

    clearAiLoading() {
      this.stopProgressTicker();
      this.isAiProcessing = false;
      this.aiProgressPercent = 0;
      this.aiProgressMsg = '';
      this.hideAiLoadingBanner();
      const checkBtn = document.getElementById('egBadgeCheckBtn');
      if (checkBtn && !this.userHasCheckedErrors) checkBtn.style.display = 'inline-flex';
      this.refreshOpenDrawer();
    }

    showDrawerLoading(title, message, percent) {
      this.isAiProcessing = true;
      if (percent !== undefined) this.aiProgressPercent = percent;
      if (message) this.aiProgressMsg = message;
      if (!this.drawerEl) this.init();
      this.openDrawer();
      const body = document.getElementById('egDrawerBody');
      const drawerScore = document.getElementById('egDrawerScore');
      if (drawerScore) {
        drawerScore.textContent = `Reading ${this.aiProgressPercent || 30}%`;
        drawerScore.className = 'eg-health-tag eg-tag-ai';
      }
      if (body) {
        body.innerHTML = `
          <div class="eg-status-banner eg-banner-ai-loading">
            <h4>⚡ ${title || 'On-device verification in progress'}</h4>
            <p>${message || this.aiProgressMsg || 'Reading the uploaded document on this device...'}</p>
          </div>
          <div class="eg-drawer-loading-box">
            <div class="eg-drawer-spinner-ring"></div>
            <h4 class="eg-drawer-loading-title">${title || 'Reading document on this device'}</h4>
            <p class="eg-drawer-loading-subtext">
              ${message || this.aiProgressMsg || 'Extracting structured details and matching against form fields...'}
            </p>
            <div class="eg-loading-bar-wrap">
              <div class="eg-loading-bar-fill" style="width: ${this.aiProgressPercent || 30}%;"></div>
            </div>
            <div class="eg-loading-percent">${this.aiProgressPercent || 30}% Completed</div>
            <div class="eg-loading-notice">
              ⏳ Waiting for on-device reading to finish before finalizing verification. The audit will display immediately.
            </div>
          </div>
        `;
      }
    }

    showAiLoadingBanner(percent, msg) {
      let banner = document.getElementById('eg-ai-loading-banner');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'eg-ai-loading-banner';
        banner.className = 'eg-ai-loading-banner';
        banner.innerHTML = `
          <div class="eg-ai-loading-content">
            <div class="eg-ai-loading-left">
              <span class="eg-ai-pulse" style="font-size: 1.3rem;">⚡</span>
              <div>
                <div class="eg-ai-loading-title">
                  <strong>Reading Document On This Device</strong>
                  <span class="eg-ai-loading-badge" id="egAiLoadingPercent">${percent}%</span>
                </div>
                <p class="eg-ai-loading-desc" id="egAiLoadingDesc">${msg || 'Reading document & preparing auto-fill...'}</p>
              </div>
            </div>
            <div class="eg-ai-loading-spinner"></div>
          </div>
          <div class="eg-ai-loading-bar-wrap">
            <div class="eg-ai-loading-bar-fill" id="egAiLoadingBarFill" style="width: ${percent}%;"></div>
          </div>
        `;
        document.body.appendChild(banner);
      } else {
        const badge = document.getElementById('egAiLoadingPercent');
        const desc = document.getElementById('egAiLoadingDesc');
        const fill = document.getElementById('egAiLoadingBarFill');
        if (badge) badge.textContent = `${percent}%`;
        if (desc && msg) desc.textContent = msg;
        if (fill) fill.style.width = `${percent}%`;
      }
    }

    hideAiLoadingBanner() {
      const banner = document.getElementById('eg-ai-loading-banner');
      if (banner) {
        banner.remove();
      }
    }

    toggleStandbyPopover() {
      const existing = document.getElementById('eg-standby-popover');
      if (existing) {
        this.hideStandbyPopover();
      } else {
        this.showStandbyPopover();
      }
    }

    showStandbyPopover() {
      this.hideStandbyPopover();
      const popover = document.createElement('div');
      popover.id = 'eg-standby-popover';
      popover.className = 'eg-standby-popover';
      popover.innerHTML = `
        <div class="eg-standby-popover-header">
          <div class="eg-standby-popover-title">
            <span style="font-size: 1.3rem;">🛡️</span>
            <div>
              <strong>Error Guard: Standby Mode</strong>
              <span class="eg-standby-pill">No Form on Page</span>
            </div>
          </div>
          <button type="button" class="eg-banner-close" id="egCloseStandby" title="Close">✕</button>
        </div>
        <div class="eg-standby-popover-body">
          <div class="eg-standby-hero-icon">📄🔍</div>
          <h4 class="eg-standby-headline">No Application Form Detected</h4>
          <p class="eg-standby-explanation">
            Error Guard is running and actively listening in the background. When you open a webpage with an application, scholarship, or registration form, pre-submission audits and on-device document reading will activate automatically.
          </p>
          <div class="eg-standby-pills-row">
            <div class="eg-standby-feature-badge">⚡ Real-Time Typo & Format Audits</div>
            <div class="eg-standby-feature-badge">📑 Document Mismatch & Blurring Guard</div>
            <div class="eg-standby-feature-badge">🪄 Auto-Fill & Cross-Verification</div>
          </div>
        </div>
        <div class="eg-standby-popover-footer">
          <button type="button" class="eg-btn eg-btn-primary" id="egOpenDemoPortalBtn" style="padding: 10px 14px; font-size: 0.84rem; font-weight: 700; border-radius: 8px; width: 100%; cursor: pointer;">
            🏛️ Open Demo Portal to Test (localhost:3000)
          </button>
        </div>
      `;

      document.body.appendChild(popover);

      document.getElementById('egCloseStandby')?.addEventListener('click', () => this.hideStandbyPopover());
      document.getElementById('egOpenDemoPortalBtn')?.addEventListener('click', () => {
        window.open('http://localhost:3000', '_blank');
        this.hideStandbyPopover();
      });
    }

    hideStandbyPopover() {
      const existing = document.getElementById('eg-standby-popover');
      if (existing) existing.remove();
    }

    /**
     * Updates overlay states based on the latest validation report
     * @param {object} report - output of ErrorEngine.aggregate
     * @param {object} [options] - display options { showAlerts, openDrawer, highlightFields }
     *   highlightFields: when false, inline red borders and tooltips are suppressed even
     *                    when showAlerts is true (used in Manual Guard mode).
     *                    Defaults to true when showAlerts is true.
     */
    update(report, options = {}) {
      this.currentReport = report;
      if (!this.badgeEl) this.init();

      const badgeStatus = document.getElementById('egBadgeStatus');
      const drawerScore = document.getElementById('egDrawerScore');
      const checkBtn = document.getElementById('egBadgeCheckBtn');

      // Check if page has no active form
      if (!report || report.hasForm === false) {
        this.hasForm = false;
        this.clearFieldHighlights();
        if (checkBtn) {
          checkBtn.style.display = '';
          checkBtn.style.opacity = '0.6';
          checkBtn.title = 'No active application form detected on this page';
        }
        this.badgeEl.className = 'eg-floating-badge eg-standby';
        this.badgeEl.title = 'Error Guard is in Standby Mode (No application form detected on this page). Click for details.';
        if (badgeStatus) {
          badgeStatus.innerHTML = '<span class="eg-pulse-dot" style="background: #94a3b8; margin-right: 4px;"></span> Standby • No Form';
        }
        if (drawerScore) {
          drawerScore.textContent = 'Status: Standby';
          drawerScore.className = 'eg-health-tag';
        }
        this.renderDrawerContent(report, false);
        if (options.openDrawer) this.openDrawer();
        return;
      }

      this.hasForm = true;
      if (checkBtn) {
        checkBtn.style.display = '';
        checkBtn.style.opacity = '';
        checkBtn.title = 'Inspect Form for Pre-Submission Errors';
      }
      this.hideStandbyPopover();
      this.badgeEl.title = '';

      const showAlerts = options.showAlerts !== undefined ? options.showAlerts : this.userHasCheckedErrors;
      this.userHasCheckedErrors = showAlerts;

      // Inline field messages appear in every mode once the user has asked for a check
      const highlightFields = options.highlightFields !== undefined
        ? options.highlightFields
        : showAlerts;


      if (this.isAiProcessing) {
        this.badgeEl.className = 'eg-floating-badge eg-ai-analyzing';
        if (badgeStatus) {
          badgeStatus.innerHTML = `<span class="eg-ai-pulse">🔒</span> Reading on device... ${this.aiProgressPercent || 0}%`;
        }
        if (drawerScore) {
          drawerScore.textContent = `Reading ${this.aiProgressPercent || 0}%`;
          drawerScore.className = 'eg-health-tag eg-tag-ai';
        }
        this.renderDrawerContent(report, showAlerts);
        if (options.openDrawer) this.openDrawer();
        return;
      }

      const allFieldIssues = [
        ...(report.issues?.blocking || []),
        ...(report.issues?.warnings || [])
      ];

      if (!showAlerts) {
        if (this.aiDocumentReady) {
          this.badgeEl.className = 'eg-floating-badge eg-ai-ready';
          if (badgeStatus) badgeStatus.innerHTML = this.aiAutoFillMode
            ? `✓ Document read • Click Auto-Fill`
            : `✓ Document read • Click Check`;
        } else {
          this.badgeEl.className = 'eg-floating-badge eg-idle';
          if (badgeStatus) badgeStatus.textContent = this.aiAutoFillMode
            ? '🪄 Auto-Fill • Active'
            : '📋 Manual Guard • Click to Check';
        }

        // Before the user checks for errors, keep form completely clean with zero warnings
        this.clearFieldHighlights();
      } else {
        // User clicked check button or submitted form -> show full audit results
        if (report.isReady) {
          this.badgeEl.className = 'eg-floating-badge eg-ready';
          if (badgeStatus) badgeStatus.textContent = 'READY TO SUBMIT';
        } else {
          const blockingCount = report.issues?.blocking?.length || 0;
          this.badgeEl.className = 'eg-floating-badge eg-not-ready';
          if (badgeStatus) badgeStatus.textContent = `${blockingCount} Issue${blockingCount > 1 ? 's' : ''} (Action Required)`;
        }

        // Inline messages directly under the offending inputs
        if (highlightFields) {
          this.syncFieldHighlights(allFieldIssues);
        } else {
          this.clearFieldHighlights();
        }
      }

      this.renderDrawerContent(report, showAlerts);

      if (options.openDrawer) {
        this.openDrawer();
      } else {
        this.updateFieldNavigator();
      }
    }

    syncFieldHighlights(issues = []) {
      // Warnings and field error highlights should ONLY show after the user checks for errors
      if (!this.userHasCheckedErrors) {
        this.clearFieldHighlights();
        return;
      }
      const activeElements = new Set();

      for (const issue of issues) {
        // Never paint untouched empty fields red while the user is filling out the form!
        // Empty required field warnings should only appear when the user explicitly clicks "Check for Errors" or submits.
        if (issue.code === 'REQUIRED_FIELD_MISSING' && !this.userHasCheckedErrors) {
          continue;
        }

        let el = issue.element || null;
        if (!el && issue.elementId) el = document.getElementById(issue.elementId);
        if (!el && issue.field) {
          el = document.querySelector(`[name="${issue.field}"], #${issue.field}`);
          if (!el) {
            const sType = String(issue.field).toUpperCase();
            if (sType === 'FULL_NAME' || sType === 'NAME') {
              el = document.querySelector('input[name*="name" i], input[id*="name" i]');
            } else if (sType === 'DOB' || sType === 'DATE_OF_BIRTH') {
              el = document.querySelector('input[type="date"], input[name*="dob" i], input[name*="birth" i], input[id*="dob" i]');
            } else if (sType === 'CERTIFICATE_NO' || sType === 'CERTIFICATE_NUMBER') {
              el = document.querySelector('input[name*="cert" i], input[id*="cert" i]');
            } else if (sType === 'PHONE' || sType === 'MOBILE') {
              el = document.querySelector('input[type="tel"], input[name*="phone" i], input[name*="mobile" i]');
            } else if (sType === 'EMAIL') {
              el = document.querySelector('input[type="email"], input[name*="email" i]');
            } else if (sType === 'AADHAAR_NUMBER' || sType === 'AADHAAR') {
              el = document.querySelector('input[name*="aadhaar" i], input[id*="aadhaar" i], input[name*="uid" i]');
            } else if (sType === 'PAN_NUMBER' || sType === 'PAN') {
              el = document.querySelector('input[name*="pan" i], input[id*="pan" i]');
            } else if (sType === 'BANK_ACCOUNT') {
              el = document.querySelector('input[name*="account" i], input[id*="account" i], input[name*="bank" i]');
            }
          }
        }

        if (el) {
          activeElements.add(el);
          this.highlightedElements.add(el);
          const isWarning = issue.severity === 'WARNING';
          el.classList.add('eg-field-error');
          el.classList.toggle('eg-field-warn', isWarning);

          // Find existing tooltip or create a new one positioned directly below the input
          // Every field gets one stable key so the same tooltip node is reused
          // instead of being recreated on each re-evaluation (which made the
          // message flicker rapidly).
          let tipKey = el.getAttribute('data-eg-tip-key');
          if (!tipKey) {
            this.tipSeq = (this.tipSeq || 0) + 1;
            tipKey = `k${this.tipSeq}`;
            el.setAttribute('data-eg-tip-key', tipKey);
          }
          let tooltip = document.querySelector(`.eg-inline-tooltip[data-eg-tip-key="${tipKey}"]`);

          const escape = (value) => String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

          const detailBits = [];
          if (issue.formValue) detailBits.push(`<span class="eg-tip-chip">Form: <strong>${escape(issue.formValue)}</strong></span>`);
          if (issue.documentValue) detailBits.push(`<span class="eg-tip-chip">Document: <strong>${escape(issue.documentValue)}</strong></span>`);
          if (typeof issue.score === 'number') {
            detailBits.push(`<span class="eg-tip-chip">Similarity: <strong>${Math.round(issue.score * (issue.score <= 1 ? 100 : 1))}%</strong></span>`);
          }

          const tooltipHtml = `
            <div class="eg-tip-head">
              <span class="eg-tip-mark">${isWarning ? '⚠' : '✕'}</span>
              <span class="eg-tip-code">${escape(issue.code || (isWarning ? 'REVIEW' : 'ERROR'))}</span>
              <span class="eg-tip-sev">${isWarning ? 'Needs review' : 'Must fix'}</span>
            </div>
            <p class="eg-tip-msg">${escape(issue.message || '')}</p>
            ${detailBits.length ? `<div class="eg-tip-chips">${detailBits.join('')}</div>` : ''}
            ${issue.fix ? `<p class="eg-tip-fix"><strong>How to fix:</strong> ${escape(issue.fix)}</p>` : ''}
          `.trim();

          if (tooltip) {
            tooltip.className = `eg-inline-tooltip${isWarning ? ' eg-tip-warning' : ''}`;
            if (tooltip.innerHTML !== tooltipHtml) {
              tooltip.innerHTML = tooltipHtml;
            }
          } else {
            tooltip = document.createElement('div');
            tooltip.className = `eg-inline-tooltip${isWarning ? ' eg-tip-warning' : ''}`;
            tooltip.setAttribute('data-eg-tip-key', tipKey);
            if (el.id || el.name) tooltip.setAttribute('data-for', el.id || el.name);
            tooltip.innerHTML = tooltipHtml;

            // Place warning message directly below the input element (or dropzone if file input)
            const dropzone = (el.type === 'file' || el.tagName.toLowerCase() === 'input') ? el.closest('.upload-dropzone') : null;
            const target = dropzone || el;
            if (target.nextSibling) {
              target.parentNode.insertBefore(tooltip, target.nextSibling);
            } else if (target.parentNode) {
              target.parentNode.appendChild(tooltip);
            }
          }
        }

      }

      // Remove warning messages from elements that are no longer in error
      for (const el of Array.from(this.highlightedElements)) {
        if (!activeElements.has(el)) {
          el.classList.remove('eg-field-error', 'eg-field-warn');

          if (el.nextElementSibling && el.nextElementSibling.classList.contains('eg-inline-tooltip')) {
            el.nextElementSibling.remove();
          }
          const tipKey = el.getAttribute('data-eg-tip-key');
          if (tipKey) {
            document.querySelectorAll(`.eg-inline-tooltip[data-eg-tip-key="${tipKey}"]`).forEach(t => t.remove());
          }
          const dropzone = (el.type === 'file' || el.tagName?.toLowerCase() === 'input') ? el.closest('.upload-dropzone') : null;
          if (dropzone && dropzone.nextElementSibling && dropzone.nextElementSibling.classList.contains('eg-inline-tooltip')) {
            dropzone.nextElementSibling.remove();
          }
          this.highlightedElements.delete(el);
        }
      }
    }

    highlightField(issue) {
      this.syncFieldHighlights([issue]);
    }

    clearFieldHighlights() {
      document.querySelectorAll('.eg-field-error').forEach(el => {
        el.classList.remove('eg-field-error', 'eg-field-warn');
      });

      document.querySelectorAll('.eg-inline-tooltip').forEach(el => {
        el.remove();
      });
      this.highlightedElements.clear();
      this.hideBlurRejectedBanner();
    }

    // ─── Field Completion Circular Component Helpers ───
    isFieldFilled(el) {
      if (!el) return false;
      const tagName = el.tagName ? el.tagName.toLowerCase() : '';
      const type = (el.type || '').toLowerCase();

      if (type === 'checkbox') {
        return el.checked;
      }
      if (type === 'radio') {
        if (el.checked) return true;
        if (el.name) {
          try {
            const checked = document.querySelector(`input[type="radio"][name="${CSS.escape(el.name)}"]:checked`);
            if (checked) return true;
          } catch (e) {
            return el.checked;
          }
        }
        return false;
      }
      if (type === 'file') {
        return !!(el.files && el.files.length > 0);
      }
      if (tagName === 'select') {
        if (!el.value || el.value === '' || el.selectedIndex < 0) return false;
        const opt = el.options && el.options[el.selectedIndex];
        const text = opt ? opt.text.trim().toLowerCase() : '';
        if (text.includes('select') || text.includes('choose') || text.startsWith('--')) {
          return false;
        }
        return true;
      }
      return typeof el.value === 'string' && el.value.trim().length > 0;
    }

    getFieldCompletionStats(report) {
      const fields = this.getVisibleFormFields();
      const total = fields.length;
      if (total === 0) {
        return { completed: 0, total: 0, percent: 0, remaining: 0, nextIncompleteIndex: -1, nextIncompleteLabel: '' };
      }

      const blockingIssues = (report && report.issues && report.issues.blocking) ? report.issues.blocking : [];
      const blockingElementIds = new Set();
      const blockingFieldNames = new Set();
      const blockingElements = new Set();

      for (const issue of blockingIssues) {
        if (issue.element) blockingElements.add(issue.element);
        if (issue.elementId) blockingElementIds.add(issue.elementId);
        if (issue.field) blockingFieldNames.add(issue.field);
      }

      let completed = 0;
      let nextIncompleteIndex = -1;

      for (let i = 0; i < fields.length; i++) {
        const el = fields[i];
        const hasBlockingError = blockingElements.has(el) ||
          (el.id && blockingElementIds.has(el.id)) ||
          (el.name && blockingFieldNames.has(el.name));

        const isFilled = this.isFieldFilled(el);

        if (isFilled && !hasBlockingError) {
          completed++;
        } else if (nextIncompleteIndex === -1) {
          nextIncompleteIndex = i;
        }
      }

      const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
      const remaining = Math.max(0, total - completed);
      let nextIncompleteLabel = '';
      if (nextIncompleteIndex >= 0 && nextIncompleteIndex < fields.length) {
        nextIncompleteLabel = this.getFieldLabel(fields[nextIncompleteIndex]) || '';
      }

      return { completed, total, percent, remaining, nextIncompleteIndex, nextIncompleteLabel };
    }

    renderFieldProgressComponent(report) {
      const stats = this.getFieldCompletionStats(report);
      const { completed, total, percent, remaining, nextIncompleteIndex, nextIncompleteLabel } = stats;

      if (total === 0) return '';

      const r = 31;
      const circumference = +(2 * Math.PI * r).toFixed(2);
      const offset = +(circumference - (circumference * (percent / 100))).toFixed(2);

      let colorClass = 'eg-circle-bar-danger';
      let badgeClass = 'eg-badge-danger';
      if (completed === total && total > 0) {
        colorClass = 'eg-circle-bar-success';
        badgeClass = 'eg-badge-success';
      } else if (percent >= 70) {
        colorClass = 'eg-circle-bar-info';
        badgeClass = 'eg-badge-info';
      } else if (percent >= 40) {
        colorClass = 'eg-circle-bar-warning';
        badgeClass = 'eg-badge-warning';
      }

      const isAllDone = completed === total && total > 0;
      const labelSnippet = nextIncompleteLabel
        ? (nextIncompleteLabel.length > 20 ? nextIncompleteLabel.slice(0, 18) + '…' : nextIncompleteLabel)
        : '';

      return `
        <div class="eg-field-progress-card" id="egFieldProgressCard" role="region" aria-label="Field Completion Progress">
          <div class="eg-progress-circle-wrap">
            <svg class="eg-progress-circle-svg" viewBox="0 0 76 76" width="76" height="76" aria-hidden="true">
              <circle class="eg-circle-bg" cx="38" cy="38" r="${r}" />
              <circle class="eg-circle-bar ${colorClass}" cx="38" cy="38" r="${r}"
                stroke-dasharray="${circumference}"
                stroke-dashoffset="${offset}" />
            </svg>
            <div class="eg-circle-inner-content">
              <div class="eg-circle-fraction">
                <span class="eg-circle-num">${completed}</span>
                <span class="eg-circle-slash">/</span>
                <span class="eg-circle-total">${total}</span>
              </div>
              <span class="eg-circle-sublabel">FIELDS</span>
            </div>
          </div>
          <div class="eg-progress-details">
            <div class="eg-progress-top-row">
              <span class="eg-progress-card-title">Fields Completed</span>
              <span class="eg-progress-percent-badge ${badgeClass}">${percent}%</span>
            </div>
            <div class="eg-progress-main-count">
              ${isAllDone
          ? '<strong>All fields completed!</strong>'
          : `<strong>${completed} of ${total}</strong> completed`
        }
            </div>
            <div class="eg-progress-remaining-text">
              ${isAllDone
          ? 'All detected input fields have valid values.'
          : `${remaining} field${remaining === 1 ? '' : 's'} remaining before submission.`
        }
            </div>
            ${!isAllDone && nextIncompleteIndex >= 0 ? `
              <button type="button" class="eg-progress-jump-btn" id="egProgressJumpBtn" data-index="${nextIncompleteIndex}" title="Focus ${nextIncompleteLabel || 'next incomplete field'}">
                <span>Jump to next: <strong>${labelSnippet || 'Missing field'}</strong></span>
                <span aria-hidden="true">→</span>
              </button>
            ` : (isAllDone ? `
              <div class="eg-progress-all-done-tag">
                <span>✓ Ready for submission</span>
              </div>
            ` : '')}
          </div>
        </div>
      `;
    }

    attachFieldProgressListeners(container) {
      if (!container) return;
      const jumpBtn = container.querySelector('#egProgressJumpBtn');
      if (jumpBtn) {
        jumpBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const targetIdx = parseInt(jumpBtn.getAttribute('data-index'), 10);
          if (!isNaN(targetIdx) && targetIdx >= 0) {
            this.navigateToField(targetIdx);
          }
        });
      }
    }

    renderDrawerContent(report, showAlerts = true) {
      const body = document.getElementById('egDrawerBody');
      if (!body) return;

      // 1. AI Loading State in Drawer
      if (this.isAiProcessing) {
        body.innerHTML = `
          <div class="eg-status-banner eg-banner-ai-loading">
            <h4>🔒 On-device Document Reading</h4>
            <p>${this.aiProgressMsg || 'Reading the uploaded document on this device...'}</p>
          </div>
          <div class="eg-drawer-loading-box">
            <div class="eg-drawer-spinner-ring"></div>
            <h4 class="eg-drawer-loading-title">Reading document on this device</h4>
            <p class="eg-drawer-loading-subtext">
              ${this.aiProgressMsg || 'Extracting structured details and matching against form fields...'}
            </p>
            <div class="eg-loading-bar-wrap">
              <div class="eg-loading-bar-fill" style="width: ${this.aiProgressPercent || 25}%;"></div>
            </div>
            <div class="eg-loading-percent">${this.aiProgressPercent || 25}% Complete</div>
            <div class="eg-loading-notice">
              💡 Pre-submission verification will update automatically as soon as reading finishes.
            </div>
          </div>
        `;
        return;
      }

      // 2. Safe Standby State when No Form is Detected
      if (!report || report.hasForm === false) {
        body.innerHTML = `
          <div class="eg-status-banner eg-banner-idle">
            <h4>🛡️ Safe Standby Mode</h4>
            <p>No active form detected on this webpage.</p>
          </div>
          <div class="eg-drawer-standby-box">
            <div class="eg-standby-icon">📄🔍</div>
            <h4 class="eg-standby-title">No Form Detected</h4>
            <p class="eg-standby-desc">
              Error Guard is running safely in the background. When you open a webpage with an application or registration form, pre-submission audits and on-device document reading will activate automatically.
            </p>
            <div class="eg-standby-tag">
              <span class="eg-pulse-dot"></span>
              Listening for form inputs...
            </div>
            <div style="margin-top: 20px;">
              <button type="button" class="eg-btn eg-btn-primary" id="egDrawerDemoPortalBtn" style="padding: 10px 16px; font-size: 0.88rem; border-radius: 8px; cursor: pointer; width: 100%; font-weight: 700;">
                🏛️ Open Demo Portal to Test
              </button>
            </div>
          </div>
        `;
        document.getElementById('egDrawerDemoPortalBtn')?.addEventListener('click', () => {
          window.open('http://localhost:3000', '_blank');
        });
        return;
      }

      if (!showAlerts) {
        body.innerHTML = `
          <div class="eg-status-banner eg-banner-idle">
            <h4>🛡️ Pre-Submission Audit Ready</h4>
            <p>Error Guard is actively scanning your form and reading your document on this device. Alerts are paused until you request a check.</p>
          </div>
          ${this.renderFieldProgressComponent(report)}
          <div style="text-align: center; margin: 20px 0;">
            <button type="button" class="eg-btn eg-btn-primary" id="egDrawerAuditBtn" style="padding: 12px 20px; font-size: 0.95rem; border-radius: 8px; cursor: pointer; width: 100%; font-weight: 700;">
              🔍 Check for Errors Now
            </button>
          </div>
          <div class="eg-section-checklist">
            <h5>Background Monitoring Status</h5>
            <div class="eg-check-grid">
              <div class="eg-check-item pass">
                <span>⚡</span>
                <span>Real-time Form Listener Active</span>
              </div>
              <div class="eg-check-item ${this.aiDocumentReady ? 'pass' : (this.isAiProcessing ? 'pass' : 'fail')}">
                <span>${this.aiDocumentReady ? '✅' : (this.isAiProcessing ? '⚡' : '⏳')}</span>
                <span>${this.aiDocumentReady ? 'Document read on this device' : (this.isAiProcessing ? 'Reading uploaded document...' : 'Awaiting Document Upload')}</span>
              </div>
            </div>
          </div>
        `;
        const auditBtn = document.getElementById('egDrawerAuditBtn');
        if (auditBtn) {
          auditBtn.addEventListener('click', async () => {
            this.userHasCheckedErrors = true;
            if (window.ErrorGuard && window.ErrorGuard.reEvaluate) {
              await window.ErrorGuard.reEvaluate({ showAlerts: true });
            }
          });
        }
        this.attachFieldProgressListeners(body);
        return;
      }

      let html = `
        <div class="eg-status-banner ${report.isReady ? 'eg-banner-ready' : 'eg-banner-error'}">
          <h4>${report.status}</h4>
          <p>${report.isReady
          ? 'All form values, document constraints, and identity cross-checks have passed.'
          : `${report.issues.blocking.length} blocking issue(s) need your attention before submitting.`}
          </p>
        </div>

        ${this.renderFieldProgressComponent(report)}

        <div style="margin-bottom: 16px; display: flex; justify-content: flex-end;">
          <button type="button" class="eg-badge-dismiss-btn" id="egDrawerDismissAlertsBtn" style="padding: 6px 12px; font-size: 0.75rem; border-radius: 6px; cursor: pointer; background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1;">
            ✕ Hide Alerts & Resume Typing
          </button>
        </div>

       
      `;

      if (report.issues.all.length > 0) {
        const escape = (val) => String(val == null ? '' : val)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        // Categorize issues into distinct, user-friendly subsections
        const categorizeIssue = (issue) => {
          const code = (issue.code || '').toUpperCase();
          const field = String(issue.field || '').toUpperCase();
          const el = issue.element;
          const isFileInput = (el && el.type === 'file') ||
            field === 'FILE_UPLOAD' ||
            (issue.elementId && issue.elementId.toLowerCase().includes('file'));

          // 1. File Upload & Document Quality Issues
          if (
            isFileInput ||
            code.startsWith('FILE_') ||
            code.startsWith('IMAGE_') ||
            code.startsWith('DOCUMENT_') ||
            code === 'WRONG_DOCUMENT_TYPE' ||
            code === 'DOCUMENT_LOW_QUALITY'
          ) {
            return 'upload';
          }

          // 2. Document & Form Cross-Verification Mismatches
          if (
            code.includes('MISMATCH') ||
            code === 'AUTOFILL_NEEDS_REVIEW' ||
            code.startsWith('CROSS_')
          ) {
            return 'mismatch';
          }

          // 3. Missing Required Fields
          if (
            code === 'REQUIRED_FIELD_MISSING' ||
            code === 'DECLARATION_NOT_CHECKED' ||
            code.includes('MISSING')
          ) {
            return 'missing';
          }

          // 4. Incorrect Format & Data Validation Errors
          return 'format';
        };

        const CATEGORIES = [
          { key: 'missing', title: 'Missing Required Fields', icon: '📝' },
          { key: 'format', title: 'Incorrect or Invalid Data', icon: '✏️' },
          { key: 'mismatch', title: 'Document & Form Mismatches', icon: '🔍' },
          { key: 'upload', title: 'File Upload & Document Quality', icon: '📁' }
        ];

        // Group the issues
        const grouped = { missing: [], format: [], mismatch: [], upload: [] };
        for (const issue of report.issues.all) {
          const catKey = categorizeIssue(issue);
          if (grouped[catKey]) {
            grouped[catKey].push(issue);
          } else {
            grouped.format.push(issue);
          }
        }

        html += `<div class="eg-issues-list"><h5>Detected Issues & Corrections (${report.issues.all.length})</h5>`;

        for (const cat of CATEGORIES) {
          const catIssues = grouped[cat.key];
          if (!catIssues || catIssues.length === 0) continue;

          const hasBlocking = catIssues.some(i => i.severity === 'BLOCKING');
          const countText = `${catIssues.length} ${catIssues.length === 1 ? 'error' : 'errors'}`;

          html += `
            <details class="eg-issue-category-group eg-category-accordion">
              <summary class="eg-cat-summary">
                <div class="eg-cat-summary-left">
                  <span class="eg-cat-icon">${cat.icon}</span>
                  <span class="eg-cat-title-text">${escape(cat.title)}</span>
                </div>
                <div class="eg-cat-summary-right">
                  <span class="eg-cat-count ${hasBlocking ? 'eg-cat-count-blocking' : ''}">${countText}</span>
                  <span class="eg-cat-arrow">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                  </span>
                </div>
              </summary>
              <div class="eg-cat-items">
          `;

          for (const issue of catIssues) {
            const isBlocking = issue.severity === 'BLOCKING';
            const targetId = issue.elementId || (issue.element && issue.element.id) || issue.field || '';
            html += `
              <details class="eg-issue-card eg-issue-accordion ${isBlocking ? 'eg-card-blocking' : 'eg-card-warning'}">
                <summary class="eg-card-summary">
                  <div class="eg-summary-left">
                    <span class="eg-summary-icon">${isBlocking ? ' ' : '⚠️'}</span>
                    <span class="eg-card-msg">${escape(issue.message)}</span>
                  </div>
                  <span class="eg-accordion-arrow">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                  </span>
                </summary>
                <div class="eg-card-body">
                  <div class="eg-card-top">
                    <span class="eg-card-severity">${isBlocking ? '  BLOCKING' : '  WARNING'}</span>
                    <span class="eg-card-code">${escape(issue.code)}</span>
                  </div>
                  ${issue.fix ? `<div class="eg-card-fix"><strong>Suggested Fix:</strong> ${escape(issue.fix)}</div>` : ''}
                  ${issue.formValue || issue.documentValue ? `
                    <div class="eg-card-chips">
                      ${issue.formValue ? `<span class="eg-card-chip">Form: <strong>${escape(issue.formValue)}</strong></span>` : ''}
                      ${issue.documentValue ? `<span class="eg-card-chip">Document: <strong>${escape(issue.documentValue)}</strong></span>` : ''}
                    </div>
                  ` : ''}
                  ${targetId ? `
                    <button type="button" class="eg-jump-btn" data-target="${escape(targetId)}">
                       Jump to Field
                    </button>
                  ` : ''}
                </div>
              </details>
            `;
          }

          html += `
              </div>
            </details>
          `;
        }

        html += `</div>`;
      }

      if (!report.isReady) {
        html += `
          <div class="eg-override-card">
            <div class="eg-override-info">
              <strong>Form data is accurate?</strong>
              <p>If you have verified that your entered details are correct despite these warnings, you can proceed with submission.</p>
            </div>
            <button type="button" class="eg-btn eg-btn-override" id="egDrawerProceedBtn" style="width: 100%; justify-content: center;">
              ⚠️ Proceed & Submit Anyway →
            </button>
          </div>
        `;
      }

      body.innerHTML = html;

      const drawerProceedBtn = body.querySelector('#egDrawerProceedBtn');
      if (drawerProceedBtn) {
        drawerProceedBtn.addEventListener('click', () => {
          this.closeDrawer();
          if (typeof this.onProceedSubmit === 'function') {
            this.onProceedSubmit();
          }
        });
      }

      const dismissBtn = document.getElementById('egDrawerDismissAlertsBtn');
      if (dismissBtn) {
        dismissBtn.addEventListener('click', () => {
          this.userHasCheckedErrors = false;
          this.clearFieldHighlights();
          if (window.ErrorGuard && window.ErrorGuard.reEvaluate) {
            window.ErrorGuard.reEvaluate({ showAlerts: false });
          }
          this.closeDrawer();
        });
      }

      // Attach jump buttons
      body.querySelectorAll('.eg-jump-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const targetId = btn.getAttribute('data-target');
          let targetEl = targetId ? document.getElementById(targetId) : null;
          if (!targetEl && targetId) {
            targetEl = document.querySelector(`[name="${targetId}"], #${targetId}`);
          }
          if (targetEl) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            targetEl.focus();
            this.closeDrawer();
          }
        });
      });

      this.attachFieldProgressListeners(body);
    }

    showPreSubmitModal(report) {
      if (!report || !report.issues || !report.issues.blocking || report.issues.blocking.length === 0) {
        return;
      }
      if (!this.modalEl) this.init();
      const issuesContainer = document.getElementById('egModalIssues');

      let html = `
        <div class="eg-modal-alert">
          <strong>Cannot proceed with application submission.</strong>
          <p>Please resolve the following ${report.issues.blocking.length} critical issue(s):</p>
        </div>
        <div class="eg-modal-items">
      `;

      for (const issue of report.issues.blocking) {
        html += `
          <div class="eg-modal-item">
            <span class="eg-modal-item-icon">❌</span>
            <div>
              <strong>${issue.code}</strong>
              <p>${issue.message}</p>
              ${issue.fix ? `<small>Fix: ${issue.fix}</small>` : ''}
            </div>
          </div>
        `;
      }
      html += `</div>`;

      issuesContainer.innerHTML = html;
      this.modalEl.classList.remove('eg-modal-hidden');
    }

    hideModal() {
      if (this.modalEl) {
        this.modalEl.classList.add('eg-modal-hidden');
      }
    }

    toggleDrawer() {
      if (this.drawerEl.classList.contains('eg-drawer-open')) {
        this.closeDrawer();
      } else {
        this.openDrawer();
      }
    }

    openDrawer() {
      if (this.drawerEl) {
        this.drawerEl.classList.remove('eg-drawer-closed');
        this.drawerEl.classList.add('eg-drawer-open');
        this.updateFieldNavigator();
      }
      // Hide the side-tab while drawer is open
      if (this.badgeEl) {
        this.badgeEl.classList.add('eg-badge-hidden');
      }
    }

    closeDrawer() {
      if (this.drawerEl) {
        this.drawerEl.classList.remove('eg-drawer-open');
        this.drawerEl.classList.add('eg-drawer-closed');
      }
      // Restore the side-tab
      if (this.badgeEl) {
        this.badgeEl.classList.remove('eg-badge-hidden');
      }
    }

    // ─── Field Navigator (Jump to Next / Previous Field) ───
    getVisibleFormFields() {
      const selector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea';
      const elements = Array.from(document.querySelectorAll(selector));

      return elements.filter(el => {
        // Exclude inputs inside Error Guard UI elements
        if (el.closest('#error-guard-drawer, #error-guard-badge, #error-guard-modal, #eg-autofill-banner, #eg-wrongdoc-banner, #eg-blur-banner, .eg-modal-overlay')) {
          return false;
        }
        // Exclude disabled elements (cannot receive user interaction/focus)
        if (el.disabled) {
          return false;
        }
        // Exclude hidden elements
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
        return (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
      });
    }

    getFieldLabel(el) {
      if (!el) return 'Input Field';

      // 1. label[for="id"]
      if (el.id) {
        const label = document.querySelector(`label[for="${el.id}"]`);
        if (label && label.innerText.trim()) {
          return label.innerText.replace(/\*/g, '').replace(/[:]/g, '').trim();
        }
      }
      // 2. Parent label element
      const parentLabel = el.closest('label');
      if (parentLabel && parentLabel.innerText.trim()) {
        return parentLabel.innerText.replace(/\*/g, '').replace(/[:]/g, '').trim();
      }
      // 3. Form group label or header
      const group = el.closest('.form-group, .form-row, .field-wrap, .form-field, .doc-upload-block');
      if (group) {
        const groupLabel = group.querySelector('label, .form-label, strong, .doc-label');
        if (groupLabel && groupLabel.innerText.trim()) {
          return groupLabel.innerText.replace(/\*/g, '').replace(/[:]/g, '').trim();
        }
      }
      // 4. aria-label or placeholder
      if (el.getAttribute('aria-label')) {
        return el.getAttribute('aria-label').trim();
      }
      if (el.placeholder && el.placeholder.trim()) {
        return el.placeholder.trim();
      }
      // 5. Semantic name or id
      if (el.name) {
        return el.name.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').replace(/^\w/, c => c.toUpperCase()).trim();
      }
      if (el.id) {
        return el.id.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').replace(/^\w/, c => c.toUpperCase()).trim();
      }
      return `${el.tagName.toLowerCase()} field`;
    }

    updateFieldNavigator() {
      const navEl = document.getElementById('egFieldNavigator');
      if (!navEl) return;

      const fields = this.getVisibleFormFields();
      const total = fields.length;
      const prevBtn = document.getElementById('egNavPrevBtn');
      const nextBtn = document.getElementById('egNavNextBtn');
      const labelEl = document.getElementById('egNavLabel');
      const counterEl = document.getElementById('egNavCounter');

      // Edge case: No input fields on page
      if (total === 0) {
        if (labelEl) labelEl.textContent = 'No Input Fields';
        if (counterEl) counterEl.textContent = '0 of 0 fields';
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
        this.currentNavIndex = -1;
        return;
      }

      // Edge case: Only 1 input field on page
      if (total === 1) {
        this.currentNavIndex = 0;
        const fieldName = this.getFieldLabel(fields[0]);
        if (labelEl) labelEl.textContent = fieldName;
        if (counterEl) counterEl.textContent = 'Field 1 of 1';
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
        return;
      }

      // Ensure index is within range if active
      if (this.currentNavIndex >= total) {
        this.currentNavIndex = total - 1;
      }

      // No field currently selected yet
      if (this.currentNavIndex < 0) {
        if (labelEl) labelEl.textContent = 'Navigate Fields';
        if (counterEl) counterEl.textContent = `${total} fields on page`;
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = false;
        return;
      }

      // An active field is selected
      const currentEl = fields[this.currentNavIndex];
      const fieldName = this.getFieldLabel(currentEl);
      if (labelEl) labelEl.textContent = fieldName;
      if (counterEl) counterEl.textContent = `Field ${this.currentNavIndex + 1} of ${total}`;

      // Edge cases: First or Last input field
      if (prevBtn) {
        prevBtn.disabled = (this.currentNavIndex <= 0);
      }
      if (nextBtn) {
        nextBtn.disabled = (this.currentNavIndex >= total - 1);
      }
    }

    navigateNextField() {
      const fields = this.getVisibleFormFields();
      if (fields.length === 0) {
        this.updateFieldNavigator();
        return;
      }

      let targetIndex;
      if (this.currentNavIndex < 0) {
        targetIndex = 0;
      } else if (this.currentNavIndex < fields.length - 1) {
        targetIndex = this.currentNavIndex + 1;
      } else {
        // Edge case: Already at last field
        this.updateFieldNavigator();
        return;
      }

      this.navigateToField(targetIndex, fields);
    }

    navigatePreviousField() {
      const fields = this.getVisibleFormFields();
      if (fields.length === 0) {
        this.updateFieldNavigator();
        return;
      }

      let targetIndex;
      if (this.currentNavIndex > 0) {
        targetIndex = this.currentNavIndex - 1;
      } else {
        // Edge case: Already at first field
        this.updateFieldNavigator();
        return;
      }

      this.navigateToField(targetIndex, fields);
    }

    navigateToField(index, fieldsList = null) {
      const fields = fieldsList || this.getVisibleFormFields();
      if (index < 0 || index >= fields.length) return;

      this.currentNavIndex = index;
      const targetEl = fields[index];

      // Smooth scroll target field to center of viewport
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Focus field
      try {
        targetEl.focus({ preventScroll: true });
      } catch (e) {
        targetEl.focus();
      }

      // Temporary pulse animation highlight for clean visual feedback
      document.querySelectorAll('.eg-focused-field-pulse').forEach(el => el.classList.remove('eg-focused-field-pulse'));
      targetEl.classList.add('eg-focused-field-pulse');
      setTimeout(() => {
        targetEl.classList.remove('eg-focused-field-pulse');
      }, 1400);

      // Update sidebar navigator state
      this.updateFieldNavigator();
    }

    // ─── AI Auto-Fill & Auto-Correct In-Page Components ───
    showAutoFillBanner(docData, onApply, fieldMap = null, previewItems = null) {
      this.hideAutoFillBanner();
      if (!docData || (!docData.name && !docData.dob && !docData.certificateNo && !docData.gender && !docData.phone)) return;

      const banner = document.createElement('div');
      banner.id = 'eg-autofill-banner';
      banner.className = 'eg-autofill-banner';

      const typeName = docData.docType === 'AADHAAR' ? 'Aadhaar Card' :
        docData.docType === 'PAN' ? 'PAN Card' :
          docData.docType === 'CASTE_CERTIFICATE' ? 'Caste Certificate' :
            docData.docType === 'INCOME_CERTIFICATE' ? 'Income Certificate' :
              docData.docType === 'MARKSHEET' ? 'Marksheet' : 'Official Document';

      // Human-readable labels and icons for each field key
      const FIELD_META = {
        fullName: { label: 'Name', icon: '👤' },
        fatherName: { label: 'Father Name', icon: '👨' },
        motherName: { label: 'Mother Name', icon: '👩' },
        dob: { label: 'Date of Birth', icon: '📅' },
        gender: { label: 'Gender', icon: '⚧' },
        aadhaarNumber: { label: 'Aadhaar No.', icon: '🆔' },
        panNumber: { label: 'PAN', icon: '💳' },
        certificateNo: { label: 'Certificate No.', icon: '📜' },
        phone: { label: 'Mobile', icon: '📞' },
        email: { label: 'Email', icon: '📧' },
        category: { label: 'Category', icon: '🏷️' }
      };

      // Fields to skip in the preview (optional/sensitive/not from doc)
      const SKIP_PREVIEW = new Set([
        'captchaInput', 'bankAccountNo', 'ifscCode',
        'alternatePhone', 'familyIncome', 'pwdStatus'
      ]);

      // Build tag HTML — dynamic from fieldMap if available, else legacy 3-field display
      let tagsHtml = '';
      const esc = (v) => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (Array.isArray(previewItems) && previewItems.length) {
        for (const item of previewItems) {
          if (!item || !item.label) continue;
          if (!item.value) continue;
          const key = item.fieldKey || item.label;
          const pct = typeof item.confidence === 'number' ? ` (${Math.round(item.confidence * 100)}%)` : '';
          let innerHtml = '';
          let cls = 'eg-autofill-tag';
          if (item.conflict) {
            cls += ' eg-tag-conflict';
            innerHtml = `${esc(item.label)}: <strong>${esc(item.value)}</strong> — differs from what you typed, left as is`;
          } else if (item.needsReview) {
            cls += ' eg-tag-review';
            innerHtml = `⚠ ${esc(item.label)}: <strong>${esc(item.value)}</strong> — confirm${pct}`;
          } else {
            innerHtml = `${esc(item.label)}: <strong>${esc(item.value)}</strong>`;
          }
          tagsHtml += `<span class="${cls}" data-field-key="${esc(key)}" data-label="${esc(item.label)}"><span class="eg-tag-text">${innerHtml}</span><button type="button" class="eg-tag-remove-btn" data-key="${esc(key)}" title="Remove ${esc(item.label)}" aria-label="Remove ${esc(item.label)}">✕</button></span>`;
        }
      } else if (fieldMap && typeof fieldMap === 'object' && Object.keys(fieldMap).length > 0) {
        for (const [key, value] of Object.entries(fieldMap)) {
          if (!value || SKIP_PREVIEW.has(key)) continue;
          const meta = FIELD_META[key];
          if (!meta) continue; // skip unmapped/unknown keys
          tagsHtml += `<span class="eg-autofill-tag" data-field-key="${esc(key)}" data-label="${esc(meta.label)}"><span class="eg-tag-text">${meta.icon} ${meta.label}: <strong>${esc(value)}</strong></span><button type="button" class="eg-tag-remove-btn" data-key="${esc(key)}" title="Remove ${esc(meta.label)}" aria-label="Remove ${esc(meta.label)}">✕</button></span>`;
        }
      } else if (docData) {
        // Legacy fallback: only show name / dob / gender / id
        if (docData.name) tagsHtml += `<span class="eg-autofill-tag" data-field-key="name" data-label="Name"><span class="eg-tag-text">👤 Name: <strong>${esc(docData.name)}</strong></span><button type="button" class="eg-tag-remove-btn" data-key="name" title="Remove Name" aria-label="Remove Name">✕</button></span>`;
        if (docData.dob) tagsHtml += `<span class="eg-autofill-tag" data-field-key="dob" data-label="Date of Birth"><span class="eg-tag-text">📅 DOB: <strong>${esc(docData.dob)}</strong></span><button type="button" class="eg-tag-remove-btn" data-key="dob" title="Remove Date of Birth" aria-label="Remove Date of Birth">✕</button></span>`;
        if (docData.gender) tagsHtml += `<span class="eg-autofill-tag" data-field-key="gender" data-label="Gender"><span class="eg-tag-text">⚧ Gender: <strong>${esc(docData.gender)}</strong></span><button type="button" class="eg-tag-remove-btn" data-key="gender" title="Remove Gender" aria-label="Remove Gender">✕</button></span>`;
        if (docData.certificateNo) tagsHtml += `<span class="eg-autofill-tag" data-field-key="certificateNo" data-label="Certificate No."><span class="eg-tag-text">🆔 ID: <strong>${esc(docData.certificateNo)}</strong></span><button type="button" class="eg-tag-remove-btn" data-key="certificateNo" title="Remove Certificate No." aria-label="Remove Certificate No.">✕</button></span>`;
        if (docData.phone) tagsHtml += `<span class="eg-autofill-tag" data-field-key="phone" data-label="Mobile"><span class="eg-tag-text">📞 Mobile: <strong>${esc(docData.phone)}</strong></span><button type="button" class="eg-tag-remove-btn" data-key="phone" title="Remove Mobile" aria-label="Remove Mobile">✕</button></span>`;
      }

      const fieldCount = tagsHtml.split('eg-autofill-tag').length - 1;

      banner.innerHTML = `
        <div class="eg-autofill-header">
          <div class="eg-autofill-header-left">
            <span class="eg-autofill-sparkle">✨</span>
            <div>
              <strong class="eg-autofill-title">${typeName} read on this device</strong>
              <p class="eg-autofill-subtitle">${fieldCount} field${fieldCount !== 1 ? 's' : ''} ready to fill. Click to auto-fill form:</p>
            </div>
          </div>
          <button type="button" class="eg-banner-close" id="egCloseAutoFill">✕</button>
        </div>
        <div class="eg-autofill-tags">
          ${tagsHtml}
        </div>
        <div class="eg-autofill-footer">
          <button type="button" class="eg-btn-autofill" id="egApplyAutoFill">
           1-Click Auto-Fill Form
          </button>
          <button type="button" class="eg-btn-dismiss-autofill" id="egDismissAutoFill">
            Dismiss
          </button>
        </div>
      `;

      document.body.appendChild(banner);

      const excludedKeys = new Set();

      const updateSubtitle = () => {
        const remainingTags = banner.querySelectorAll('.eg-autofill-tag:not(.eg-tag-removing)');
        const count = remainingTags.length;
        const subtitleEl = banner.querySelector('.eg-autofill-subtitle');
        const applyBtn = banner.querySelector('#egApplyAutoFill');
        if (subtitleEl) {
          if (count === 0) {
            subtitleEl.textContent = 'All suggested fields have been removed.';
          } else {
            subtitleEl.textContent = `${count} field${count !== 1 ? 's' : ''} ready to fill. Click to auto-fill form:`;
          }
        }
        if (applyBtn) {
          if (count === 0) {
            applyBtn.disabled = true;
            applyBtn.style.opacity = '0.4';
            applyBtn.style.cursor = 'not-allowed';
          } else {
            applyBtn.disabled = false;
            applyBtn.style.opacity = '1';
            applyBtn.style.cursor = 'pointer';
          }
        }
      };

      banner.querySelectorAll('.eg-tag-remove-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const key = btn.getAttribute('data-key');
          const tag = btn.closest('.eg-autofill-tag');
          if (key) {
            excludedKeys.add(key);
            excludedKeys.add(key.toLowerCase());
          }
          if (tag) {
            const label = tag.getAttribute('data-label');
            if (label) {
              excludedKeys.add(label);
              excludedKeys.add(label.toLowerCase());
            }
            const fieldKey = tag.getAttribute('data-field-key');
            if (fieldKey) {
              excludedKeys.add(fieldKey);
              excludedKeys.add(fieldKey.toLowerCase());
            }
            tag.classList.add('eg-tag-removing');
            setTimeout(() => {
              tag.remove();
              updateSubtitle();
            }, 180);
          }
          updateSubtitle();
        });
      });

      document.getElementById('egCloseAutoFill').addEventListener('click', () => this.hideAutoFillBanner());
      document.getElementById('egDismissAutoFill').addEventListener('click', () => this.hideAutoFillBanner());
      document.getElementById('egApplyAutoFill').addEventListener('click', () => {
        if (typeof onApply === 'function') onApply(excludedKeys);
        this.hideAutoFillBanner();
      });
    }

    hideAutoFillBanner() {
      const existing = document.getElementById('eg-autofill-banner');
      if (existing) existing.remove();
    }

    showWrongDocBanner({ expectedType, actualType, fileInputEl, fileName, onReplace } = {}) {
      this.hideWrongDocBanner();
      this.hideAutoFillBanner();

      const banner = document.createElement('div');
      banner.id = 'eg-wrongdoc-banner';
      banner.className = 'eg-wrongdoc-banner';

      const formatDoc = (t) => {
        switch (t) {
          case 'AADHAAR': return 'Aadhaar Card';
          case 'PAN': return 'PAN Card';
          case 'CASTE_CERTIFICATE': return 'Caste Certificate';
          case 'INCOME_CERTIFICATE': return 'Income Certificate';
          case 'CERTIFICATE': return 'Official Certificate';
          case 'MARKSHEET': return 'Marksheet / Academic Memo';
          default: return t ? t.replace(/_/g, ' ') : 'Required Document';
        }
      };

      const expectedName = formatDoc(expectedType);
      const actualName = formatDoc(actualType);

      // Find field label or upload title if possible
      let slotTitle = '';
      if (fileInputEl) {
        if (fileInputEl.id) {
          const lbl = document.querySelector(`label[for="${fileInputEl.id}"]`);
          if (lbl) slotTitle = lbl.innerText.replace(/\*/g, '').trim();
        }
        if (!slotTitle) {
          const block = fileInputEl.closest('.doc-upload-block, .form-group');
          const header = block ? block.querySelector('.doc-label, label, strong') : null;
          if (header) slotTitle = header.innerText.replace(/\*/g, '').trim();
        }
      }
      if (!slotTitle) slotTitle = `${expectedName} Upload`;

      banner.innerHTML = `
        <div class="eg-wrongdoc-header">
          <div class="eg-wrongdoc-header-left">
            <span class="eg-wrongdoc-icon"> </span>
            <div>
              <strong class="eg-wrongdoc-title">Wrong Document Detected!</strong>
              <p class="eg-wrongdoc-subtitle">
                You uploaded an <strong>${actualName}</strong> into the slot for <strong>${slotTitle}</strong>.
              </p>
            </div>
          </div>
          <button type="button" class="eg-banner-close" id="egCloseWrongDoc" title="Close">✕</button>
        </div>
        <div class="eg-wrongdoc-body">
          ⚠️ <strong>Document Mismatch:</strong> This field specifically requires a valid <strong>${expectedName}</strong>. Submitting an incorrect document will cause your application to be rejected during verification.
        </div>
        <div class="eg-wrongdoc-footer">
          <button type="button" class="eg-btn-replace-doc" id="egReplaceDocBtn">
            🔄 Click to Upload ${expectedName}
          </button>
          <button type="button" class="eg-btn-dismiss-wrongdoc" id="egDismissWrongDoc">
            Dismiss
          </button>
        </div>
      `;

      document.body.appendChild(banner);

      const closeBtn = document.getElementById('egCloseWrongDoc');
      const dismissBtn = document.getElementById('egDismissWrongDoc');
      const replaceBtn = document.getElementById('egReplaceDocBtn');

      if (closeBtn) closeBtn.addEventListener('click', () => this.hideWrongDocBanner());
      if (dismissBtn) dismissBtn.addEventListener('click', () => this.hideWrongDocBanner());
      if (replaceBtn) {
        replaceBtn.addEventListener('click', () => {
          this.hideWrongDocBanner();
          if (typeof onReplace === 'function') {
            onReplace();
          } else if (fileInputEl) {
            fileInputEl.click();
          }
        });
      }
    }

    hideWrongDocBanner() {
      const existing = document.getElementById('eg-wrongdoc-banner');
      if (existing) existing.remove();
    }

    showBlurRejectedBanner({ fileInputEl, fileName, message, onReplace } = {}) {
      this.hideBlurRejectedBanner();
      this.hideWrongDocBanner();
      this.hideAutoFillBanner();

      const banner = document.createElement('div');
      banner.id = 'eg-blur-banner';
      banner.className = 'eg-wrongdoc-banner eg-blur-banner';

      let slotTitle = '';
      if (fileInputEl) {
        if (fileInputEl.id) {
          const lbl = document.querySelector(`label[for="${fileInputEl.id}"]`);
          if (lbl) slotTitle = lbl.innerText.replace(/\*/g, '').trim();
        }
        if (!slotTitle) {
          const block = fileInputEl.closest('.doc-upload-block, .form-group');
          const header = block ? block.querySelector('.doc-label, label, strong') : null;
          if (header) slotTitle = header.innerText.replace(/\*/g, '').trim();
        }
      }
      if (!slotTitle) slotTitle = 'Document';

      banner.innerHTML = `
        <div class="eg-wrongdoc-header">
          <div class="eg-wrongdoc-header-left">
            <span class="eg-wrongdoc-icon">🔍❌</span>
            <div>
              <strong class="eg-wrongdoc-title" style="color: #dc2626;">Document Rejected — Blurry / Unreadable!</strong>
              <p class="eg-wrongdoc-subtitle">
                The file uploaded for <strong>${slotTitle}</strong> (<em>${fileName || 'document'}</em>) is out of focus or blurred.
              </p>
            </div>
          </div>
          <button type="button" class="eg-banner-close" id="egCloseBlurDoc" title="Close">✕</button>
        </div>
        <div class="eg-wrongdoc-body" style="border-left: 4px solid #dc2626; background: #fef2f2; color: #991b1b; padding: 12px 14px; border-radius: 6px; margin: 10px 0; font-size: 0.88rem; line-height: 1.5;">
          🚫 <strong>Document Not Accepted:</strong> Government portals require official certificate scans to be sharp and fully legible for verification.<br>
          💡 <strong>Action Required:</strong> ${message || 'Please upload a clear, sharp, well-lit scan or photo.'}
        </div>
        <div class="eg-wrongdoc-footer">
          <button type="button" class="eg-btn-replace-doc" id="egReplaceBlurDocBtn" style="background: #dc2626; color: #ffffff;">
            🔄 Upload a Clear, Sharp Document
          </button>
          <button type="button" class="eg-btn-dismiss-wrongdoc" id="egDismissBlurDoc">
            Dismiss
          </button>
        </div>
      `;

      document.body.appendChild(banner);

      const closeBtn = document.getElementById('egCloseBlurDoc');
      const dismissBtn = document.getElementById('egDismissBlurDoc');
      const replaceBtn = document.getElementById('egReplaceBlurDocBtn');

      if (closeBtn) closeBtn.addEventListener('click', () => this.hideBlurRejectedBanner());
      if (dismissBtn) dismissBtn.addEventListener('click', () => this.hideBlurRejectedBanner());
      if (replaceBtn) {
        replaceBtn.addEventListener('click', () => {
          this.hideBlurRejectedBanner();
          if (typeof onReplace === 'function') {
            onReplace();
          } else if (fileInputEl) {
            fileInputEl.click();
          }
        });
      }
    }

    hideBlurRejectedBanner() {
      const existing = document.getElementById('eg-blur-banner');
      if (existing) existing.remove();
    }

    showAutoCorrectChip(fieldElement, correctValue, onApply) {
      if (!fieldElement || !correctValue) return;

      const parent = fieldElement.parentElement || fieldElement.closest('.form-group') || fieldElement;
      const existingChip = parent.querySelector('.eg-autocorrect-chip');
      if (existingChip) {
        if (existingChip.dataset.val === correctValue) return;
        existingChip.remove();
      }

      const chip = document.createElement('div');
      chip.className = 'eg-autocorrect-chip';
      chip.dataset.val = correctValue;
      chip.innerHTML = `
        <span class="eg-chip-text">⚡ Document has: <strong>"${correctValue}"</strong></span>
        <button type="button" class="eg-chip-apply-btn">Auto-Fix</button>
      `;

      parent.appendChild(chip);

      chip.querySelector('.eg-chip-apply-btn').addEventListener('click', () => {
        if (typeof onApply === 'function') onApply();
        chip.remove();
      });
    }

    clearAutoCorrectChips() {
      document.querySelectorAll('.eg-autocorrect-chip').forEach(el => el.remove());
    }
  }

  window.ErrorGuard.Overlay = new OverlayManager();
})();
