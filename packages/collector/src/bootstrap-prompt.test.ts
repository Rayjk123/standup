import { expect, test, describe } from "bun:test";
import type { Project } from "@standup/shared";
import { bootstrapPrompt } from "./bootstrap-prompt.js";

/**
 * The research prompt (phase-7 Step 4).
 *
 * Prompt *quality* is not unit-testable — it is judged by reading the six
 * documents a real run produces, and measured by Step 7's eval. What is
 * testable is the structural contract the rest of the system depends on,
 * and the specific regressions that would be silent:
 *
 * - The six slugs are an interface. Review, accept, and `replaces_slug`
 *   on regeneration all key off them, and Component 4.5 expects
 *   `overview` / `connections` / `practices` by name. A prompt that
 *   renames one still reads fine and quietly breaks the regenerate path.
 * - The prohibitions are the whole design. Softening them produces a
 *   plausible knowledge base rather than a failing one, which is the
 *   failure mode Component 4.6 exists to prevent.
 */

const project: Project = {
  id: "example",
  name: "example",
  repos: ["/tmp/example"],
  branch: "main",
  setup: "make bootstrap",
};

describe("bootstrapPrompt", () => {
  test("asks for exactly the six slugs the review flow expects", () => {
    const prompt = bootstrapPrompt(project);

    for (const slug of [
      "toolchain",
      "gotchas",
      "practices",
      "architecture",
      "overview",
      "connections",
    ]) {
      expect(prompt).toContain(`\`${slug}\``);
    }
  });

  test("names the tool that delivers drafts, not a file path", () => {
    // The agent must never learn where the knowledge directory is: the
    // collector stamps provenance, so a prompt that hands over a path
    // reintroduces the self-reported sha the gate exists to prevent.
    const prompt = bootstrapPrompt(project);

    expect(prompt).toContain("propose_knowledge");
    expect(prompt).not.toContain(".config/standup");
    expect(prompt).not.toContain(".drafts");
  });

  test("keeps the prohibition on inventing intent", () => {
    const prompt = bootstrapPrompt(project);

    expect(prompt).toContain("Do not write intent");
    // The banned openers are load-bearing: a generic caution produces
    // careful-sounding invention, a concrete list is checkable mid-sentence.
    expect(prompt).toContain("this project aims to");
    expect(prompt).toContain("Do not summarize the README");
  });

  test("makes overview and connections stubs rather than prose", () => {
    const prompt = bootstrapPrompt(project);

    // Both must be marked STUB. Without this the agent writes a confident
    // paraphrase of the README for exactly the two documents whose honest
    // content is a list of questions.
    expect(prompt.match(/A STUB/g)?.length).toBe(2);
  });

  test("keeps the run read-only", () => {
    expect(bootstrapPrompt(project)).toContain("Do not modify anything");
  });

  test("names the project's real setup command when it has one", () => {
    expect(bootstrapPrompt(project)).toContain("`make bootstrap`");
  });

  test("does not ask the agent to verify a command it would have to invent", () => {
    // With no configured setup, telling the agent to "verify it" invites a
    // plausible build sequence reported as fact.
    const prompt = bootstrapPrompt({ ...project, setup: undefined });

    expect(prompt).toContain("no configured setup command");
    expect(prompt).not.toContain("undefined");
  });

  test("is a real prompt, not the Step 3 placeholder", () => {
    const prompt = bootstrapPrompt(project);

    expect(prompt).not.toContain("PLACEHOLDER");
    expect(prompt).not.toContain("has not been implemented");
  });
});
