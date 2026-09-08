/**
 * Form Validator Module
 * Checks for missing required fields, invalid date formats,
 * and input completeness prior to submission.
 */

(function () {
  window.ErrorGuard = window.ErrorGuard || {};

  window.ErrorGuard.FormValidator = {
    /**
     * Validates detected fields against portal rules
     * @param {Array<{ field: HTMLElement, semantic: object, value: string }>} detectedFields
     * @param {object} ruleProfile
     * @returns {Array<object>} list of validation issues
     */
    validate(detectedFields, ruleProfile) {
      const issues = [];
      const requiredTypes = ruleProfile.requiredFields || [];
      const foundTypes = new Set();

      for (const item of detectedFields) {
        const { field, semantic, value } = item;
        const sType = semantic ? semantic.type : null;
        if (sType) foundTypes.add(sType);

        // A field is required ONLY if it explicitly carries the HTML `required` attribute.
        // The rule-profile `requiredTypes` is used below only to detect fields missing
        // entirely from the DOM — not to override optional fields that happen to share
        // the same semantic type (e.g. alternatePhone vs primary phone).
        const isRequired = field.hasAttribute('required');

        // Check 1: Missing Required Field
        if (isRequired) {
          if (sType === 'DECLARATION') {
            if (!field.checked) {
              issues.push({
                code: 'REQUIRED_FIELD_MISSING',
                field: sType,
                elementId: field.id,
                severity: 'BLOCKING',
                message: 'Self-declaration checkbox must be confirmed before submitting.',
                fix: 'Read and check the declaration box.'
              });
            }
          } else if (sType === 'FILE_UPLOAD') {
            if (!field.files || field.files.length === 0) {
              issues.push({
                code: 'REQUIRED_FIELD_MISSING',
                field: sType,
                elementId: field.id,
                severity: 'BLOCKING',
                message: 'Supporting certificate document is required.',
                fix: 'Upload your original certificate file (PNG, JPG, or PDF).'
              });
            }
          } else if (!value || value.trim() === '') {
            issues.push({
              code: 'REQUIRED_FIELD_MISSING',
              field: sType || field.name || field.id,
              elementId: field.id,
              severity: 'BLOCKING',
              message: `${semantic ? semantic.label : 'Field'} is required.`,
              fix: `Please enter a value for ${semantic ? semantic.label : 'this field'}.`
            });
          }
        }

        // Check 1.5: Name Format (letters and spaces only; no symbols, no digits)
        if (['FULL_NAME', 'FATHER_NAME', 'MOTHER_NAME'].includes(sType) && value && value.trim() !== '') {
          const rawName = value.trim();

          // 1. Check for numbers/digits
          if (/\d/.test(rawName)) {
            issues.push({
              code: 'INVALID_NAME_CONTAINS_DIGITS',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `${semantic ? semantic.label : 'Name'} cannot contain numbers (entered: "${value}").`,
              fix: 'Remove numbers and enter alphabetic letters only.'
            });
          }
          // 2. Check for special symbols (anything other than alphabetic letters, spaces, and dot for initials)
          else if (/[^a-zA-Z\s\.]/.test(rawName)) {
            const invalidChars = rawName.match(/[^a-zA-Z\s\.]/g) || [];
            const uniqueChars = [...new Set(invalidChars)].join(' ');
            issues.push({
              code: 'INVALID_NAME_CONTAINS_SYMBOLS',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `${semantic ? semantic.label : 'Name'} cannot contain special symbols (found: ${uniqueChars}; entered: "${value}").`,
              fix: 'Remove special characters and enter letters only.'
            });
          }
          // 3. Must contain at least 2 alphabetic letters
          else if ((rawName.match(/[a-zA-Z]/g) || []).length < 2) {
            issues.push({
              code: 'INVALID_NAME_LENGTH',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `${semantic ? semantic.label : 'Name'} must contain at least 2 alphabetic letters (entered: "${value}").`,
              fix: 'Enter valid legal name.'
            });
          }
        }

        // Check 2: Date Validity & Age Boundary (15 to 40 years)
        if (sType === 'DOB' && value && value.trim() !== '') {
          const normDate = window.ErrorGuard.Normalize.date(value);
          if (!normDate) {
            issues.push({
              code: 'INVALID_DATE',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: 'Invalid Date of Birth format. Please enter a valid date (DD/MM/YYYY).',
              fix: 'Correct the date to DD/MM/YYYY or select from the calendar.'
            });
          } else {
            const birthDate = new Date(normDate);
            const today = new Date();
            if (birthDate > today) {
              issues.push({
                code: 'FUTURE_DATE_OF_BIRTH',
                field: sType,
                elementId: field.id,
                element: field,
                severity: 'BLOCKING',
                message: `Date of Birth cannot be in the future (${normDate}).`,
                fix: 'Please select your actual past birth date.'
              });
            } else {
              let age = today.getFullYear() - birthDate.getFullYear();
              const m = today.getMonth() - birthDate.getMonth();
              if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
                age--;
              }
              if (age < 15) {
                issues.push({
                  code: 'APPLICANT_UNDERAGE',
                  field: sType,
                  elementId: field.id,
                  element: field,
                  severity: 'BLOCKING',
                  message: `Applicant must be at least 15 years old for post-matric scholarship (calculated age: ${age} years).`,
                  fix: 'Verify the date of birth entered.'
                });
              } else if (age > 40) {
                issues.push({
                  code: 'APPLICANT_OVERAGE',
                  field: sType,
                  elementId: field.id,
                  element: field,
                  severity: 'WARNING',
                  message: `Applicant age (${age} years) exceeds standard scheme limit of 40 years.`,
                  fix: 'Ensure age relaxation certificate is attached if applicable.'
                });
              }
            }
          }
        }

        // Check 3: Mobile Number Format (must start with 6-9 range, 10 digits total)
        if (sType === 'PHONE' && value && value.trim() !== '') {
          const rawVal = value.trim();
          const cleanPhone = window.ErrorGuard.Normalize && window.ErrorGuard.Normalize.phone
            ? window.ErrorGuard.Normalize.phone(rawVal)
            : rawVal.replace(/[\s\-()]/g, '').replace(/^(\+?91|0)/, '').replace(/\D/g, '');

          // Check for illegal non-numeric characters (excluding common phone separators)
          if (/[^\d\s\-+()]/.test(rawVal)) {
            issues.push({
              code: 'INVALID_PHONE_FORMAT',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `Mobile number contains invalid characters: "${value}".`,
              fix: 'Enter numbers only (10 digits starting with 6, 7, 8, or 9).'
            });
          } else if (cleanPhone.length > 0 && !/^[6-9]/.test(cleanPhone)) {
            issues.push({
              code: 'INVALID_PHONE_START',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `Invalid mobile number: must start with 6, 7, 8, or 9 (entered begins with "${cleanPhone[0]}").`,
              fix: 'Ensure your mobile number begins with 6, 7, 8, or 9 (e.g. 9876543210).'
            });
          } else if (cleanPhone.length !== 10) {
            issues.push({
              code: 'INVALID_PHONE_LENGTH',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `Mobile number must be exactly 10 digits (currently ${cleanPhone.length} digit${cleanPhone.length === 1 ? '' : 's'} entered: "${value}").`,
              fix: 'Enter a valid 10-digit mobile number.'
            });
          }
        }

        // Check 4: Aadhaar Number Format (UIDAI 12-Digit UID requirement, starts 2-9)
        if (sType === 'AADHAAR_NUMBER' && value && value.trim() !== '') {
          const cleanAadhaar = value.replace(/\D/g, '');
          if (cleanAadhaar.length !== 12) {
            issues.push({
              code: 'INVALID_AADHAAR_NUMBER',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `Aadhaar Number must be exactly 12 digits (currently ${cleanAadhaar.length} digit${cleanAadhaar.length === 1 ? '' : 's'} entered: "${value}").`,
              fix: 'Please enter all 12 digits of your Aadhaar UID number.'
            });
          } else if (cleanAadhaar.startsWith('0') || cleanAadhaar.startsWith('1')) {
            issues.push({
              code: 'INVALID_AADHAAR_START',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `Invalid Aadhaar Number: UIDAI Aadhaar numbers cannot start with '0' or '1' (entered starts with "${cleanAadhaar[0]}").`,
              fix: 'Ensure the Aadhaar number starts with a digit from 2 to 9 as issued by UIDAI.'
            });
          }
        }

        // Check 5: PAN Number Format (10-character alphanumeric: 5 letters, 4 digits, 1 letter)
        if (sType === 'PAN_NUMBER' && value && value.trim() !== '') {
          const cleanPan = value.trim().toUpperCase().replace(/[\s\-]/g, '');
          if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(cleanPan)) {
            issues.push({
              code: 'INVALID_PAN_NUMBER',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `PAN Number must be 10 characters (5 uppercase letters, 4 digits, 1 letter, e.g. ABCDE1234F; currently "${value}").`,
              fix: 'Please enter a valid 10-character Permanent Account Number.'
            });
          } else if (cleanPan[3] !== 'P') {
            issues.push({
              code: 'PAN_NON_INDIVIDUAL',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'WARNING',
              message: `PAN 4th character is "${cleanPan[3]}". Scholarship applicants must submit an Individual PAN (where the 4th letter is 'P' for Person, e.g. ABC P E1234F).`,
              fix: 'Verify you are entering the applicant personal PAN.'
            });
          }
        }

        // Check 6: Email Format (Regex Pattern Validation for wrongly typed emails)
        const fieldType = (field.getAttribute && field.getAttribute('type') || '').toLowerCase();
        const containsAt = value && value.includes('@') && !['password', 'hidden', 'file', 'checkbox', 'radio'].includes(fieldType);
        const contextStr = `${field.id || ''} ${field.name || ''} ${field.getAttribute && field.getAttribute('placeholder') || ''} ${semantic?.label || ''}`.toLowerCase();
        const allowsUsername = /(user|username|login|id)/i.test(contextStr) && fieldType !== 'email';
        const isDedicatedEmail = (sType === 'EMAIL' && !allowsUsername) || fieldType === 'email';

        // Validate if it is a dedicated email field OR if the user attempted to type an email (contains @)
        if ((isDedicatedEmail || containsAt) && value && value.trim() !== '') {
          if (!allowsUsername || containsAt) {
            const emailCheck = window.ErrorGuard.Normalize && window.ErrorGuard.Normalize.validateEmail
              ? window.ErrorGuard.Normalize.validateEmail(value.trim())
              : (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? { isValid: false, code: 'INVALID_EMAIL', error: `Invalid email format: "${value}".`, fix: 'Please enter a valid email address (e.g. applicant@domain.gov.in).' } : { isValid: true });

            if (!emailCheck.isValid) {
              issues.push({
                code: emailCheck.code || 'INVALID_EMAIL',
                field: sType || 'EMAIL',
                elementId: field.id,
                element: field,
                severity: 'BLOCKING',
                message: emailCheck.error || `Invalid email format: "${value}".`,
                fix: emailCheck.fix || 'Please enter a valid email address (e.g. applicant@domain.gov.in).'
              });
            }
          }
        }

        // Check 7: Bank Account Number Format (9 to 18 digits)
        if (sType === 'BANK_ACCOUNT' && value && value.trim() !== '') {
          const rawVal = value.trim();
          const cleanAcc = window.ErrorGuard.Normalize && window.ErrorGuard.Normalize.bankAccount
            ? window.ErrorGuard.Normalize.bankAccount(rawVal)
            : rawVal.replace(/[\s\-]/g, '');

          if (/[^\d\s\-]/.test(rawVal)) {
            issues.push({
              code: 'INVALID_BANK_ACCOUNT_FORMAT',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `Bank Account Number must contain numbers only (entered: "${value}").`,
              fix: 'Remove letters or symbols from your bank account number.'
            });
          } else if (cleanAcc.length < 9 || cleanAcc.length > 18) {
            issues.push({
              code: 'INVALID_BANK_ACCOUNT_LENGTH',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `Bank Account Number must be between 9 and 18 digits (currently ${cleanAcc.length} digits entered: "${value}").`,
              fix: 'Verify and enter your 9 to 18-digit bank account number.'
            });
          }
        }

        // Check 8: Bank IFSC Code Format (11 characters: 4 letters, 0, 6 alphanumeric branch characters)
        if (sType === 'IFSC_CODE' && value && value.trim() !== '') {
          const rawVal = value.trim().toUpperCase();
          const cleanIfsc = window.ErrorGuard.Normalize && window.ErrorGuard.Normalize.ifsc
            ? window.ErrorGuard.Normalize.ifsc(rawVal)
            : rawVal.replace(/[\s\-]/g, '');

          if (cleanIfsc.length !== 11) {
            issues.push({
              code: 'INVALID_IFSC_LENGTH',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `IFSC Code must be exactly 11 characters (currently ${cleanIfsc.length} entered: "${value}").`,
              fix: 'Enter a valid 11-character IFSC code (e.g. SBIN0001234).'
            });
          } else if (cleanIfsc[4] === 'O') {
            issues.push({
              code: 'INVALID_IFSC_FIFTH_CHAR',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `Invalid IFSC Code: the 5th character must be the digit zero "0", not the letter "O" ("${cleanIfsc}").`,
              fix: 'Change the 5th character from letter "O" to number "0" (e.g. SBIN0... instead of SBINO...).'
            });
          } else if (!/^[A-Z]{4}/.test(cleanIfsc)) {
            issues.push({
              code: 'INVALID_IFSC_BANK_CODE',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `Invalid IFSC Code: first 4 characters must be alphabetic bank letters (e.g. SBIN, HDFC, ICIC).`,
              fix: 'Ensure the first 4 characters are letters representing the bank name.'
            });
          } else if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(cleanIfsc)) {
            issues.push({
              code: 'INVALID_IFSC_FORMAT',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `Invalid IFSC Code format: "${value}". Must be 4 letters, digit 0, and 6 branch characters (e.g. SBIN0001234).`,
              fix: 'Enter a valid 11-character Indian Financial System Code.'
            });
          }
        }

        // Check 9: Postal PIN Code Format (6 digits, starts with 1-9)
        if (sType === 'PINCODE' && value && value.trim() !== '') {
          const rawPin = value.trim();
          const cleanPin = rawPin.replace(/\D/g, '');

          if (/[^\d\s\-]/.test(rawPin)) {
            issues.push({
              code: 'INVALID_PINCODE_FORMAT',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `PIN Code must contain numeric digits only (entered: "${value}").`,
              fix: 'Enter a valid 6-digit numeric postal code.'
            });
          } else if (cleanPin.length !== 6) {
            issues.push({
              code: 'INVALID_PINCODE_LENGTH',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `PIN Code must be exactly 6 digits (currently ${cleanPin.length} digits entered: "${value}").`,
              fix: 'Enter a 6-digit postal PIN code.'
            });
          } else if (cleanPin.startsWith('0')) {
            issues.push({
              code: 'INVALID_PINCODE_START',
              field: sType,
              elementId: field.id,
              element: field,
              severity: 'BLOCKING',
              message: `Invalid PIN Code: Indian postal PIN codes cannot start with '0' (entered: "${cleanPin}").`,
              fix: 'Enter a valid PIN code starting with a digit between 1 and 9.'
            });
          }
        }
      }

      return issues;
    }
  };
})();
