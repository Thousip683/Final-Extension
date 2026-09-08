/**
 * File Validator Module
 * Enforces file size limits, accepted MIME types, and file extensions.
 * Phase 5 of Build Guide.
 */

(function () {
  window.ErrorGuard = window.ErrorGuard || {};

  function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  window.ErrorGuard.FileValidator = {
    /**
     * Validates a File object against portal rules
     * @param {File} file
     * @param {object} fileRules
     * @returns {Array<object>} list of file issues
     */
    validate(file, fileRules = {}) {
      const issues = [];
      if (!file) return issues;

      const maxBytes = fileRules.maxSizeBytes || 2097152; // 2 MB default
      const acceptedMimes = fileRules.acceptedMimeTypes || ['image/png', 'image/jpeg', 'application/pdf'];
      const acceptedExts = fileRules.acceptedExtensions || ['.png', '.jpg', '.jpeg', '.pdf'];

      // Check 1: File size > 0
      if (file.size === 0) {
        issues.push({
          code: 'FILE_EMPTY',
          severity: 'BLOCKING',
          message: 'The selected file is empty (0 bytes).',
          fix: 'Please select a valid, non-empty document.'
        });
        return issues;
      }

      // Check 2: Max File Size
      if (file.size > maxBytes) {
        issues.push({
          code: 'FILE_TOO_LARGE',
          severity: 'BLOCKING',
          message: `File size is ${formatBytes(file.size)}, which exceeds the maximum allowed limit of ${formatBytes(maxBytes)}.`,
          fix: `Please compress or resize the document to under ${formatBytes(maxBytes)}.`
        });
      }

      // Check 3: MIME type and Extension
      const fileName = file.name || '';
      const ext = (fileName.slice(fileName.lastIndexOf('.')) || '').toLowerCase();
      const mime = (file.type || '').toLowerCase();

      const isMimeValid = !mime || acceptedMimes.some(m => m.toLowerCase() === mime);
      const isExtValid = acceptedExts.some(e => e.toLowerCase() === ext);

      if (!isMimeValid || !isExtValid) {
        issues.push({
          code: 'FILE_TYPE_NOT_ALLOWED',
          severity: 'BLOCKING',
          message: `File type "${ext || mime || 'unknown'}" is not permitted. Only ${acceptedExts.join(', ')} are supported.`,
          fix: `Convert or save your document in one of the allowed formats: ${acceptedExts.join(', ')}.`
        });
      }

      return issues;
    }
  };
})();
