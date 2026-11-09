import { readFileSync } from "fs";
import { join } from "path";
import { DEFAULT_ORG_PROFILE } from "../default.js";
import { mergeOrgProfile } from "../load.js";
import type { OrgProfile } from "../types.js";

/** The example.corp fixture profile's file, which exercises every profile field. */
export const EXAMPLE_CORP_PROFILE_PATH = join(import.meta.dir, "example-corp.json");

/** The example.corp fixture profile, merged over the default as loadOrgProfile merges a file. Throws when the fixture doesn't validate. */
export function exampleCorpProfile(): OrgProfile {
  const { profile, errors } = mergeOrgProfile(DEFAULT_ORG_PROFILE, JSON.parse(readFileSync(EXAMPLE_CORP_PROFILE_PATH, "utf8")));
  if (errors.length) throw new Error(`example-corp.json: ${errors.join("; ")}`);
  return profile;
}
