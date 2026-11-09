import { walkAndMatch, type WalkRequest } from "./code-search-walk.js";

/**
 * Worker entry for the JS search backend. Matches stream back one file at a
 * time, then a final "done" message; searchCode terminates this worker at the
 * search deadline whether or not "done" has arrived.
 */

declare const self: Worker;

self.onmessage = (event: MessageEvent<WalkRequest>) => {
  const outcome = walkAndMatch(event.data, (matches) => self.postMessage({ type: "matches", matches }));
  self.postMessage({ type: "done", ...outcome });
};
