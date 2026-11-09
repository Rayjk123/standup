// Shared-file intake: Slack's file objects normalized, the metadata checks
// made before any download, and the downloader's guarantees — the bot token
// goes only to Slack hosts, redirects are bounded, the body is capped, and an
// HTML sign-in page reads as the missing files:read scope.

import { describe, expect, test } from "bun:test";
import {
  acceptedTypesText,
  byteCapFor,
  downloadSlackFile,
  inboundSlackFiles,
  isSlackFileUrl,
  needsFileInfo,
  precheckFile,
  SlackDownloadError,
  type InboundSlackFile,
} from "./persona-files.js";

const MB = 1024 * 1024;

describe("inboundSlackFiles", () => {
  test("normalizes Slack's snake_case file objects and drops anything without an id", () => {
    expect(
      inboundSlackFiles([
        {
          id: "F1",
          name: "a.png",
          mimetype: "image/png",
          filetype: "png",
          size: 12,
          url_private: "https://files.slack.com/files-pri/T-F1/a.png",
          url_private_download: "https://files.slack.com/files-pri/T-F1/download/a.png",
          mode: "hosted",
        },
        { id: "F2", file_access: "check_file_info" },
        { name: "no id" },
        "junk",
        null,
      ]),
    ).toEqual([
      {
        id: "F1",
        name: "a.png",
        mimetype: "image/png",
        filetype: "png",
        size: 12,
        urlPrivate: "https://files.slack.com/files-pri/T-F1/a.png",
        urlPrivateDownload: "https://files.slack.com/files-pri/T-F1/download/a.png",
        mode: "hosted",
      },
      { id: "F2", name: "F2", fileAccess: "check_file_info" },
    ]);
    expect(inboundSlackFiles(undefined)).toEqual([]);
  });

  test("a file with no URL, or one marked check_file_info, needs files.info", () => {
    expect(needsFileInfo({ id: "F", name: "F", fileAccess: "check_file_info", urlPrivate: "https://files.slack.com/x" })).toBe(true);
    expect(needsFileInfo({ id: "F", name: "F" })).toBe(true);
    expect(needsFileInfo({ id: "F", name: "F", urlPrivateDownload: "https://files.slack.com/x" })).toBe(false);
  });
});

describe("precheckFile", () => {
  const file = (f: Partial<InboundSlackFile>): InboundSlackFile => ({ id: "F", name: "f", ...f });
  const cases: [string, Partial<InboundSlackFile>, string | undefined][] = [
    ["a PNG", { mimetype: "image/png", size: 5 * MB }, undefined],
    ["an image at the cap", { mimetype: "image/webp", size: 10 * MB }, undefined],
    ["an image over the cap", { mimetype: "image/jpeg", size: 10 * MB + 1 }, "it's 10.0 MB; images can be at most 10 MB"],
    ["a video under its cap", { mimetype: "video/mp4", size: 49 * MB }, undefined],
    ["a video over its cap", { mimetype: "video/quicktime", size: 62 * MB }, "it's 62.0 MB; videos can be at most 50 MB"],
    ["HEIC", { mimetype: "image/heic", filetype: "heic" }, `HEIC isn't supported — send ${acceptedTypesText()}`],
    ["a type named only by its mime", { mimetype: "video/x-matroska" }, `MATROSKA isn't supported — send ${acceptedTypesText()}`],
    ["an unknown type is left to the collector", { size: 3 }, undefined],
    ["octet-stream is left to the collector", { mimetype: "application/octet-stream", filetype: "binary", size: 3 }, undefined],
    ["an unknown type over the video cap", { size: 51 * MB }, "it's 51.0 MB; videos can be at most 50 MB"],
    ["an empty file", { mimetype: "image/png", size: 0 }, "it's empty"],
    ["an external file", { mode: "external", mimetype: "image/png" }, "it's a link to a file stored outside Slack — attach the file itself"],
    ["a deleted file", { mode: "tombstone" }, "it was deleted from Slack"],
  ];
  for (const [what, f, want] of cases) {
    test(what, () => expect(precheckFile(file(f))).toBe(want));
  }

  test("the accepted list and the byte caps follow the shared contract", () => {
    expect(acceptedTypesText()).toBe("PNG, JPEG, GIF, WebP, MP4, MOV or WebM");
    expect(byteCapFor(file({ mimetype: "image/gif" }))).toBe(10 * MB);
    expect(byteCapFor(file({ mimetype: "video/webm" }))).toBe(50 * MB);
    expect(byteCapFor(file({}))).toBe(50 * MB);
  });
});

/** A recording fetch answering each URL from `routes`; unknown URLs throw. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const route = routes[String(url)];
    if (!route) throw new Error(`unexpected fetch ${String(url)}`);
    return route();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function auth(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.authorization;
}

/** A body that streams `chunks`, recording whether it was cancelled. */
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const state = { cancelled: false, pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[state.pulled++];
      if (next) controller.enqueue(next);
      else controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, { status: 200, headers: { "content-type": "image/png", ...headers } }), state };
}

async function failure(p: Promise<unknown>): Promise<SlackDownloadError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SlackDownloadError) return err;
    throw err;
  }
  throw new Error("expected the download to fail");
}

const FILE = "https://files.slack.com/files-pri/T1-F1/download/a.png";

describe("downloadSlackFile", () => {
  test("fetches a Slack file with the bot token and returns its bytes", async () => {
    const f = fakeFetch({ [FILE]: () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }) });
    expect(await downloadSlackFile(FILE, { token: "xoxb-1", maxBytes: 10 }, f.impl)).toEqual(new Uint8Array([1, 2, 3]));
    expect(f.calls).toHaveLength(1);
    expect(auth(f.calls[0]!.init)).toBe("Bearer xoxb-1");
    expect(f.calls[0]!.init?.redirect).toBe("manual");
  });

  const refusedUrls = [
    "http://files.slack.com/a.png",
    "https://files.slack.com.evil.test/a.png",
    "https://evilslack.com/a.png",
    "https://user:pw@files.slack.com/a.png",
    "not a url",
  ];
  for (const url of refusedUrls) {
    test(`refuses ${url} without a request`, async () => {
      const f = fakeFetch({});
      expect((await failure(downloadSlackFile(url, { token: "xoxb-1", maxBytes: 10 }, f.impl))).kind).toBe("refused");
      expect(f.calls).toHaveLength(0);
      expect(isSlackFileUrl(url)).toBe(false);
    });
  }

  test("follows a redirect within Slack, with the token", async () => {
    const f = fakeFetch({
      [FILE]: () => new Response(null, { status: 302, headers: { location: "https://files-edge.slack.com/x/a.png" } }),
      "https://files-edge.slack.com/x/a.png": () => new Response(new Uint8Array([7]), { headers: { "content-type": "image/png" } }),
    });
    expect(await downloadSlackFile(FILE, { token: "xoxb-1", maxBytes: 10 }, f.impl)).toEqual(new Uint8Array([7]));
    expect(f.calls.map((c) => [c.url, auth(c.init)])).toEqual([
      [FILE, "Bearer xoxb-1"],
      ["https://files-edge.slack.com/x/a.png", "Bearer xoxb-1"],
    ]);
  });

  test("a redirect off Slack is refused and the token never goes there", async () => {
    const f = fakeFetch({
      [FILE]: () => new Response(null, { status: 302, headers: { location: "https://cdn.example.com/a.png" } }),
    });
    const err = await failure(downloadSlackFile(FILE, { token: "xoxb-1", maxBytes: 10 }, f.impl));
    expect(err.kind).toBe("refused");
    expect(f.calls.map((c) => c.url)).toEqual([FILE]);
  });

  test("stops after three redirects", async () => {
    const hop = (n: number) => `https://files.slack.com/hop/${n}`;
    const f = fakeFetch(Object.fromEntries([0, 1, 2, 3, 4].map((n) => [hop(n), () => new Response(null, { status: 302, headers: { location: hop(n + 1) } })])));
    const err = await failure(downloadSlackFile(hop(0), { token: "t", maxBytes: 10 }, f.impl));
    expect(err.kind).toBe("failed");
    expect(f.calls).toHaveLength(4);
  });

  test("an HTML page (Slack's sign-in, for a token without files:read) is the scope failure", async () => {
    const f = fakeFetch({
      [FILE]: () => new Response(null, { status: 302, headers: { location: "https://acme.slack.com/?redir=%2Ffiles-pri" } }),
      "https://acme.slack.com/?redir=%2Ffiles-pri": () => new Response("<html>sign in</html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    expect((await failure(downloadSlackFile(FILE, { token: "t", maxBytes: 100 }, f.impl))).kind).toBe("scope");
  });

  test("HTML served straight from the file URL is the scope failure too", async () => {
    const f = fakeFetch({ [FILE]: () => new Response("<html></html>", { headers: { "content-type": "text/html" } }) });
    expect((await failure(downloadSlackFile(FILE, { token: "t", maxBytes: 100 }, f.impl))).kind).toBe("scope");
  });

  test("a file declared as HTML is refused before any fetch, so an HTML answer can only be Slack's page", () => {
    expect(precheckFile({ id: "F", name: "page.html", mimetype: "text/html", filetype: "html" })).toContain("HTML isn't supported");
  });

  test("the byte cap is enforced mid-stream: the body is cancelled once it passes the cap", async () => {
    const s = streamed([new Uint8Array(4), new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)]);
    const f = fakeFetch({ [FILE]: () => s.response });
    const err = await failure(downloadSlackFile(FILE, { token: "t", maxBytes: 10 }, f.impl));
    expect(err.kind).toBe("too_large");
    expect(s.state.cancelled).toBe(true);
    expect(s.state.pulled).toBeLessThan(5);
  });

  test("a declared length over the cap fails before the body is read", async () => {
    const s = streamed([new Uint8Array(4)], { "content-length": String(60 * MB) });
    const f = fakeFetch({ [FILE]: () => s.response });
    const err = await failure(downloadSlackFile(FILE, { token: "t", maxBytes: 50 * MB }, f.impl));
    expect(err.kind).toBe("too_large");
    expect(err.message).toBe("it's 60.0 MB, over the 50 MB limit");
  });

  test("a body exactly at the cap is accepted", async () => {
    const s = streamed([new Uint8Array(6), new Uint8Array(4)]);
    const f = fakeFetch({ [FILE]: () => s.response });
    expect((await downloadSlackFile(FILE, { token: "t", maxBytes: 10 }, f.impl)).length).toBe(10);
  });

  test("an HTTP error or a network failure is a plain failure", async () => {
    let f = fakeFetch({ [FILE]: () => new Response("gone", { status: 404 }) });
    let err = await failure(downloadSlackFile(FILE, { token: "t", maxBytes: 10 }, f.impl));
    expect([err.kind, err.message]).toEqual(["failed", "Slack answered HTTP 404"]);
    f = fakeFetch({});
    err = await failure(downloadSlackFile(FILE, { token: "t", maxBytes: 10 }, f.impl));
    expect(err.kind).toBe("failed");
  });
});
