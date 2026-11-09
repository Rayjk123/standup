import type { ReactNode } from "react";
import { LuBox } from "react-icons/lu";
import type { Project } from "@standup/shared";
import { alpha, theme } from "./theme";

type IconSource = Pick<Project, "emoji" | "iconPath" | "name"> | null | undefined;

/**
 * A project's glyph, inline and unboxed: its uploaded custom image when one is
 * set, otherwise its emoji, otherwise `fallback`. Used where the emoji shows as
 * a bare character today (flat session rows, the project header) so a custom
 * image lands there without changing the surrounding layout.
 */
export function ProjectIcon({
  project,
  size = 14,
  fallback,
}: {
  project: IconSource;
  size?: number;
  fallback?: ReactNode;
}) {
  if (project?.iconPath) {
    return (
      <img
        src={project.iconPath}
        alt=""
        style={{
          width: size,
          height: size,
          borderRadius: Math.max(3, Math.round(size * 0.22)),
          objectFit: "cover",
          display: "inline-block",
          verticalAlign: "middle",
        }}
      />
    );
  }
  if (project?.emoji) return <>{project.emoji}</>;
  return <>{fallback ?? <LuBox />}</>;
}

/**
 * The rounded, tinted avatar box the sidebar and detail headers use. Renders
 * the project's uploaded image edge-to-edge when set (dropping the tint so the
 * image reads as the avatar itself), otherwise the emoji — or `LuBox` — centered
 * in the familiar running-tinted square.
 */
export function ProjectAvatar({
  project,
  size = 22,
  fontSize,
}: {
  project: IconSource;
  size?: number;
  fontSize?: number;
}) {
  const radius = Math.max(4, Math.round(size * 0.23));
  if (project?.iconPath) {
    return (
      <img
        src={project.iconPath}
        alt=""
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          objectFit: "cover",
          display: "block",
          flexShrink: 0,
          border: `1px solid ${theme.edge}`,
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: alpha(theme.running, 0x1f),
        border: `1px solid ${alpha(theme.running, 0x55)}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: fontSize ?? Math.round(size * 0.55),
        flexShrink: 0,
      }}
    >
      {project?.emoji ?? <LuBox />}
    </div>
  );
}
