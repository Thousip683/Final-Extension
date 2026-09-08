/**
 * Reading Engine Module (on-device)
 *
 * Documents are read entirely inside the browser by the bundled PP-OCRv6_small
 * pipeline running in this extension's offscreen page:
 *   - PDFs with a text layer are read directly from that text layer
 *   - Scanned PDFs and images go through PP-OCRv6 detection + recognition
 *   - Fields are then extracted by the deterministic document-understanding
 *     layer (Aadhaar / PAN / certificate / generic), with confidence + evidence
 *
 * Nothing is uploaded. There is no demo shortcut: every file is really read.
 *
 * Cloud reading (Gemini / local backend) is kept only as an explicit opt-in.
 * It is OFF unless the user turns on "Cloud AI reading" in the popup, and it
 * sends the document to Google when enabled.
 */

(function () {
  window.ErrorGuard = window.ErrorGuard || {};

  async function cloudReadingEnabled() {
    try {
      const S = window.ErrorGuard.Storage;
      if (!S) return false;
      return (await S.get('EG_CLOUD_AI_ENABLED')) === true;
    } catch (e) {
      return false;
    }
  }

  /** Legacy-shaped result so every existing caller keeps working. */
  function toLegacy(read) {
    const f = (read && read.flat) || {};
    return {
      text: read && read.text ? read.text : '',
      confidence: read && typeof read.confidence === 'number' ? read.confidence : 0,
      onDevice: true,
      engine: 'PP-OCRv6_small (local)',
      docFields: {
        name: f.name || null,
        fatherName: f.fatherName || null,
        dob: f.dob || null,
        gender: f.gender || null,
        phone: f.phone || f.mobile || null,
        certificateNo: f.certificateNo || null,
        aadhaarNo: f.aadhaarNo || null,
        panNo: f.panNo || null,
        issueDate: f.issueDate || null,
        docType: (read && read.documentType ? String(read.documentType) : 'unknown').toUpperCase(),
        classificationConfidence: read && read.classification && read.classification.confidence,
        candidates: (read && read.fields) || {},
        warnings: (read && read.warnings) || [],
        timings: (read && read.timings) || {},
        source: read && read.source
      },
      read
    };
  }

  window.ErrorGuard.OcrEngine = {
    /**
     * Reads a document and returns text + structured fields.
     * @param {File|Blob} file
     * @param {function(number,string)} onProgress
     * @param {Array} formFields optional page form descriptors for local mapping
     */
    async extractText(file, onProgress = () => {}, formFields = []) {
      if (!file) return { text: '', confidence: 0 };

      const Logger = window.ErrorGuard.Logger || { info() {}, warn() {} };
      const LP = window.ErrorGuard.LocalPipeline;

      if (LP && LP.available()) {
        const result = await LP.read(file, formFields, onProgress);
        if (result.ok) {
          onProgress(100, 'Read on this device ✓');
          Logger.info('OcrEngine', 'On-device reading complete', {
            docType: result.read.documentType,
            regions: result.read.regionCount,
            confidence: result.read.confidence
          });
          const legacy = toLegacy(result.read);
          legacy.match = result.match;
          return legacy;
        }
        Logger.warn('OcrEngine', `On-device reading failed: ${result.error}`);
        onProgress(100, 'Could not read this document on this device');
        if (!(await cloudReadingEnabled())) {
          return {
            text: '',
            confidence: 0,
            onDevice: true,
            warning: result.error || 'The document could not be read on this device.'
          };
        }
      }

      // ── Optional, explicitly enabled cloud reading ─────────────────
      if (!(await cloudReadingEnabled())) {
        return {
          text: '',
          confidence: 0,
          onDevice: true,
          warning: 'On-device reader unavailable. Reload the page and try again.'
        };
      }

      Logger.warn('OcrEngine', 'Cloud reading is enabled — this document is sent to Google.');

      try {
        const bFetch = window.ErrorGuard.backendFetch || fetch;
        let backendUrl = 'http://localhost:5001';
        let health = await bFetch(`${backendUrl}/api/health`).catch(() => null);
        if (!health || !health.ok) {
          backendUrl = 'http://localhost:5000';
          health = await bFetch(`${backendUrl}/api/health`).catch(() => null);
        }
        if (health && health.ok) {
          onProgress(35, 'Sending document to the cloud reader (opt-in)...');
          const base64Data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          const mimeType =
            file.type || (String(file.name).toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/png');
          const res = await bFetch(`${backendUrl}/api/analyze-document`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileData: base64Data, mimeType, fileName: file.name })
          });
          if (res && res.ok) {
            const data = await res.json();
            if (data.success && data.fields) {
              onProgress(100, 'Cloud reading complete');
              return {
                text: data.raw_text || '',
                confidence: data.confidence || 0.9,
                onDevice: false,
                docFields: {
                  name: data.fields.full_name || null,
                  fatherName: data.fields.father_name || null,
                  dob: data.fields.dob || null,
                  gender: data.fields.gender || null,
                  phone: data.fields.phone || data.fields.mobile || null,
                  certificateNo: data.fields.certificate_no || null,
                  aadhaarNo: null,
                  panNo: null,
                  docType: (data.document_type || 'DOCUMENT').toUpperCase(),
                  candidates: [],
                  warnings: ['Read in the cloud (opt-in), not on this device.']
                }
              };
            }
          }
        }

        const key =
          window.ErrorGuard.Storage && window.ErrorGuard.Storage.getGoogleApiKey
            ? await window.ErrorGuard.Storage.getGoogleApiKey()
            : '';
        if (key && window.ErrorGuard.GoogleVision) {
          onProgress(35, 'Sending document to Google Gemini (opt-in)...');
          return await window.ErrorGuard.GoogleVision.analyzeDocument(file, key, onProgress);
        }
      } catch (err) {
        Logger.warn('OcrEngine', 'Cloud reading failed', err);
      }

      return {
        text: '',
        confidence: 0,
        onDevice: false,
        warning: 'The document could not be read.'
      };
    }
  };
})();
