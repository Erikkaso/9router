import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";
import { throwUpstreamError } from "../../open-sse/handlers/ttsProviders/_base.js";

afterEach(() => vi.unstubAllGlobals());
const upstream = (status, error) => Response.json({ error }, { status });

describe("TTS retains upstream model removal without changing legacy errors", () => {
  it.each(["openai", "openrouter", "gemini", "xiaomi-mimo", "selfhosted-tts", "elevenlabs"])("retains structured removal from %s", async (provider) => {
    vi.stubGlobal("fetch", vi.fn(async () => upstream(400, { code: "model_deprecated", message: "Request failed" })));
    const result = await handleTtsCore({ provider, model: "old/alloy", input: "Hello", credentials: { apiKey: "test", baseUrl: "https://example.test" } });
    expect(result.status).toBe(502);
    expect(result.response.status).toBe(502);
    expect(result.modelUnavailable).toBe(true);
  });

  it("shared provider helper retains a structured removal code", async () => {
    await expect(throwUpstreamError(upstream(410, { code: "model_retired", message: "Gone" })))
      .rejects.toMatchObject({ message: "Gone", modelUnavailable: true });
  });

  it("recognizes MiniMax's extracted status message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      base_resp: { status_code: 2013, status_msg: "The requested model has been retired" },
    }, { status: 400 })));
    const result = await handleTtsCore({ provider: "minimax", model: "old/voice", input: "Hello", credentials: { apiKey: "test" } });
    expect(result.status).toBe(502);
    expect(result.modelUnavailable).toBe(true);
  });

  it("retains authentication classification even with misleading text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => upstream(400, { type: "authentication_error", message: "This model is no longer available" })));
    const result = await handleTtsCore({ provider: "openai", model: "old/alloy", input: "Hello", credentials: { apiKey: "test" } });
    expect(result.status).toBe(502);
    expect(result.modelUnavailable).toBe(false);
  });
});
