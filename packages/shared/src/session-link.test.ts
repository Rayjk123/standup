import { describe, it, expect } from "bun:test";
import {
  SHORT_SESSION_ID_LEN,
  shortSessionId,
  sessionSharePath,
  sessionShareUrl,
  resolveShortSessionId,
} from "./session-link.js";

const ID_A = "abcd1234-0000-4000-8000-0000000000a1";
const ID_B = "abcd1234-1111-4000-8000-0000000000b2"; // shares the 8-char prefix with ID_A
const ID_C = "ef567890-2222-4000-8000-0000000000c3";

describe("shortSessionId", () => {
  it("takes the leading prefix", () => {
    expect(shortSessionId(ID_A)).toBe("abcd1234");
    expect(shortSessionId(ID_A).length).toBe(SHORT_SESSION_ID_LEN);
  });
  it("is safe for ids shorter than the prefix", () => {
    expect(shortSessionId("abc")).toBe("abc");
  });
});

describe("sessionSharePath / sessionShareUrl", () => {
  it("builds the /s/<shortId> path", () => {
    expect(sessionSharePath(ID_C)).toBe("/s/ef567890");
  });
  it("joins onto a base url and trims a trailing slash", () => {
    expect(sessionShareUrl("http://localhost:5173", ID_C)).toBe(
      "http://localhost:5173/s/ef567890"
    );
    expect(sessionShareUrl("http://localhost:5173/", ID_C)).toBe(
      "http://localhost:5173/s/ef567890"
    );
  });
});

describe("resolveShortSessionId", () => {
  const ids = [ID_C, "12345678-3333-4000-8000-0000000000d4"];

  it("resolves a unique short prefix to the full id (round-trips the share path)", () => {
    const short = shortSessionId(ID_C);
    expect(resolveShortSessionId(short, ids)).toBe(ID_C);
  });

  it("resolves an exact full id", () => {
    expect(resolveShortSessionId(ID_C, ids)).toBe(ID_C);
  });

  it("prefers an exact full-id match over a prefix collision", () => {
    // ID_A is a full id AND a prefix of ID_B — exact id must win.
    expect(resolveShortSessionId(ID_A, [ID_A, ID_B])).toBe(ID_A);
  });

  it("is case-insensitive", () => {
    expect(resolveShortSessionId("EF567890", ids)).toBe(ID_C);
  });

  it("returns undefined for an ambiguous prefix", () => {
    // Both ID_A and ID_B start with the same 8-char prefix.
    expect(resolveShortSessionId("abcd1234", [ID_A, ID_B])).toBeUndefined();
  });

  it("returns undefined for no match or empty input", () => {
    expect(resolveShortSessionId("ffffffff", ids)).toBeUndefined();
    expect(resolveShortSessionId("", ids)).toBeUndefined();
    expect(resolveShortSessionId("  ", ids)).toBeUndefined();
  });
});
