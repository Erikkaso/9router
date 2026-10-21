import { describe, expect, it, vi } from "vitest";
import { handleComboChat, resetComboRotation } from "../../open-sse/services/combo.js";
import { isDeprecatedModelError } from "../../open-sse/services/accountFallback.js";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

const log = { info() {}, warn() {} };
const failure = (status, error) => new Response(JSON.stringify({ error }), {
  status, headers: { "Content-Type": "application/json" },
});

describe("deprecated model recognition", () => {
  it.each([
    [400, { code: "model_deprecated", message: "Request failed" }],
    [422, { type: "model_not_found", message: "Request failed" }],
    [410, { details: [{ reason: "MODEL_RETIRED" }] }],
    [400, "The requested model is deprecated"],
    [400, "Model deprecation: use a newer model"],
    [404, "Model not found"],
    [410, "The model has been retired"],
    [422, "This model reached its sunset date"],
    [400, "The requested model is no longer supported"],
    [400, "This model is no longer available"],
    [404, "The model `old-model` does not exist"],
    [410, "The requested model davinci has been retired"],
  ])("recognizes explicit model removal (%s, %j)", (status, error) => {
    expect(isDeprecatedModelError(status, error)).toBe(true);
  });

  it.each([
    [400, "Invalid temperature parameter for this model"],
    [400, "The max_tokens parameter is deprecated for this model"],
    [400, "The model parameter is deprecated"],
    [400, "The model endpoint is no longer available"],
    [400, { message: "The field model is deprecated; use model_id instead", param: "model" }],
    [400, { type: "permission_error", message: "This model is no longer available to your organization" }],
    [400, { type: "authentication_error", message: "This model is no longer available for this account" }],
    [400, "This model is no longer available for your account"],
    [400, "The model does not support this deprecated API endpoint"],
    [404, "File not found"],
    [404, "Endpoint no longer available"],
    [404, { code: "model_not_found", message: "You do not have access to this model" }],
    [404, "The model does not exist or you do not have access to it"],
    [400, "Permission denied for this model"],
    [401, "Model no longer available"],
    [403, { code: "model_deprecated" }],
    [429, "Model no longer available due to rate limit"],
    [422, { param: "model", message: "Invalid parameter" }],
  ])("rejects ambiguous or unrelated errors (%s, %j)", (status, error) => {
    expect(isDeprecatedModelError(status, error)).toBe(false);
  });

  it("retains structured recognition when an executor extracts only the message", async () => {
    const parsed = await parseUpstreamError(failure(400, { code: "model_deprecated", message: "Request failed" }), {
      parseError: () => ({ status: 400, message: "Request failed" }),
    });
    expect(parsed.message).toBe("Request failed");
    expect(parsed.modelUnavailable).toBe(true);
  });
});

describe("combo deprecated model fallback", () => {
  async function run(status, error, enabled, extra = {}) {
    const attempted = [];
    const first = failure(status, error);
    const response = await handleComboChat({
      body: {}, models: ["p/old", "p/new"], log,
      fallbackOnDeprecatedModels: enabled,
      handleSingleModel: async (_body, model) => {
        attempted.push(model);
        return model === "p/old" ? first : Response.json({ model });
      },
      ...extra,
    });
    return { response, attempted, first };
  }

  it.each([400, 404, 410, 422])("uses the next seat for explicit removal at %s", async (status) => {
    const { response, attempted } = await run(status, { code: "model_deprecated", message: "Request failed" }, true);
    expect(await response.json()).toEqual({ model: "p/new" });
    expect(attempted).toEqual(["p/old", "p/new"]);
  });

  it.each([false, undefined])("preserves the original 400 when disabled (%s)", async (enabled) => {
    const { response, attempted, first } = await run(400, { message: "Model is deprecated" }, enabled);
    expect(response).toBe(first);
    expect(attempted).toEqual(["p/old"]);
  });

  it("retains the pre-existing 404 fallback when disabled", async () => {
    const { response, attempted } = await run(404, { message: "Model not found" }, false);
    expect(response.ok).toBe(true);
    expect(attempted).toEqual(["p/old", "p/new"]);
  });

  it("does not add fallback for invalid parameters", async () => {
    const { response, attempted, first } = await run(400, { message: "Invalid temperature for this model" }, true);
    expect(response).toBe(first);
    expect(attempted).toEqual(["p/old"]);
  });

  it.each([false, true])("preserves quota, rate limit and context handling (%s)", async (enabled) => {
    for (const [status, message, expected] of [
      [429, "Rate limit", 2], [400, "quota exceeded", 2],
      [422, "rate limit reached", 2], [400, "maximum context length exceeded", 1],
    ]) {
      const { attempted } = await run(status, { message }, enabled);
      expect(attempted).toHaveLength(expected);
    }
  });

  it("respects round-robin order", async () => {
    resetComboRotation("deprecated-test");
    const extra = { comboName: "deprecated-test", comboStrategy: "round-robin" };
    await run(400, { message: "Model is retired" }, true, extra);
    const { attempted } = await run(400, { message: "Model is retired" }, true, extra);
    expect(attempted).toEqual(["p/new"]);
  });

  it("does not retry a repeated retired model", async () => {
    const { response, attempted } = await run(400, { message: "Model is retired" }, true, {
      models: ["p/old", "p/old", "p/new"],
    });
    expect(response.ok).toBe(true);
    expect(attempted).toEqual(["p/old", "p/new"]);
  });

  it("returns the error when there is no alternate model", async () => {
    const { response, attempted } = await run(410, { message: "Model is retired" }, true, { models: ["p/old"] });
    expect(response.status).toBe(410);
    expect((await response.json()).error.message).toContain("retired");
    expect(attempted).toEqual(["p/old"]);
  });

  it("returns an active stream without retrying even if it later errors", async () => {
    const encoder = new TextEncoder();
    const partial = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
      },
      pull(controller) { controller.error(new Error("Model no longer available")); },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const handleSingleModel = vi.fn(async () => partial);
    const response = await handleComboChat({
      body: { stream: true }, models: ["p/old", "p/new"], log,
      fallbackOnDeprecatedModels: true, handleSingleModel,
    });
    expect(response).toBe(partial);
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("Hello");
    await expect(reader.read()).rejects.toThrow("no longer available");
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });
});
