// renderer/host/resolve-host.ts — the ONE boot-time platform selection for the EditorHost seam (refactor §S4/§5).
//
// The whole `isWeb` tangle collapses to a single predicate evaluated ONCE at boot: is the Electron preload bridge
// (`window.flowline`) present? Yes → DesktopHost (the bridge already IS the capability surface, 1:1); no → WebHost
// (FSA/Blob + in-window MDI). That is the SAME predicate desktop already used to decide "do I have a bridge", so
// wrapping it introduces no behavior shift (the pure-refactor non-goal).
//
// resolveHost returns `{ host, shell }` (§R4 ResolvedHost): `host` (FileHost & WindowHost) is always present; `shell`
// (the desktop-only lifecycle relay) is the SAME DesktopHost instance on desktop and `null` on web — so main.ts wires
// the menu/close/quit handlers behind ONE honest `if (shell)` instead of the old `isWeb`/`window.flowline` branches.
//
// Imports only the two host impls + the bridge/host types, keeping the platform layer dependency-clean.

import type { FlowlineBridge } from "../../persistence/bridge";
import type { ResolvedHost } from "./types";
import { DesktopHost } from "./desktop-host";
import { WebHost } from "./web-host";
import type { WebHostDeps } from "./web-host";

/**
 * Select the platform host ONCE at boot. `bridge` present ⇒ desktop (the one DesktopHost is handed back as both the
 * `host` view and the `shell` view — they are the same object behind two interfaces); absent ⇒ web (WebHost, no shell).
 *
 * @param opts.bridge          `window.flowline` — the preload capability surface, or `undefined` in a bare web tab.
 * @param opts.deps            everything the WebHost needs from main.ts's side of the §R8 seam (ignored on desktop,
 *                             where the bridge supplies these capabilities).
 */
export function resolveHost(opts: {
  readonly bridge: FlowlineBridge | undefined;
  readonly deps: WebHostDeps;
}): ResolvedHost {
  if (opts.bridge) {
    // Desktop: ONE DesktopHost satisfies EditorHost AND DesktopShell (the bridge backs all three interfaces); hand the
    // same instance out under both views so there is no second object to keep in sync (§S2 DRY rationale).
    const host = new DesktopHost(opts.bridge);
    return { host, shell: host };
  }
  // Web: no preload bridge, so no DesktopShell — the WebHost installs its own DOM menubar + accelerators (via mountUI).
  const host = new WebHost(opts.deps);
  return { host, shell: null };
}
