/**
 * Document Parser Module
 * Parses raw OCR text into structured application fields (Name, DOB, Cert No).
 * Phase 8 of Build Guide.
 */

(function () {
  window.ErrorGuard = window.ErrorGuard || {};

  const NON_NAME_KEYWORDS = [
    'government', 'india', 'state', 'department', 'certificate', 'authority',
    'unique', 'identification', 'uidai', 'enrolment', 'enrollment', 'help',
    'address', 'father', 'husband', 'mother', 'gender', 'male', 'female',
    'transgender', 'signature', 'issuing', 'tahsildar', 'revenue', 'portal',
    'income', 'tax', 'permanent', 'account', 'number', 'card', 'mera', 'aadhaar',
    'meri', 'pehchan', 'electronic', 'valid', 'download', 'date', 'generation',
    'scan', 'qr', 'barcode', 'issued', 'www', 'http', 'toll', 'free', 'help'
  ];

  function cleanCandidateName(str) {
    if (!str || typeof str !== 'string') return null;
    // Extract only Latin alphabetic sequences
    const cleaned = str
      .replace(/[^A-Za-z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleaned.length < 3 || cleaned.length > 50) return null;

    const lower = cleaned.toLowerCase();
    for (const kw of NON_NAME_KEYWORDS) {
      if (lower.includes(kw)) return null;
    }

    const words = cleaned.split(' ').filter(w => w.length > 1);
    if (words.length >= 1 && words.length <= 5) {
      return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }
    return null;
  }

  window.ErrorGuard.DocumentParser = {
    /**
     * Parses OCR text into structured fields
     * @param {string} ocrText
     * @param {Object} [aiData] - Optional structured data from Google Gemini Vision
     * @returns {{ name: string|null, dob: string|null, certificateNo: string|null, aadhaarNo: string|null, panNo: string|null, docType: string, lines: Array<string>, raw: string }}
     */
    parse(ocrText, aiData = null) {
      // ── On-device engine result ────────────────────────────────────
      // The local PP-OCRv6 pipeline already produced classified fields with
      // confidence and evidence, so trust them instead of re-guessing by regex.
      if (aiData && aiData.docType && (aiData.name || aiData.dob || aiData.certificateNo || aiData.aadhaarNo || aiData.panNo)) {
        return {
          name: aiData.name || null,
          fatherName: aiData.fatherName || null,
          dob: aiData.dob || null,
          gender: aiData.gender || null,
          certificateNo: aiData.certificateNo || null,
          aadhaarNo: aiData.aadhaarNo || null,
          panNo: aiData.panNo || null,
          docType: String(aiData.docType).toUpperCase(),
          authority: aiData.authority || null,
          notes: aiData.notes || '',
          candidates: aiData.candidates || [],
          warnings: aiData.warnings || [],
          timings: aiData.timings || {},
          onDevice: aiData.candidates ? true : false,
          lines: (ocrText || '').split('\n').map(l => l.trim()).filter(Boolean),
          raw: ocrText || ''
        };
      }

      if (aiData && (aiData.name || aiData.dob || aiData.certificateNo)) {
        return {
          name: aiData.name || null,
          dob: aiData.dob || null,
          certificateNo: aiData.certificateNo || null,
          aadhaarNo: aiData.docType === 'AADHAAR' ? aiData.certificateNo : null,
          panNo: aiData.docType === 'PAN' ? aiData.certificateNo : null,
          docType: aiData.docType || 'DOCUMENT',
          authority: aiData.authority || null,
          notes: aiData.notes || '',
          lines: (ocrText || '').split('\n'),
          raw: ocrText || '',
          isAi: true
        };
      }

      if (!ocrText || typeof ocrText !== 'string') {
        return {
          name: null,
          dob: null,
          certificateNo: null,
          aadhaarNo: null,
          panNo: null,
          docType: 'UNKNOWN',
          lines: [],
          raw: ''
        };
      }

      const rawLines = ocrText.split('\n').map(l => l.trim()).filter(Boolean);
      let name = null;
      let dob = null;
      let certificateNo = null;
      let aadhaarNo = null;
      let panNo = null;
      let docType = 'GENERIC';

      // ── Detect Document Type ──
      const lowerAll = ocrText.toLowerCase();
      if (lowerAll.includes('aadhaar') || lowerAll.includes('uidai') || lowerAll.includes('unique identification') || /\b\d{4}[\s\-_.]*\d{4}[\s\-_.]*\d{4}\b/.test(ocrText)) {
        docType = 'AADHAAR';
      } else if (lowerAll.includes('income tax department') || lowerAll.includes('permanent account number') || /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/.test(ocrText)) {
        docType = 'PAN';
      } else if (lowerAll.includes('certificate') || lowerAll.includes('revenue department')) {
        docType = 'CERTIFICATE';
      }

      // ── Step 1: Aadhaar 12-digit number (e.g. 1234 5678 9012 or 123456789012) ──
      const aadhaarMatch = ocrText.match(/\b([2-9]\d{3}[\s\-_.]*\d{4}[\s\-_.]*\d{4})\b/);
      if (aadhaarMatch) {
        const rawDigits = aadhaarMatch[1].replace(/\D/g, '');
        if (rawDigits.length === 12) {
          aadhaarNo = `${rawDigits.slice(0, 4)} ${rawDigits.slice(4, 8)} ${rawDigits.slice(8, 12)}`;
        }
      }

      // PAN Card (5 letters, 4 digits, 1 letter)
      const panMatch = ocrText.match(/\b([A-Z]{5}[0-9]{4}[A-Z]{1})\b/);
      if (panMatch) {
        panNo = panMatch[1].trim();
      }

      // ── Step 2: Line-by-line field extraction ──
      const candidateNames = [];

      for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];

        // A. Explicit Name Label
        if (!name) {
          const nameLabelMatch = line.match(/(?:full\s*name|applicant\s*name|candidate\s*name|^name)\s*[:=\-]\s*(.+)/i);
          if (nameLabelMatch && nameLabelMatch[1]) {
            const cand = cleanCandidateName(nameLabelMatch[1]);
            if (cand) name = cand;
          }
        }

        // B. Explicit DOB / Birth Date Label
        if (!dob) {
          if (/(?:date\s*of\s*birth|birth\s*date|dob|d\.o\.b|जन्म|year\s*of\s*birth|yob)/i.test(line)) {
            // Find DD/MM/YYYY or YYYY-MM-DD in line
            const dateMatch = line.match(/([0-3]?[0-9][./\-\s][0-1]?[0-9][./\-\s](?:19|20)\d{2})/);
            if (dateMatch) {
              dob = dateMatch[1].replace(/[\s.]/g, '/').replace(/--/g, '-');
            } else {
              const yearMatch = line.match(/\b(19\d{2}|20\d{2})\b/);
              if (yearMatch) dob = yearMatch[1];
            }
          }
        }

        // C. Explicit Certificate / Application Number
        if (!certificateNo) {
          const certMatch = line.match(/(?:certificate\s*(?:no|number)|cert\s*no|reg\s*no|appl\s*no|application\s*no)\s*[:=\-]\s*([A-Za-z0-9\-_]+)/i);
          if (certMatch && certMatch[1]) {
            certificateNo = certMatch[1].trim();
          }
        }

        // D. Collect Candidate Name Lines (for unlabelled cards like Aadhaar)
        const cand = cleanCandidateName(line);
        if (cand) {
          candidateNames.push({ index: i, text: cand });
        }
      }

      // ── Step 3: Global DOB fallback across whole text ──
      if (!dob) {
        const globalDateMatch = ocrText.match(/\b([0-3]?[0-9][./\-\s][0-1]?[0-9][./\-\s](?:19|20)\d{2})\b/);
        if (globalDateMatch) {
          dob = globalDateMatch[1].replace(/[\s.]/g, '/');
        }
      }

      // ── Step 4: Name Heuristics for Aadhaar/ID cards without explicit labels ──
      if (!name && candidateNames.length > 0) {
        if (docType === 'AADHAAR') {
          // Look for name right before DOB or Gender line
          const dobLineIdx = rawLines.findIndex(l => /(?:dob|d\.o\.b|birth|जन्म|gender|male|female)/i.test(l));
          if (dobLineIdx > 0) {
            for (let k = dobLineIdx - 1; k >= 0; k--) {
              const cand = cleanCandidateName(rawLines[k]);
              if (cand) {
                name = cand;
                break;
              }
            }
          }
        }

        // Fallback: Pick the first valid candidate name
        if (!name && candidateNames.length > 0) {
          name = candidateNames[0].text;
        }
      }

      // Do NOT fall back to aadhaarNo or panNo as certificateNo — they are
      // distinct identifier types and conflating them causes the Aadhaar number
      // to be auto-filled into caste/income certificate number fields.

      console.log('%c[ErrorGuard Parser] Document Parsed Result:', 'color: #10b981; font-weight: bold;', {
        name,
        dob,
        certificateNo,
        aadhaarNo,
        panNo,
        docType
      });

      return {
        name,
        dob,
        certificateNo,
        aadhaarNo,
        panNo,
        docType,
        lines: rawLines,
        raw: ocrText
      };
    }
  };
})();
