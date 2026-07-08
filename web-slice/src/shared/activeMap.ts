// Single source of truth for which curated arena both the client (src/main.ts)
// and the match server (server/config/arena.ts) load by default — keeping
// them on the SAME map is load-bearing: enemy spawn heights, weapon-box
// placement and rocket-vs-terrain collision are all computed server-side from
// a Heightfield built off this file, so a client rendering a different map
// than the server sees floating/sunken karts and wrong rocket pitch (see
// docs/known-issues or the 2026-07-08 bug report this file fixes).
//
// The in-browser map editor (?map=editor, see src/editor/main.ts) still lets
// you preview any map client-side by stashing it in localStorage — that path
// is unaffected by this constant. Change ACTIVE_MAP to switch the arena both
// sides actually play on.
export const ACTIVE_MAP = "mars_base";
