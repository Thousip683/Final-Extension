/**
 * Sandboxed reader frame.
 *
 * Loads the bundled PP-OCRv6 engine and answers EG_SANDBOX_READ messages sent
 * by the offscreen page. Worker mode is off because a sandboxed document has an
 * opaque origin and cannot start an extension worker script.
 */
import "../engine/errorguard-engine.js";

const engine = window.ErrorGuardEngine;
let baseUrl = "";
let configured = false;

function reply(message) {
  parent.postMessage(message, "*");
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;

  if (message.type === "EG_SANDBOX_READ") {
    (async () => {
      try {
        baseUrl = message.baseUrl || baseUrl;
        if (!configured) {
          engine.configure({
            worker: false,
            resolveAsset: (path) => new URL(path, baseUrl).toString(),
          });
          configured = true;
        }
        const read = await engine.readDocument(
          { bytes: message.bytes, mimeType: message.mimeType, fileName: message.fileName },
          (percent, text) =>
            reply({ type: "EG_SANDBOX_PROGRESS", requestId: message.requestId, percent, message: text }),
        );
        const match =
          Array.isArray(message.formFields) && message.formFields.length
            ? engine.matchFormFields(message.formFields, read)
            : { rows: [], fieldMap: {}, reviewMap: {}, fillMap: {}, reviewCount: 0, conflictCount: 0 };
        reply({ type: "EG_SANDBOX_RESULT", requestId: message.requestId, ok: true, read, match });
      } catch (error) {
        reply({
          type: "EG_SANDBOX_RESULT",
          requestId: message.requestId,
          ok: false,
          error: error && error.message ? error.message : String(error),
        });
      }
    })();
  }
});

reply({ type: "EG_SANDBOX_READY" });
