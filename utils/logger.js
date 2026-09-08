/**
 * Privacy-safe Logger
 * Prevents full names, certificate numbers, and uploaded document contents
 * from appearing in console logs (as mandated by Section 20 of PRD).
 */

(function () {
  window.ErrorGuard = window.ErrorGuard || {};

  function maskString(str) {
    if (!str || typeof str !== 'string') return '';
    const trimmed = str.trim();
    if (trimmed.length <= 3) return '***';
    return trimmed[0] + '*'.repeat(Math.max(2, trimmed.length - 2)) + trimmed[trimmed.length - 1];
  }

  function maskEmail(email) {
    if (!email || typeof email !== 'string' || !email.includes('@')) return '***@***';
    const [user, domain] = email.split('@');
    return maskString(user) + '@' + domain;
  }

  window.ErrorGuard.Logger = {
    info(tag, message, meta = null) {
      if (meta) {
        console.log(`[ErrorGuard::${tag}]`, message, meta);
      } else {
        console.log(`[ErrorGuard::${tag}]`, message);
      }
    },

    warn(tag, message, meta = null) {
      console.warn(`[ErrorGuard::${tag}] ⚠️`, message, meta || '');
    },

    error(tag, message, err = null) {
      console.error(`[ErrorGuard::${tag}] ❌`, message, err || '');
    },

    mask(value, type = 'text') {
      if (type === 'email') return maskEmail(value);
      return maskString(value);
    }
  };
})();
