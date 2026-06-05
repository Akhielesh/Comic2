import { describe, expect, it } from "vitest";
import { isAllowedOrigin } from "./config.js";

describe("isAllowedOrigin", () => {
  it("allows requests with no Origin header (non-browser / same-origin)", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
  });

  it("always trusts the production brand apex domains over HTTPS", () => {
    expect(isAllowedOrigin("https://dreamstreamstudio.ai")).toBe(true);
    expect(isAllowedOrigin("https://dreamstreamstudio.com")).toBe(true);
  });

  it("trusts www and arbitrary subdomains of the brand domains", () => {
    expect(isAllowedOrigin("https://www.dreamstreamstudio.ai")).toBe(true);
    // Tokenized Studio preview hosts: <port>-<id>-<token>.dreamstreamstudio.ai
    expect(isAllowedOrigin("https://3000-uabc-deadbeef.dreamstreamstudio.ai")).toBe(true);
  });

  it("rejects the brand domains over plain HTTP", () => {
    expect(isAllowedOrigin("http://dreamstreamstudio.ai")).toBe(false);
  });

  it("rejects look-alike domains that merely contain the brand name", () => {
    expect(isAllowedOrigin("https://dreamstreamstudio.ai.evil.com")).toBe(false);
    expect(isAllowedOrigin("https://notdreamstreamstudio.ai")).toBe(false);
    expect(isAllowedOrigin("https://evil.com")).toBe(false);
  });

  it("rejects malformed origin values", () => {
    expect(isAllowedOrigin("not-a-url")).toBe(false);
  });
});
