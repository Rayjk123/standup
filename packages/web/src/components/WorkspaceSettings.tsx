import { MultiplayerToggle } from "./MultiplayerToggle";
import { OrchestrationProfiles } from "./OrchestrationProfiles";
import { theme } from "./theme";

/**
 * The host-wide launch setting: the multiplayer launch default. The toggle
 * self-fetches and PUTs /api/settings, so this takes no props. The You tab
 * shows it as its Workspace › Multiplayer section.
 */
export function WorkspaceSettings() {
  return (
    <div>
      <MultiplayerToggle />
      <div style={{ fontSize: 11.5, color: theme.dim, lineHeight: 1.5, marginTop: 8, maxWidth: "75ch" }}>
        Auto-detected from connected users. When on, new launches
        default to a fresh worktree per project so shared users don't
        collide; single-user local launches in-place.
      </div>
    </div>
  );
}

/** The account-wide orchestration-profile editor, the You tab's Workspace › Orchestration section. */
export function WorkspaceOrchestration() {
  return <OrchestrationProfiles scope="global" />;
}
