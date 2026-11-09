import { describe, expect, test } from "bun:test";
import type { DocsChangedPayload } from "@standup/shared";
import { publishDocsChanged, publishDocsResync, subscribeDocsUpdates } from "./docsUpdates";

describe("docs updates", () => {
  test("a published change reaches every subscriber; a resync arrives as null", () => {
    const a: (DocsChangedPayload | null)[] = [];
    const b: (DocsChangedPayload | null)[] = [];
    const offA = subscribeDocsUpdates((c) => a.push(c));
    const offB = subscribeDocsUpdates((c) => b.push(c));
    publishDocsChanged({ tree: false, docId: "d1", revision: 3 });
    publishDocsResync();
    expect(a).toEqual([{ tree: false, docId: "d1", revision: 3 }, null]);
    expect(b).toEqual(a);
    offA();
    offB();
  });

  test("an unsubscribed listener hears nothing more", () => {
    const heard: (DocsChangedPayload | null)[] = [];
    const off = subscribeDocsUpdates((c) => heard.push(c));
    off();
    publishDocsChanged({ tree: true });
    publishDocsResync();
    expect(heard).toEqual([]);
  });

  test("a listener that unsubscribes while being called doesn't stop the others", () => {
    const heard: string[] = [];
    const offFirst = subscribeDocsUpdates(() => {
      heard.push("first");
      offFirst();
    });
    const offSecond = subscribeDocsUpdates(() => heard.push("second"));
    publishDocsResync();
    publishDocsResync();
    expect(heard).toEqual(["first", "second", "second"]);
    offSecond();
  });
});
