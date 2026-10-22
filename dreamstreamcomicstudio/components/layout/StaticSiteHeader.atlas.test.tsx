import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({ allowed: null as Set<string> | null }));
const openAtlasStudio = vi.hoisted(() => vi.fn());

vi.mock("../../services/productAccess", () => ({ useProductAccess: () => access.allowed }));
vi.mock("../../services/atlasStudio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/atlasStudio")>()),
  openAtlasStudio,
}));
vi.mock("../NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("../UserAvatar", () => ({ UserAvatar: () => null }));
vi.mock("../TokenAvailabilityPill", () => ({ TokenAvailabilityPill: () => null }));

import { StaticSiteHeader } from "./StaticSiteHeader";

const noop = () => {};
const renderHeader = () =>
  render(
    <StaticSiteHeader
      isAuthenticated={false}
      onGoHome={noop}
      onViewComics={noop}
      onEnterStudio={noop}
      onSignIn={noop}
      onOpenProfile={noop}
      onNavigate={noop}
    />,
  );

describe("StaticSiteHeader — Atlas Studio", () => {
  beforeEach(() => {
    access.allowed = null;
    openAtlasStudio.mockClear();
  });

  it("offers Atlas Studio in the desktop nav and opens it", () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: /^Atlas/ }));
    fireEvent.click(screen.getByText("Open Atlas Studio"));
    expect(openAtlasStudio).toHaveBeenCalledTimes(1);
  });

  it("lists Atlas Studio in the mobile menu", () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(screen.getByText("Atlas Studio")).toBeTruthy();
  });

  it("hides Atlas Studio from accounts confined to other studios", () => {
    access.allowed = new Set(["comic_studio"]);
    renderHeader();
    expect(screen.queryByRole("button", { name: /^Atlas/ })).toBeNull();
  });
});
