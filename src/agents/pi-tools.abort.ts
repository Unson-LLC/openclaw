import type { AnyAgentTool } from "./pi-tools.types.js";

function throwAbortError(): never {
  const err = new Error("Aborted");
  err.name = "AbortError";
  throw err;
}

function isAbortSignal(obj: unknown): obj is AbortSignal {
  return typeof AbortSignal !== "undefined" && obj instanceof AbortSignal;
}

function isAbortSignalLike(
  obj: unknown,
): obj is Pick<AbortSignal, "aborted" | "addEventListener" | "removeEventListener"> {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "aborted" in obj &&
    typeof (obj as { addEventListener?: unknown }).addEventListener === "function"
  );
}

function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  const first = a as unknown;
  const second = b as unknown;

  if (!first && !second) {
    return undefined;
  }
  if (isAbortSignal(first) && !second) {
    return first;
  }
  if (isAbortSignal(second) && !first) {
    return second;
  }
  if (isAbortSignal(first) && first.aborted) {
    return first;
  }
  if (isAbortSignal(second) && second.aborted) {
    return second;
  }
  if (typeof AbortSignal.any === "function" && isAbortSignal(first) && isAbortSignal(second)) {
    try {
      return AbortSignal.any([first, second]);
    } catch {
      // Some runtimes may reject mixed-origin signals; fallback below handles that safely.
    }
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const wireAbort = (signal: unknown) => {
    if (!isAbortSignalLike(signal)) {
      return;
    }
    if (signal.aborted) {
      controller.abort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  };
  wireAbort(first);
  wireAbort(second);
  return controller.signal;
}

export function wrapToolWithAbortSignal(
  tool: AnyAgentTool,
  abortSignal?: AbortSignal,
): AnyAgentTool {
  if (!abortSignal) {
    return tool;
  }
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const combined = combineAbortSignals(signal, abortSignal);
      if (combined?.aborted) {
        throwAbortError();
      }
      return await execute(toolCallId, params, combined, onUpdate);
    },
  };
}
