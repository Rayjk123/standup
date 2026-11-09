import { expect, test, describe, afterEach } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  ensureInternalCwd,
  ensurePrivateDir,
  headlessSettingsDir,
  internalRoot,
  paneDeliveryDir,
  unsafeAncestor,
  writePrivateFileSync,
} from "./internal-cwd.js";

const MODULE_PATH = join(import.meta.dir, "internal-cwd.ts");

describe("internalRoot — STANDUP_INTERNAL_ROOT override", () => {
  test("defaults under the home directory", () => {
    expect(internalRoot({})).toBe(join(homedir(), ".local", "share", "standup", "internal"));
  });

  test("blank or whitespace-only override is ignored", () => {
    const fallback = internalRoot({});
    expect(internalRoot({ STANDUP_INTERNAL_ROOT: "" })).toBe(fallback);
    expect(internalRoot({ STANDUP_INTERNAL_ROOT: "   " })).toBe(fallback);
  });

  test("override is trimmed", () => {
    expect(internalRoot({ STANDUP_INTERNAL_ROOT: "  /tmp/standup-alt  " })).toBe("/tmp/standup-alt");
  });

  describe("module-level cwds honor the override", () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    test("derived cwds and isInternalCwd follow STANDUP_INTERNAL_ROOT", async () => {
      dir = mkdtempSync(join(tmpdir(), "standup-internal-root-"));
      const root = join(dir, "internal");
      const script = `
        const m = await import(${JSON.stringify(MODULE_PATH)});
        console.log(JSON.stringify({
          checkpoint: m.AUTO_CHECKPOINT_CWD,
          verify: m.DRAFT_VERIFY_CWD,
          insideVerify: m.isInternalCwd(m.DRAFT_VERIFY_CWD),
          insideNew: m.isInternalCwd(${JSON.stringify(join(root, "anything"))}),
          defaultRoot: m.isInternalCwd(${JSON.stringify(internalRoot({}))}),
        }));
      `;
      const proc = Bun.spawn(["bun", "-e", script], {
        env: { ...process.env, STANDUP_INTERNAL_ROOT: ` ${root} ` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      expect(proc.exitCode).toBe(0);
      expect(JSON.parse(out)).toEqual({
        checkpoint: root,
        verify: join(root, "verify"),
        insideVerify: true,
        insideNew: true,
        defaultRoot: false,
      });
    });
  });
});

describe("ensurePrivateDir", () => {
  let dir: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates a missing directory 0700", () => {
    dir = mkdtempSync(join(tmpdir(), "standup-private-"));
    const target = join(dir, "a", "persona");
    expect(ensurePrivateDir(target)).toBeNull();
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });

  test("tightens a directory we own that others can only read", () => {
    dir = mkdtempSync(join(tmpdir(), "standup-private-"));
    const target = join(dir, "persona");
    mkdirSync(target);
    chmodSync(target, 0o755);
    expect(ensurePrivateDir(target)).toBeNull();
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });

  test("a group-writable directory and parent we own (umask 002) are accepted and tightened to 0700", () => {
    dir = mkdtempSync(join(tmpdir(), "standup-private-"));
    const writable = join(dir, "writable");
    mkdirSync(writable);
    chmodSync(writable, 0o775);
    expect(ensurePrivateDir(writable)).toBeNull();
    expect(statSync(writable).mode & 0o777).toBe(0o700);

    const openParent = join(dir, "open");
    mkdirSync(openParent);
    chmodSync(openParent, 0o777);
    const target = join(openParent, "persona");
    expect(ensurePrivateDir(target)).toBeNull();
    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(statSync(openParent).mode & 0o777).toBe(0o700);
  });

  test("under umask 002 an existing internal root and a fresh one both yield private dirs", () => {
    dir = mkdtempSync(join(tmpdir(), "standup-private-"));
    const previous = process.umask(0o002);
    try {
      ensureInternalCwd(join(dir, "existing", "internal", "digest"));
      expect(statSync(join(dir, "existing", "internal")).mode & 0o777).toBe(0o700);
      chmodSync(join(dir, "existing", "internal"), 0o775);
      for (const sub of ["persona", "settings"]) {
        const target = join(dir, "existing", "internal", sub);
        expect(ensurePrivateDir(target)).toBeNull();
        expect(statSync(target).mode & 0o777).toBe(0o700);
      }
      expect(statSync(join(dir, "existing", "internal")).mode & 0o777).toBe(0o700);

      const fresh = join(dir, "fresh", "internal", "persona");
      expect(ensurePrivateDir(fresh)).toBeNull();
      expect(statSync(join(dir, "fresh", "internal")).mode & 0o777).toBe(0o700);
      expect(statSync(fresh).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previous);
    }
  });

  test("an ancestor owned by someone else that others can write to is refused, at any depth", () => {
    dir = mkdtempSync(join(tmpdir(), "standup-private-"));
    const shared = join(dir, "shared");
    const deep = join(shared, "a", "b", "persona");
    mkdirSync(deep, { recursive: true });
    chmodSync(shared, 0o777);
    // A uid that is not ours makes every directory we created read as foreign-owned.
    const foreign = (process.getuid?.() ?? 0) + 4242;
    expect(unsafeAncestor(deep, foreign)).toContain(`${shared} is owned by uid`);
    expect(unsafeAncestor(deep, foreign)).toContain("writable by group or others (mode 777)");
    // Sticky, like /tmp: others cannot rename our entries away.
    chmodSync(shared, 0o1777);
    expect(unsafeAncestor(deep, foreign)).toBeNull();
    // A foreign-owned symlink on the path could be repointed by its owner.
    chmodSync(shared, 0o755);
    const link = join(dir, "link");
    symlinkSync(shared, link);
    expect(unsafeAncestor(join(link, "a", "b", "persona"), foreign)).toContain(`${link} is a symlink owned by uid`);
    // As ourselves, the same tree is fine.
    expect(unsafeAncestor(join(link, "a", "b", "persona"), process.getuid?.() ?? 0)).toBeNull();
  });

  test("writePrivateFileSync replaces a planted symlink instead of following it, and writes 0600", () => {
    dir = mkdtempSync(join(tmpdir(), "standup-private-"));
    const victim = join(dir, "victim");
    writeFileSync(victim, "original");
    const path = join(dir, "config.json");
    symlinkSync(victim, path);
    const previous = process.umask(0o000);
    try {
      writePrivateFileSync(path, "secret");
    } finally {
      process.umask(previous);
    }
    expect(readFileSync(victim, "utf8")).toBe("original");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("secret");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("refuses a path that is not a directory", () => {
    dir = mkdtempSync(join(tmpdir(), "standup-private-"));
    const file = join(dir, "file");
    writeFileSync(file, "");
    expect(ensurePrivateDir(file)).not.toBeNull();
  });

  test("the forwarded-settings directory sits under the internal root", () => {
    dir = mkdtempSync(join(tmpdir(), "standup-private-"));
    expect(headlessSettingsDir({ STANDUP_INTERNAL_ROOT: dir })).toBe(join(dir, "settings"));
    expect(paneDeliveryDir({ STANDUP_INTERNAL_ROOT: dir })).toBe(join(dir, "pane-send"));
  });
});
