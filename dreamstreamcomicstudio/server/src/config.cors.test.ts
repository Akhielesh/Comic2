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

  it("trusts the live Cloudflare Pages frontend and its preview deploys", () => {
    expect(isAllowedOrigin("https://comic2.pages.dev")).toBe(true);
    // Cloudflare preview deploys are <hash>.comic2.pages.dev
    expect(isAllowedOrigin("https://a1b2c3d4.comic2.pages.dev")).toBe(true);
  });

  it("does NOT trust unrelated pages.dev sites", () => {
    expect(isAllowedOrigin("https://evil.pages.dev")).toBe(false);
    expect(isAllowedOrigin("https://comic2.pages.dev.evil.com")).toBe(false);
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
