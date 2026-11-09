import { describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "http";
import { SHARE_RESOURCE_TYPES, sharePagePath } from "@standup/shared/share";
import { collectorShareCheck, sharePageMiddleware, sharePageRequest } from "./share-page";
import type { ShareTokenCheck } from "./share-page";

const TOKEN = "Ab-_".repeat(10) + "xyz";

interface Captured {
  status: number;
  headers: Record<string, string>;
  body?: string;
  passed: boolean;
}

async function run(url: string, check: ShareTokenCheck, method = "GET"): Promise<Captured> {
  const out: Captured = { status: 200, headers: {}, passed: false };
  await new Promise<void>((done) => {
    const res = {
      set statusCode(v: number) {
        out.status = v;
      },
      setHeader(name: string, value: string) {
        out.headers[name.toLowerCase()] = value;
      },
      end(body?: string) {
        out.body = body;
        done();
      },
    } as unknown as ServerResponse;
    sharePageMiddleware(check)({ url, method } as IncomingMessage, res, () => {
      out.passed = true;
      done();
    });
  });
  return out;
}

const always = (state: "live" | "missing" | "unknown"): ShareTokenCheck => async () => state;

describe("share page status", () => {
  for (const type of SHARE_RESOURCE_TYPES) {
    test(`a live ${type} token is handed to the app, uncached and with no referrer`, async () => {
      const r = await run(sharePagePath(type, TOKEN), always("live"));
      expect(r.passed).toBe(true);
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
    });

    test(`an unknown or revoked ${type} token is a 404 that names nothing`, async () => {
      const r = await run(sharePagePath(type, TOKEN), always("missing"));
      expect(r.passed).toBe(false);
      expect(r.status).toBe(404);
      expect(r.body).toContain("404");
      expect(r.body).not.toContain(TOKEN);
    });
  }

  test("the collector is asked about the token under the page's own type", async () => {
    const asked: string[] = [];
    const check: ShareTokenCheck = async (type, token) => {
      asked.push(`${type}:${token}`);
      return "live";
    };
    await run(`/share/review/${TOKEN}`, check);
    await run(`/share/doc/${TOKEN}`, check);
    expect(asked).toEqual([`review:${TOKEN}`, `doc:${TOKEN}`]);
  });

  test("a malformed token is a 404 without asking the collector", async () => {
    let asked = 0;
    const check: ShareTokenCheck = async () => {
      asked++;
      return "live";
    };
    for (const prefix of ["/share/review/", "/share/doc/"]) {
      for (const path of [prefix, `${prefix}short`, `${prefix}${TOKEN}/x`, `${prefix}${TOKEN}A`, `${prefix}..%2F..%2Fapi`]) {
        const r = await run(path, check);
        expect(r.status).toBe(404);
      }
    }
    expect(asked).toBe(0);
  });

  test("when the collector can't be asked the app is served and its own read decides", async () => {
    expect((await run(`/share/review/${TOKEN}`, always("unknown"))).passed).toBe(true);
    expect((await run(`/share/doc/${TOKEN}`, always("unknown"))).passed).toBe(true);
  });

  test("other paths fall through untouched", async () => {
    for (const path of ["/", "/review/abc", "/docs/abc", "/api/share/reviews/x", "/api/share/docs/x", "/share", "/share/reviews/x", "/share/docs/x"]) {
      const r = await run(path, always("missing"));
      expect(r.passed).toBe(true);
      expect(r.headers).toEqual({});
    }
  });

  test("a POST to a share page falls through", async () => {
    expect((await run(`/share/doc/${TOKEN}`, always("missing"), "POST")).passed).toBe(true);
  });

  test("sharePageRequest reads the type and token and ignores a query", () => {
    expect(sharePageRequest(`/share/review/${TOKEN}?x=1`)).toEqual({ type: "review", token: TOKEN });
    expect(sharePageRequest(`/share/doc/${TOKEN}#top`)).toEqual({ type: "doc", token: TOKEN });
    expect(sharePageRequest("/share/doc/nope")).toEqual({ type: "doc", token: null });
    expect(sharePageRequest(`/share/folder/${TOKEN}?doc=d1`)).toEqual({ type: "folder", token: TOKEN });
    expect(sharePageRequest(`/share/folder/${TOKEN}/../doc/${TOKEN}`)).toEqual({ type: "folder", token: null });
    expect(sharePageRequest("/review/x")).toBeUndefined();
  });

  test("collectorShareCheck maps the collector's answer at each type's share route", async () => {
    const urls: string[] = [];
    const as = (status: number) =>
      collectorShareCheck("http://127.0.0.1:1", (async (u: string) => {
        urls.push(u);
        return new Response(null, { status });
      }) as unknown as typeof fetch);
    expect(await as(200)("review", TOKEN)).toBe("live");
    expect(await as(404)("doc", TOKEN)).toBe("missing");
    expect(await as(500)("doc", TOKEN)).toBe("unknown");
    expect(urls[0]).toBe(`http://127.0.0.1:1/api/share/reviews/${TOKEN}`);
    expect(urls[1]).toBe(`http://127.0.0.1:1/api/share/docs/${TOKEN}`);
    const down = collectorShareCheck("http://127.0.0.1:1", (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    expect(await down("review", TOKEN)).toBe("unknown");
  });
});
