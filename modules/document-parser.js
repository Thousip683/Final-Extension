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
    'scan', 'qr', 'barcode', 'issued', 'www', 'http', 'toll', 'free', 'help',
    'mobile', 'phone', 'mob', 'contact', 'cell', 'telephone'
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

  /**
   * Robust Indian mobile number extractor from OCR text.
   * Prioritizes explicit labels, followed by +91 country codes, then standalone 10-digit patterns,
   * while strictly avoiding Aadhaar numbers, enrollment IDs, dates, and account numbers.
   */
  function extractMobileNumber(ocrText, rawLines = []) {
    if (!ocrText || typeof ocrText !== 'string') return null;

    // Clean null bytes and control characters from PDF text streams
    const cleanOcrText = ocrText.replace(/[\0\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');

    const normalizePhoneDigits = (raw) => {
      if (!raw) return null;
      let digits = raw.replace(/\D/g, '');
      if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);
      else if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);
      // Valid Indian mobile numbers are 10 digits starting with 6, 7, 8, or 9
      if (digits.length === 10 && /^[6-9]/.test(digits)) {
        return digits;
      }
      return null;
    };

    const lines = Array.isArray(rawLines) && rawLines.length > 0
      ? rawLines.map(l => l.replace(/[\0\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').trim()).filter(Boolean)
      : cleanOcrText.split('\n').map(l => l.trim()).filter(Boolean);

    // Priority 1: Labeled numbers (Mobile, Phone, Contact, Cell, multilingual labels)
    // Matches the label, optional country code (+91/0), and precisely a 10-digit number starting with 6-9
    // without greedily absorbing subsequent Aadhaar numbers on the same line.
    const labelRegex = /(?:mobile(?:\s*no\.?|\s*number|\s*num)?|mob\.?|phone(?:\s*no\.?|\s*number|\s*num)?|ph\.?|contact(?:\s*no\.?|\s*number)?|cell|telephone|दूरभाष|मोबाइल|మొబైల్|ఫోన్|సంపర్క|సంప్రదించండి)\s*[:=\-]?\s*(?:\+?91[\s\-]??|0)?\s*([6-9](?:[\s\-]??\d){9})\b/i;

    for (const line of lines) {
      const match = line.match(labelRegex);
      if (match && match[1]) {
        const phone = normalizePhoneDigits(match[1]);
        if (phone) return phone;
      }
    }

    const fullTextLabelMatch = cleanOcrText.match(labelRegex);
    if (fullTextLabelMatch && fullTextLabelMatch[1]) {
      const phone = normalizePhoneDigits(fullTextLabelMatch[1]);
      if (phone) return phone;
    }

    // Priority 2: Explicit country code +91 or 0091 followed by 10-digit number
    const countryCodeRegex = /(?:\+91|0091)[\s\-]?([6-9](?:[\s\-]??\d){9})\b/;
    const ccMatch = cleanOcrText.match(countryCodeRegex);
    if (ccMatch && ccMatch[1]) {
      const phone = normalizePhoneDigits(ccMatch[1]);
      if (phone) return phone;
    }

    // Priority 3: Standalone 10-digit Indian mobile number
    for (const line of lines) {
      if (/\b\d{4}[\s\-_.]*\d{4}[\s\-_.]*\d{4}\b/.test(line)) continue;
      if (/\b\d{12}\b/.test(line)) continue;
      if (/(?:dob|d\.o\.b|birth|जन्म|year|yob|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i.test(line)) continue;
      if (/(?:enrolment|enrollment|account|ifsc|pan|tax|income)/i.test(line) && !/mobile|phone|contact/i.test(line)) continue;

      const standAloneMatch = line.match(/\b([6-9]\d{9})\b/) || line.match(/\b([6-9](?:[\s\-]??\d){9})\b/);
      if (standAloneMatch) {
        const rawDigits = standAloneMatch[0].replace(/\D/g, '');
        const phone = normalizePhoneDigits(rawDigits);
        if (phone) return phone;
      }
    }

    return null;
  }

  window.ErrorGuard.DocumentParser = {
    /**
     * Parses OCR text into structured fields
     * @param {string} ocrText
     * @param {Object} [aiData] - Optional structured data from Google Gemini Vision
     * @returns {{ name: string|null, dob: string|null, gender: string|null, phone: string|null, certificateNo: string|null, aadhaarNo: string|null, panNo: string|null, docType: string, lines: Array<string>, raw: string }}
     */
    parse(ocrText, aiData = null) {
      const rawLines = (ocrText || '').split('\n').map(l => l.trim()).filter(Boolean);

      // ── On-device engine result ────────────────────────────────────
      // The local PP-OCRv6 pipeline already produced classified fields with
      // confidence and evidence, so trust them instead of re-guessing by regex.
      if (aiData && aiData.docType && (aiData.name || aiData.dob || aiData.certificateNo || aiData.aadhaarNo || aiData.panNo || aiData.phone || aiData.mobile)) {
        const extractedPhone = aiData.phone || aiData.mobile || extractMobileNumber(ocrText, rawLines);
        return {
          name: aiData.name || null,
          fatherName: aiData.fatherName || null,
          dob: aiData.dob || null,
          gender: aiData.gender || null,
          phone: extractedPhone || null,
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
          lines: rawLines,
          raw: ocrText || ''
        };
      }

      if (aiData && (aiData.name || aiData.dob || aiData.certificateNo || aiData.gender || aiData.phone || aiData.mobile)) {
        const extractedPhone = aiData.phone || aiData.mobile || extractMobileNumber(ocrText, rawLines);
        return {
          name: aiData.name || null,
          dob: aiData.dob || null,
          gender: aiData.gender || null,
          phone: extractedPhone || null,
          certificateNo: aiData.certificateNo || null,
          aadhaarNo: aiData.docType === 'AADHAAR' ? aiData.certificateNo : null,
          panNo: aiData.docType === 'PAN' ? aiData.certificateNo : null,
          docType: aiData.docType || 'DOCUMENT',
          authority: aiData.authority || null,
          notes: aiData.notes || '',
          lines: rawLines,
          raw: ocrText || '',
          isAi: true
        };
      }

      if (!ocrText || typeof ocrText !== 'string') {
        return {
          name: null,
          dob: null,
          gender: null,
          phone: null,
          certificateNo: null,
          aadhaarNo: null,
          panNo: null,
          docType: 'UNKNOWN',
          lines: [],
          raw: ''
        };
      }

      let name = null;
      let dob = null;
      let gender = null;
      let phone = extractMobileNumber(ocrText, rawLines);
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

        // B2. Explicit Gender Label
        if (!gender) {
          const genderMatch = line.match(/(?:gender|sex|लिंग)\s*[:=\-]?\s*(male|female|transgender|पुरुष|महिला)/i);
          if (genderMatch && genderMatch[1]) {
            const g = genderMatch[1].toLowerCase();
            gender = (g === 'female' || g === 'महिला') ? 'FEMALE' : (g.includes('trans') ? 'TRANSGENDER' : 'MALE');
          } else {
            const standaloneGender = line.match(/\b(male|female|transgender|पुरुष|महिला)\b/i);
            if (standaloneGender && standaloneGender[1]) {
              const g = standaloneGender[1].toLowerCase();
              gender = (g === 'female' || g === 'महिला') ? 'FEMALE' : (g.includes('trans') ? 'TRANSGENDER' : 'MALE');
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
        gender,
        phone,
        certificateNo,
        aadhaarNo,
        panNo,
        docType
      });

      return {
        name,
        dob,
        gender,
        phone,
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
