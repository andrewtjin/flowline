// renderer/settings.test.ts — the Settings DOM shell: the SHARED single-instance overlay latch (Settings and a
// Join-style modal can never stack, BOTH orderings), the S-003 doc-purity invariant (theme + Settings state
// never enters doc.toJSON()), and the Appearance theme picker (Light ⇒ applyTheme(null), Dark ⇒ applyTheme('dark')).
//
// Runs under jsdom (vitest env). main.ts's modal scaffold routes through the SAME `openOverlay` primitive this
// module exports, so calling openOverlay directly here is a faithful stand-in for "another overlay is open" — it
// exercises the exact same module-level latch openSettings shares.

import { describe, it, expect, beforeEach } from "vitest";
import {
  openSettings,
  openOverlay,
  closeOverlay,
  isOverlayOpen,
  registerBuiltinSettings,
  settingsRegistries,
} from "../../src/renderer/settings";
import { THEME_STORAGE_KEY } from "../../src/renderer/settings-registry";
import { createSeedDoc } from "../../src/seed";

// Register the built-in Appearance section + light/dark themes once (idempotent via the registries' replace
// dedupe). The shell's section/theme registries are module-level, so this primes them for every test below.
registerBuiltinSettings();

// Count overlays currently in the DOM (the shared latch must keep this at most 1).
const overlayCount = (): number => document.querySelectorAll(".fl-overlay").length;

beforeEach(() => {
  // Reset overlay + theme state between cases so neither leaks across tests.
  closeOverlay();
  delete document.documentElement.dataset.theme;
  try {
    localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    /* ambient localStorage absent — ignore */
  }
});

describe("shared single-instance overlay latch (E7-S3)", () => {
  it("Settings-then-Join: opening a Join-style overlay while Settings is up is a graceful no-op", () => {
    expect(openSettings("appearance")).toBe(true);
    expect(isOverlayOpen()).toBe(true);
    expect(overlayCount()).toBe(1);
    // A second overlay (the Join modal goes through this SAME openOverlay) must NOT open.
    const opened = openOverlay((dialog) => {
      dialog.textContent = "join";
      return [];
    });
    expect(opened).toBe(false);
    expect(overlayCount()).toBe(1); // still exactly one — nothing stacked
  });

  it("Join-then-Settings: opening Settings while a Join-style overlay is up is a graceful no-op", () => {
    const opened = openOverlay((dialog) => {
      dialog.textContent = "join";
      return [];
    });
    expect(opened).toBe(true);
    expect(overlayCount()).toBe(1);
    // openSettings must refuse while the Join overlay is up.
    expect(openSettings("appearance")).toBe(false);
    expect(overlayCount()).toBe(1);
  });

  it("after closing one overlay the other can open (latch released)", () => {
    expect(openSettings()).toBe(true);
    closeOverlay();
    expect(isOverlayOpen()).toBe(false);
    expect(overlayCount()).toBe(0);
    // Now the Join-style overlay can open.
    expect(openOverlay(() => [])).toBe(true);
    expect(overlayCount()).toBe(1);
  });

  it("Escape and backdrop click dismiss the overlay (releasing the latch)", () => {
    openSettings("appearance");
    const overlay = document.querySelector(".fl-overlay") as HTMLElement;
    // Escape on the overlay closes it.
    overlay.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isOverlayOpen()).toBe(false);
    expect(overlayCount()).toBe(0);

    // Re-open and dismiss via a backdrop click (target === the overlay element itself).
    openSettings("appearance");
    const overlay2 = document.querySelector(".fl-overlay") as HTMLElement;
    overlay2.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // jsdom click: e.target is the dispatch target (the overlay) ⇒ backdrop dismiss fires.
    expect(isOverlayOpen()).toBe(false);
  });
});

describe("S-003 / E7-F2 — theme + Settings state never enters doc.toJSON()", () => {
  it("doc.toJSON() is byte-identical before vs after applyTheme('dark') and after opening Settings", () => {
    const doc = createSeedDoc();
    const before = JSON.stringify(doc.toJSON());

    // Apply a theme via the Appearance picker (the real user path), then open Settings.
    openSettings("appearance");
    const darkBtn = [...document.querySelectorAll<HTMLButtonElement>(".fl-settings__theme-option")].find(
      (b) => b.dataset.themeId === "dark",
    );
    expect(darkBtn).toBeDefined();
    darkBtn!.click();
    expect(document.documentElement.dataset.theme).toBe("dark"); // theme really changed…

    const after = JSON.stringify(doc.toJSON());
    expect(after).toBe(before); // …but the DOCUMENT is byte-identical (theme is chrome, not content)
  });
});

describe("Appearance theme picker (E7-S6)", () => {
  it("choosing Dark applies 'dark'; choosing Light clears to default; active swatch tracks the choice", () => {
    expect(openSettings("appearance")).toBe(true);
    const options = () => [...document.querySelectorAll<HTMLButtonElement>(".fl-settings__theme-option")];
    const byId = (id: string) => options().find((b) => b.dataset.themeId === id)!;

    // Choose Dark.
    byId("dark").click();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(byId("dark").classList.contains("fl-active")).toBe(true);
    expect(byId("light").classList.contains("fl-active")).toBe(false);

    // Choose Light ⇒ applyTheme(null): dataset cleared, key removed, active swatch flips to Light.
    byId("light").click();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(byId("light").classList.contains("fl-active")).toBe(true);
    expect(byId("dark").classList.contains("fl-active")).toBe(false);
  });

  it("openSettings('appearance') renders both registered themes in the picker", () => {
    openSettings("appearance");
    const ids = [...document.querySelectorAll<HTMLButtonElement>(".fl-settings__theme-option")].map(
      (b) => b.dataset.themeId,
    );
    expect(ids).toEqual(["light", "dark"]);
  });
});

describe("unified one-page Settings layout (WT3-3 — 'don't make two panes')", () => {
  it("stacks every registered section on one page with NO rail; both sections render together", () => {
    // Register a second section (any host-added section) to prove stacking on one page.
    let rendered = false;
    settingsRegistries().sections.registerSection({
      id: "test-extra",
      title: "Extra",
      order: 10,
      render: (c) => {
        rendered = true;
        const marker = document.createElement("div");
        marker.className = "fl-test-extra-marker";
        c.appendChild(marker);
      },
    });

    expect(openSettings()).toBe(true);
    // The unified layout has NO left rail / pane (those are gone).
    expect(document.querySelector(".fl-settings__rail")).toBeNull();
    expect(document.querySelector(".fl-settings__pane")).toBeNull();
    // BOTH sections are present on the one page at once: Appearance's theme picker AND the extra marker.
    expect(document.querySelector(".fl-settings__theme-option")).not.toBeNull();
    expect(rendered).toBe(true);
    expect(document.querySelector(".fl-test-extra-marker")).not.toBeNull();
    // One .fl-settings__group per section (Appearance + Extra), stacked.
    expect(document.querySelectorAll(".fl-settings__group").length).toBe(2);
  });
});
