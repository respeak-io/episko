import { describe, it, expect } from "vitest";
import { gitMutates } from "../src/gitwatch";

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
