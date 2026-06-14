import { describe, expect, it } from "vitest";
import {
  confirmGateNeeded,
  makeDefaultComicAgentSettings,
  normalizeComicAgentSettings,
  prefersStrictConsistency,
  shouldAutoRunComicAgent
} from "./comicAgentSettings";

describe("comicAgentSettings", () => {
  it("keeps guided confirmation as the default", () => {
    const settings = makeDefaultComicAgentSettings();

    expect(settings.confirmPolicy).toBe("big_spends");
    expect(shouldAutoRunComicAgent(settings)).toBe(false);
    expect(shouldAutoRunComicAgent(undefined)).toBe(false);
  });

  it("only enables agent autopilot for explicit auto-spend mode", () => {
    expect(shouldAutoRunComicAgent({ confirmPolicy: "never" })).toBe(true);
    expect(shouldAutoRunComicAgent({ confirmPolicy: "always" })).toBe(false);
    expect(shouldAutoRunComicAgent({ confirmPolicy: "big_spends" })).toBe(false);
  });

  it("normalizes invalid settings without preserving unsafe values", () => {
    const normalized = normalizeComicAgentSettings({
      confirmPolicy: "nonsense" as never,
      outputTargets: ["comic", "nope", "html"] as never,
      autoPageCount: true,
      budgetCapUsd: -20
    });

    expect(normalized.confirmPolicy).toBe("big_spends");
    expect(normalized.outputTargets).toEqual(["comic", "html"]);
    expect(normalized.budgetCapUsd).toBeUndefined();
    expect(normalized.consistencyPolicy).toBe("resilient");
  });

  it("defaults to resilient consistency and only goes strict on request", () => {
    expect(makeDefaultComicAgentSettings().consistencyPolicy).toBe("resilient");
    expect(prefersStrictConsistency(undefined)).toBe(false);
    expect(prefersStrictConsistency({ consistencyPolicy: "strict" })).toBe(true);
    expect(prefersStrictConsistency({ consistencyPolicy: "bogus" as never })).toBe(false);
  });

  it("gates spend per confirm policy", () => {
    // always → always gate
    expect(confirmGateNeeded({ confirmPolicy: "always" }, 0.01)).toBe(true);
    // big_spends → gate over the $0.50 threshold, not under
    expect(confirmGateNeeded({ confirmPolicy: "big_spends" }, 0.40)).toBe(false);
    expect(confirmGateNeeded({ confirmPolicy: "big_spends" }, 0.80)).toBe(true);
    // never → only gate over an explicit budget cap
    expect(confirmGateNeeded({ confirmPolicy: "never" }, 5)).toBe(false);
    expect(confirmGateNeeded({ confirmPolicy: "never", budgetCapUsd: 1 }, 2)).toBe(true);
  });
});
