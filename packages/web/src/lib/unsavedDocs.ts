import { useSyncExternalStore } from "react";

/** A doc's text a closed doc pane couldn't save. */
export interface UnsavedDoc {
  docId: string;
  name: string;
  /** The whole body as it would have been saved, frontmatter included. */
  text: string;
  /** "deleted": the doc is gone; "conflict": it changed elsewhere first; "error": the save failed. */
  reason: "deleted" | "conflict" | "error";
  message: string;
}

/** An unsaved text as held here, with the id it is dismissed by. */
export interface HeldUnsavedDoc extends UnsavedDoc {
  id: number;
  /** Set when the doc went because the person deleted it from this console. */
  deletedHere: boolean;
}

/*
 * Unsaved doc texts live at module level, not in the Docs tab, so they
 * outlast the tab being left (its doc pane hands them over as it unmounts)
 * and show again when it is opened; the console's tab bar reads them too.
 * Every text is kept until it is dismissed: one never replaces another.
 */

let held: readonly HeldUnsavedDoc[] = [];
let nextId = 1;
const deletedHere = new Set<string>();
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of [...listeners]) listener();
};

/** Records that the person is deleting `docId` themselves (or, `false`, that the delete failed), so text it leaves unsaved says so. */
export function noteDeletedHere(docId: string, deleting: boolean): void {
  if (deleting) deletedHere.add(docId);
  else deletedHere.delete(docId);
}

export function holdUnsavedDoc(unsaved: UnsavedDoc): void {
  const own = unsaved.reason === "deleted" && deletedHere.has(unsaved.docId);
  held = [...held, { ...unsaved, id: nextId++, deletedHere: own }];
  emit();
}

export function dismissUnsavedDoc(id: number): void {
  held = held.filter((u) => u.id !== id);
  emit();
}

/** Forgets every held text (tests start from none). */
export function clearUnsavedDocs(): void {
  held = [];
  deletedHere.clear();
  emit();
}

export function unsavedDocs(): readonly HeldUnsavedDoc[] {
  return held;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The unsaved texts held now, re-rendering as they change. */
export function useUnsavedDocs(): readonly HeldUnsavedDoc[] {
  return useSyncExternalStore(subscribe, unsavedDocs, unsavedDocs);
}
