import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { wrapToolWithAbortSignal } from "./pi-tools.abort.js";

describe("wrapToolWithAbortSignal", () => {
  it("falls back when runtime provides a non-native AbortSignal object", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const tool = wrapToolWithAbortSignal(
      {
        name: "exec",
        execute,
      } as unknown as AnyAgentTool,
      new AbortController().signal,
    );
    const runtimeSignal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await expect(tool.execute("call-1", { cmd: "pwd" }, runtimeSignal, undefined)).resolves.toEqual(
      { ok: true },
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
  });

  it("throws AbortError when fallback sees an already-aborted signal-like object", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const tool = wrapToolWithAbortSignal(
      {
        name: "read",
        execute,
      } as unknown as AnyAgentTool,
      new AbortController().signal,
    );
    const runtimeSignal = {
      aborted: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await expect(
      tool.execute("call-2", { filePath: "README.md" }, runtimeSignal, undefined),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).not.toHaveBeenCalled();
  });
});
