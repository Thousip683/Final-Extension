/**
 * Portal Rule Engine
 * Loads and applies portal-specific constraints without altering core extension code.
 * Phase 4 of Build Guide.
 */

(function () {
  window.ErrorGuard = window.ErrorGuard || {};

  class RuleEngine {
    constructor() {
      this.activeProfile = window.ErrorGuard.Schemas.DEFAULT_PROFILE;
      this.loaded = false;
    }

    async init() {
      if (this.loaded) return this.activeProfile;

      try {
        // Try fetching the embedded demo portal profile
        let demoProfileUrl = '';
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
          demoProfileUrl = chrome.runtime.getURL('rules/demo-portal.json');
        } else {
          demoProfileUrl = '../rules/demo-portal.json';
        }

        const response = await fetch(demoProfileUrl);
        if (response.ok) {
          const profile = await response.json();
          const currentUrl = window.location.href;

          // Check if current URL matches any pattern
          const isMatch = profile.matchUrlPatterns.some(pattern => {
            const cleanPattern = pattern.replace(/\*/g, '.*');
            return new RegExp(cleanPattern, 'i').test(currentUrl);
          });

          if (isMatch) {
            this.activeProfile = profile;
            window.ErrorGuard.Logger.info('RuleEngine', `Matched Portal Profile: ${profile.name}`);
          }
        }
      } catch (err) {
        window.ErrorGuard.Logger.warn('RuleEngine', 'Could not load portal JSON profile, using defaults', err);
      }

      this.loaded = true;
      return this.activeProfile;
    }

    getProfile() {
      return this.activeProfile;
    }

    getFileRules() {
      return this.activeProfile.fileRules || window.ErrorGuard.Schemas.DEFAULT_PROFILE.fileRules;
    }

    getRequiredFields() {
      return this.activeProfile.requiredFields || [];
    }

    getCrossChecks() {
      return this.activeProfile.crossChecks || window.ErrorGuard.Schemas.DEFAULT_PROFILE.crossChecks;
    }
  }

  window.ErrorGuard.RuleEngine = new RuleEngine();
})();
