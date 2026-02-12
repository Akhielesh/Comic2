import { describe, expect, it } from "vitest";
import { buildMissingServiceRoleKeyError, buildMissingSupabaseConfigError } from "./serviceConfig.js";

describe("buildMissingServiceRoleKeyError", () => {
  it("builds a typed public config error with status and code", () => {
    const err = buildMissingServiceRoleKeyError();

    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(503);
    expect(err.publicCode).toBe("MISSING_SERVICE_ROLE_KEY");
    expect(String(err.message)).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});

describe("buildMissingSupabaseConfigError", () => {
  it("builds a typed config error with status and code", () => {
    const err = buildMissingSupabaseConfigError();

    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(503);
    expect(err.publicCode).toBe("MISSING_SUPABASE_CONFIG");
    expect(String(err.message)).toContain("Supabase configuration");
  });
});
