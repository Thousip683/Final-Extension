/**
 * Content Script DOM Detector
 * Discovers and tracks forms, input fields, and file upload controls.
 * Phase 3 of Build Guide.
 */

(function () {
  window.ErrorGuard = window.ErrorGuard || {};

  window.ErrorGuard.Detector = {
    /**
     * Scans document for forms and relevant fields
     * @returns {{ forms: HTMLElement[], fields: Array<{ field: HTMLElement, semantic: object, value: string }>, submitButtons: HTMLElement[] }}
     */
    scan() {
      const forms = Array.from(document.querySelectorAll('form'));
      const formControls = Array.from(document.querySelectorAll('input, select, textarea'));
      const submitButtons = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"], a.btn, a.button')).filter(btn => {
        const type = (btn.getAttribute('type') || '').toLowerCase();
        if (type === 'submit') return true;
        const text = (btn.textContent || btn.value || '').toLowerCase().trim();
        return text.includes('submit') || text.includes('apply') || text.includes('proceed') || text.includes('send') ||
               text.includes('log in') || text.includes('login') || text.includes('sign in') || text.includes('signin') ||
               text.includes('continue') || text.includes('next');
      });

      const detectedFields = [];

      for (const el of formControls) {
        // Skip hidden and non-interactive
        const type = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
        if (type === 'hidden' || el.style.display === 'none' || el.style.visibility === 'hidden') {
          continue;
        }

        const semantic = window.ErrorGuard.FieldMapper.classify(el);
        const value = type === 'checkbox' ? (el.checked ? 'true' : '') : el.value;

        detectedFields.push({
          field: el,
          semantic,
          value,
          files: el.files || null
        });
      }

      return {
        forms,
        fields: detectedFields,
        submitButtons
      };
    }
  };
})();
