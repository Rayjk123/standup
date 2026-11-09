import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement, useState } from "react";
import type { PersonaJob } from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import { hashQueryAt, jobTagLabel, matchJobs } from "./JobTagPicker";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = ["window", "document", "navigator", "Node", "HTMLElement", "Element", "Text", "Event", "MutationObserver"] as const;
const saved = new Map<string, unknown>();

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let PersonaComposer: typeof import("./PersonaView").PersonaComposer;

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ PersonaComposer } = await import("./PersonaView"));
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

function job(id: string, title: string, status: PersonaJob["status"] = "active", updatedAt = "2026-10-07T10:00:00.000Z"): PersonaJob {
  return { id, owner: "alice", threadId: "t1", title, goal: `goal of ${title}`, status, launchIds: [], sessionIds: [], createdAt: updatedAt, updatedAt };
}

const JOBS = [
  job("job-a", "Fix the flaky login test"),
  job("job-b", "Upgrade the build toolchain", "waiting_user"),
  job("job-c", "Old release notes", "done"),
];

describe("hashQueryAt / matchJobs", () => {
  test("a # opens a query only at a word start, up to the caret", () => {
    expect(hashQueryAt("#", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(hashQueryAt("about #log", 10)).toEqual({ start: 6, end: 10, query: "log" });
    expect(hashQueryAt("C# code", 2)).toBeNull();
    expect(hashQueryAt("#log in", 7)).toBeNull();
    expect(hashQueryAt("issue#4", 7)).toBeNull();
  });

  test("open jobs come first; a query matches title words or an id prefix", () => {
    expect(matchJobs(JOBS, "").map((j) => j.id)).toEqual(["job-b", "job-a", "job-c"]);
    expect(matchJobs(JOBS, "LOGIN").map((j) => j.id)).toEqual(["job-a"]);
    expect(matchJobs(JOBS, "job-c").map((j) => j.id)).toEqual(["job-c"]);
    expect(matchJobs(JOBS, "zzz")).toEqual([]);
    expect(jobTagLabel("Ship it")).toBe("re: Ship it");
  });
});

let host: HTMLElement;
let root: Root;
let mounted = false;

afterEach(async () => {
  if (!mounted) return;
  await act(() => root.unmount());
  host.remove();
  mounted = false;
});

/** The composer as PersonaView holds it: the tag lives above it, sends are recorded. */
function mountComposer(initialTag: string | null = null) {
  const sent: Array<{ text: string; tag: string | null }> = [];
  function Harness() {
    const [tag, setTag] = useState<string | null>(initialTag);
    return createElement(PersonaComposer, {
      jobs: JOBS,
      tag: JOBS.find((j) => j.id === tag),
      onTag: setTag,
      paused: false,
      placeholder: "Ask Persona…",
      onSend: (text: string) => {
        sent.push({ text, tag });
        setTag(null);
      },
    });
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mounted = true;
  return { sent, render: () => act(() => root.render(createElement(Harness))) };
}

function textarea(): HTMLTextAreaElement {
  return host.querySelector("textarea") as HTMLTextAreaElement;
}

/** Types `value` into the textarea the way React sees it, caret at the end. */
async function type(value: string) {
  const el = textarea();
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!;
  await act(() => {
    setter.call(el, value);
    el.setSelectionRange(value.length, value.length);
    el.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
}

async function key(k: string) {
  await act(() => {
    textarea().dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }) as unknown as Event);
  });
}

function chip(): HTMLElement | null {
  return host.querySelector("[data-testid=job-tag-chip]");
}

function options(): string[] {
  return [...host.querySelectorAll("[role=option]")].map((o) => o.textContent ?? "");
}

describe("PersonaComposer job tagging", () => {
  test("the chip shows the tagged job and × removes it", async () => {
    const c = mountComposer("job-a");
    await c.render();
    expect(chip()?.textContent).toContain("re: Fix the flaky login test");
    await act(() => (host.querySelector("button[aria-label='Remove job tag']") as HTMLElement).click());
    expect(chip()).toBeNull();
  });

  test("typing # opens the picker; it filters, and Enter tags the job and drops the #query", async () => {
    const c = mountComposer();
    await c.render();
    await type("status on #");
    expect(host.querySelector("[role=listbox]")).not.toBeNull();
    expect(options()).toHaveLength(3);
    await type("status on #toolch");
    expect(options().map((o) => o.includes("Upgrade the build toolchain"))).toEqual([true]);
    await key("Enter");
    expect(host.querySelector("[role=listbox]")).toBeNull();
    expect(chip()?.textContent).toContain("re: Upgrade the build toolchain");
    expect(textarea().value).toBe("status on ");
    expect(c.sent).toEqual([]);

    await type("status on it?");
    await key("Enter");
    expect(c.sent).toEqual([{ text: "status on it?", tag: "job-b" }]);
    expect(chip()).toBeNull();
  });

  test("arrow keys move the choice, a click picks, Esc closes without tagging", async () => {
    const c = mountComposer();
    await c.render();
    await type("#");
    await key("ArrowDown");
    expect(host.querySelectorAll("[role=option][aria-selected=true]")[0]?.textContent).toContain("Fix the flaky login test");
    await key("Escape");
    expect(host.querySelector("[role=listbox]")).toBeNull();
    expect(chip()).toBeNull();

    await type("hi #old");
    const option = host.querySelector("[role=option]") as HTMLElement;
    await act(() => {
      option.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }) as unknown as Event);
    });
    expect(chip()?.textContent).toContain("re: Old release notes");
    expect(textarea().value).toBe("hi ");
  });
});
