import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { DocDetail, DocTree } from "@standup/shared";
import { joinFrontmatter, splitFrontmatter } from "@standup/shared";
import { alpha, palettes, theme, type ThemeName } from "../theme";
import { useThemeName } from "../../hooks/useTheme";
import { lazyNamed } from "../../lib/lazyNamed";
import { subscribeDocsUpdates } from "../../lib/docsUpdates";
import { holdUnsavedDoc, type UnsavedDoc } from "../../lib/unsavedDocs";
import { ShareToggle } from "../share/ShareToggle";
import { getShare } from "../share/api";
import type { DocEditorHandle } from "./DocEditor";
import { DocComments, type DocCommentsSummary } from "./DocComments";
import { ShareLinkDisclosure, ShareableToggle } from "./ShareableToggle";
import { DocsRequestError, getDoc, imageFileName, imageUploadRefusal, updateDoc, writeImage } from "./api";
import { assetForSrc, folderPath, imageResolutionKey, relativeSrc } from "./docsTree";
import { minimalBody, prepareMinimalDiff } from "./minimalDiff";

/** The editor is a chunk of its own (Milkdown and everything under it); it loads when a doc first opens. */
const DocEditor = lazyNamed(() => import("./DocEditor"), "DocEditor");

/** How long typing pauses before the doc saves. */
export const AUTOSAVE_DELAY_MS = 800;
/** The longest an autosave waits between retries after a network or server failure. */
export const AUTOSAVE_MAX_BACKOFF_MS = 30_000;
/** Saves retried at once when a rename or move moved the revision on under one. */
const REVISION_RETRIES = 3;

/**
 * What the editor shows for an image that names no asset of the doc's: a
 * drawn placeholder, so an absolute or off-site src never loads (nothing an
 * image could report back to) and the markdown keeps the src as written.
 * An image can't read the theme's variables, so each palette has its own,
 * drawn in a gray that reads on that palette's grounds.
 */
export function missingImageSrc(name: ThemeName): string {
  const ink = MISSING_IMAGE_INK[name];
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="40" viewBox="0 0 160 40"><rect x="0.5" y="0.5" width="159" height="39" rx="4" fill="none" stroke="${ink}" stroke-dasharray="4 3"/><text x="80" y="24" font-family="sans-serif" font-size="12" fill="${ink}" text-anchor="middle">image not found</text></svg>`
  )}`;
}

const MISSING_IMAGE_INK: Readonly<Record<ThemeName, string>> = { dark: "#888", light: palettes.light.dim };

/** Every palette's placeholder, to find the ones on screen when the theme switches. */
const MISSING_IMAGE_SRCS: ReadonlySet<string> = new Set((Object.keys(MISSING_IMAGE_INK) as ThemeName[]).map(missingImageSrc));

type SaveStatus = { kind: "saved" } | { kind: "unsaved" } | { kind: "saving" } | { kind: "error"; message: string };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface DocPaneProps {
  docId: string;
  tree: DocTree;
  /** The newest revision of this doc known from the tree or a docs:changed frame. */
  remoteRevision: number;
  /** Something this pane did changed the tree (a rename, an uploaded image). */
  onTreeChanged: () => void;
}

const smallButton = {
  padding: "3px 10px",
  borderRadius: 5,
  border: `1px solid ${theme.edge}`,
  background: "transparent",
  color: theme.text,
  fontSize: 12,
  cursor: "pointer",
} as const;

/**
 * One open doc: its name (click to rename), save status, share switch and
 * editor. Markdown is the storage format: the frontmatter is split off before
 * the editor sees the body and put back verbatim on save, blocks an edit
 * didn't touch are saved as stored (see minimalDiff), and only a change
 * the person made saves (debounced, against the revision it was made on).
 * A newer revision saved elsewhere reloads in place when there is nothing
 * unsaved here, and otherwise asks which version to keep; so does a save
 * that loses the race to a body change (one that lost only to a rename or
 * move is saved again on the new revision). Whether anything is unsaved is
 * read from the editor's live document, not its debounced reports. Leaving
 * the doc saves what is pending, after any save still in flight; what can't
 * be saved then is held (lib/unsavedDocs) for the Docs tab to show.
 */
export function DocPane({ docId, tree, remoteRevision, onTreeChanged }: DocPaneProps) {
  const [doc, setDoc] = useState<DocDetail | null>(null);
  const [initial, setInitial] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>({ kind: "saved" });
  const [conflict, setConflict] = useState<DocDetail | null>(null);
  const [comments, setComments] = useState<DocCommentsSummary>({ total: 0, waiting: 0 });
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const mounted = useRef(true);
  const editor = useRef<DocEditorHandle | null>(null);
  /** Starts a comment on the editor's selection: the comment margin's, run from the editor toolbar's Comment item. */
  const startComment = useRef<(() => void) | null>(null);
  const bindStartComment = useCallback((start: (() => void) | null) => {
    startComment.current = start;
  }, []);
  /** The revision the editor's content was loaded from or last saved as. */
  const revision = useRef(0);
  /** The body the server holds at `revision`, as last read or saved. */
  const serverBody = useRef("");
  const frontmatter = useRef("");
  /** The editor's serialization of the content at `revision`; an edit is anything else. */
  const saved = useRef<string | null>(null);
  /** The editor's content as of its last report. */
  const current = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const conflictRef = useRef<DocDetail | null>(null);
  const checking = useRef(false);
  /** Set once the doc's first read has landed. */
  const opened = useRef(false);
  const remoteRef = useRef(remoteRevision);
  remoteRef.current = remoteRevision;
  const scroller = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef(tree);
  treeRef.current = tree;
  /** Set once this pane, closed, has handed its unsaved text over: it saves nothing more. */
  const handedOver = useRef(false);
  /** The doc's folder as last read from the server; the tree's listing of the doc takes precedence. */
  const folderId = useRef<string | null>(null);
  const name = useRef("");
  /** Images uploaded from this pane, by the src written for them, until the tree lists them. */
  const uploaded = useRef(new Map<string, string>());
  /** Set when the server refused a save (a 4xx): autosave waits for the next edit or Retry. */
  const refused = useRef<{ status: number; message: string } | null>(null);
  /** Network or server failures in a row, which space out autosave's retries. */
  const failures = useRef(0);
  /** Set when a save is asked for while one is in flight: it runs again once that one lands. */
  const again = useRef(false);

  /** The folder the doc is in now: where the tree lists it, else where it was last read. */
  const docFolder = (): string | null => {
    const listed = treeRef.current.docs.find((d) => d.id === docId);
    return listed ? listed.folderId : folderId.current;
  };

  /**
   * The editor's content as it stands: its live document once the person has
   * touched it (the debounced report may not have caught up), else its last
   * report.
   */
  const pending = (): string | null => {
    const handle = editor.current;
    if (handle?.touched()) {
      const live = handle.markdown();
      if (live !== null) current.current = live;
    }
    return current.current;
  };

  const dirty = () => {
    const markdown = pending();
    return markdown !== null && markdown !== saved.current;
  };

  const backoff = () => Math.min(AUTOSAVE_DELAY_MS * 2 ** failures.current, AUTOSAVE_MAX_BACKOFF_MS);

  const showConflict = (next: DocDetail | null) => {
    conflictRef.current = next;
    setConflict(next);
  };

  /**
   * The body to store for the editor content `markdown`: the frontmatter put
   * back, and every block the edit left alone written as the server holds it.
   */
  const bodyFor = (markdown: string) => {
    try {
      // `saved` is the editor's serialization of the server's body, which lets only the changed part be parsed.
      return minimalBody(serverBody.current, frontmatter.current, markdown, saved.current ?? undefined);
    } catch {
      return joinFrontmatter(frontmatter.current, markdown);
    }
  };

  /**
   * Hands the newest text this closed pane can no longer save to the unsaved
   * store, once: the editor's live text where it is still up, else its last report.
   */
  const leaveUnsaved = (reason: UnsavedDoc["reason"], why: string) => {
    if (handedOver.current) return;
    const markdown = pending();
    if (markdown === null) return;
    handedOver.current = true;
    holdUnsavedDoc({ docId, name: name.current || docId, text: bodyFor(markdown), reason, message: why });
  };

  /** Takes a doc read from the server as the pane's state; the editor's content is the caller's to set. */
  const adopt = (next: DocDetail) => {
    revision.current = next.revision;
    serverBody.current = next.body;
    frontmatter.current = splitFrontmatter(next.body).frontmatter;
    folderId.current = next.folderId;
    name.current = next.name;
    setDoc((prev) => ({ ...next, share: next.share ?? prev?.share }));
  };

  useEffect(() => {
    mounted.current = true;
    let live = true;
    getDoc(docId).then(
      (loaded) => {
        if (!live) return;
        adopt(loaded);
        opened.current = true;
        setInitial(splitFrontmatter(loaded.body).content);
      },
      (err: unknown) => live && setLoadError(message(err))
    );
    return () => {
      live = false;
      mounted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  /** One save of what the editor holds, unless it is already saved. */
  const attemptSave = async (): Promise<void> => {
    if (conflictRef.current || handedOver.current) return;
    const markdown = pending();
    if (markdown === null || markdown === saved.current) return;
    const body = bodyFor(markdown);
    if (mounted.current) setStatus({ kind: "saving" });
    try {
      let result = await updateDoc(docId, { body, baseRevision: revision.current });
      // A rename or move landing first moves the revision on and leaves the
      // body as this pane knew it: that is no conflict, so save on the new revision.
      for (let tries = 0; !result.ok && result.conflict.body === serverBody.current && tries < REVISION_RETRIES; tries++) {
        const theirs = result.conflict;
        revision.current = theirs.revision;
        folderId.current = theirs.folderId;
        name.current = theirs.name;
        if (mounted.current) setDoc((prev) => (prev ? { ...prev, name: theirs.name, folderId: theirs.folderId, revision: theirs.revision } : prev));
        result = await updateDoc(docId, { body, baseRevision: revision.current });
      }
      if (!result.ok) {
        if (mounted.current) {
          showConflict(result.conflict);
          setStatus({ kind: "unsaved" });
        } else leaveUnsaved("conflict", "It was changed in another tab or by an agent before your last edits saved.");
        return;
      }
      failures.current = 0;
      refused.current = null;
      revision.current = result.doc.revision;
      serverBody.current = result.doc.body ?? body;
      name.current = result.doc.name ?? name.current;
      saved.current = markdown;
      if (!mounted.current) return;
      // The share state is the share route's to report (see the docs:changed
      // subscription): a save answered late must not turn the switch back.
      setDoc((prev) => (prev ? { ...prev, ...result.doc, share: prev.share } : result.doc));
      setStatus(dirty() ? { kind: "unsaved" } : { kind: "saved" });
    } catch (err) {
      const status = err instanceof DocsRequestError ? err.status : 0;
      const text = status === 413 ? `the doc is too large (${message(err)})` : message(err);
      // A refusal (4xx) won't change by sending the same text again; a network or server failure may.
      if (status >= 400 && status < 500) refused.current = { status, message: text };
      else failures.current++;
      if (mounted.current) setStatus({ kind: "error", message: text });
      else leaveUnsaved(status === 404 ? "deleted" : "error", text);
    }
  };

  const save = useCallback(async (): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current) {
      // Runs again once the save in flight lands, with whatever is pending then.
      again.current = true;
      return inFlight.current;
    }
    if (conflictRef.current) return;
    const run = (async () => {
      do {
        again.current = false;
        await attemptSave();
      } while (again.current && !conflictRef.current && !refused.current);
    })();
    inFlight.current = run;
    try {
      await run;
    } finally {
      inFlight.current = null;
    }
    if (!mounted.current) return;
    // Typing during the save, or a newer revision announced meanwhile, is handled now.
    if (dirty() && !conflictRef.current && !refused.current) schedule(failures.current ? backoff() : AUTOSAVE_DELAY_MS);
    void checkRemote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  const schedule = (delay = AUTOSAVE_DELAY_MS) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void save();
    }, delay);
  };

  /** Follows a newer revision saved elsewhere: in place when nothing here is unsaved, else by asking. */
  const checkRemote = useCallback(async (): Promise<void> => {
    if (checking.current || inFlight.current || !opened.current) return;
    if (remoteRef.current <= revision.current) return;
    checking.current = true;
    try {
      const fresh = await getDoc(docId);
      if (!mounted.current || fresh.revision <= revision.current || inFlight.current) return;
      if (fresh.body === serverBody.current) {
        // A rename or move: the content is what this pane already holds.
        adopt(fresh);
        return;
      }
      if (dirty() || timer.current || conflictRef.current) {
        showConflict(fresh);
        return;
      }
      adopt(fresh);
      const { content } = splitFrontmatter(fresh.body);
      if (editor.current) editor.current.replace(content);
      else {
        setInitial(content);
        setEditorKey((k) => k + 1);
      }
    } catch {
      // The next frame, resync or catch-up tries again.
    } finally {
      checking.current = false;
    }
    // A revision announced while this read ran is followed too.
    if (mounted.current && remoteRef.current > revision.current && !conflictRef.current) void checkRemote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  useEffect(() => {
    void checkRemote();
  }, [remoteRevision, checkRemote]);

  // A share switched on or off elsewhere (another tab, a resync) shows here
  // too, and so does a folder holding the doc being shared or unshared, or
  // the doc landing in or leaving a shared folder (a change to the tree).
  useEffect(() => {
    let latest = 0;
    return subscribeDocsUpdates((change) => {
      if (change && !(change.share && (change.docId === docId || change.folderId)) && !change.tree) return;
      const id = ++latest;
      void getShare("doc", docId).then((share) => {
        if (!share || id !== latest || !mounted.current) return;
        setDoc((prev) => (prev ? { ...prev, share } : prev));
      });
      // A Shareable switch flipped elsewhere (this doc's, or a folder's above it) changes only the tree.
      if (!change || change.tree) {
        void getDoc(docId).then(
          (read) => {
            if (id !== latest || !mounted.current) return;
            setDoc((prev) => (prev ? { ...prev, shareable: read.shareable, shareableVia: read.shareableVia } : prev));
          },
          () => undefined
        );
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  // Leaving the doc (another doc, another tab) saves what is pending, after
  // any save in flight; closing the page with unsaved edits asks first.
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirty() && !inFlight.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      mounted.current = false;
      const markdown = pending();
      if (markdown === null || markdown === saved.current) return;
      if (conflictRef.current) leaveUnsaved("conflict", "It was changed in another tab or by an agent before your last edits saved.");
      else if (refused.current) leaveUnsaved(refused.current.status === 404 ? "deleted" : "error", refused.current.message);
      else void save();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save]);

  const onLoaded = (markdown: string) => {
    saved.current = markdown;
    current.current = markdown;
    if (!mounted.current) return;
    if (restoreScroll.current !== null && scroller.current) scroller.current.scrollTop = restoreScroll.current;
    restoreScroll.current = null;
    // The first save then parses only what it changed.
    const stored = splitFrontmatter(serverBody.current).content;
    setTimeout(() => saved.current === markdown && prepareMinimalDiff(stored, markdown), 0);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setStatus({ kind: "saved" });
  };

  const onEdit = (markdown: string) => {
    current.current = markdown;
    if (!mounted.current) {
      // The editor's last word as it closes, after this pane's own cleanup ran.
      if (markdown !== saved.current && !conflictRef.current && !refused.current) void save();
      return;
    }
    if (markdown === saved.current) {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (!inFlight.current) setStatus({ kind: "saved" });
      return;
    }
    // A new edit may be one the server accepts: autosave resumes after a refusal.
    refused.current = null;
    setStatus({ kind: "unsaved" });
    if (!conflictRef.current) schedule(failures.current ? backoff() : AUTOSAVE_DELAY_MS);
  };

  /** The tree the editor's images were last resolved against. */
  const treeSeen = useRef(tree);
  /** The scroll position to restore once a remounted editor has loaded. */
  const restoreScroll = useRef<number | null>(null);
  // The editor resolves an image's src only as it renders it, so an image
  // stored after the doc was rendered (by Persona, a worker or another tab)
  // would stay "not found". When the tree changes what one of the doc's own
  // images resolves to and nothing here is unsaved, the editor is mounted
  // again at the same scroll position (replacing its content with the same
  // markdown keeps the old image views).
  useEffect(() => {
    const previous = treeSeen.current;
    treeSeen.current = tree;
    if (previous === tree || !opened.current || !editor.current) return;
    const content = splitFrontmatter(serverBody.current).content;
    const folderIn = (t: DocTree) => t.docs.find((d) => d.id === docId)?.folderId ?? folderId.current;
    if (imageResolutionKey(previous, folderIn(previous), content) === imageResolutionKey(tree, folderIn(tree), content)) return;
    if (dirty() || timer.current || inFlight.current || conflictRef.current) return;
    restoreScroll.current = scroller.current?.scrollTop ?? null;
    setInitial(content);
    setEditorKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree]);

  const shownTheme = useThemeName();
  const themeName = useRef(shownTheme);
  themeName.current = shownTheme;
  // The editor keeps the src it resolved an image to, so placeholders already
  // drawn are swapped for the palette now showing.
  useEffect(() => {
    const src = missingImageSrc(shownTheme);
    for (const img of scroller.current?.querySelectorAll("img") ?? []) {
      const was = img.getAttribute("src");
      if (was !== src && was !== null && MISSING_IMAGE_SRCS.has(was)) img.setAttribute("src", src);
    }
  }, [shownTheme]);

  const resolveImage = (src: string): string => {
    // An image block with no src yet shows the editor's own upload prompt.
    if (src.trim() === "") return "";
    const local = uploaded.current.get(src);
    if (local) return local;
    const asset = assetForSrc(treeRef.current, docFolder(), src);
    return asset ? asset.url : missingImageSrc(themeName.current);
  };

  // Stores an image the person picked, pasted or dropped beside the doc, as
  // write_doc's images are, and returns the src the doc embeds it by. The
  // collector never replaces an image already there (another doc may embed
  // it): it picks a free name, and the src is the name it used.
  const uploadImage = async (file: File, first = true): Promise<string> => {
    if (first) setUploadError(null);
    // A refusal of a later file in one paste or drop is shown beside the earlier ones.
    const report = (refusal: string) => setUploadError((prev) => (!first && prev ? `${prev} ${refusal}` : refusal));
    const folder = docFolder();
    // A folder the tree doesn't list yet has no path to store the image under.
    const refusal =
      imageUploadRefusal(file) ??
      (folder && !treeRef.current.folders.some((f) => f.id === folder) ? "The doc's folder isn't loaded yet; try again in a moment." : null);
    if (refusal) {
      report(refusal);
      throw new Error(refusal);
    }
    try {
      const asset = await writeImage([...folderPath(treeRef.current, folder), imageFileName(file)], folder, file);
      const src = relativeSrc(asset.path.split("/").pop()!);
      uploaded.current.set(src, asset.url);
      onTreeChanged();
      return src;
    } catch (err) {
      // The doc's folder changed since the tree was read: the next try needs the tree read again.
      if (err instanceof DocsRequestError && err.status === 409) onTreeChanged();
      report(`Couldn't upload ${file.name ? `"${file.name}"` : "the image"}: ${message(err)}`);
      throw err;
    }
  };

  const retry = () => {
    refused.current = null;
    failures.current = 0;
    void save();
  };

  const reloadTheirs = () => {
    const theirs = conflictRef.current;
    if (!theirs) return;
    showConflict(null);
    adopt(theirs);
    const { content } = splitFrontmatter(theirs.body);
    if (editor.current) editor.current.replace(content);
    else {
      setInitial(content);
      setEditorKey((k) => k + 1);
    }
    // A revision newer than the one the banner offered, announced while it was up, is followed now.
    void checkRemote();
  };

  const keepMine = () => {
    const theirs = conflictRef.current;
    if (!theirs) return;
    showConflict(null);
    revision.current = theirs.revision;
    serverBody.current = theirs.body;
    // Mine is saved over theirs even where it matches what this pane last loaded,
    // frontmatter included: `frontmatter` stays the one this pane loaded, and
    // only the server's body (the base the save is written against) is theirs.
    saved.current = null;
    void save().finally(() => void checkRemote());
  };

  const commitRename = async () => {
    const wanted = nameDraft.trim();
    if (!doc || !wanted || wanted === doc.name) {
      setRenaming(false);
      return;
    }
    try {
      const result = await updateDoc(docId, { name: wanted });
      if (!result.ok) throw new Error("The doc changed meanwhile; try again");
      // A rename moves the revision on; the body (and any unsaved edit) is untouched.
      if (result.doc.body === serverBody.current) revision.current = result.doc.revision;
      name.current = result.doc.name;
      setDoc((prev) => (prev ? { ...prev, name: result.doc.name, revision: result.doc.revision } : prev));
      setRenaming(false);
      setNameError(null);
      onTreeChanged();
    } catch (err) {
      setNameError(message(err));
    }
  };

  if (loadError) {
    return (
      <div role="alert" style={{ padding: 24, color: theme.waiting, fontSize: 13 }}>
        Couldn't open this doc: {loadError}
      </div>
    );
  }
  if (!doc || initial === null) return <div style={{ padding: 24, color: theme.dim, fontSize: 13 }}>Loading…</div>;

  const statusText =
    status.kind === "saved" ? "Saved" : status.kind === "saving" ? "Saving…" : status.kind === "unsaved" ? "Unsaved" : `Couldn't save: ${status.message}`;
  const statusColor = status.kind === "error" ? theme.waiting : status.kind === "unsaved" ? theme.stalled : theme.faint;

  return (
    <div data-testid="doc-pane" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 20px", borderBottom: `1px solid ${theme.edgeSoft}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          {renaming ? (
            <input
              autoFocus
              data-testid="doc-name-input"
              aria-label="Doc name"
              value={nameDraft}
              onChange={(e) => {
                setNameDraft(e.target.value);
                setNameError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename();
                if (e.key === "Escape") {
                  setRenaming(false);
                  setNameError(null);
                }
              }}
              onBlur={() => !nameError && setRenaming(false)}
              style={{
                flex: "1 1 auto",
                minWidth: 0,
                padding: "3px 8px",
                borderRadius: 5,
                border: `1px solid ${nameError ? theme.waiting : theme.running}`,
                background: theme.ground,
                color: theme.text,
                fontSize: 17,
                fontWeight: 700,
              }}
            />
          ) : (
            <h1
              data-testid="doc-name"
              title="Click to rename"
              onClick={() => {
                setNameDraft(doc.name);
                setRenaming(true);
              }}
              style={{ margin: 0, fontSize: 17, fontWeight: 700, cursor: "text", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
            >
              {doc.name}
            </h1>
          )}
          {comments.waiting > 0 && (
            <span data-testid="doc-comments-waiting" style={{ marginLeft: "auto", fontSize: 12.5, color: theme.running, whiteSpace: "nowrap" }}>
              {comments.waiting} waiting for you
            </span>
          )}
          <span
            data-testid="doc-save-status"
            aria-live="polite"
            style={{ marginLeft: comments.waiting > 0 ? 0 : "auto", fontSize: 12, color: statusColor, whiteSpace: "nowrap" }}
          >
            {statusText}
          </span>
          {status.kind === "error" && (
            <button type="button" data-testid="doc-save-retry" onClick={retry} style={smallButton}>
              Retry
            </button>
          )}
        </div>
        {nameError && (
          <div role="alert" style={{ color: theme.waiting, fontSize: 12 }}>
            {nameError}
          </div>
        )}
        <ShareableToggle
          kind="doc"
          id={docId}
          shareable={!!doc.shareable}
          via={doc.shareableVia}
          onChanged={(on) => setDoc((prev) => (prev ? { ...prev, shareable: on || undefined } : prev))}
        />
        {doc.share && (
          <ShareLinkDisclosure testId="doc-share-link" live={doc.share.enabled || !!doc.share.viaFolder}>
            <ShareToggle resourceType="doc" resourceId={docId} share={doc.share} />
          </ShareLinkDisclosure>
        )}
      </header>
      {conflict && (
        <div
          role="alert"
          data-testid="doc-conflict"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            padding: "8px 20px",
            background: alpha(theme.stalled, 0x1a),
            borderBottom: `1px solid ${alpha(theme.stalled, 0x55)}`,
            fontSize: 12.5,
            color: theme.text,
          }}
        >
          <span>Changed in another tab or by an agent. Keep mine overwrites their version, including its frontmatter.</span>
          <button type="button" data-testid="doc-conflict-reload" onClick={reloadTheirs} style={smallButton}>
            Reload
          </button>
          <button type="button" data-testid="doc-conflict-keep" onClick={keepMine} style={{ ...smallButton, borderColor: alpha(theme.waiting, 0x88), color: theme.waiting }}>
            Keep mine (overwrite)
          </button>
        </div>
      )}
      {uploadError && (
        <div role="alert" style={{ padding: "6px 20px", color: theme.waiting, fontSize: 12.5 }}>
          {uploadError}
        </div>
      )}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div ref={scroller} data-testid="doc-scroll" style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
          <Suspense fallback={<div style={{ padding: 24, color: theme.dim, fontSize: 13 }}>Loading the editor…</div>}>
            <DocEditor
              key={editorKey}
              initialMarkdown={initial}
              resolveImage={resolveImage}
              uploadImage={uploadImage}
              onLoaded={onLoaded}
              onEdit={onEdit}
              onError={(m: string) => setLoadError(m)}
              bind={(handle: DocEditorHandle | null) => {
                editor.current = handle;
              }}
              onComment={() => startComment.current?.()}
            />
          </Suspense>
        </div>
        <DocComments
          docId={docId}
          root={scroller}
          role="owner"
          onSummary={setComments}
          bindStartComment={bindStartComment}
        />
      </div>
    </div>
  );
}
