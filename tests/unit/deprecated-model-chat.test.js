import { beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorResult } from "../../open-sse/utils/error.js";
import { isDeprecatedModelError } from "../../open-sse/services/accountFallback.js";

const state = vi.hoisted(() => ({ enabled: true, attempted: [], status: 400, message: "Model is retired", structured: false, type: "invalid_request_error" }));
const markAccountUnavailable = vi.hoisted(() => vi.fn(async () => ({ shouldFallback: false })));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, fallbackOnDeprecatedModels: state.enabled }),
  getModelAliases: async () => ({}),
  getComboByName: async (name) => name === "Main" ? { name, models: ["openai/old", "openai/new"] } : null,
  getProviderNodes: async () => [],
  getCombos: async () => [],
  getProviderConnections: async () => [],
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: async () => ({ connectionId: "conn", connectionName: "test" }),
  markAccountUnavailable,
  clearAccountError: vi.fn(),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => null,
  enforceKeyAccess: async () => null,
  filterAdapterModels: async (_access, models) => models,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({
  handleChatCore: async ({ modelInfo }) => {
    state.attempted.push(modelInfo.model);
    if (modelInfo.model === "new") return { success: true, response: Response.json({ model: "new" }) };
    const modelUnavailable = state.structured || isDeprecatedModelError(state.status, { type: state.type, message: state.message });
    return { ...createErrorResult(state.status, state.message, undefined, null, modelUnavailable), modelUnavailable };
  },
}));

async function mediaResult(model) {
  state.attempted.push(model);
  if (model === "new") return { success: true, response: Response.json({ model: "new" }) };
  const modelUnavailable = isDeprecatedModelError(state.status, { type: state.type, message: state.message });
  return { ...createErrorResult(state.status, state.message, undefined, null, modelUnavailable), modelUnavailable };
}
vi.mock("open-sse/handlers/imageGenerationCore.js", () => ({
  handleImageGenerationCore: async ({ modelInfo }) => mediaResult(modelInfo.model),
}));
vi.mock("open-sse/handlers/ttsCore.js", () => ({
  handleTtsCore: async ({ model }) => mediaResult(model),
}));

const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { handleImageGeneration } = await import("../../src/sse/handlers/imageGeneration.js");
const { handleTts } = await import("../../src/sse/handlers/tts.js");
const chat = (model = "Main", stream = false) => handleChat(new Request("http://localhost/v1/chat/completions", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "Hello" }] }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, { enabled: true, attempted: [], status: 400, message: "Model is retired", structured: false, type: "invalid_request_error" });
});

describe("persisted setting drives chat combo routing", () => {
  it.each([false, true])("routes to the next model before starting the response (stream=%s)", async (stream) => {
    expect(await (await chat("Main", stream)).json()).toEqual({ model: "new" });
    expect(state.attempted).toEqual(["old", "new"]);
    expect(markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("does not lose the provider's structured removal code", async () => {
    state.structured = true;
    state.message = "Request failed";
    expect(await (await chat()).json()).toEqual({ model: "new" });
    expect(markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("keeps the original response and credential handling when disabled", async () => {
    state.enabled = false;
    const response = await chat();
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("bad_request");
    expect(state.attempted).toEqual(["old"]);
    expect(markAccountUnavailable).toHaveBeenCalledTimes(1);
  });

  it("keeps direct model requests unchanged even when enabled", async () => {
    const response = await chat("openai/old");
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("bad_request");
    expect(markAccountUnavailable).toHaveBeenCalledTimes(1);
  });

  it("keeps credential handling for unrelated failures", async () => {
    state.message = "Invalid temperature parameter";
    expect((await chat()).status).toBe(400);
    expect(state.attempted).toEqual(["old"]);
    expect(markAccountUnavailable).toHaveBeenCalledTimes(1);
  });
});

describe("global setting also drives media model combos", () => {
  it.each([
    ["images", handleImageGeneration, { prompt: "Hello" }],
    ["tts", handleTts, { input: "Hello" }],
  ])("uses the next %s model without cooling credentials", async (_kind, handler, body) => {
    const response = await handler(new Request("http://localhost/v1/media", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "Main", ...body }),
    }));
    expect(await response.json()).toEqual({ model: "new" });
    expect(state.attempted).toEqual(["old", "new"]);
    expect(markAccountUnavailable).not.toHaveBeenCalled();
  });

  it.each([
    ["images", handleImageGeneration, { prompt: "Hello" }],
    ["tts", handleTts, { input: "Hello" }],
  ])("preserves %s credential handling when disabled", async (_kind, handler, body) => {
    state.enabled = false;
    const response = await handler(new Request("http://localhost/v1/media", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "Main", ...body }),
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("bad_request");
    expect(state.attempted).toEqual(["old"]);
    expect(markAccountUnavailable).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["chat", handleChat, { messages: [{ role: "user", content: "Hello" }] }],
    ["images", handleImageGeneration, { prompt: "Hello" }],
    ["tts", handleTts, { input: "Hello" }],
  ])("does not reclassify a flattened authentication error in %s", async (_kind, handler, body) => {
    state.type = "authentication_error";
    state.message = "This model is no longer available";
    const response = await handler(new Request("http://localhost/v1/media", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "Main", ...body }),
    }));
    expect(response.status).toBe(400);
    expect(state.attempted).toEqual(["old"]);
    expect(markAccountUnavailable).toHaveBeenCalledTimes(1);
  });
});
