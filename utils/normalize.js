/**
 * Normalization Utilities
 * Prepares text, dates, and identifiers for robust cross-verification
 * as specified in Phase 9 of the Implementation Guide.
 */

(function () {
  window.ErrorGuard = window.ErrorGuard || {};

  const MONTH_NAMES = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12
  };

  window.ErrorGuard.Normalize = {
    /**
     * Normalizes names/general strings:
     * - collapses multiple spaces
     * - lowercases
     * - removes special punctuation
     */
    text(str) {
      if (!str || typeof str !== 'string') return '';
      return str
        .toLowerCase()
        .normalize('NFD') // decompose accents
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    },

    /**
     * Formats string to Title Case for UI display
     */
    titleCase(str) {
      if (!str || typeof str !== 'string') return '';
      return str
        .toLowerCase()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    },

    /**
     * Normalizes phone number: strips country code (+91, 0), spaces, dashes.
     * Returns clean digits string.
     */
    phone(phoneStr) {
      if (!phoneStr || typeof phoneStr !== 'string') return '';
      let clean = phoneStr.trim().replace(/[\s\-()]/g, '');
      if (clean.startsWith('+91')) clean = clean.slice(3);
      else if (clean.startsWith('91') && clean.length === 12) clean = clean.slice(2);
      else if (clean.startsWith('0') && clean.length === 11) clean = clean.slice(1);
      return clean.replace(/\D/g, '');
    },

    /**
     * Normalizes bank account number: removes spaces, dashes.
     */
    bankAccount(accStr) {
      if (!accStr || typeof accStr !== 'string') return '';
      return accStr.trim().replace(/[\s\-]/g, '');
    },

    /**
     * Normalizes IFSC Code: uppercase, removes spaces and hyphens.
     */
    ifsc(ifscStr) {
      if (!ifscStr || typeof ifscStr !== 'string') return '';
      return ifscStr.trim().toUpperCase().replace(/[\s\-]/g, '');
    },

    /**
     * Normalizes alphanumeric IDs (Certificate numbers, Aadhaar, Application IDs)
     */
    identifier(id) {
      if (!id || typeof id !== 'string') return '';
      return id.toUpperCase().replace(/[\s\-_/.]/g, '').trim();
    },

    /**
     * Normalizes dates from various formats (DD/MM/YYYY, YYYY-MM-DD, DD-MM-YYYY)
     * to canonical format: YYYY-MM-DD
     */
    date(dateStr) {
      if (!dateStr || typeof dateStr !== 'string') return null;
      const clean = dateStr.trim();

      // Format: YYYY-MM-DD (Standard HTML5 date input)
      const isoMatch = clean.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
      if (isoMatch) {
        const y = parseInt(isoMatch[1], 10);
        const m = parseInt(isoMatch[2], 10);
        const d = parseInt(isoMatch[3], 10);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
          return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        }
      }

      // Format: DD/MM/YYYY or DD-MM-YYYY (Common in Indian official forms and certificates)
      const dmyMatch = clean.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
      if (dmyMatch) {
        const d = parseInt(dmyMatch[1], 10);
        const m = parseInt(dmyMatch[2], 10);
        const y = parseInt(dmyMatch[3], 10);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
          return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        }
      }

      // Format: DD Month YYYY (e.g. 12 May 2005)
      const textDateMatch = clean.match(/^(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})$/);
      if (textDateMatch) {
        const d = parseInt(textDateMatch[1], 10);
        const monthKey = textDateMatch[2].toLowerCase();
        const y = parseInt(textDateMatch[3], 10);
        const m = MONTH_NAMES[monthKey];
        if (m && d >= 1 && d <= 31) {
          return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        }
      }

      return null;
    },

    /**
     * Formats canonical YYYY-MM-DD back to user-friendly DD/MM/YYYY
     */
    formatDateDisplay(isoDate) {
      if (!isoDate || typeof isoDate !== 'string') return '';
      const parts = isoDate.split('-');
      if (parts.length === 3) {
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
      }
      return isoDate;
    },

    /**
     * Normalizes email address: trims whitespace and lowercases
     */
    email(emailStr) {
      if (!emailStr || typeof emailStr !== 'string') return '';
      return emailStr.trim().toLowerCase();
    },

    /**
     * Validates an email address against robust format rules and regex patterns.
     * Identifies specific errors in wrongly typed email addresses.
     * @param {string} emailStr
     * @returns {{ isValid: boolean, code?: string, error?: string, fix?: string }}
     */
    validateEmail(emailStr) {
      if (!emailStr || typeof emailStr !== 'string') {
        return { isValid: false, code: 'EMAIL_EMPTY', error: 'Email address cannot be empty.' };
      }
      const val = emailStr.trim();
      if (!val) {
        return { isValid: false, code: 'EMAIL_EMPTY', error: 'Email address cannot be empty.' };
      }

      // 1. Whitespace check
      if (/\s/.test(val)) {
        return {
          isValid: false,
          code: 'EMAIL_CONTAINS_SPACES',
          error: `Email address cannot contain spaces (entered: "${val}").`,
          fix: 'Remove all spaces from the email address.'
        };
      }

      // 2. @ presence check
      if (!val.includes('@')) {
        return {
          isValid: false,
          code: 'EMAIL_MISSING_AT',
          error: `Email address is missing the '@' symbol (entered: "${val}").`,
          fix: 'Enter an email with an "@" symbol (e.g. name@example.com).'
        };
      }

      // 3. Multiple @ check
      const atParts = val.split('@');
      if (atParts.length > 2) {
        return {
          isValid: false,
          code: 'EMAIL_MULTIPLE_AT',
          error: `Email address cannot contain multiple '@' symbols (entered: "${val}").`,
          fix: 'Ensure your email contains only one "@" symbol.'
        };
      }

      const [localPart, domainPart] = atParts;

      // 4. Local part (username before @)
      if (!localPart || localPart.length === 0) {
        return {
          isValid: false,
          code: 'EMAIL_MISSING_LOCAL_PART',
          error: `Email address is missing the username before '@' (entered: "${val}").`,
          fix: 'Enter your email username before the @ symbol.'
        };
      }

      if (localPart.startsWith('.') || localPart.endsWith('.')) {
        return {
          isValid: false,
          code: 'EMAIL_DOT_PLACEMENT',
          error: `Email username cannot start or end with a dot (entered: "${val}").`,
          fix: 'Remove leading or trailing dots from the email username.'
        };
      }

      if (/\.{2,}/.test(localPart)) {
        return {
          isValid: false,
          code: 'EMAIL_CONSECUTIVE_DOTS',
          error: `Email username cannot contain consecutive dots '..' (entered: "${val}").`,
          fix: 'Remove consecutive dots from your email username.'
        };
      }

      // RFC 5322 characters in local part
      const localRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
      if (!localRegex.test(localPart)) {
        return {
          isValid: false,
          code: 'EMAIL_INVALID_LOCAL_CHARS',
          error: `Email username contains invalid characters (entered: "${val}").`,
          fix: 'Use standard letters, numbers, and basic symbols.'
        };
      }

      // 5. Domain part (after @)
      if (!domainPart || domainPart.length === 0) {
        return {
          isValid: false,
          code: 'EMAIL_MISSING_DOMAIN',
          error: `Email address is missing the domain after '@' (entered: "${val}").`,
          fix: 'Enter a complete domain (e.g. @gmail.com, @domain.gov.in).'
        };
      }

      // 6. Typo check: comma in domain (e.g. user@gmail,com)
      if (domainPart.includes(',')) {
        const suggested = val.replace(/,/g, '.');
        return {
          isValid: false,
          code: 'EMAIL_COMMA_IN_DOMAIN',
          error: `Email domain contains a comma ',' instead of a dot '.' (entered: "${val}").`,
          fix: `Did you mean "${suggested}"? Replace the comma with a dot.`
        };
      }

      // 7. Domain must contain dot
      if (!domainPart.includes('.')) {
        return {
          isValid: false,
          code: 'EMAIL_MISSING_TLD',
          error: `Email domain "${domainPart}" is missing a top-level extension like .com, .in, or .org.`,
          fix: `Add a valid domain extension (e.g. "${val}.com").`
        };
      }

      // 8. Domain dot/hyphen placement
      if (domainPart.startsWith('.') || domainPart.endsWith('.') || domainPart.startsWith('-') || domainPart.endsWith('-')) {
        return {
          isValid: false,
          code: 'EMAIL_DOMAIN_DOT_PLACEMENT',
          error: `Email domain cannot start or end with a dot or hyphen (entered: "${val}").`,
          fix: 'Ensure the domain name begins and ends with letters or digits.'
        };
      }

      if (/\.{2,}/.test(domainPart)) {
        return {
          isValid: false,
          code: 'EMAIL_DOMAIN_CONSECUTIVE_DOTS',
          error: `Email domain cannot contain consecutive dots '..' (entered: "${val}").`,
          fix: 'Remove consecutive dots from the domain.'
        };
      }

      // 9. Check domain labels
      const domainLabels = domainPart.split('.');
      for (const label of domainLabels) {
        if (!label || label.length === 0) {
          return {
            isValid: false,
            code: 'EMAIL_INVALID_DOMAIN_LABEL',
            error: `Email domain contains an empty segment (entered: "${val}").`,
            fix: 'Check the domain name format.'
          };
        }
        if (!/^[a-zA-Z0-9-]+$/.test(label) || label.startsWith('-') || label.endsWith('-')) {
          return {
            isValid: false,
            code: 'EMAIL_INVALID_DOMAIN_CHARS',
            error: `Email domain segment "${label}" contains invalid characters.`,
            fix: 'Domain can only contain letters, numbers, and hyphens.'
          };
        }
      }

      // 10. Top-Level Domain (TLD) must be letters only, at least 2 chars
      const tld = domainLabels[domainLabels.length - 1];
      if (!/^[a-zA-Z]{2,24}$/.test(tld)) {
        return {
          isValid: false,
          code: 'EMAIL_INVALID_TLD',
          error: `Email domain extension ".${tld}" is invalid (must be at least 2 letters, e.g. .com, .in, .org).`,
          fix: 'Enter a valid domain extension like .com, .in, or .gov.in.'
        };
      }

      // 11. Common domain typo hints
      const domainLower = domainPart.toLowerCase();
      const TYPO_MAP = {
        'gmial.com': 'gmail.com',
        'gamil.com': 'gmail.com',
        'gmai.com': 'gmail.com',
        'gmaill.com': 'gmail.com',
        'yaho.com': 'yahoo.com',
        'yahooo.com': 'yahoo.com',
        'hotmial.com': 'hotmail.com',
        'hotmai.com': 'hotmail.com',
        'outlok.com': 'outlook.com',
        'outloo.com': 'outlook.com',
        'redifmail.com': 'rediffmail.com'
      };

      if (TYPO_MAP[domainLower]) {
        const correctDomain = TYPO_MAP[domainLower];
        const suggested = `${localPart}@${correctDomain}`;
        return {
          isValid: false,
          code: 'EMAIL_DOMAIN_TYPO',
          error: `Possible domain typo: "${domainPart}" looks like "${correctDomain}".`,
          fix: `Did you mean "${suggested}"?`
        };
      }

      // 12. Full standard RFC regex validation
      const standardEmailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
      if (!standardEmailRegex.test(val)) {
        return {
          isValid: false,
          code: 'INVALID_EMAIL_FORMAT',
          error: `Invalid email address format: "${val}".`,
          fix: 'Please enter a valid email address (e.g. applicant@domain.gov.in).'
        };
      }

      return { isValid: true };
    }
  };
})();
