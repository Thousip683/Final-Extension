/**
 * Image Quality Analysis Module
 * Analyzes uploaded image documents for dimensions, brightness, contrast, and blur.
 * Phase 6 of Build Guide.
 */

(function () {
  window.ErrorGuard = window.ErrorGuard || {};

  window.ErrorGuard.ImageQuality = {
    /**
     * Analyzes an image File or Blob
     * @param {File|Blob} file
     * @param {object} rules
     * @returns {Promise<Array<object>>} list of quality issues
     */
    async analyze(file, rules = {}) {
      const issues = [];
      if (!file || !file.type.startsWith('image/')) {
        return issues; // PDFs handled separately or skipped for canvas quality
      }

      const minW = rules.minWidth || 400;
      const minH = rules.minHeight || 300;

      return new Promise((resolve) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);

        img.onload = () => {
          try {
            const width = img.naturalWidth;
            const height = img.naturalHeight;

            // Check 1: Dimensions
            if (width < minW || height < minH) {
              issues.push({
                code: 'IMAGE_TOO_SMALL',
                severity: 'WARNING',
                message: `Image resolution is low (${width}x${height} px). Minimum recommended is ${minW}x${minH} px.`,
                fix: 'Upload a higher resolution photo or scan so details remain legible.'
              });
            }

            // Create canvas for pixel analysis (sample down to 400x300 for speed)
            const sampleW = Math.min(width, 400);
            const sampleH = Math.min(height, 300);
            const canvas = document.createElement('canvas');
            canvas.width = sampleW;
            canvas.height = sampleH;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, sampleW, sampleH);

            const imgData = ctx.getImageData(0, 0, sampleW, sampleH);
            const data = imgData.data;

            let totalLuminance = 0;
            const pixelCount = sampleW * sampleH;
            const grayPixels = new Float32Array(pixelCount);

            // Compute luminance and grayscale buffer
            for (let i = 0; i < data.length; i += 4) {
              const r = data[i];
              const g = data[i + 1];
              const b = data[i + 2];
              // Relative luminance formula
              const lum = 0.299 * r + 0.587 * g + 0.114 * b;
              totalLuminance += lum;
              grayPixels[i / 4] = lum;
            }

            const avgLuminance = totalLuminance / pixelCount;

            // Check 2: Overly Dark or Washed Out
            if (avgLuminance < 35) {
              issues.push({
                code: 'DOCUMENT_TOO_DARK',
                severity: 'WARNING',
                message: 'Document scan appears very dark. Information may not be legible to reviewers.',
                fix: 'Ensure adequate lighting when taking document photos or scanning.'
              });
            } else if (avgLuminance > 248) {
              issues.push({
                code: 'DOCUMENT_OVEREXPOSED',
                severity: 'WARNING',
                message: 'Document appears overexposed or blank with high glare.',
                fix: 'Reduce camera flash/glare and recapture the document.'
              });
            }

            // Check 3: Blur / Edge Sharpness Estimation
            // Compute variance of discrete Laplacian (horizontal + vertical differences)
            let diffSum = 0;
            for (let y = 1; y < sampleH - 1; y += 2) {
              for (let x = 1; x < sampleW - 1; x += 2) {
                const idx = y * sampleW + x;
                const center = grayPixels[idx];
                const top = grayPixels[idx - sampleW];
                const bottom = grayPixels[idx + sampleW];
                const left = grayPixels[idx - 1];
                const right = grayPixels[idx + 1];

                const laplacian = Math.abs(4 * center - top - bottom - left - right);
                diffSum += laplacian;
              }
            }

            const sharpnessScore = diffSum / (pixelCount / 4);

            // A typical sharp document with text scores ~5 and above.
            // Anything under 3.5 is at least mildly blurred — flag it and stop.
            if (sharpnessScore < 3.5) {
              issues.push({
                code: 'DOCUMENT_BLURRED',
                severity: 'BLOCKING',
                message: `Uploaded document is blurry or out of focus (Sharpness: ${sharpnessScore.toFixed(1)}). Details cannot be verified reliably.`,
                fix: 'Please upload a clear, sharp, and well-lit document scan.'
              });
            }
          } catch (err) {
            window.ErrorGuard.Logger.warn('ImageQuality', 'Canvas analysis error', err);
          } finally {
            URL.revokeObjectURL(objectUrl);
            resolve(issues);
          }
        };

        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          resolve(issues);
        };

        img.src = objectUrl;
      });
    }
  };
})();
