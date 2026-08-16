export const theme = {
  ground: "#101520",
  hover: "#161C27",
  surface: "#171D2A",
  raised: "#1E2534",
  edge: "#2B3446",
  edgeSoft: "#212939",
  text: "#E6EAF2",
  dim: "#8A97AD",
  faint: "#5A6579",
  running: "#4C9EF5",
  checkpoint: "#5FDCA4",
  stalled: "#F0A93B",
  waiting: "#FF6B84",
  idle: "#48536A",
  expert: "#B08CF0",
  mono: "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Cascadia Code', Menlo, monospace",
  sans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
} as const;

export const statusColors = {
  running: theme.running,
  idle: theme.idle,
  waiting: theme.waiting,
  stalled: theme.stalled,
} as const;
