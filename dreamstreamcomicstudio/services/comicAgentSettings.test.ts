import { describe, expect, it } from "vitest";
import {
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
});
