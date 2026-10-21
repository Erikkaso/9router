import { afterEach, describe, expect, it, vi } from "vitest";
const execute = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/executors/index.js", () => ({ getExecutor: () => ({ execute }) }));
import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { getModelErrorClassification } from "../../open-sse/utils/error.js";

afterEach(() => vi.unstubAllGlobals());
describe("image errors retain upstream model classification", () => {
  it.each([
    ["openai", 400], ["antigravity", 502],
  ])("preserves structured model removal from %s", async (provider, legacyStatus) => {
    const upstream = () => Response.json({ error: { code: "model_deprecated", message: "Request failed" } }, { status: 400 });
    vi.stubGlobal("fetch", vi.fn(async () => upstream()));
    execute.mockImplementation(async () => ({ response: upstream() }));
    const result = await handleImageGenerationCore({
      body: { prompt: "Hello" }, modelInfo: { provider, model: "old-image" }, credentials: { apiKey: "test" },
    });
    expect(result.status).toBe(legacyStatus);
    expect(result.modelUnavailable).toBe(true);
    expect(getModelErrorClassification(result.response)).toBe(true);
  });
});
