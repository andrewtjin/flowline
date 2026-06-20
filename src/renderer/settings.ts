// renderer/settings.ts — the DOM shell for Settings + the SHARED single-instance overlay primitive.
//
// WHY THIS EXISTS: Settings needs a modal overlay — a dim full-screen backdrop, a centered dialog, an
// Escape/backdrop-click dismiss, a focus keytrap, and a "only one open at a time" latch. This module owns that
// overlay primitive (`openOverlay`) behind ONE module-level latch, so two overlays can never stack: opening one
// while another is already up is a graceful no-op (E7-S3).
//
// CLEAN-ROOM / PURITY: this shell paints chrome and calls into the PURE settings-registry (sections + themes +
// applyTheme). It never touches the ProseMirror doc — theme state lives on documentElement.dataset + localStorage
// only (S-003 / E7-F2). Every class is `fl-` prefixed (`.fl-settings*`, plus the shared `.fl-overlay*`).

import { SectionRegistry, ThemeRegistry, applyTheme } from "./settings-registry";

// ── Shared single-instance overlay ─────────────────────────────────────────────────────────────────────────

// THE one latch. Module-level so EVERY overlay in the renderer (Settings here + the Join/rename modals routed
// through `openOverlay` from main.ts) shares it: at most one overlay element is ever in the DOM. A second
// `openOverlay` while one is up is a no-op (the caller's build callback never runs), so nothing stacks.
let activeOverlay: HTMLElement | null = null;

/** True iff an overlay (Settings or a modal) is currently open. Lets a caller decide gracefully (it can also
 *  just call openOverlay — a redundant open is a safe no-op). */
export function isOverlayOpen(): boolean {
  return activeOverlay !== null;
}

/** Close the active overlay, if any. Idempotent: a second call (or a call with none open) is harmless. */
export function closeOverlay(): void {
  if (!activeOverlay) return;
  activeOverlay.remove();
  activeOverlay = null;
}

/**
 * The shared overlay primitive. Builds the dim backdrop + a centered dialog, wires the standard dismiss
 * affordances (Escape, backdrop click), TRAPS keys on the overlay so the editor's ProseMirror keymaps never see
 * them (Enter/Escape/Tab are handled here; everything else is stopped from propagating to the editor underneath),
 * and enforces the single-instance latch. The caller's `build(dialog, close)` populates the dialog body and may
 * call `close` to dismiss; `build` returns the list of focusable controls (in tab order) so Tab/Shift-Tab cycle
 * within the dialog and the first is auto-focused.
 *
 * Returns true if the overlay opened, false if one was already open (graceful no-stack). The single
 * `activeOverlay` latch guarantees two overlays can never coexist.
 */
export function openOverlay(
  build: (dialog: HTMLElement, close: () => void) => HTMLElement[],
): boolean {
  if (activeOverlay) return false; // never stack — a second open is a graceful no-op.

  const overlay = document.createElement("div");
  overlay.className = "fl-overlay";
  const dialog = document.createElement("div");
  dialog.className = "fl-overlay__dialog";
  overlay.appendChild(dialog);

  // close() tears down + releases the latch. Idempotent via the activeOverlay guard in closeOverlay.
  const close = (): void => {
    if (activeOverlay === overlay) closeOverlay();
  };

  const focusables = build(dialog, close);

  // Trap keys ON the overlay: Escape dismisses, Tab/Shift-Tab cycle the dialog's own controls, and EVERY key is
  // stopped from propagating so the editor's keymaps underneath never fire while an overlay is up. (Enter is left
  // for the caller's own controls — e.g. a submit button listener — but still stopped from reaching the editor.)
  overlay.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab" && focusables.length > 0) {
      // Wrap focus within the dialog. From an unknown focus (idx -1): Tab→first, Shift-Tab→last.
      e.preventDefault();
      const idx = focusables.indexOf(document.activeElement as HTMLElement);
      const dir = e.shiftKey ? -1 : 1;
      const start = idx === -1 ? (e.shiftKey ? 0 : -1) : idx;
      focusables[(start + dir + focusables.length) % focusables.length].focus();
    }
  });
  // Backdrop click (outside the dialog) dismisses, like a standard modal.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  activeOverlay = overlay;
  document.body.appendChild(overlay);
  focusables[0]?.focus();
  return true;
}

// ── Settings shell ────────────────────────────────────────────────────────────────────────────────────────

// The app's single section registry. A built-in "Appearance" section is registered into it at startup
// (registerBuiltinSettings below); the registry is the documented extension point for future sections.
const sections = new SectionRegistry();
// The app's single theme registry, populated at startup (light + dark) by registerBuiltinSettings.
const themes = new ThemeRegistry();

/** Expose the registries so boot wiring (main.ts) and tests can register/inspect themes + sections. */
export function settingsRegistries(): { sections: SectionRegistry; themes: ThemeRegistry } {
  return { sections, themes };
}

/**
 * Open the Settings overlay (single-instance, via the shared latch). Opening while ANY overlay is already up
 * is a graceful no-op (returns false).
 *
 * Layout (user 2026-06-19, "don't make two panes"): ONE combined page — every registered section is stacked
 * vertically into a single scrollable body, each rendering its own labeled field group (e.g. "Theme", then
 * "Display name"). No left rail. The section's `render(container)` still owns only its own group; the shell owns
 * the chrome (title, close button, spacing/dividers between groups). `sectionId` is accepted for call-site
 * back-compat but no longer selects a pane — with everything on one page there is nothing to switch to.
 */
export function openSettings(_sectionId?: string): boolean {
  return openOverlay((dialog, close) => {
    dialog.classList.add("fl-settings");

    // Header: title + a close affordance.
    const header = document.createElement("div");
    header.className = "fl-settings__header";
    const heading = document.createElement("h2");
    heading.className = "fl-settings__title";
    heading.textContent = "Settings";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "fl-settings__close";
    closeBtn.textContent = "✕";
    closeBtn.title = "Close settings";
    closeBtn.setAttribute("aria-label", "Close settings");
    closeBtn.addEventListener("click", close);
    header.append(heading, closeBtn);

    // Body: every registered section stacked on ONE page (no rail). Each section paints its own field group.
    const body = document.createElement("div");
    body.className = "fl-settings__body";
    for (const section of sections.listSections()) {
      const group = document.createElement("div");
      group.className = "fl-settings__group";
      group.dataset.sectionId = section.id;
      section.render(group);
      body.appendChild(group);
    }

    dialog.append(header, body);

    // Focus order: close button, then every focusable control the sections rendered (theme swatches, the name
    // input, …) in DOM order, so Tab/Shift-Tab cycle the whole page.
    const controls = [...body.querySelectorAll<HTMLElement>("button, input, select, textarea")];
    return [closeBtn, ...controls];
  });
}

// ── Built-in Appearance section + light/dark themes ───────────────────────────────────────────────────────

/**
 * Register the built-in themes (light + dark) and the "Appearance" section into the app registries. Idempotent
 * by the registries' REPLACE dedupe, so calling it more than once (HMR / a re-mount) is safe. Called once at
 * startup from main.ts. The light theme's id is the SENTINEL string "light" for the picker's selection model,
 * but choosing it calls `applyTheme(null)` — light is the absence of a theme (no dataset attr, no persisted key).
 */
export function registerBuiltinSettings(): void {
  // "light" is an explicit, user-visible entry (the locked spec wants a real Light choice), but it maps to the
  // DEFAULT state: applyTheme(null). "dark" is a real registered theme whose overrides live in the static
  // [data-theme="dark"] CSS block (no `vars` here — see settings-registry.ts ThemeDef.vars).
  themes.registerTheme({ id: "light", label: "Light" });
  themes.registerTheme({ id: "dark", label: "Dark" });

  sections.registerSection({
    id: "appearance",
    title: "Appearance",
    order: 0,
    render: (container) => renderAppearance(container),
  });
}

// The picker selection model: a theme whose id is the LIGHT sentinel applies the default (applyTheme(null));
// any other id applies that theme. Kept as a named constant so the section + a test agree on the sentinel.
const LIGHT_THEME_ID = "light";

/**
 * Paint the Appearance section: a theme picker listing every registered theme. Choosing "Light" calls
 * `applyTheme(null)` (the default state); any other theme calls `applyTheme(id, themes)`. The currently-applied
 * theme (read from documentElement.dataset.theme: present ⇒ that id, absent ⇒ light) is marked active.
 */
function renderAppearance(container: HTMLElement): void {
  const wrap = document.createElement("div");
  wrap.className = "fl-settings__appearance";

  const label = document.createElement("div");
  label.className = "fl-settings__field-label";
  label.textContent = "Theme";
  wrap.appendChild(label);

  const picker = document.createElement("div");
  picker.className = "fl-settings__theme-picker";

  // The live applied theme: dataset.theme present ⇒ that id; absent ⇒ light (the default). Used to pre-mark
  // the active swatch and to keep the picker honest after a choice.
  const current = (): string =>
    (typeof document !== "undefined" && document.documentElement.dataset.theme) || LIGHT_THEME_ID;

  const buttons: HTMLButtonElement[] = [];
  const mark = (): void => {
    const c = current();
    buttons.forEach((b) => b.classList.toggle("fl-active", b.dataset.themeId === c));
  };

  for (const theme of themes.listThemes()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fl-settings__theme-option";
    btn.dataset.themeId = theme.id;
    btn.textContent = theme.label;
    btn.addEventListener("click", () => {
      // Light is the absence of a theme (applyTheme(null)); anything else applies that registered theme.
      if (theme.id === LIGHT_THEME_ID) applyTheme(null, themes);
      else applyTheme(theme.id, themes);
      mark();
    });
    picker.appendChild(btn);
    buttons.push(btn);
  }

  mark();
  wrap.appendChild(picker);
  container.appendChild(wrap);
}
