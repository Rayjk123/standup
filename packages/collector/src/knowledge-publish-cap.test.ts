import { expect, test, describe } from "bun:test";
import { AUTO_PUBLISH_DAILY_CAP_PER_SESSION, AutoPublishCap } from "./knowledge-publish-cap.js";

describe("AutoPublishCap", () => {
  const day1 = new Date("2026-10-08T09:00:00Z");
  const day1Late = new Date("2026-10-08T23:59:00Z");
  const day2 = new Date("2026-10-09T00:01:00Z");

  test("is reached after the cap's worth of publishes by one session in one UTC day", () => {
    const cap = new AutoPublishCap();
    for (let i = 0; i < AUTO_PUBLISH_DAILY_CAP_PER_SESSION; i++) {
      expect(cap.reached("s1", day1)).toBe(false);
      cap.record("s1", day1);
    }
    expect(cap.reached("s1", day1Late)).toBe(true);
    expect(cap.reached("s2", day1)).toBe(false);
  });

  test("resets on the next UTC day", () => {
    const cap = new AutoPublishCap(2);
    cap.record("s1", day1);
    cap.record("s1", day1);
    expect(cap.reached("s1", day1)).toBe(true);
    expect(cap.reached("s1", day2)).toBe(false);
    cap.record("s1", day2);
    expect(cap.reached("s1", day2)).toBe(false);
  });

  test("the message names the cap and the review draft", () => {
    expect(new AutoPublishCap(3).message()).toContain("auto-published 3 knowledge docs today");
    expect(new AutoPublishCap(3).message()).toContain("review draft");
  });
});
