import { Component } from "react";
import type { ComponentType, ReactNode } from "react";
import type { PersonaMessage } from "@standup/shared";
import { theme } from "./theme";
import { RamCard, toRamReport } from "./RamCard";
import { StateCard, toStateReport } from "./StateCard";

// The console's half of the slash-command registry: one renderer per name in
// PERSONA_COMMANDS, drawing the result card a command's message carries.
// Cards stay in thread history, so a renderer must cope with data written by
// an older collector: it normalizes what it reads, and a card that still
// fails to draw falls back to its summary line.

export interface CommandRendererProps {
  data: unknown;
  /** When the command ran (ISO), for data that doesn't say. */
  ranAt: string;
}

export const COMMAND_RENDERERS: Readonly<Record<string, ComponentType<CommandRendererProps>>> = {
  state: ({ data, ranAt }) => <StateCard report={toStateReport(data, ranAt)} />,
  ram: ({ data, ranAt }) => <RamCard report={toRamReport(data, ranAt)} />,
};

/** Draws `fallback` instead of a card that throws while rendering. */
class CardBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** A command's result message: its renderer's card, or the summary line when it failed or has none. */
export function CommandResultCard({ message }: { message: PersonaMessage }) {
  const command = message.command;
  const result = command?.result;
  const Renderer = command ? COMMAND_RENDERERS[command.name] : undefined;
  const summary = (
    <div
      data-testid="command-summary"
      style={{
        fontSize: 12.5,
        color: result?.ok === false ? theme.waiting : theme.dim,
        border: `1px solid ${theme.edgeSoft}`,
        background: theme.surface,
        borderRadius: 8,
        padding: "8px 12px",
      }}
    >
      {result?.summary ?? message.text}
    </div>
  );
  return (
    <div
      data-message-id={message.id}
      data-testid="command-result"
      data-command={command?.name}
      style={{ alignSelf: "stretch", width: "100%", maxWidth: 720, margin: "0 auto", minWidth: 0 }}
    >
      {result?.ok && Renderer ? (
        <CardBoundary fallback={summary}>
          <Renderer data={result.data} ranAt={result.ranAt || message.createdAt} />
        </CardBoundary>
      ) : (
        summary
      )}
    </div>
  );
}
