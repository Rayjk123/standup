import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { PERSONA_COMMANDS } from "@standup/shared";
import type { Root } from "react-dom/client";
import { GlobalWindow } from "happy-dom";
import { matchCommands, slashQuery } from "./CommandMenu";

// react-dom decides whether a DOM exists when it is first imported, so the
// window is installed before the view modules load.
const window = new GlobalWindow({ url: "http://localhost/" });
const GLOBALS = ["window", "document", "navigator", "Node", "HTMLElement", "Element", "Text", "Event", "MutationObserver"] as const;
const saved = new Map<string, unknown>();

let act: (fn: () => void | Promise<void>) => Promise<void>;
let createRoot: (el: Element) => Root;
let PersonaComposer: typeof import("./PersonaView").PersonaComposer;
let COMMAND_RENDERERS: typeof import("./CommandResultCard").COMMAND_RENDERERS;

beforeAll(async () => {
  for (const name of GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = (window as unknown as Record<string, unknown>)[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = (await import("react")) as unknown as { act: typeof act });
  ({ createRoot } = await import("react-dom/client"));
  ({ PersonaComposer } = await import("./PersonaView"));
  ({ COMMAND_RENDERERS } = await import("./CommandResultCard"));
});

afterAll(async () => {
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  await window.happyDOM.close();
});

describe("slashQuery / matchCommands", () => {
  test("the menu opens only on a leading /word with no space yet", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/st")).toBe("st");
    expect(slashQuery("/STATE")).toBe("state");
    expect(slashQuery("/state now")).toBeNull();
    expect(slashQuery("see /state")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });

  test("commands match by name prefix", () => {
    expect(matchCommands("").map((c) => c.name)).toEqual(PERSONA_COMMANDS.map((c) => c.name));
    expect(matchCommands("st").map((c) => c.name)).toEqual(["state"]);
    expect(matchCommands("zz")).toEqual([]);
  });

  test("every listed command has a renderer, and every renderer is listed", () => {
    expect(Object.keys(COMMAND_RENDERERS).sort()).toEqual(PERSONA_COMMANDS.map((c) => c.name).sort());
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

function mountComposer(withCommands = true) {
  const sent: string[] = [];
  const ran: string[] = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mounted = true;
  const element = createElement(PersonaComposer, {
    jobs: [],
    onTag: () => {},
    paused: false,
    placeholder: "Ask Persona…",
    onSend: (text: string) => sent.push(text),
    ...(withCommands ? { onCommand: (text: string) => ran.push(text) } : {}),
  });
  return { sent, ran, render: () => act(() => root.render(element)) };
}

function textarea(): HTMLTextAreaElement {
  return host.querySelector("textarea") as HTMLTextAreaElement;
}

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

function menu(): HTMLElement | null {
  return host.querySelector("[data-testid=slash-command-menu]");
}

describe("the composer's / menu", () => {
  test("typing / lists every command with its description", async () => {
    const c = mountComposer();
    await c.render();
    expect(menu()).toBeNull();
    await type("/");
    const options = [...menu()!.querySelectorAll("[role=option]")].map((o) => o.textContent);
    expect(options).toEqual(PERSONA_COMMANDS.map((cmd) => `/${cmd.name}${cmd.description}`));
  });

  test("Enter on the highlighted command runs it, not a message to Persona, and clears the draft", async () => {
    const c = mountComposer();
    await c.render();
    await type("/st");
    await key("Enter");
    expect(c.ran).toEqual(["/state"]);
    expect(c.sent).toEqual([]);
    expect(textarea().value).toBe("");
    expect(menu()).toBeNull();
  });

  test("Tab completes the command into the draft; Esc closes the menu", async () => {
    const c = mountComposer();
    await c.render();
    await type("/s");
    await key("Tab");
    expect(textarea().value).toBe("/state");
    expect(c.ran).toEqual([]);
    await key("Escape");
    expect(menu()).toBeNull();
    // With the menu closed, Enter still runs a known command.
    await key("Enter");
    expect(c.ran).toEqual(["/state"]);
    expect(c.sent).toEqual([]);
  });

  test("after Esc, editing the draft lets / open the menu again", async () => {
    const c = mountComposer();
    await c.render();
    await type("/");
    await key("Escape");
    expect(menu()).toBeNull();
    await type("");
    await type("/");
    expect(menu()).not.toBeNull();
  });

  test("Tab on a completed command moves focus on instead of being swallowed", async () => {
    const c = mountComposer();
    await c.render();
    await type("/state");
    let prevented = false;
    await act(() => {
      const ev = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      textarea().dispatchEvent(ev as unknown as Event);
      prevented = ev.defaultPrevented;
    });
    expect(prevented).toBe(false);
  });

  test("Send with the menu open runs the highlighted command", async () => {
    const c = mountComposer();
    await c.render();
    await type("/s");
    const send = [...host.querySelectorAll("button")].find((b) => b.textContent === "Send") as HTMLButtonElement;
    await act(() => send.click());
    expect(c.ran).toEqual(["/state"]);
    expect(c.sent).toEqual([]);
  });

  test("the textarea names the highlighted option for screen readers", async () => {
    const c = mountComposer();
    await c.render();
    await type("/");
    expect(textarea().getAttribute("aria-activedescendant")).toBe("slash-command-state");
    expect(host.querySelector("#slash-command-state")).not.toBeNull();
  });

  test("a click on a command runs it", async () => {
    const c = mountComposer();
    await c.render();
    await type("/");
    await act(() => {
      menu()!.querySelector("[role=option]")!.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }) as unknown as Event);
    });
    expect(c.ran).toEqual(["/state"]);
  });

  test("an unknown /word has no menu and is sent to Persona as text", async () => {
    const c = mountComposer();
    await c.render();
    await type("/deploy");
    expect(menu()).toBeNull();
    await key("Enter");
    expect(c.sent).toEqual(["/deploy"]);
    expect(c.ran).toEqual([]);
  });

  test("where commands don't run, there is no menu and /state is sent as text", async () => {
    const c = mountComposer(false);
    await c.render();
    await type("/");
    expect(menu()).toBeNull();
    await type("/state");
    await key("Enter");
    expect(c.sent).toEqual(["/state"]);
  });
});
