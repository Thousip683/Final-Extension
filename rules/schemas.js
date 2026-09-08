/**
 * Rule Schemas & Generic Fallbacks
 * Used when no portal-specific JSON profile is matched.
 */

(function () {
  window.ErrorGuard = window.ErrorGuard || {};

  window.ErrorGuard.Schemas = {
    DEFAULT_PROFILE: {
      portalId: 'generic_default',
      name: 'Generic Form Guard',
      fileRules: {
        maxSizeBytes: 5242880, // 5 MB fallback
        acceptedMimeTypes: [
          'image/png',
          'image/jpeg',
          'image/jpg',
          'application/pdf'
        ],
        acceptedExtensions: ['.png', '.jpg', '.jpeg', '.pdf'],
        minWidth: 200,
        minHeight: 200
      },
      crossChecks: {
        verifyName: { enabled: true, fuzzyThreshold: 0.85 },
        verifyDob: { enabled: true, exactMatch: true },
        verifyCertificateNo: { enabled: true, exactMatch: true }
      },
      submissionGuard: {
        preventSubmitOnBlocking: true,
        allowUserOverride: true
      }
    }
  };
})();
