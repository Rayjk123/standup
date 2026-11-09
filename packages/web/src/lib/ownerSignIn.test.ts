import { describe, expect, test } from "bun:test";
import { dismissOwnerSignIn, isOwnerTokenDenial, ownerSignInNeeded, setOwnerSignInViewer, watchOwnerDenials } from "./ownerSignIn";

describe("isOwnerTokenDenial", () => {
  const body = { error: "Only the owner can allow this: this request doesn't carry the owner token (x-standup-owner-token)." };

  test("recognises the collector's owner-token refusal", () => {
    expect(isOwnerTokenDenial(403, body)).toBe(true);
  });

  test("ignores other statuses and other 403s", () => {
    expect(isOwnerTokenDenial(401, body)).toBe(false);
    expect(isOwnerTokenDenial(403, { error: "Persona is single-user" })).toBe(false);
    expect(isOwnerTokenDenial(403, null)).toBe(false);
    expect(isOwnerTokenDenial(403, "x-standup-owner-token")).toBe(false);
  });

  test("an unauthenticated refusal is never an owner sign-in prompt", () => {
    expect(isOwnerTokenDenial(403, { ...body, reason: "unauthenticated" })).toBe(false);
    expect(isOwnerTokenDenial(403, { ...body, reason: "unauthenticated" }, true)).toBe(false);
    expect(isOwnerTokenDenial(403, { ...body, reason: "host-only" })).toBe(true);
  });

  test("a sign-in refusal prompts the host to sign in as the owner, never a guest", () => {
    const guestWording = { error: "To direct your Persona, sign in to the Standup console as alice", reason: "sign-in" };
    const hostWording = { ...body, reason: "sign-in" };
    expect(isOwnerTokenDenial(403, hostWording, true)).toBe(true);
    expect(isOwnerTokenDenial(403, guestWording, true)).toBe(true);
    expect(isOwnerTokenDenial(403, hostWording, false)).toBe(false);
    expect(isOwnerTokenDenial(403, guestWording, false)).toBe(false);
    // Viewer not known yet: the host's wording names the owner-token header.
    expect(isOwnerTokenDenial(403, hostWording)).toBe(true);
    expect(isOwnerTokenDenial(403, guestWording)).toBe(false);
  });
});

describe("watchOwnerDenials", () => {
  const signIn = { error: "To direct your Persona, sign in", reason: "sign-in" };

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("raises the notice on a host's sign-in refusal and not on a guest's", async () => {
    let host: boolean | undefined = false;
    const target = { fetch: async () => new Response(JSON.stringify(signIn), { status: 403 }) };
    const restore = watchOwnerDenials(target, () => host);
    try {
      dismissOwnerSignIn();
      await target.fetch();
      await settle();
      expect(ownerSignInNeeded()).toBe(false);
      host = true;
      await target.fetch();
      await settle();
      expect(ownerSignInNeeded()).toBe(true);
    } finally {
      restore();
      dismissOwnerSignIn();
    }
  });

  test("the recorded viewer is what the default watcher consults", async () => {
    const target = { fetch: async () => new Response(JSON.stringify(signIn), { status: 403 }) };
    const restore = watchOwnerDenials(target);
    try {
      dismissOwnerSignIn();
      setOwnerSignInViewer(false);
      await target.fetch();
      await settle();
      expect(ownerSignInNeeded()).toBe(false);
      setOwnerSignInViewer(true);
      await target.fetch();
      await settle();
      expect(ownerSignInNeeded()).toBe(true);
    } finally {
      restore();
      setOwnerSignInViewer(undefined);
      dismissOwnerSignIn();
    }
  });
});
