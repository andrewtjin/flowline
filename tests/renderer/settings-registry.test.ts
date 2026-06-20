// renderer/settings-registry.test.ts — the PURE Settings core: section + theme registries, applyTheme, and
// loadPersistedTheme. The registries are DOM-free Maps; applyTheme/loadPersistedTheme touch
// documentElement.dataset + Storage. jsdom (the vitest env) gives us document + a real localStorage, but the
// persistence round-trip is exercised through an INJECTED fake Storage so it is hermetic and not coupled to the
// ambient jsdom localStorage.

import { describe, it, expect, beforeEach } from "vitest";
import {
  SectionRegistry,
  ThemeRegistry,
  applyTheme,
  loadPersistedTheme,
  THEME_STORAGE_KEY,
  type SettingsSection,
} from "../../src/renderer/settings-registry";

// A minimal in-memory Storage stub (getItem/setItem/removeItem) for hermetic persistence round-trips.
function fakeStore(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

// A no-op section factory (render is irrelevant to the registry's ordering/dedupe contract).
const section = (id: string, title: string, order?: number): SettingsSection => ({
  id,
  title,
  order,
  render: () => {},
});

describe("SectionRegistry", () => {
  it("listSections sorts by order ascending, then by insertion order for ties/absent order", () => {
    const r = new SectionRegistry();
    r.registerSection(section("c", "C", 2));
    r.registerSection(section("a", "A", 1));
    r.registerSection(section("z", "Z")); // no order ⇒ Infinity ⇒ last
    r.registerSection(section("b", "B", 1)); // tie with "a" on order=1 ⇒ keeps insertion order (a before b)
    expect(r.listSections().map((s) => s.id)).toEqual(["a", "b", "c", "z"]);
  });

  it("registerSection dedupes by id with REPLACE, keeping the original insertion slot", () => {
    const r = new SectionRegistry();
    r.registerSection(section("first", "First", 0));
    r.registerSection(section("second", "Second", 1));
    // Re-register "first" with a NEW title — replace wins, but the slot (insertion order) is unchanged.
    r.registerSection(section("first", "First v2", 0));
    const list = r.listSections();
    expect(list).toHaveLength(2); // replaced, not appended
    expect(list[0].id).toBe("first");
    expect(list[0].title).toBe("First v2"); // last writer won
  });

  it("getSection returns the registered section or undefined", () => {
    const r = new SectionRegistry();
    r.registerSection(section("x", "X"));
    expect(r.getSection("x")?.title).toBe("X");
    expect(r.getSection("nope")).toBeUndefined();
  });
});

describe("ThemeRegistry", () => {
  it("registers, lists in insertion order, and gets by id; replace dedupes", () => {
    const r = new ThemeRegistry();
    r.registerTheme({ id: "light", label: "Light" });
    r.registerTheme({ id: "dark", label: "Dark" });
    expect(r.listThemes().map((t) => t.id)).toEqual(["light", "dark"]);
    expect(r.getTheme("dark")?.label).toBe("Dark");
    // Replace the dark label; slot + count unchanged.
    r.registerTheme({ id: "dark", label: "Midnight" });
    expect(r.listThemes().map((t) => t.id)).toEqual(["light", "dark"]);
    expect(r.getTheme("dark")?.label).toBe("Midnight");
  });
});

describe("applyTheme — DOM + storage effects", () => {
  beforeEach(() => {
    // Reset the live root between cases so dataset/inline-vars don't leak across tests.
    delete document.documentElement.dataset.theme;
    document.documentElement.removeAttribute("style");
  });

  it("applyTheme('dark') sets dataset.theme + persists the id to the injected store", () => {
    const store = fakeStore();
    applyTheme("dark", undefined, store);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(store.map.get(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("applyTheme(null) clears the dataset attr AND removes the persisted key (light/default)", () => {
    const store = fakeStore();
    applyTheme("dark", undefined, store); // set dark first
    applyTheme(null, undefined, store); // then back to light
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(store.map.has(THEME_STORAGE_KEY)).toBe(false); // key REMOVED, not set to ""
  });

  it("applies a registered theme's programmatic vars and clears them when switching away", () => {
    const reg = new ThemeRegistry();
    reg.registerTheme({ id: "sepia", label: "Sepia", vars: { "--fl-bg": "#f4ecd8" } });
    const store = fakeStore();
    applyTheme("sepia", reg, store);
    expect(document.documentElement.style.getPropertyValue("--fl-bg")).toBe("#f4ecd8");
    // Switching to light clears the prior theme's inline var (no leakage).
    applyTheme(null, reg, store);
    expect(document.documentElement.style.getPropertyValue("--fl-bg")).toBe("");
  });
});

describe("loadPersistedTheme — round-trip via injected fake Storage", () => {
  beforeEach(() => {
    delete document.documentElement.dataset.theme;
    document.documentElement.removeAttribute("style");
  });

  it("reads a persisted 'dark' and applies it (dataset set, id returned)", () => {
    const store = fakeStore();
    store.map.set(THEME_STORAGE_KEY, "dark");
    const resolved = loadPersistedTheme(undefined, store);
    expect(resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("an absent/empty persisted value resolves to light/default (null, no dataset attr)", () => {
    const store = fakeStore(); // empty
    expect(loadPersistedTheme(undefined, store)).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();

    store.map.set(THEME_STORAGE_KEY, "   "); // whitespace-only ⇒ treated as default
    expect(loadPersistedTheme(undefined, store)).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("full round-trip: applyTheme('dark') then loadPersistedTheme reads back 'dark' from the SAME store", () => {
    const store = fakeStore();
    applyTheme("dark", undefined, store);
    delete document.documentElement.dataset.theme; // simulate a fresh page (dataset reset)
    const resolved = loadPersistedTheme(undefined, store);
    expect(resolved).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
