/**
 * Error Engine Module
 * Aggregates all checks, categorizes issues according to the PRD error taxonomy,
 * computes the Application Health Score, and determines the final pre-submission Readiness status.
 * Phase 10 of Build Guide.
 */

(function () {
  window.ErrorGuard = window.ErrorGuard || {};

  window.ErrorGuard.ErrorEngine = {
    /**
     * Aggregates all check results into a unified application health report
     * @param {object} params
     * @param {Array<object>} params.formIssues
     * @param {Array<object>} params.fileIssues
     * @param {Array<object>} params.qualityIssues
     * @param {Array<object>} params.crossCheckIssues
     * @param {object} params.extractedData
     * @param {object} params.formData
     * @returns {object} complete application health and readiness summary
     */
    aggregate({
      formIssues = [],
      fileIssues = [],
      qualityIssues = [],
      crossCheckIssues = [],
      extractedData = null,
      formData = {}
    }) {
      const allIssues = [
        ...formIssues,
        ...fileIssues,
        ...qualityIssues,
        ...crossCheckIssues
      ];

      const blockingIssues = allIssues.filter(i => i.severity === 'BLOCKING');
      const warningIssues = allIssues.filter(i => i.severity === 'WARNING');
      const infoIssues = allIssues.filter(i => i.severity === 'INFO');

      const isReady = blockingIssues.length === 0;
      const status = isReady ? 'READY TO SUBMIT' : 'NOT READY TO SUBMIT';

      // Application Health Score calculation (0 to 100)
      // Total potential baseline points: 100
      // Each blocking issue deducts 25 points, each warning deducts 8 points
      let score = 100;
      score -= blockingIssues.length * 25;
      score -= warningIssues.length * 8;
      score = Math.max(10, Math.min(100, score));

      const hasFileInput = !!(formData.hasFileInput || formData.hasFile || fileIssues.length > 0);
      const isFileRequired = formIssues.some(i => i.code === 'REQUIRED_FIELD_MISSING' && (i.field === 'FILE_UPLOAD' || (i.element && i.element.type === 'file')));

      // Checklist section summaries
      const checklist = {
        form: {
          nameEntered: !!formData.full_name,
          dobEntered: !!formData.dob,
          certNoEntered: !!formData.certificate_no,
          declarationConfirmed: !!formData.declaration,
          valid: formIssues.filter(i => i.severity === 'BLOCKING').length === 0
        },
        document: {
          hasFileInput,
          required: isFileRequired,
          uploaded: !!formData.hasFile,
          formatValid: fileIssues.filter(i => i.code === 'FILE_TYPE_NOT_ALLOWED').length === 0,
          sizeValid: fileIssues.filter(i => i.code === 'FILE_TOO_LARGE').length === 0,
          qualityPass: qualityIssues.length === 0
        },
        verification: {
          nameMatch: extractedData?.name ? crossCheckIssues.filter(i => i.code === 'NAME_MISMATCH').length === 0 : null,
          dobMatch: extractedData?.dob ? crossCheckIssues.filter(i => i.code === 'DOB_MISMATCH').length === 0 : null,
          certNoMatch: extractedData?.certificateNo ? crossCheckIssues.filter(i => i.code === 'IDENTIFIER_MISMATCH').length === 0 : null
        }
      };

      return {
        status,
        isReady,
        healthScore: score,
        issues: {
          all: allIssues,
          blocking: blockingIssues,
          warnings: warningIssues,
          info: infoIssues
        },
        checklist,
        extractedData,
        timestamp: Date.now()
      };
    }
  };
})();
