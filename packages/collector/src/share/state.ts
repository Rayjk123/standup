import type { Database } from "bun:sqlite";
import type { ShareResourceType, ShareState } from "@standup/shared";
import { sharePagePath } from "@standup/shared";
import { docFolderPath, getDoc, getDocFolder, getLiveGrant, sharedDocFolderAbove } from "@standup/store";
import type { ShareGrant } from "@standup/store";

/** A grant as its owner sees it: the share page path while it is live. */
export function shareStateOfGrant(type: ShareResourceType, grant: ShareGrant | null): ShareState {
  return grant ? { enabled: true, path: sharePagePath(type, grant.token) } : { enabled: false, path: null };
}

/**
 * The path of the nearest shared folder holding the owner's doc (its own
 * folder or one above) or folder (one above it), or null.
 */
function sharedFolderPathAbove(db: Database, type: ShareResourceType, id: string, owner: string): string | null {
  if (type === "review") return null;
  const start = type === "doc" ? (getDoc(db, id, owner)?.folderId ?? null) : (getDocFolder(db, id, owner)?.parentId ?? null);
  const shared = sharedDocFolderAbove(db, start, owner);
  return shared ? (docFolderPath(db, shared.id, owner)?.join("/") ?? null) : null;
}

/** The owner's resource's share state. Only ever shown to the owner as a person, never to Persona. */
export function shareStateOf(db: Database, type: ShareResourceType, id: string, owner: string): ShareState {
  const state = shareStateOfGrant(type, getLiveGrant(db, type, id, owner));
  const viaFolder = sharedFolderPathAbove(db, type, id, owner);
  return viaFolder === null ? state : { ...state, viaFolder };
}
