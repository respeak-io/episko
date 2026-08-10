import { describe, it, expect } from "vitest";
import { checkoutDir, driftTarget, driftUpdate, gitMutates } from "../src/gitwatch";
import type { Drift } from "../src/types";

describe("gitMutates", () => {
  it("catches every ordinary way an agent moves HEAD", () => {
    // `checkout` and `switch` are the same case, whatever the user's habit.
    expect(gitMutates("git checkout main")).toBe(true);
    expect(gitMutates("git checkout -b feat/thing")).toBe(true);
    expect(gitMutates("git switch dev")).toBe(true);
    expect(gitMutates("git switch -c feat/thing")).toBe(true);
    expect(gitMutates("git rebase origin/main")).toBe(true);
    expect(gitMutates("git pull --rebase")).toBe(true);
    expect(gitMutates("git reset --hard HEAD~1")).toBe(true);
    expect(gitMutates("gh pr checkout 126")).toBe(true);
  });

  it("catches worktree creation and removal — the case nothing else can see", () => {
    expect(gitMutates("git worktree add ../feature-x -b feature-x")).toBe(true);
    expect(gitMutates("git worktree remove ../feature-x")).toBe(true);
    expect(gitMutates("git worktree prune")).toBe(true);
  });

  it("sees through the shapes a real command actually arrives in", () => {
    // Compound commands are the norm, so this can't be a prefix match.
    expect(gitMutates("cd sub && git switch dev")).toBe(true);
    expect(gitMutates("git worktree add ../x && cd ../x && pnpm install")).toBe(true);
    // Global flags sit between `git` and the verb.
    expect(gitMutates("git -C /Users/t/dev/some/deep/path checkout main")).toBe(true);
    expect(gitMutates("git --no-pager branch -a")).toBe(true);
    // Multi-line heredoc-ish blobs still match.
    expect(gitMutates("set -e\ngit fetch origin\ngit checkout main\n")).toBe(true);
  });

  it("ignores commands that touch no git state", () => {
    expect(gitMutates("ls -la")).toBe(false);
    expect(gitMutates("pnpm test")).toBe(false);
    expect(gitMutates("git status --porcelain")).toBe(false);
    expect(gitMutates("git log --oneline -5")).toBe(false);
    expect(gitMutates("git diff HEAD")).toBe(false);
    expect(gitMutates("cargo build")).toBe(false);
  });

  it("is not fooled by non-strings", () => {
    expect(gitMutates(undefined)).toBe(false);
    expect(gitMutates(null)).toBe(false);
    expect(gitMutates(42)).toBe(false);
    expect(gitMutates({ command: "git checkout main" })).toBe(false);
  });

  it("accepts the false positives it is designed to tolerate", () => {
    // `checkout -- <path>` restores a file and moves nothing. Matching it is fine and
    // deliberate: the re-read finds no change and renders nothing. This test exists so
    // that if someone later tightens the regex to exclude it, they do so knowingly —
    // the risk of a clever exclusion is missing a real `checkout` that looks like it.
    expect(gitMutates("git checkout -- src/main.ts")).toBe(true);
    // A word merely containing a verb must not trigger on its own, though.
    expect(gitMutates("./scripts/branchless-deploy.sh")).toBe(false);
    expect(gitMutates("echo 'nothing to see'")).toBe(false);
  });

  it("does not let the match run away into an unrelated later command", () => {
    // `git` early, a verb far later in a long unrelated pipeline: the bounded gap is
    // what stops this reading as a branch change.
    const far = "git status && " + "echo padding ".repeat(20) + "&& npm run reset";
    expect(gitMutates(far)).toBe(false);
  });
});

describe("driftTarget", () => {
  // The shape the roster reports, and the shape of the real case this was written for:
  // a session launched in exp-overview whose agent created ../overview and moved there.
  const WT = "/Users/t/w/cc-launcher-spike";
  const REPO = "/Users/t/repos/cc-launcher-spike";
  const roster = [
    { path: REPO, branch: "main", exists: true, is_main: true },
    { path: `${WT}/exp-overview`, branch: "exp/overview", exists: true, is_main: false },
    { path: `${WT}/overview`, branch: "feat/overview", exists: true, is_main: false },
    { path: `${WT}/gone`, branch: "dead/branch", exists: false, is_main: false },
  ];
  const launched = `${WT}/exp-overview`;

  it("names the checkout a write landed in when it isn't the session's own", () => {
    expect(driftTarget(launched, "Write", `${WT}/overview/src/usage.ts`, roster))
      .toEqual({ dir: `${WT}/overview`, branch: "feat/overview", via: "write" });
    expect(driftTarget(launched, "Edit", `${WT}/overview/src-tauri/src/usage.rs`, roster))
      .toEqual({ dir: `${WT}/overview`, branch: "feat/overview", via: "write" });
    // Drifting into the repo's own main checkout counts exactly the same.
    expect(driftTarget(launched, "Write", `${REPO}/README.md`, roster))
      .toEqual({ dir: REPO, branch: "main", via: "write" });
  });

  it("stays silent while the agent works where it was launched", () => {
    expect(driftTarget(launched, "Write", `${launched}/src/phase.ts`, roster)).toBeNull();
    expect(driftTarget(launched, "Edit", `${launched}/deep/nested/file.ts`, roster)).toBeNull();
  });

  it("only writes count — a read lands anywhere and would make this flap", () => {
    // Every one of these is an ordinary thing for an agent to do from exp-overview.
    expect(driftTarget(launched, "Read", `${WT}/overview/src/usage.ts`, roster)).toBeNull();
    expect(driftTarget(launched, "Bash", `${WT}/overview/src/usage.ts`, roster)).toBeNull();
    expect(driftTarget(launched, "Grep", `${WT}/overview/src/usage.ts`, roster)).toBeNull();
  });

  it("ignores writes outside the repo entirely", () => {
    // A scratch file, a global config, another project: none of these are a move, and
    // treating them as one would offer to relocate a live session into $TMPDIR.
    expect(driftTarget(launched, "Write", "/tmp/scratch/notes.md", roster)).toBeNull();
    expect(driftTarget(launched, "Write", "/Users/t/.claude/settings.json", roster)).toBeNull();
    expect(driftTarget(launched, "Write", "/Users/t/repos/other-project/src/a.ts", roster)).toBeNull();
  });

  it("ignores a checkout git still lists but that is gone from disk", () => {
    expect(driftTarget(launched, "Write", `${WT}/gone/src/a.ts`, roster)).toBeNull();
  });

  it("picks the innermost checkout when one worktree sits inside another", () => {
    // Claude Code's own worktrees live at `<repo>/.claude/worktrees/<name>`, so the repo
    // root also contains them and a longest-match is the only thing that names the right
    // branch. This is not hypothetical — it is where `EnterWorktree` puts them.
    const nested = [
      { path: "/r", branch: "main", exists: true, is_main: true },
      { path: "/r/.claude/worktrees/feature", branch: "feat/x", exists: true, is_main: false },
    ];
    expect(driftTarget("/r", "Write", "/r/.claude/worktrees/feature/a.ts", nested))
      .toEqual({ dir: "/r/.claude/worktrees/feature", branch: "feat/x", via: "write" });
    // …and from inside that worktree, writing back up into the repo is drift too.
    expect(driftTarget("/r/.claude/worktrees/feature", "Write", "/r/src/a.ts", nested))
      .toEqual({ dir: "/r", branch: "main", via: "write" });
  });

  it("does not mistake a sibling with a shared name prefix for a match", () => {
    // `/w/overview-old` starts with `/w/overview` as a *string*; only a path-boundary
    // test keeps them apart. The roster must include the session's own checkout, as a
    // real one from `worktree_heads` always does — without it there is no home to
    // compare against and the answer is (correctly) nothing at all.
    const sib = [
      { path: launched, branch: "exp/overview", exists: true, is_main: false },
      { path: `${WT}/overview`, branch: "feat/overview", exists: true, is_main: false },
      { path: `${WT}/overview-old`, branch: "old/overview", exists: true, is_main: false },
    ];
    expect(driftTarget(launched, "Write", `${WT}/overview-old/a.ts`, sib))
      .toEqual({ dir: `${WT}/overview-old`, branch: "old/overview", via: "write" });
    expect(driftTarget(launched, "Write", `${WT}/overview/a.ts`, sib))
      .toEqual({ dir: `${WT}/overview`, branch: "feat/overview", via: "write" });
  });

  // The regression guard for the review finding: the roster is resolved and normalised
  // in Rust, while `workdir` is however the user spelled the folder they picked. When
  // the two cannot be reconciled, the old code compared the target against `undefined`
  // and every write into the session's OWN checkout read as a move — permanently.
  it("says nothing at all when the session's own folder isn't in the roster", () => {
    const elsewhere = [
      { path: `${WT}/overview`, branch: "feat/overview", exists: true, is_main: false },
    ];
    expect(driftTarget("/some/symlinked/spelling", "Write", `${WT}/overview/a.ts`, elsewhere)).toBeNull();
    expect(driftUpdate(null, "/some/symlinked/spelling", "Write", `${WT}/overview/a.ts`, `${WT}/overview`, elsewhere)).toBeNull();
    // …and an unplaceable home must not retire a drift either, in the other direction.
    const held = { dir: `${WT}/overview`, branch: "feat/overview", via: "write" as const };
    expect(driftUpdate(held, "/some/symlinked/spelling", "Write", "/some/symlinked/spelling/a.ts", undefined, elsewhere))
      .toEqual(held);
  });

  it("compares paths case-insensitively, as norm_path and the filesystem both do", () => {
    // `worktree_heads` upper-cases a Windows drive letter; Claude Code may report it
    // lower-case. Left case-sensitive, the whole feature goes dark on Windows.
    const win = [
      { path: "C:/r/main", branch: "main", exists: true, is_main: true },
      { path: "C:/r/feat", branch: "feat/x", exists: true, is_main: false },
    ];
    expect(driftTarget("c:/r/main", "Write", "c:/r/feat/src/a.ts", win))
      .toEqual({ dir: "C:/r/feat", branch: "feat/x", via: "write" });
    expect(driftTarget("c:/r/main", "Write", "c:/R/MAIN/src/a.ts", win)).toBeNull();
  });

  it("treats a session launched in a subfolder of a checkout as being in it", () => {
    // Launching in `overview/src-tauri` and writing to `overview/src` is not a move.
    expect(driftTarget(`${WT}/overview/src-tauri`, "Write", `${WT}/overview/src/a.ts`, roster)).toBeNull();
  });

  it("handles Windows separators and a trailing slash on the roster path", () => {
    const win = [{ path: "C:\\r\\main\\", branch: "main", exists: true, is_main: true },
                 { path: "C:\\r\\feat", branch: "feat/x", exists: true, is_main: false }];
    expect(driftTarget("C:\\r\\main", "Edit", "C:\\r\\feat\\src\\a.ts", win))
      .toEqual({ dir: "C:\\r\\feat", branch: "feat/x", via: "write" });
    expect(driftTarget("C:\\r\\main", "Edit", "C:\\r\\main\\src\\a.ts", win)).toBeNull();
  });

  it("rejects a payload with no usable file_path", () => {
    expect(driftTarget(launched, "Write", undefined, roster)).toBeNull();
    expect(driftTarget(launched, "Write", "", roster)).toBeNull();
    expect(driftTarget(launched, "Write", "   ", roster)).toBeNull();
    expect(driftTarget(launched, "Write", 42, roster)).toBeNull();
    expect(driftTarget(launched, "Write", `${WT}/overview/a.ts`, [])).toBeNull();
  });

  describe("driftUpdate — two signals, one answer", () => {
    const moved = { dir: `${WT}/overview`, branch: "feat/overview", via: "write" as const };
    // Case 1: cwd is pinned to the launch dir for the whole life of the drift.
    const upd = (prev: Drift | null, tool: string, fp: unknown, cwd: unknown = launched) =>
      driftUpdate(prev, launched, tool, fp, cwd, roster);

    it("latches on the first write into another checkout", () => {
      expect(upd(null, "Write", `${WT}/overview/src/a.ts`)).toEqual(moved);
    });

    it("holds through everything that isn't a write home", () => {
      // This is the whole point of latching, and it is the common case: an agent that
      // moved to a new checkout goes on reading the one it came from, constantly.
      expect(upd(moved, "Read", `${launched}/src/phase.ts`)).toEqual(moved);
      expect(upd(moved, "Grep", `${launched}/src`)).toEqual(moved);
      expect(upd(moved, "Bash", undefined)).toEqual(moved);
      // A write to somewhere that is no checkout of this repo says nothing either way.
      expect(upd(moved, "Write", "/tmp/scratch/notes.md")).toEqual(moved);
      expect(upd(moved, "Write", undefined)).toEqual(moved);
    });

    it("clears only when the agent writes home again", () => {
      expect(upd(moved, "Write", `${launched}/src/phase.ts`)).toBeNull();
      expect(upd(moved, "Edit", `${launched}/deep/a.ts`)).toBeNull();
    });

    it("re-targets straight from one drifted checkout to another", () => {
      expect(upd(moved, "Write", `${REPO}/README.md`))
        .toEqual({ dir: REPO, branch: "main", via: "write" });
    });

    it("is a no-op on a session that never drifted", () => {
      expect(upd(null, "Read", `${WT}/overview/src/a.ts`)).toBeNull();
      expect(upd(null, "Write", `${launched}/src/a.ts`)).toBeNull();
      expect(upd(null, "Bash", undefined)).toBeNull();
    });

    // --- the cwd signal: Claude Code moving the session itself ---

    it("reads a moved cwd as drift with no write at all", () => {
      // The EnterWorktree case, exactly: three Bash calls, zero writes, and the only
      // thing that changed is the cwd riding along on every hook. The write signal is
      // blind here, which is why this half exists.
      expect(driftUpdate(null, launched, "Bash", undefined, `${WT}/overview`, roster))
        .toEqual({ dir: `${WT}/overview`, branch: "feat/overview", via: "cwd" });
      expect(driftUpdate(null, launched, "Bash", undefined, `${WT}/overview/src`, roster))
        .toEqual({ dir: `${WT}/overview`, branch: "feat/overview", via: "cwd" });
    });

    it("does not read a cd within the same checkout as a move", () => {
      // `cd src && …` moves the cwd and changes no checkout. Without resolving both
      // sides to a checkout first, every such call would read as a relocation.
      expect(driftUpdate(null, launched, "Bash", undefined, `${launched}/src`, roster)).toBeNull();
      expect(driftUpdate(null, launched, "Bash", undefined, launched, roster)).toBeNull();
    });

    it("lets cwd outrank a write, since it also moves the conversation", () => {
      // Both signals firing at once: cwd wins, and the `via` it carries is what tells
      // the repair that the transcript has already been re-homed by Claude.
      expect(driftUpdate(null, launched, "Write", `${REPO}/a.ts`, `${WT}/overview`, roster))
        .toEqual({ dir: `${WT}/overview`, branch: "feat/overview", via: "cwd" });
    });

    it("retires a cwd drift when cwd comes home", () => {
      const byCwd = { dir: `${WT}/overview`, branch: "feat/overview", via: "cwd" as const };
      expect(driftUpdate(byCwd, launched, "Bash", undefined, launched, roster)).toBeNull();
    });

    // The regression guard for the bug this whole feature exists to fix.
    it("NEVER lets a home cwd clear a write drift", () => {
      // In case 1 the cwd reads "home" on every single hook for the entire life of the
      // drift — Claude Code resets it. If that were allowed to clear the flag, the
      // feature would work for exactly one tool call and then delete its own answer.
      expect(upd(moved, "Bash", undefined, launched)).toEqual(moved);
      expect(upd(moved, "Read", `${WT}/overview/a.ts`, launched)).toEqual(moved);
      expect(upd(moved, "Read", `${launched}/a.ts`, `${launched}/src`)).toEqual(moved);
    });

    it("says nothing when cwd names no checkout of this repo", () => {
      // A session whose cwd is a scratch dir tells us nothing about checkouts, so it
      // must neither set a drift nor retire one.
      expect(driftUpdate(null, launched, "Bash", undefined, "/tmp/whatever", roster)).toBeNull();
      expect(driftUpdate(moved, launched, "Bash", undefined, "/tmp/whatever", roster)).toEqual(moved);
      const byCwd = { dir: `${WT}/overview`, branch: "feat/overview", via: "cwd" as const };
      expect(driftUpdate(byCwd, launched, "Bash", undefined, "/tmp/whatever", roster)).toEqual(byCwd);
      expect(driftUpdate(byCwd, launched, "Bash", undefined, undefined, roster)).toEqual(byCwd);
    });
  });
});

// The same resolution read as a grouping answer: which checkout does this *directory*
// belong to. ./grouping keys its worktree clusters on it, so a pane that starts below
// its checkout (a task's declared cwd, or a shell that inherited one) still lands in
// the row its branch is on.
describe("checkoutDir", () => {
  const REPO = "E:\\w\\epi";
  const WT = "E:\\w\\wt-feat";
  const roster = [
    { path: REPO, branch: "main", exists: true, is_main: true },
    { path: WT, branch: "feat", exists: true, is_main: false },
  ];

  it("resolves a subfolder to the checkout that contains it", () => {
    expect(checkoutDir(`${WT}/00_scripts/clone_db_locally`, roster)).toBe(WT);
    expect(checkoutDir(`${REPO}/src-tauri`, roster)).toBe(REPO);
  });

  it("keeps the caller's spelling for the checkout itself", () => {
    // Both sides name one directory; the roster's has been through norm_path in Rust
    // and the caller's has not. Handing back the roster's would break every comparison
    // the caller makes against its own paths.
    expect(checkoutDir(REPO, roster)).toBe(REPO);
    expect(checkoutDir("E:/w/epi", roster)).toBe("E:/w/epi");
    expect(checkoutDir(REPO + "\\", roster)).toBe(REPO + "\\");
  });

  it("returns a folder it cannot place untouched", () => {
    // No roster yet, a scratch dir, another project entirely: fail closed, exactly as
    // drift does — the alternative is a pane clustered under a repo it isn't in.
    expect(checkoutDir(`${WT}/x`, [])).toBe(`${WT}/x`);
    expect(checkoutDir("C:\\tmp\\scratch", roster)).toBe("C:\\tmp\\scratch");
  });

  it("prefers the innermost checkout when one nests inside another", () => {
    const inner = REPO + "\\wt\\inner";
    const nested = [...roster, { path: inner, branch: "inner", exists: true, is_main: false }];
    expect(checkoutDir(`${REPO}/wt/inner/src/main.ts`, nested)).toBe(inner);
  });

  it("ignores a registered checkout whose folder is gone", () => {
    const stale = [{ path: WT, branch: "feat", exists: false, is_main: false }];
    expect(checkoutDir(`${WT}/00_scripts`, stale)).toBe(`${WT}/00_scripts`);
  });
});
