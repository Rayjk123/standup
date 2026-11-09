import { afterEach, describe, expect, test } from "bun:test";
import { handleToolCall, tools } from "./tools.js";

/**
 * register_process and list_processes let a worker hand the long-lived
 * processes it starts to Standup, which stops them when its job closes. This
 * checks the tools are registered, what they post and read, and that a
 * refusal reads as an error naming why.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("register_process", () => {
  test("is registered with label required", () => {
    const tool = tools.find((t) => t.name === "register_process");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(["label"]);
    expect(tools.find((t) => t.name === "list_processes")).toBeDefined();
  });

  test("needs exactly one of pid or unit, without calling the collector", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    expect((await handleToolCall("register_process", { label: "x" }, "http://collector.test")).isError).toBe(true);
    expect((await handleToolCall("register_process", { label: "x", pid: 12, unit: "a.service" }, "http://collector.test")).isError).toBe(true);
    expect(called).toBe(false);
  });

  test("posts the pid, label, port and correlation fields, and confirms", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (u: string, init?: RequestInit) => {
      url = u;
      body = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({ process: { id: "p1", label: "vite", pid: 4242, pgid: 4242, port: 5200 } });
    }) as unknown as typeof fetch;
    const result = await handleToolCall("register_process", { pid: 4242, label: "vite", port: 5200 }, "http://collector.test");
    expect(url).toBe("http://collector.test/api/processes/register");
    expect(body).toMatchObject({ pid: 4242, label: "vite", port: 5200 });
    expect(body).toHaveProperty("cwd");
    expect(body).toHaveProperty("session_id");
    expect(body).not.toHaveProperty("unit");
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Registered vite: pid 4242 (and its process group), port 5200. It is stopped when your job closes.");
  });

  test("a refusal reads as an error with the collector's reason", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: "process 1 can't be registered: it is init" }, 400)) as unknown as typeof fetch;
    const result = await handleToolCall("register_process", { unit: "x.service", label: "x" }, "http://collector.test");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Process not registered: process 1 can't be registered: it is init");
  });

  test("an unprefixed unit's refusal passes the required prefix through", async () => {
    const reason = "unit must be named sw-3f2b8c1e-<name>.service or sw-3f2b8c1e-<name>.scope; start it with `systemd-run --user --unit=sw-3f2b8c1e-<name> …`";
    globalThis.fetch = (async () => jsonResponse({ error: reason }, 400)) as unknown as typeof fetch;
    const result = await handleToolCall("register_process", { unit: "my-dev.service", label: "dev" }, "http://collector.test");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("--unit=sw-3f2b8c1e-<name>");
  });

  test("its description tells a worker how to name a unit", () => {
    const tool = tools.find((t) => t.name === "register_process")!;
    expect(tool.description).toContain("systemd-run --user --unit=sw-<id8>-<name>");
    expect(tool.description).toContain("list_processes");
  });
});

describe("list_processes", () => {
  test("reads the calling worker's processes and its unit prefix", async () => {
    let url = "";
    globalThis.fetch = (async (u: string) => {
      url = u;
      return jsonResponse({
        processes: [{ label: "vite", pid: 4242, port: 5200, registeredAt: "2026-10-12 10:00:00" }, { label: "dev", unit: "sw-3f2b8c1e-dev.service", registeredAt: "2026-10-12 10:01:00" }],
        unitPrefix: "sw-3f2b8c1e-",
      });
    }) as unknown as typeof fetch;
    const text = (await handleToolCall("list_processes", {}, "http://collector.test")).content[0].text;
    expect(url).toBe("http://collector.test/api/processes");
    expect(text).toContain("- vite: pid 4242, port 5200 (registered 2026-10-12 10:00:00)");
    expect(text).toContain("- dev: unit sw-3f2b8c1e-dev.service (registered 2026-10-12 10:01:00)");
    expect(text).toContain("systemd-run --user --unit=sw-3f2b8c1e-<name>");
  });

  test("says so when nothing is registered, still naming the prefix for units and hand-opened tunnels", async () => {
    globalThis.fetch = (async () => jsonResponse({ processes: [], unitPrefix: "sw-3f2b8c1e-" })) as unknown as typeof fetch;
    expect((await handleToolCall("list_processes", {}, "http://collector.test")).content[0].text).toBe(
      "No registered processes are running.\nStart a systemd unit as `systemd-run --user --unit=sw-3f2b8c1e-<name> …` to register it." +
        "\nName a tunnel you open by hand `sw-3f2b8c1e-<name>`. Standup stops it when your job closes only if the " +
        "tunnel provider's list command reports its pid, local port and host; otherwise stop it yourself."
    );
  });

  test("without a prefix in the reply, just says nothing is registered", async () => {
    globalThis.fetch = (async () => jsonResponse({ processes: [] })) as unknown as typeof fetch;
    expect((await handleToolCall("list_processes", {}, "http://collector.test")).content[0].text).toBe("No registered processes are running.");
  });
});
