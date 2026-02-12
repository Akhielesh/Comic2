import { describe, expect, it } from "vitest";
import { isMissingPrivateProfileTableError } from "./profilePrivate";

describe("isMissingPrivateProfileTableError", () => {
  it("returns true for missing relation code PGRST205", () => {
    expect(isMissingPrivateProfileTableError({ code: "PGRST205" })).toBe(true);
  });

  it("returns true for 404 relation-not-found messages", () => {
    expect(
      isMissingPrivateProfileTableError({
        status: 404,
        message: 'Could not find table "public.profile_private" in schema cache',
      })
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isMissingPrivateProfileTableError({
        code: "42501",
        message: "permission denied for table projects",
      })
    ).toBe(false);
  });
});
