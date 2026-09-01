import { describe, it, expect } from "vitest";
import { checkoutDir, driftTarget, driftUpdate, gitMutates } from "../src/gitwatch";
import type { Drift } from "../src/types";

describe("gitMutates", () => {
  it("catches every ordinary way an agent moves HEAD", () => {
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
    expect(gitMutates("git -C /Users/t/dev/some/deep/path checkout main")).toBe(true);
    expect(gitMutates("git --no-pager branch -a")).toBe(true);
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
    // `checkout -- <path>` moves nothing; matching it anyway beats an exclusion that could miss a real one.
    expect(gitMutates("git checkout -- src/main.ts")).toBe(true);
    // a verb inside another word must not match
    expect(gitMutates("./scripts/branchless-deploy.sh")).toBe(false);
    expect(gitMutates("echo 'nothing to see'")).toBe(false);
  });

  it("does not let the match run away into an unrelated later command", () => {
    const far = "git status && " + "echo padding ".repeat(20) + "&& npm run reset";
    expect(gitMutates(far)).toBe(false);
  });
});

describe("driftTarget", () => {
  // The roster as worktree_heads reports it: launched in exp-overview, the agent moved to ../overview.
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
    expect(driftTarget(launched, "Write", { file_path: `${WT}/overview/src/usage.ts` }, null, roster))
      .toEqual({ dir: `${WT}/overview`, branch: "feat/overview", via: "write" });
    expect(driftTarget(launched, "Edit", { file_path: `${WT}/overview/src-tauri/src/usage.rs` }, null, roster))
      .toEqual({ dir: `${WT}/overview`, branch: "feat/overview", via: "write" });
    expect(driftTarget(launched, "Write", { file_path: `${REPO}/README.md` }, null, roster))
      .toEqual({ dir: REPO, branch: "main", via: "write" });
  });

  it("stays silent while the agent works where it was launched", () => {
    expect(driftTarget(launched, "Write", { file_path: `${launched}/src/phase.ts` }, null, roster)).toBeNull();
    expect(driftTarget(launched, "Edit", { file_path: `${launched}/deep/nested/file.ts` }, null, roster)).toBeNull();
  });

  it("only writes count — a read lands anywhere and would make this flap", () => {
    expect(driftTarget(launched, "Read", { file_path: `${WT}/overview/src/usage.ts` }, null, roster)).toBeNull();
    expect(driftTarget(launched, "Bash", { file_path: `${WT}/overview/src/usage.ts` }, null, roster)).toBeNull();
    expect(driftTarget(launched, "Grep", { file_path: `${WT}/overview/src/usage.ts` }, null, roster)).toBeNull();
  });

  it("ignores writes outside the repo entirely", () => {
    // a false positive here offers to relocate a live session into $TMPDIR
    expect(driftTarget(launched, "Write", { file_path: "/tmp/scratch/notes.md" }, null, roster)).toBeNull();
    expect(driftTarget(launched, "Write", { file_path: "/Users/t/.claude/settings.json" }, null, roster)).toBeNull();
    expect(driftTarget(launched, "Write", { file_path: "/Users/t/repos/other-project/src/a.ts" }, null, roster)).toBeNull();
  });

  it("ignores a checkout git still lists but that is gone from disk", () => {
    expect(driftTarget(launched, "Write", { file_path: `${WT}/gone/src/a.ts` }, null, roster)).toBeNull();
  });

  it("picks the innermost checkout when one worktree sits inside another", () => {
    // EnterWorktree puts worktrees at `<repo>/.claude/worktrees/<name>`, inside the root,
    // so only a longest match names the right branch.
    const nested = [
      { path: "/r", branch: "main", exists: true, is_main: true },
      { path: "/r/.claude/worktrees/feature", branch: "feat/x", exists: true, is_main: false },
    ];
    expect(driftTarget("/r", "Write", { file_path: "/r/.claude/worktrees/feature/a.ts" }, null, nested))
      .toEqual({ dir: "/r/.claude/worktrees/feature", branch: "feat/x", via: "write" });
    expect(driftTarget("/r/.claude/worktrees/feature", "Write", { file_path: "/r/src/a.ts" }, null, nested))
      .toEqual({ dir: "/r", branch: "main", via: "write" });
  });

  it("does not mistake a sibling with a shared name prefix for a match", () => {
    // The roster includes the session's own checkout, as a real one always does: with no
    // home to compare against, the answer is null.
    const sib = [
      { path: launched, branch: "exp/overview", exists: true, is_main: false },
      { path: `${WT}/overview`, branch: "feat/overview", exists: true, is_main: false },
      { path: `${WT}/overview-old`, branch: "old/overview", exists: true, is_main: false },
    ];
    expect(driftTarget(launched, "Write", { file_path: `${WT}/overview-old/a.ts` }, null, sib))
      .toEqual({ dir: `${WT}/overview-old`, branch: "old/overview", via: "write" });
    expect(driftTarget(launched, "Write", { file_path: `${WT}/overview/a.ts` }, null, sib))
      .toEqual({ dir: `${WT}/overview`, branch: "feat/overview", via: "write" });
  });

  // The roster is normalised in Rust and `workdir` is however the user spelled it; an
  // unplaceable home must answer nothing, never read every write as a move.
  it("says nothing at all when the session's own folder isn't in the roster", () => {
    const elsewhere = [
      { path: `${WT}/overview`, branch: "feat/overview", exists: true, is_main: false },
    ];
    expect(driftTarget("/some/symlinked/spelling", "Write", { file_path: `${WT}/overview/a.ts` }, null, elsewhere)).toBeNull();
    expect(driftUpdate(null, "/some/symlinked/spelling", "Write", { file_path: `${WT}/overview/a.ts` }, `${WT}/overview`, elsewhere)).toBeNull();
    // …and must not retire a drift either
    const held = { dir: `${WT}/overview`, branch: "feat/overview", via: "write" as const };
    expect(driftUpdate(held, "/some/symlinked/spelling", "Write", { file_path: "/some/symlinked/spelling/a.ts" }, undefined, elsewhere))
      .toEqual(held);
  });

  it("compares paths case-insensitively, as norm_path and the filesystem both do", () => {
    // worktree_heads upper-cases a Windows drive letter; Claude Code may report it lower-case
    const win = [
      { path: "C:/r/main", branch: "main", exists: true, is_main: true },
      { path: "C:/r/feat", branch: "feat/x", exists: true, is_main: false },
    ];
    expect(driftTarget("c:/r/main", "Write", { file_path: "c:/r/feat/src/a.ts" }, null, win))
      .toEqual({ dir: "C:/r/feat", branch: "feat/x", via: "write" });
    expect(driftTarget("c:/r/main", "Write", { file_path: "c:/R/MAIN/src/a.ts" }, null, win)).toBeNull();
  });

  it("treats a session launched in a subfolder of a checkout as being in it", () => {
    expect(driftTarget(`${WT}/overview/src-tauri`, "Write", { file_path: `${WT}/overview/src/a.ts` }, null, roster)).toBeNull();
  });

  it("handles Windows separators and a trailing slash on the roster path", () => {
    const win = [{ path: "C:\\r\\main\\", branch: "main", exists: true, is_main: true },
                 { path: "C:\\r\\feat", branch: "feat/x", exists: true, is_main: false }];
    expect(driftTarget("C:\\r\\main", "Edit", { file_path: "C:\\r\\feat\\src\\a.ts" }, null, win))
      .toEqual({ dir: "C:\\r\\feat", branch: "feat/x", via: "write" });
    expect(driftTarget("C:\\r\\main", "Edit", { file_path: "C:\\r\\main\\src\\a.ts" }, null, win)).toBeNull();
  });

  it("rejects a payload with no usable file_path", () => {
    expect(driftTarget(launched, "Write", { file_path: undefined }, null, roster)).toBeNull();
    expect(driftTarget(launched, "Write", { file_path: "" }, null, roster)).toBeNull();
    expect(driftTarget(launched, "Write", { file_path: "   " }, null, roster)).toBeNull();
    expect(driftTarget(launched, "Write", { file_path: 42 }, null, roster)).toBeNull();
    expect(driftTarget(launched, "Write", { file_path: `${WT}/overview/a.ts` }, null, [])).toBeNull();
    // no tool_input at all: what a hook for an argument-less tool sends
    expect(driftTarget(launched, "Write", undefined, null, roster)).toBeNull();
    expect(driftTarget(launched, "Write", "not an object", null, roster)).toBeNull();
  });

  // An agent told to prefer the shell writes with heredocs and `sed -i`, so WRITE_TOOLS never fires
  // and Claude Code keeps cwd pinned to the launch dir: both signals blind at once.
  describe("the Bash arm — an agent that calls no write tool at all", () => {
    const WROTE = `${WT}/overview`;
    const moved = { dir: WROTE, branch: "feat/overview", via: "write" as const };
    // cwd defaults to the launch dir, where Claude Code resets it on every hook
    const bash = (command: string, wd = launched, r = roster, cwd: unknown = wd) =>
      driftTarget(wd, "Bash", { command }, cwd, r);

    it("names the checkout a write-shaped command ran in", () => {
      expect(bash(`cd ${WROTE} && cat > src/toolio.ts <<'TSEOF'\nexport const x = 1;\nTSEOF`))
        .toEqual({ dir: WROTE, branch: "feat/overview", via: "write" });
      expect(bash(`cd ${WROTE} && python3 - <<'PY'\np="src/phase.ts"\ns=open(p).read()\nopen(p,"w").write(s)\nPY`))
        .toEqual({ dir: WROTE, branch: "feat/overview", via: "write" });
      expect(bash(`cd ${WROTE} && sed -i '' 's/a/b/' src/a.ts`))
        .toEqual({ dir: WROTE, branch: "feat/overview", via: "write" });
      expect(bash(`cd ${WROTE} && printf 'x\\n' >> notes/log.txt`))
        .toEqual({ dir: WROTE, branch: "feat/overview", via: "write" });
      // Quoted, because a checkout path can contain a space.
      expect(bash(`cd "${WROTE}" && cat > src/a.ts <<'E'\nE`))
        .toEqual({ dir: WROTE, branch: "feat/overview", via: "write" });
    });

    it("resolves a relative cd against the cwd the hook carried", () => {
      expect(bash(`cd ../overview && cat > src/tour.ts <<'TOUREOF'\nexport const x = 1;\nTOUREOF`))
        .toEqual(moved);
      expect(bash(`cd ../overview && python3 - <<'PY'\np="src/x.ts"\nopen(p,"w").write(s)\nPY`))
        .toEqual(moved);
      expect(bash(`cd ../overview && cat >> src/styles.css <<'CSSEOF'\n.a{}\nCSSEOF`))
        .toEqual(moved);
      expect(bash(`cd ../../../repos/cc-launcher-spike && cat > README.md <<'E'\nE`))
        .toEqual({ dir: REPO, branch: "main", via: "write" });
      // two spellings of one directory still satisfy the "exactly one" rule…
      expect(bash(`cd ../overview && cat > a.ts <<'E'\nE\ncd ${WT}/overview && cat > b.ts <<'E'\nE`))
        .toEqual(moved);
      // …and two directories still decline
      expect(bash(`cd ../overview && cat > a.ts <<'E'\nE\ncd ${REPO} && cat > b.ts <<'E'\nE`))
        .toBeNull();
    });

    it("declines a relative cd on a payload that carried no cwd", () => {
      // an unplaceable target may be a second directory, which declines for the same reason
      expect(bash(`cd ../overview && cat > a.ts <<'E'\nE`, launched, roster, null)).toBeNull();
      expect(bash(`cd ../overview && cat > a.ts <<'E'\nE`, launched, roster, 42)).toBeNull();
      expect(bash(`cd ${WT}/overview && cat > a.ts <<'E'\nE`, launched, roster, null))
        .toEqual(moved);
    });

    it("stays silent when the command only read", () => {
      // an agent reads everywhere; a drift set by a read would offer to relocate a live session
      expect(bash(`cd ${WROTE} && sed -n '1,80p' src/files.ts`)).toBeNull();
      expect(bash(`cd ${WROTE} && cat src/a.ts`)).toBeNull();
      expect(bash(`cd ${WROTE} && grep -rn "toolUseId" src/`)).toBeNull();
      expect(bash(`cd ${WROTE} && git log --oneline -3`)).toBeNull();
      expect(bash(`cd ${WROTE} && pnpm exec tsc --noEmit`)).toBeNull();
    });

    it("does not mistake shell punctuation or heredoc code for a redirect", () => {
      expect(bash(`cd ${WROTE} && pnpm install 2>&1 | tail -5`)).toBeNull();
      expect(bash(`cd ${WROTE} && ls src/ >/dev/null`)).toBeNull();
      expect(bash(`cd ${WROTE} && grep -n "const k = (a: Act): string => a.id" src/x.ts`))
        .toBeNull();
      // a `>` inside quoted code: the redirect target must look like a path
      expect(bash(`cd ${WROTE} && grep -n "if (s.activity.length > 12)" src/phase.ts`))
        .toBeNull();
    });

    it("declines when the command names more than one directory", () => {
      // fail closed: the second cd may be a real one…
      expect(bash(`cd ${WROTE} && cat > a/b.ts <<'E'\nE\ncd ${REPO} && cat > c/d.ts <<'E'\nE`))
        .toBeNull();
      // …or a line of the shell script being written
      expect(bash(`cd ${WROTE} && cat > setup.sh <<'E'\ncd ${REPO}\nE`)).toBeNull();
    });

    it("needs a cd it can actually place", () => {
      // a cd that stays inside the checkout lands on home
      expect(bash(`cd src && cat > a.ts <<'E'\nE`)).toBeNull();
      expect(bash(`cd ./src/x && cat > a.ts <<'E'\nE`)).toBeNull();
      // Only a shell could expand these, so they land on a path no checkout contains.
      expect(bash(`cd ~/w/overview && cat > a.ts <<'E'\nE`)).toBeNull();
      expect(bash(`cd $WT/overview && cat > a.ts <<'E'\nE`)).toBeNull();
      // no cd: the write went to the pinned cwd, i.e. home
      expect(bash(`cat > src/a.ts <<'E'\nE`)).toBeNull();
      expect(bash(`cd /tmp/scratch && cat > notes.md <<'E'\nE`)).toBeNull();
      expect(bash(`cd ${WT}/gone && cat > a.ts <<'E'\nE`)).toBeNull();   // registered, off disk
      expect(bash(`cd ${WROTE} && cat > a.ts <<'E'\nE`, launched, [])).toBeNull();
    });

    it("is not extended to any other tool, and reads no other field", () => {
      expect(driftTarget(launched, "Read", { command: `cd ${WROTE} && cat > a.ts <<'E'\nE` }, null, roster))
        .toBeNull();
      expect(driftTarget(launched, "Bash", { file_path: `${WROTE}/src/a.ts` }, null, roster)).toBeNull();
      expect(driftTarget(launched, "Bash", { command: 42 }, null, roster)).toBeNull();
      expect(driftTarget(launched, "Bash", undefined, null, roster)).toBeNull();
      expect(driftTarget(launched, "Bash", null, null, roster)).toBeNull();
    });

    it("works on Windows spellings too", () => {
      const win = [
        { path: "C:/r/main", branch: "main", exists: true, is_main: true },
        { path: "C:/r/feat", branch: "feat/x", exists: true, is_main: false },
      ];
      expect(bash("cd C:\\r\\feat && cat > src/a.ts <<'E'\nE", "c:/r/main", win))
        .toEqual({ dir: "C:/r/feat", branch: "feat/x", via: "write" });
      expect(bash("cd C:/r/main && cat > src/a.ts <<'E'\nE", "c:/r/main", win)).toBeNull();
      expect(bash("cd ..\\feat && cat > src/a.ts <<'E'\nE", "c:/r/main", win, "C:\\r\\main"))
        .toEqual({ dir: "C:/r/feat", branch: "feat/x", via: "write" });
    });

    it("sets and retires a drift by the same evidence it set it with", () => {
      const cmd = (dir: string) => ({ command: `cd ${dir} && cat > src/a.ts <<'E'\nE` });
      const upd = (prev: Drift | null, input: unknown) =>
        driftUpdate(prev, launched, "Bash", input, launched, roster);
      expect(upd(null, cmd(WROTE))).toEqual(moved);
      expect(upd(moved, { command: `cd ${launched} && grep -rn x src/` })).toEqual(moved);
      expect(upd(moved, { command: `cd ${launched} && pnpm test 2>&1 | tail -3` })).toEqual(moved);
      // a write home retires it; an arm that sets but never clears would strand a stale card
      expect(upd(moved, cmd(launched))).toBeNull();
    });
  });

  describe("driftUpdate — two signals, one answer", () => {
    const moved = { dir: `${WT}/overview`, branch: "feat/overview", via: "write" as const };
    // Claude Code resets cwd to the launch dir on every hook, so it stays pinned for the drift's whole life.
    const upd = (prev: Drift | null, tool: string, fp: unknown, cwd: unknown = launched) =>
      driftUpdate(prev, launched, tool, { file_path: fp }, cwd, roster);

    it("latches on the first write into another checkout", () => {
      expect(upd(null, "Write", `${WT}/overview/src/a.ts`)).toEqual(moved);
    });

    it("holds through everything that isn't a write home", () => {
      // an agent that moved keeps reading the checkout it came from
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

    it("follows an agent into the worktree it just created next door", () => {
      const cmd = (prev: Drift | null, command: string) =>
        driftUpdate(prev, launched, "Bash", { command }, launched, roster);
      // `worktree add` writes no file and sets nothing; the roster poll (refreshWorktrees) sees the checkout
      expect(cmd(null, "git worktree add -b feat/overview ../overview dev 2>&1 | tail -3")).toBeNull();
      const d = cmd(null, `cd ../overview && cat > src/tour.ts <<'E'\nE`);
      expect(d).toEqual(moved);
      expect(cmd(d, "cd ../overview && grep -n renderAllNow src/main.ts")).toEqual(moved);
      expect(cmd(d, "cd src && sed -n '1,40p' phase.ts")).toEqual(moved);
      // a write with no cd names no directory and must not read the pinned cwd as "came home":
      // the heredoc it writes may carry the absolute path of the checkout it moved to
      expect(cmd(d, `cat > src/phase.ts <<'E'\nE`)).toEqual(moved);
      expect(cmd(d, `cd ${launched} && cat > src/phase.ts <<'E'\nE`)).toBeNull();
    });

    // --- the cwd signal: Claude Code moving the session itself ---

    it("reads a moved cwd as drift with no write at all", () => {
      // EnterWorktree: no write at all, only the cwd riding along on every hook moves
      expect(driftUpdate(null, launched, "Bash", { file_path: undefined }, `${WT}/overview`, roster))
        .toEqual({ dir: `${WT}/overview`, branch: "feat/overview", via: "cwd" });
      expect(driftUpdate(null, launched, "Bash", { file_path: undefined }, `${WT}/overview/src`, roster))
        .toEqual({ dir: `${WT}/overview`, branch: "feat/overview", via: "cwd" });
    });

    it("does not read a cd within the same checkout as a move", () => {
      // both sides resolve to a checkout before comparing, or every `cd src` reads as a move
      expect(driftUpdate(null, launched, "Bash", { file_path: undefined }, `${launched}/src`, roster)).toBeNull();
      expect(driftUpdate(null, launched, "Bash", { file_path: undefined }, launched, roster)).toBeNull();
    });

    it("lets cwd outrank a write, since it also moves the conversation", () => {
      // `via: "cwd"` tells the repair that Claude has already re-homed the transcript
      expect(driftUpdate(null, launched, "Write", { file_path: `${REPO}/a.ts` }, `${WT}/overview`, roster))
        .toEqual({ dir: `${WT}/overview`, branch: "feat/overview", via: "cwd" });
    });

    it("retires a cwd drift when cwd comes home", () => {
      const byCwd = { dir: `${WT}/overview`, branch: "feat/overview", via: "cwd" as const };
      expect(driftUpdate(byCwd, launched, "Bash", { file_path: undefined }, launched, roster)).toBeNull();
    });

    it("NEVER lets a home cwd clear a write drift", () => {
      // Claude Code resets cwd to home on every hook, so a home cwd clearing the flag
      // would undo the drift one call later.
      expect(upd(moved, "Bash", undefined, launched)).toEqual(moved);
      expect(upd(moved, "Read", `${WT}/overview/a.ts`, launched)).toEqual(moved);
      expect(upd(moved, "Read", `${launched}/a.ts`, `${launched}/src`)).toEqual(moved);
    });

    it("says nothing when cwd names no checkout of this repo", () => {
      expect(driftUpdate(null, launched, "Bash", { file_path: undefined }, "/tmp/whatever", roster)).toBeNull();
      expect(driftUpdate(moved, launched, "Bash", { file_path: undefined }, "/tmp/whatever", roster)).toEqual(moved);
      const byCwd = { dir: `${WT}/overview`, branch: "feat/overview", via: "cwd" as const };
      expect(driftUpdate(byCwd, launched, "Bash", { file_path: undefined }, "/tmp/whatever", roster)).toEqual(byCwd);
      expect(driftUpdate(byCwd, launched, "Bash", { file_path: undefined }, undefined, roster)).toEqual(byCwd);
    });
  });
});

// The same resolution as a grouping answer: which checkout a directory belongs to, so a
// pane started below its checkout still lands in the row its branch is on (./grouping).
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
    // the roster's spelling has been through norm_path; handing it back breaks the caller's comparisons
    expect(checkoutDir(REPO, roster)).toBe(REPO);
    expect(checkoutDir("E:/w/epi", roster)).toBe("E:/w/epi");
    expect(checkoutDir(REPO + "\\", roster)).toBe(REPO + "\\");
  });

  it("returns a folder it cannot place untouched", () => {
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
