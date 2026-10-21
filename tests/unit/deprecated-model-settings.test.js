import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-deprecated-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});
afterEach(() => {
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("deprecated model settings persistence", () => {
  it("defaults to disabled for existing installations", async () => {
    const repo = await import("@/lib/db/repos/settingsRepo.js");
    await repo.updateSettings({ comboStrategy: "round-robin" });
    expect((await repo.getSettings()).fallbackOnDeprecatedModels).toBe(false);
  });

  it.each([true, false])("retains %s after closing and reopening the database", async (enabled) => {
    const { PATCH } = await import("@/app/api/settings/route.js");
    const saved = await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fallbackOnDeprecatedModels: enabled }),
    }));
    expect(saved.status).toBe(200);
    global._dbAdapter.instance.close();
    delete global._dbAdapter;
    vi.resetModules();
    const { GET } = await import("@/app/api/settings/route.js");
    const settings = await (await GET()).json();
    expect(settings.fallbackOnDeprecatedModels).toBe(enabled);
    expect(settings.comboStrategy).toBe("fallback");
  });
});
