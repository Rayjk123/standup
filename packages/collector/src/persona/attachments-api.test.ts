import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createStore,
  getOrCreatePersonaConsoleThread,
  getOrCreatePersonaThreadByRef,
  getPersonaAttachment,
  listPersonaMessages,
  stagedPersonaAttachments,
} from "@standup/store";
import type { PersonaAudience, PersonaMessage, WsMessage } from "@standup/shared";
import { DEFAULT_IDENTITY_HEADER, personaAttachmentPosterPath } from "@standup/shared";
import { FAKE_FFMPEG_JPEG, trackedMp4Bytes, webmBytes, writeFakeFfmpeg } from "../test-support/persona-media.js";
import { OWNER_TOKEN_HEADER, USER_CHANNEL_HEADER, userChannelToken } from "@standup/shared/owner-token";
import { createServer, resolveUserAlias } from "../server.js";
import { generateOwnerSecrets } from "../owner-secret.js";
import { attachmentsDir } from "./attachments.js";
import { resolvePersonaConfig } from "./config.js";
import { createBroadcastTap } from "./events.js";
import { PERSONA_TOKEN_HEADER } from "./routes.js";
import { PersonaRuntime } from "./runtime.js";
import { PersonaFleet } from "./fleet.js";
import type { TurnSlots } from "./fleet.js";

const OWNER = resolveUserAlias(undefined);
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);

function setUp() {
  const root = mkdtempSync(join(tmpdir(), "persona-attach-api-"));
  dirs.push(root);
  const dataDir = join(root, "data");
  const work = join(root, "work");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(work, { recursive: true });
  const store = createStore(":memory:");
  const frames: WsMessage[] = [];
  const tap = createBroadcastTap((frame) => frames.push(frame));
  const secrets = generateOwnerSecrets();
  const runtimeFor = (owner: string, shared?: { turnSlots: TurnSlots; host: string }) =>
    new PersonaRuntime({
      db: store.db,
      owner,
      host: shared?.host,
      turnSlots: shared?.turnSlots,
      config: resolvePersonaConfig({}),
      broadcast: tap.broadcast,
      dataDir,
      turnRunner: async () => ({ ok: true, text: "[silent]", sessionId: "sid" }),
      ownerToken: () => secrets.ownerToken,
    });
  const runtime = runtimeFor(OWNER);
  const fleet = new PersonaFleet({ db: store.db, host: OWNER, hostRuntime: runtime, create: runtimeFor });
  tap.subscribe(fleet.eventListener());
  const app = createServer(store, tap.broadcast, null, undefined, undefined, "", "", {}, undefined, undefined, undefined, undefined, {
    fleet,
    ownerSecrets: secrets,
  });

  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await app.request("/api/persona/tool", {
      method: "POST",
      headers: { "content-type": "application/json", [PERSONA_TOKEN_HEADER]: runtime.token },
      body: JSON.stringify({ name, arguments: args }),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { content: Array<{ text: string }>; isError?: boolean };
    const text = result.content.map((c) => c.text).join("");
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: !!result.isError, text, json };
  };

  /**
   * Runs one turn woken by an owner message in `threadId` (the console when
   * omitted): `body` makes its tool calls, and the turn ends with `reply`.
   */
  const turn = async (body: () => Promise<void>, reply = "Here it is.", threadId?: string) => {
    (runtime as unknown as { turnRunner: () => Promise<unknown> }).turnRunner = async () => {
      await body();
      return { ok: true, text: reply, sessionId: "sid-turn" };
    };
    runtime.receiveUserMessage({ text: "show me the screenshot", actor: OWNER, ...(threadId ? { threadId } : {}) });
    await runtime.drain();
  };

  const image = (name: string, bytes: Uint8Array = PNG) => {
    const path = join(work, name);
    writeFileSync(path, bytes);
    return path;
  };

  /** A GET as the owner's console (the owner token) unless `headers` say otherwise; `bare` drops the token. */
  const get = (path: string, headers: Record<string, string> = {}, bare = false) =>
    app.request(path, { headers: { ...(bare ? {} : { [OWNER_TOKEN_HEADER]: secrets.ownerToken }), ...headers } });

  const thread = (audience: PersonaAudience) =>
    getOrCreatePersonaThreadByRef(store.db, OWNER, "slack", audience === "private" ? "dm:D1" : `C-${audience}:1.0`, "t", audience);

  const lastPersona = (threadId = runtime.consoleThreadId()): PersonaMessage | undefined =>
    listPersonaMessages(store.db, threadId).filter((m) => m.role === "persona").pop();

  return { store, app, runtime, tool, turn, image, get, thread, lastPersona, dataDir, secrets, frames };
}

describe("attach_image", () => {
  test("is in Persona's catalog with a path argument", async () => {
    const h = setUp();
    const res = await h.app.request("/api/persona/tools", { headers: { [PERSONA_TOKEN_HEADER]: h.runtime.token } });
    const { tools } = (await res.json()) as { tools: Array<{ name: string; description: string; inputSchema: { required?: string[] } }> };
    const attach = tools.find((t) => t.name === "attach_image")!;
    expect(attach.inputSchema.required).toEqual(["path"]);
    expect(attach.description).toContain("PNG, JPEG, GIF or WebP");
  });

  test("an image attached in a turn rides on that turn's reply, in order, with its caption", async () => {
    const h = setUp();
    let first: Record<string, unknown> | undefined;
    await h.turn(async () => {
      first = (await h.tool("attach_image", { path: h.image("ui-order-history.png"), caption: "  Order\nhistory  "})).json;
      await h.tool("attach_image", { path: h.image("before.jpg", JPEG) });
    });
    expect(first).toMatchObject({ attachmentId: expect.any(String), mimeType: "image/png", bytes: PNG.length });
    const reply = h.lastPersona()!;
    expect(reply.text).toBe("Here it is.");
    expect(reply.attachments).toEqual([
      { id: first!.attachmentId as string, mimeType: "image/png", bytes: PNG.length, name: "ui-order-history.png", caption: "Order history" },
      { id: expect.any(String), mimeType: "image/jpeg", bytes: JPEG.length, name: "before.jpg" },
    ]);
    // The tool result never echoes the source path back.
    expect(JSON.stringify(first)).not.toContain("ui-order-history");
  });

  test("a reply that would be silent still posts, carrying just the images", async () => {
    const h = setUp();
    await h.turn(async () => {
      await h.tool("attach_image", { path: h.image("only.png") });
    }, "[silent]");
    const reply = h.lastPersona()!;
    expect(reply.text).toBe("");
    expect(reply.attachments).toHaveLength(1);
  });

  test("attaching the same image twice in a turn keeps one, and a reply holds at most four", async () => {
    const h = setUp();
    const results: Array<{ isError: boolean; text: string; json?: Record<string, unknown> }> = [];
    await h.turn(async () => {
      const path = h.image("same.png");
      results.push(await h.tool("attach_image", { path }));
      results.push(await h.tool("attach_image", { path }));
      for (let i = 0; i < 4; i++) {
        const bytes = new Uint8Array([...PNG, i]);
        results.push(await h.tool("attach_image", { path: h.image(`n${i}.png`, bytes) }));
      }
    });
    expect(results[1]!.json).toMatchObject({ deduped: true, attachmentId: results[0]!.json!.attachmentId });
    expect(results.slice(2, 5).every((r) => !r.isError)).toBe(true);
    expect(results[5]!.isError).toBe(true);
    expect(results[5]!.text).toMatch(/at most 4 images/);
    expect(h.lastPersona()!.attachments).toHaveLength(4);
  });

  test("validation failures come back as tool errors: type by content, size, denied locations", async () => {
    const h = setUp();
    const errors: string[] = [];
    await h.turn(async () => {
      for (const path of [
        h.image("fake.png", new TextEncoder().encode("not an image")),
        h.image("data.txt", PNG),
        "relative.png",
        join(h.dataDir, "..", "missing.png"),
        "/proc/self/environ.png",
        "~/.ssh/id_ed25519.png",
      ]) {
        const r = await h.tool("attach_image", { path });
        expect(r.isError).toBe(true);
        errors.push(r.text);
      }
      const big = new Uint8Array(10 * 1024 * 1024 + 1);
      big.set(PNG);
      const r = await h.tool("attach_image", { path: h.image("big.png", big) });
      expect(r.isError).toBe(true);
      errors.push(r.text);
    });
    expect(errors[0]).toMatch(/not a PNG, JPEG, GIF or WebP/);
    expect(errors[1]).toMatch(/only \.png/);
    expect(errors[2]).toMatch(/must be absolute/);
    expect(errors[3]).toMatch(/no such file/);
    expect(errors[4]).toMatch(/refused|no such file/);
    expect(errors[5]).toMatch(/refused|no such file/);
    expect(errors[6]).toMatch(/over 10\.0 MB/);
    expect(h.lastPersona()!.attachments).toBeUndefined();
  });

  test("works only inside a turn", async () => {
    const h = setUp();
    const r = await h.tool("attach_image", { path: h.image("x.png") });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/only while you are composing a reply/);
  });

  test("an image attached in a shared thread rides on that thread's reply, never the console's", async () => {
    const h = setUp();
    const shared = h.thread("shared");
    await h.turn(async () => {
      expect((await h.tool("attach_image", { path: h.image("team.png") })).isError).toBe(false);
    }, "For the channel.", shared.id);
    expect(h.lastPersona(shared.id)!.attachments).toHaveLength(1);
    expect(h.lastPersona()).toBeUndefined();
  });

  test("is refused in a thread with people outside the workspace", async () => {
    const h = setUp();
    const external = h.thread("external");
    let r: { isError: boolean; text: string } | undefined;
    await h.turn(async () => {
      r = await h.tool("attach_image", { path: h.image("ext.png") });
    }, "No images here.", external.id);
    expect(r!.isError).toBe(true);
    expect(r!.text).toMatch(/outside the owner's workspace/);
    expect(h.lastPersona(external.id)!.attachments).toBeUndefined();
  });

  test("a failed turn leaves its images staged, and its retry posts them once", async () => {
    const h = setUp();
    let calls = 0;
    (h.runtime as unknown as { turnRunner: () => Promise<unknown> }).turnRunner = async () => {
      calls++;
      await h.tool("attach_image", { path: h.image("retry.png") });
      return calls === 1 ? { ok: false, error: "boom" } : { ok: true, text: "Done.", sessionId: "s" };
    };
    h.runtime.receiveUserMessage({ text: "go", actor: OWNER });
    await h.runtime.drain();
    const consoleId = getOrCreatePersonaConsoleThread(h.store.db, OWNER).id;
    expect(h.lastPersona()).toBeUndefined();
    const { batch_key: batchKey } = h.store.db.query("SELECT batch_key FROM persona_attachments").get() as { batch_key: string };
    expect(stagedPersonaAttachments(h.store.db, consoleId, batchKey)).toHaveLength(1);
    // The retry is the same batch (same inbox items), so it reuses the staged row.
    h.store.db.run("UPDATE persona_inbox SET not_before = NULL");
    await h.runtime.drain();
    expect(calls).toBe(2);
    expect(h.lastPersona()!.attachments).toHaveLength(1);
    expect(h.store.db.query("SELECT COUNT(*) AS n FROM persona_attachments").get()).toEqual({ n: 1 });
    expect(stagedPersonaAttachments(h.store.db, consoleId, batchKey)).toEqual([]);
  });
});

describe("GET /api/persona/attachments/:id", () => {
  async function attached(h: ReturnType<typeof setUp>, bytes: Uint8Array = PNG, name = "served.png") {
    let id = "";
    await h.turn(async () => {
      id = (await h.tool("attach_image", { path: h.image(name, bytes) })).json!.attachmentId as string;
    });
    return id;
  }

  test("serves the stored copy by id, as an inert image", async () => {
    const h = setUp();
    const id = await attached(h);
    const res = await h.get(`/api/persona/attachments/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="served.png"; filename*=UTF-8''served.png`);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...PNG]);
  });

  test("serves the collector's copy even after the source file is gone or changed", async () => {
    const h = setUp();
    const id = await attached(h);
    writeFileSync(h.image("served.png", JPEG), JPEG);
    const res = await h.get(`/api/persona/attachments/${id}`);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...PNG]);
  });

  test("never serves by path: unknown ids, path-shaped ids and digests are 404", async () => {
    const h = setUp();
    await attached(h);
    const sha = h.store.db.query("SELECT sha256 FROM persona_attachments").get() as { sha256: string };
    for (const id of [
      "00000000-0000-4000-8000-000000000000",
      "..%2F..%2Fetc%2Fpasswd",
      encodeURIComponent("/tmp/served.png"),
      sha.sha256,
      `${sha.sha256}.png`,
    ]) {
      expect((await h.get(`/api/persona/attachments/${id}`)).status).toBe(404);
    }
    expect((await h.get("/api/persona/attachments/../../secrets/owner.token")).status).toBe(404);
  });

  test("a staged image no reply carries is not served", async () => {
    const h = setUp();
    let id = "";
    (h.runtime as unknown as { turnRunner: () => Promise<unknown> }).turnRunner = async () => {
      id = (await h.tool("attach_image", { path: h.image("staged.png") })).json!.attachmentId as string;
      return { ok: false, error: "boom" };
    };
    h.runtime.receiveUserMessage({ text: "go", actor: OWNER });
    await h.runtime.drain();
    expect(id).not.toBe("");
    expect((await h.get(`/api/persona/attachments/${id}`)).status).toBe(404);
  });

  test("only its owner may fetch, never with Persona's token", async () => {
    const h = setUp();
    const id = await attached(h);
    // Another user's own Persona has no such attachment.
    const mallory = {
      [DEFAULT_IDENTITY_HEADER]: "mallory-not-owner",
      [USER_CHANNEL_HEADER]: userChannelToken(h.secrets.ownerToken, "mallory-not-owner"),
    };
    expect((await h.get(`/api/persona/attachments/${id}`, mallory, true)).status).toBe(404);
    expect((await h.get(`/api/persona/attachments/${id}`, { [PERSONA_TOKEN_HEADER]: h.runtime.token })).status).toBe(403);
    expect((await h.get(`/api/persona/attachments/${id}`, { host: "evil.example" })).status).toBe(403);
    // The owner's loopback without the owner token proves nothing.
    expect((await h.get(`/api/persona/attachments/${id}`, {}, true)).status).toBe(403);
    expect((await h.get(`/api/persona/attachments/${id}`, { [OWNER_TOKEN_HEADER]: h.secrets.ownerToken })).status).toBe(200);
  });

  test("a stored copy that went missing is 410, not a fallback to anything else", async () => {
    const h = setUp();
    const id = await attached(h);
    rmSync(attachmentsDir(h.dataDir), { recursive: true, force: true });
    expect((await h.get(`/api/persona/attachments/${id}`)).status).toBe(410);
  });

  test("the thread's messages list carries the attachments for clients", async () => {
    const h = setUp();
    const id = await attached(h);
    const res = await h.get(`/api/persona/messages`);
    const body = (await res.json()) as { messages: PersonaMessage[] };
    const reply = body.messages.find((m) => m.role === "persona")!;
    expect(reply.attachments?.map((a) => a.id)).toEqual([id]);
    expect(JSON.stringify(body)).not.toContain(h.dataDir);
  });
});

describe("attach_video", () => {
  const H264 = trackedMp4Bytes({ codec: "avc1", audio: true });
  const originalFfmpeg = process.env.STANDUP_FFMPEG;
  /** Runs `body` with the tool's ffmpeg set to `path`, or to none when null. */
  async function withFfmpeg(path: string | null, body: () => Promise<void>) {
    process.env.STANDUP_FFMPEG = path ?? join(tmpdir(), "standup-no-such-ffmpeg", "ffmpeg");
    try {
      await body();
    } finally {
      if (originalFfmpeg === undefined) delete process.env.STANDUP_FFMPEG;
      else process.env.STANDUP_FFMPEG = originalFfmpeg;
    }
  }

  test("is in Persona's catalog with a path argument", async () => {
    const h = setUp();
    const res = await h.app.request("/api/persona/tools", { headers: { [PERSONA_TOKEN_HEADER]: h.runtime.token } });
    const { tools } = (await res.json()) as { tools: Array<{ name: string; description: string; inputSchema: { required?: string[] } }> };
    const attach = tools.find((t) => t.name === "attach_video")!;
    expect(attach.inputSchema.required).toEqual(["path"]);
    expect(attach.description).toContain("MP4 (H.264) or WebM");
    expect(attach.description).toContain("1 video per reply, beside up to 4 images");
  });

  test("a video rides on the turn's reply beside images, with a poster frame, and reaches live clients in the message frame", async () => {
    const h = setUp();
    let result: Record<string, unknown> | undefined;
    await withFfmpeg(writeFakeFfmpeg(join(h.dataDir, ".."), { duration: "00:00:12.50" }), async () => {
      await h.turn(async () => {
        await h.tool("attach_image", { path: h.image("before.png") });
        result = (await h.tool("attach_video", { path: h.image("order-flow.mp4", H264), caption: " The\norder flow "})).json;
        await h.tool("attach_image", { path: h.image("after.jpg", JPEG) });
      });
    });
    expect(result).toMatchObject({ attachmentId: expect.any(String), mimeType: "video/mp4", bytes: H264.length, durationSec: 12.5, poster: true });
    expect(JSON.stringify(result)).not.toContain("order-flow");
    const reply = h.lastPersona()!;
    expect(reply.attachments!.map((a) => a.mimeType)).toEqual(["image/png", "video/mp4", "image/jpeg"]);
    const video = reply.attachments![1]!;
    expect(video).toEqual({
      id: result!.attachmentId as string,
      mimeType: "video/mp4",
      bytes: H264.length,
      name: "order-flow.mp4",
      caption: "The order flow",
      video: { durationSec: 12.5, frames: 0, poster: true },
    });
    // The live frame clients render from carries the same attachment: no refresh needed.
    const live = h.frames.filter((f) => f.type === "persona:message").map((f) => f.payload as PersonaMessage);
    expect(live.find((m) => m.id === reply.id)?.attachments?.[1]).toEqual(video);

    const poster = await h.get(personaAttachmentPosterPath(video.id));
    expect(poster.status).toBe(200);
    expect(poster.headers.get("content-type")).toBe("image/jpeg");
    expect(poster.headers.get("x-content-type-options")).toBe("nosniff");
    expect(poster.headers.get("content-security-policy")).toContain("sandbox");
    expect([...new Uint8Array(await poster.arrayBuffer())]).toEqual([...FAKE_FFMPEG_JPEG]);

    const whole = await h.get(`/api/persona/attachments/${video.id}`);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect([...new Uint8Array(await whole.arrayBuffer())]).toEqual([...H264]);
    const part = await h.get(`/api/persona/attachments/${video.id}`, { range: "bytes=4-11" });
    expect(part.status).toBe(206);
    expect(new TextDecoder().decode(await part.arrayBuffer())).toBe("ftypisom");
  });

  test("without ffmpeg a WebM is attached with no poster, and the poster route is 404", async () => {
    const h = setUp();
    let id = "";
    await withFfmpeg(null, async () => {
      await h.turn(async () => {
        id = (await h.tool("attach_video", { path: h.image("cold-load.webm", webmBytes()) })).json!.attachmentId as string;
      });
    });
    expect(h.lastPersona()!.attachments).toEqual([
      { id, mimeType: "video/webm", bytes: webmBytes().length, name: "cold-load.webm", video: { frames: 0 } },
    ]);
    expect((await h.get(personaAttachmentPosterPath(id))).status).toBe(404);
    expect((await h.get(`/api/persona/attachments/${id}`)).status).toBe(200);
  });

  test("a reply carries one video; the same video again dedupes, and images still have their own four", async () => {
    const h = setUp();
    const results: Array<{ isError: boolean; text: string; json?: Record<string, unknown> }> = [];
    await withFfmpeg(null, async () => {
      await h.turn(async () => {
        const path = h.image("one.webm", webmBytes());
        results.push(await h.tool("attach_video", { path }));
        results.push(await h.tool("attach_video", { path }));
        results.push(await h.tool("attach_video", { path: h.image("two.mp4", H264) }));
        for (let i = 0; i < 4; i++) results.push(await h.tool("attach_image", { path: h.image(`n${i}.png`, new Uint8Array([...PNG, i])) }));
      });
    });
    expect(results[1]!.json).toMatchObject({ deduped: true, attachmentId: results[0]!.json!.attachmentId });
    expect(results[2]!.isError).toBe(true);
    expect(results[2]!.text).toMatch(/at most 1 video \(beside up to 4 images\)/);
    expect(results.slice(3).map((r) => r.isError)).toEqual([false, false, false, false]);
    const kinds = h.lastPersona()!.attachments!.map((a) => a.mimeType);
    expect(kinds).toEqual(["video/webm", "image/png", "image/png", "image/png", "image/png"]);
  });

  test("two videos attached at once can't both ride on the reply; the loser's files are removed", async () => {
    const h = setUp();
    const results: Array<{ isError: boolean; text: string; json?: Record<string, unknown> }> = [];
    const second = trackedMp4Bytes({ codec: "avc1", mdat: 128 });
    await withFfmpeg(writeFakeFfmpeg(join(h.dataDir, ".."), { delaySec: 0.3 }), async () => {
      await h.turn(async () => {
        results.push(
          ...(await Promise.all([
            h.tool("attach_video", { path: h.image("a.mp4", H264) }),
            h.tool("attach_video", { path: h.image("b.mp4", second) }),
          ]))
        );
      });
    });
    expect(results.map((r) => r.isError).sort()).toEqual([false, true]);
    expect(results.find((r) => r.isError)!.text).toMatch(/at most 1 video/);
    expect(h.lastPersona()!.attachments).toHaveLength(1);
    const kept = h.lastPersona()!.attachments![0]!;
    const loser = kept.name === "a.mp4" ? second : H264;
    const loserSha = new Bun.CryptoHasher("sha256").update(loser).digest("hex");
    expect(existsSync(join(attachmentsDir(h.dataDir), `${loserSha}.mp4`))).toBe(false);
  });

  test("a video whose turn ends while its poster is taken isn't staged, and leaves no file", async () => {
    const h = setUp();
    let pending: Promise<{ isError: boolean; text: string }> | undefined;
    await withFfmpeg(writeFakeFfmpeg(join(h.dataDir, ".."), { delaySec: 0.3 }), async () => {
      await h.turn(async () => {
        pending = h.tool("attach_video", { path: h.image("late.mp4", H264) });
      }, "Done.");
      const late = await pending!;
      expect(late).toMatchObject({ isError: true, text: expect.stringMatching(/turn ended before the video was ready/) });
    });
    expect(h.lastPersona()!.attachments).toBeUndefined();
    expect(h.store.db.query("SELECT COUNT(*) AS n FROM persona_attachments").get()).toEqual({ n: 0 });
    const sha = new Bun.CryptoHasher("sha256").update(H264).digest("hex");
    expect(existsSync(join(attachmentsDir(h.dataDir), `${sha}.mp4`))).toBe(false);
  });

  test("a video a failed turn staged and no reply ever claimed is removed, with its poster, a day later", async () => {
    const h = setUp();
    let staleId = "";
    await withFfmpeg(writeFakeFfmpeg(join(h.dataDir, "..")), async () => {
      (h.runtime as unknown as { turnRunner: () => Promise<unknown> }).turnRunner = async () => {
        staleId = (await h.tool("attach_video", { path: h.image("stale.mp4", H264) })).json!.attachmentId as string;
        return { ok: false, error: "boom" };
      };
      h.runtime.receiveUserMessage({ text: "go", actor: OWNER });
      await h.runtime.drain();
    });
    const stale = getPersonaAttachment(h.store.db, staleId)!;
    const files = [`${stale.sha256}.mp4`, `${stale.media!.poster!.sha256}.jpg`].map((f) => join(attachmentsDir(h.dataDir), f));
    expect(files.map((f) => existsSync(f))).toEqual([true, true]);
    h.store.db.run("UPDATE persona_attachments SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [staleId]);
    await withFfmpeg(null, async () => {
      await h.turn(async () => {
        expect((await h.tool("attach_video", { path: h.image("fresh.webm", webmBytes()) })).isError).toBe(false);
      });
    });
    expect(getPersonaAttachment(h.store.db, staleId)).toBeNull();
    expect(files.map((f) => existsSync(f))).toEqual([false, false]);
    expect(h.lastPersona()!.attachments!.map((a) => a.name)).toEqual(["fresh.webm"]);
  });

  test("validation failures come back as tool errors and attach nothing", async () => {
    const h = setUp();
    const cases: Array<{ label: string; path: () => string; want: RegExp }> = [
      { label: "text renamed .mp4", path: () => h.image("fake.mp4", new TextEncoder().encode("not a video at all")), want: /not an MP4 or WebM video \(checked by content\)/ },
      { label: "HEVC MP4", path: () => h.image("hevc.mp4", trackedMp4Bytes({ codec: "hvc1" })), want: /only H\.264 MP4s/ },
      { label: "relative path", path: () => "relative.mp4", want: /must be absolute/ },
      { label: "ssh dir", path: () => "~/.ssh/id_ed25519.mp4", want: /refused|no such file/ },
      { label: "proc", path: () => "/proc/self/environ.webm", want: /refused|no such file/ },
      { label: "Standup secrets", path: () => join(h.dataDir, "secrets", "owner.mp4"), want: /refused/ },
    ];
    const errors: Array<{ label: string; text: string }> = [];
    await withFfmpeg(null, async () => {
      await h.turn(async () => {
        for (const c of cases) {
          const r = await h.tool("attach_video", { path: c.path() });
          expect({ label: c.label, isError: r.isError }).toEqual({ label: c.label, isError: true });
          errors.push({ label: c.label, text: r.text });
        }
      });
    });
    expect(errors).toEqual(cases.map((c) => ({ label: c.label, text: expect.stringMatching(c.want) })));
    expect(h.lastPersona()!.attachments).toBeUndefined();
  });

  test("an oversize video is refused at the configured cap", async () => {
    const h = setUp();
    (h.runtime as unknown as { config: { attachVideoMaxBytes: number } }).config.attachVideoMaxBytes = 1024;
    const big = new Uint8Array(4096);
    big.set(H264);
    let r: { isError: boolean; text: string } | undefined;
    await withFfmpeg(null, async () => {
      await h.turn(async () => {
        r = await h.tool("attach_video", { path: h.image("big.mp4", big) });
      });
    });
    expect(r!.isError).toBe(true);
    expect(r!.text).toMatch(/big\.mp4 is 4 KB; videos over 1 KB can't be attached/);
  });

  test("a video ffmpeg can't decode is refused", async () => {
    const h = setUp();
    let r: { isError: boolean; text: string } | undefined;
    await withFfmpeg(writeFakeFfmpeg(join(h.dataDir, ".."), { frames: "fail" }), async () => {
      await h.turn(async () => {
        r = await h.tool("attach_video", { path: h.image("broken.mp4", H264) });
      });
    });
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining("broken.mp4 couldn't be decoded as a video") });
  });

  test("works only inside a turn, and is refused in a thread with people outside the workspace", async () => {
    const h = setUp();
    const outside = await h.tool("attach_video", { path: h.image("x.webm", webmBytes()) });
    expect(outside).toMatchObject({ isError: true, text: expect.stringMatching(/only while you are composing a reply/) });
    const external = h.thread("external");
    let r: { isError: boolean; text: string } | undefined;
    await h.turn(async () => {
      r = await h.tool("attach_video", { path: h.image("ext.webm", webmBytes()) });
    }, "No videos here.", external.id);
    expect(r).toMatchObject({ isError: true, text: expect.stringMatching(/outside the owner's workspace, so videos can't be attached/) });
    expect(h.lastPersona(external.id)!.attachments).toBeUndefined();
  });

  test("a video attached in a shared thread rides on that thread's reply only", async () => {
    const h = setUp();
    const shared = h.thread("shared");
    await withFfmpeg(null, async () => {
      await h.turn(async () => {
        expect((await h.tool("attach_video", { path: h.image("team.webm", webmBytes()) })).isError).toBe(false);
      }, "For the channel.", shared.id);
    });
    expect(h.lastPersona(shared.id)!.attachments).toHaveLength(1);
    expect(h.lastPersona()).toBeUndefined();
  });

  test("the poster route is gated like the video: unknown ids 404, Persona's token and other users refused", async () => {
    const h = setUp();
    let id = "";
    await withFfmpeg(writeFakeFfmpeg(join(h.dataDir, "..")), async () => {
      await h.turn(async () => {
        id = (await h.tool("attach_video", { path: h.image("gated.mp4", H264) })).json!.attachmentId as string;
      });
    });
    expect((await h.get(personaAttachmentPosterPath(id))).status).toBe(200);
    expect((await h.get(personaAttachmentPosterPath("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
    expect((await h.get(personaAttachmentPosterPath(id), { [PERSONA_TOKEN_HEADER]: h.runtime.token })).status).toBe(403);
    const mallory = {
      [DEFAULT_IDENTITY_HEADER]: "mallory-not-owner",
      [USER_CHANNEL_HEADER]: userChannelToken(h.secrets.ownerToken, "mallory-not-owner"),
    };
    expect((await h.get(personaAttachmentPosterPath(id), mallory, true)).status).toBe(404);
    rmSync(attachmentsDir(h.dataDir), { recursive: true, force: true });
    expect((await h.get(personaAttachmentPosterPath(id))).status).toBe(410);
  });
});
