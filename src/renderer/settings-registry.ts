// renderer/settings-registry.ts — the PURE core of the Settings shell.
//
// Two registries (sections + themes) and the theme-apply machinery. This module is deliberately split from
// settings.ts (the DOM shell): the registries themselves are DOM-free, Map-backed, and unit-testable with no
// jsdom, while only `applyTheme`/`loadPersistedTheme` touch the platform (documentElement.dataset + Storage).
// Keeping the contract here means the DOM shell and the boot wiring depend on this interface, never on the
// internal Maps — and a test can exercise the registries without constructing a single element.
//
// CLEAN-IMPLEMENTATION / PURITY: nothing here ever touches the ProseMirror doc. Theme state lives ONLY on
// document.documentElement.dataset.theme + localStorage[THEME_STORAGE_KEY]; it is per-user chrome, never
// document content (case S-003 / E7-F2). No `--fl-color-*` highlight var is referenced here.

// ── Sections ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A registrable Settings section. `render` paints the section's body into the container the shell hands it
 * (the shell owns the chrome — title list, close, layout — the section owns only its own pane). `order` sorts
 * the section list (ascending); ties and missing orders fall back to insertion order (see `listSections`).
 */
export interface SettingsSection {
  readonly id: string;
  readonly title: string;
  readonly order?: number;
  render(container: HTMLElement): void;
}

/**
 * A Map-backed section registry. Insertion order is preserved by the Map, which `listSections` uses as the
 * stable tiebreaker behind `order`. PURE: no DOM, no storage — a section's `render` is only ever invoked by
 * the DOM shell, never here.
 */
export class SectionRegistry {
  // Map preserves insertion order, which is the documented tiebreaker for equal/absent `order` values.
  private readonly sections = new Map<string, SettingsSection>();

  /**
   * Register a section. DEDUPE POLICY = REPLACE: re-registering an id overwrites the prior section (it does
   * NOT throw). Rationale — a built-in "Appearance" section can be safely re-registered on an HMR reload or a
   * re-mount without the app having to track whether it already ran; last writer wins. NOTE: Map.set on an
   * existing key keeps the ORIGINAL insertion slot, so a replace does not jump the section to the end.
   */
  registerSection(section: SettingsSection): void {
    this.sections.set(section.id, section);
  }

  /** All registered sections, sorted by `order` ascending (absent `order` = Infinity, i.e. last), then by
   *  insertion order for ties. A stable sort + the Map's insertion ordering give the documented tiebreak. */
  listSections(): SettingsSection[] {
    // Array.prototype.sort is stable (ES2019+), so equal comparator results keep their input (insertion) order.
    return [...this.sections.values()].sort(
      (a, b) => (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY),
    );
  }

  /** The section registered under `id`, or undefined if none. */
  getSection(id: string): SettingsSection | undefined {
    return this.sections.get(id);
  }
}

// ── Themes ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A theme definition. `id` is the value written to `documentElement.dataset.theme` (and persisted); `label`
 * is the human name shown in the picker. `vars` is an OPTIONAL bag of CSS custom-property overrides a future
 * theme could carry programmatically — the built-in dark theme does NOT use it (its overrides live in a static
 * `[data-theme="dark"]` block in styles.css, which is leaner and avoids inline-style churn); it exists so a
 * later user-defined theme can ship variable values without a stylesheet edit. NEVER put a `--fl-color-*`
 * highlight var here: those are OOXML-locked for .docx fidelity (case E7-F3).
 */
export interface ThemeDef {
  readonly id: string;
  readonly label: string;
  readonly vars?: Record<string, string>;
}

/**
 * The single source of truth for the persisted-theme localStorage key. Exported so the no-flash boot script
 * (index.html) and any test reference the SAME string — a drifting key would silently break persistence.
 */
export const THEME_STORAGE_KEY = "flowline.theme";

/** The minimal storage surface we need: window.localStorage in the app; an injected fake in tests. Mirrors the
 *  shared `KV` storage convention, plus removeItem (clearing a theme deletes the key rather than storing ""). */
type ThemeStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * A Map-backed theme registry. PURE: registering/listing/getting a theme touches no DOM and no storage — only
 * `applyTheme` (a free function below) mutates the platform. `listThemes` returns themes in INSERTION order
 * (the order the picker shows them); there is no `order` field on a theme — the registrant controls the order.
 */
export class ThemeRegistry {
  private readonly themes = new Map<string, ThemeDef>();

  /** Register a theme. DEDUPE = REPLACE (same rationale as sections): re-registering an id overwrites it and
   *  keeps the original insertion slot, so a re-register on HMR does not reshuffle the picker. */
  registerTheme(theme: ThemeDef): void {
    this.themes.set(theme.id, theme);
  }

  /** All registered themes, in insertion order (the picker's display order). */
  listThemes(): ThemeDef[] {
    return [...this.themes.values()];
  }

  /** The theme registered under `id`, or undefined if none. */
  getTheme(id: string): ThemeDef | undefined {
    return this.themes.get(id);
  }
}

/**
 * Apply a theme to the live document AND persist the choice.
 *   - `applyTheme('dark')` sets `document.documentElement.dataset.theme = 'dark'` (the CSS `[data-theme="dark"]`
 *     block then takes over the chrome/ink tokens) AND writes `localStorage[THEME_STORAGE_KEY] = 'dark'`.
 *   - `applyTheme(null)` is the LIGHT/DEFAULT state: it DELETES the dataset attribute (so `:root` defaults win)
 *     AND REMOVES the persisted key (rather than storing "" — absence is the canonical "default" marker, which
 *     the no-flash boot script also relies on).
 * If a registered theme carries `vars`, they are applied/cleared as inline custom properties on the root too,
 * so a programmatic (var-only) theme works without a stylesheet edit; the built-in dark theme has no `vars`.
 *
 * `store` is injectable (defaults to the ambient localStorage, or null where absent — e.g. a non-DOM context)
 * so tests can round-trip through a fake Storage. Storage writes are best-effort (try/catch): a privacy-mode /
 * non-persistent partition that throws on write must not break the live (in-DOM) theme switch.
 */
export function applyTheme(
  id: string | null,
  registry?: ThemeRegistry,
  store: ThemeStore | null = typeof localStorage !== "undefined" ? localStorage : null,
): void {
  const root = typeof document !== "undefined" ? document.documentElement : null;
  // Resolve any var bag for the chosen theme so we can apply (or, on the previous theme, the absence clears via
  // the dataset swap + below). We only manage vars we are explicitly given; we never touch --fl-color-* vars.
  const theme = id != null ? registry?.getTheme(id) : undefined;

  if (root) {
    // Clear any inline vars from a prior programmatic theme first so themes don't leak vars into one another.
    // (Only inline props WE set live in root.style; the static stylesheet vars are untouched.)
    for (let i = root.style.length - 1; i >= 0; i--) {
      const prop = root.style.item(i);
      if (prop.startsWith("--fl-")) root.style.removeProperty(prop);
    }
    if (id == null) {
      // Light/default: drop the attribute entirely so the `:root` token defaults apply.
      delete root.dataset.theme;
    } else {
      root.dataset.theme = id;
      // Apply any programmatic var overrides (built-in dark has none — it uses the static CSS block).
      if (theme?.vars) for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
    }
  }

  // Persist the choice (best-effort). null = light/default ⇒ REMOVE the key (absence is the default marker).
  try {
    if (id == null) store?.removeItem(THEME_STORAGE_KEY);
    else store?.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // Best-effort: the live DOM theme already switched; a failed persist only loses cross-reload memory.
  }
}

/**
 * Read the persisted theme from `store` and apply it (so a returning dark user gets dark on boot). A missing /
 * empty persisted value resolves to light/default (`applyTheme(null)`). `registry` is forwarded so a persisted
 * programmatic theme's `vars` are re-applied. Returns the resolved theme id (or null for default) for callers
 * that want to sync UI state. `store` is injectable so the round-trip is testable with a fake Storage.
 */
export function loadPersistedTheme(
  registry?: ThemeRegistry,
  store: ThemeStore | null = typeof localStorage !== "undefined" ? localStorage : null,
): string | null {
  let saved: string | null = null;
  try {
    saved = store?.getItem(THEME_STORAGE_KEY) ?? null;
  } catch {
    saved = null; // a throwing read (privacy mode) ⇒ fall back to default.
  }
  const id = saved && saved.trim() ? saved : null;
  applyTheme(id, registry, store);
  return id;
}
