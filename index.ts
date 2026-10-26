// Server-side entrypoint of the statusline plugin.
// The line itself renders in the TUI; see tui.tsx. This file completes the
// standard two-entrypoint layout that OpenCode expects from a discovered
// plugin (server and TUI entrypoints kept together).
export default {
  id: "statusline",
  setup() {},
}
