// Shared TTS helpers
import { Buffer } from "node:buffer";
import { isDeprecatedModelError } from "../../services/accountFallback.js";

// Keep upstream classification when TTS wraps every provider failure as a 502.
export function annotateModelError(error, status, details) {
  return Object.assign(error, { modelUnavailable: isDeprecatedModelError(status, { error: details, message: error.message }) });
}

export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

// Convert upstream Response (binary audio) to { base64, format }
export async function responseToBase64(res, defaultFormat = "mp3") {
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 100) throw new Error("Upstream returned empty audio");
  const ctype = res.headers.get("content-type") || "";
  let format = defaultFormat;
  if (ctype.includes("wav")) format = "wav";
  else if (ctype.includes("mpeg") || ctype.includes("mp3")) format = "mp3";
  else if (ctype.includes("ogg")) format = "ogg";
  return { base64: Buffer.from(buf).toString("base64"), format };
}

export async function throwUpstreamError(res) {
  const text = await res.text().catch(() => "");
  let msg = `Upstream error (${res.status})`;
  try {
    const parsed = JSON.parse(text);
    msg = parsed?.error?.message || parsed?.message || parsed?.detail?.message || (typeof parsed?.detail === "string" ? parsed.detail : null) || text || msg;
  } catch { msg = text || msg; }
  throw annotateModelError(new Error(msg), res.status, text);
}

// Parse `model` string as "modelId/voiceId" — match against known model list (longest prefix wins)
export function parseModelVoice(model, defaultModel = "", defaultVoice = "", knownModels = []) {
  if (!model) return { modelId: defaultModel, voiceId: defaultVoice };
  const known = knownModels.map((m) => m.id || m).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const id of known) {
    if (model === id) return { modelId: id, voiceId: defaultVoice };
    if (model.startsWith(`${id}/`)) return { modelId: id, voiceId: model.slice(id.length + 1) };
  }
  const idx = model.lastIndexOf("/");
  if (idx > 0) return { modelId: model.slice(0, idx), voiceId: model.slice(idx + 1) };
  return { modelId: defaultModel || model, voiceId: defaultVoice || model };
}
