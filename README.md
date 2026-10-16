# Pre-Submission Error Guard for Official Forms

A Chrome Manifest V3 extension that validates online application forms before submission, checks uploaded documents, and flags mismatches between form fields and document data.

## What this extension does

Pre-Submission Error Guard runs directly in the browser and helps users catch mistakes such as:

- missing required fields
- invalid input formats (DOB, phone, Aadhaar, PAN, IFSC, email, etc.)
- invalid or oversized uploaded files
- low-quality document uploads
- mismatches between form values and extracted document values
- wrong document type uploaded to a slot (for example PAN uploaded where Aadhaar is expected)

It then computes a health score and marks the application as **READY TO SUBMIT** or **NOT READY TO SUBMIT**.

## Key capabilities

### 1) Local-first document reading (default)

- Uses an offscreen document + sandboxed reader pipeline.
- Runs bundled PP-OCRv6 assets from this repository.
- Keeps document processing inside the extension context by default.

### 2) Optional cloud AI path (opt-in only)

- Supports Gemini-based analysis when explicitly enabled and configured by the user.
- Stores API key locally in extension storage.

### 3) Form intelligence

- Detects forms and relevant controls on page load and dynamic updates.
- Classifies fields semantically (name, DOB, IDs, uploads, declaration, etc.).
- Continuously reevaluates form state on user edits and file changes.

### 4) Pre-submission guard

- Intercepts submit flows.
- Blocks submissions when blocking-level issues are present (based on active rules profile).

### 5) Rule-driven behavior

- Uses a default fallback profile.
- Loads a portal profile (`rules/demo-portal.json`) when URL patterns match.

## High-level architecture

```text
Popup UI
  -> asks active tab for status / rescan / mode updates

Content script (content/content.js)
  -> detector + validators + matcher + error aggregation + overlay
  -> on file upload, sends document to local pipeline client

Background service worker (background/service-worker.js)
  -> owns offscreen document lifecycle
  -> relays progress + routes popup/tab messages

Offscreen bridge (offscreen/offscreen.js)
  -> forwards read requests into sandbox iframe

Sandbox reader (sandbox/sandbox.js + engine/* + models/* + ort/*)
  -> executes on-device OCR / extraction / matching
  -> returns structured read results
```

## Repository structure

```text
background/    MV3 service worker and message routing
content/       content-script orchestrator, detector, overlay, helpers
modules/       validation, OCR, matching, parsing, and rule modules
offscreen/     offscreen document bridge for local reading
sandbox/       sandboxed frame that runs bundled reader engine
engine/        bundled document reading engine assets/runtime
models/        OCR model archives
ort/           ONNX runtime web assets
rules/         portal profile JSON + schema defaults
popup/         extension popup UI
utils/         logger, normalization, storage wrappers
assets/        icons and static image assets
lib/           OCR/pdf related third-party runtime assets
```

## Installation (unpacked extension)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository root folder.
5. Pin the extension if needed.

## Usage

1. Open a target form page.
2. Fill fields and upload required document files.
3. Open the extension popup to view:
   - application health score
   - readiness status
   - checklist state
   - blocking/warning issues
4. Click the refresh/rescan action in popup to force re-evaluation.
5. Resolve blocking issues before final submission.

## Validation model summary

The extension combines multiple validators:

- **FormValidator**: required fields + format checks
- **FileValidator**: file size/type/extension checks
- **ImageQuality**: basic quality constraints
- **Matcher / DocumentParser / OCR**: extracted-doc vs form consistency checks
- **ErrorEngine**: issue aggregation + health score + readiness status

Issue severities:

- `BLOCKING` (must fix)
- `WARNING` (recommended fix)
- `INFO` (non-blocking context)

## Rules and profile configuration

### Default profile

`rules/schemas.js` provides fallback rules when no specific portal profile is matched.

### Demo portal profile

`rules/demo-portal.json` defines:

- URL match patterns
- required field semantic types
- file constraints
- cross-check thresholds and toggles
- submission guard behavior

To support additional portals, add new profile JSON definitions and load/match them in the rule engine flow.

## Permissions and security notes

Configured in `manifest.json`:

- `activeTab`, `storage`, `offscreen`
- host permissions for web pages and local `file://` pages

Security model highlights:

- local-first processing by default
- optional cloud analysis path is explicit opt-in
- no external backend dependency required for default on-device flow

## Development notes

- This repository is a browser extension project (no Node build pipeline included here).
- Main behavior is implemented in plain JavaScript modules loaded by the extension.
- To test changes:
  1. edit files
  2. reload extension in `chrome://extensions`
  3. refresh target page and retest flows

## Troubleshooting

- **Popup shows no active form**  
  Ensure the current tab is not a restricted URL (`chrome://`, `edge://`, etc.).

- **Document reading fails**  
  Reload the page and retry upload; verify file type/size constraints from active profile.

- **Cloud AI fails**  
  Check API key validity and network access; local mode remains available by default.

- **No content-script response**  
  Reload the tab after extension reload to re-inject content scripts.

## Version

Current manifest version: **1.1.0**
