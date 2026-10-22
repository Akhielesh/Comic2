import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../contexts/AuthContext", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("./WaitlistForm", () => ({ WaitlistForm: () => null }));

import { HomePage } from "./HomePage";
import { ATLAS_STUDIO_SOURCES, ATLAS_STUDIO_URL } from "../services/atlasStudio";

describe("HomePage — Atlas Studio", () => {
  it("links the Atlas Studio card and footer entry to the Atlas subdomain and lists its sources", () => {
    const noop = () => {};
    render(<HomePage onEnterStudio={noop} onViewComics={noop} onOpenPrivacy={noop} onOpenTerms={noop} />);

    expect(screen.getByRole("link", { name: /Open Atlas Studio/ }).getAttribute("href")).toBe(ATLAS_STUDIO_URL);
    expect(screen.getByRole("link", { name: /^Atlas Studio/ }).getAttribute("href")).toBe(ATLAS_STUDIO_URL);
    const sources = screen.getByRole("list", { name: "Sources Atlas Studio connects" });
    for (const source of ATLAS_STUDIO_SOURCES) expect(sources.textContent).toContain(source);
  });
});
