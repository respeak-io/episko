// A pull request reviewed inside the app: one GraphQL read for everything the review pane
// draws, the diff from the user's own clone (fetching objects, never refs), and the writes a
// review makes. Every write is something the user pressed; nothing here posts on its own.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::git::{cap_patch, git_cmd, git_run, split_remote};
use crate::github::{classify, gh, gh_input, gh_invalidate, who_for, GhComment};

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct PrCheck {
    pub name: String,
    pub state: String, // "pass" | "fail" | "pending" | "skip" | "neutral"
    pub url: String,
    pub workflow: String,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct PrCommit {
    pub oid: String,
    pub headline: String,
    pub author: String,
    pub at: String,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct PrComment {
    pub id: String,
    pub db_id: i64, // REST replies address a comment by this, GraphQL by `id`
    pub author: String,
    pub body: String,
    pub at: String,
    pub url: String,
    pub diff_hunk: String,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct PrThread {
    pub id: String,
    pub resolved: bool,
    pub outdated: bool,
    pub path: String,
    pub line: Option<i64>, // null for a FILE subject and for an outdated thread
    pub start_line: Option<i64>,
    pub original_line: Option<i64>,
    pub original_start_line: Option<i64>,
    pub side: String,
    pub subject: String,
    pub comments: Vec<PrComment>,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct PrReviewEntry {
    pub author: String,
    pub state: String,
    pub body: String,
    pub at: String,
    pub commit: String,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct PrReview {
    pub available: bool,
    pub reason: Option<String>,
    pub number: i64,
    pub slug: String,
    pub title: String,
    pub url: String,
    pub state: String,
    pub draft: bool,
    pub author: Option<String>,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    pub base_ref: String,
    pub head_ref: String,
    pub base_oid: String,
    pub head_oid: String,
    pub same_repo: bool,
    pub mergeable: String,
    pub merge_state: String,
    pub review_decision: Option<String>,
    pub merge_methods: Vec<String>,
    pub viewer: Option<String>,
    pub checks: Vec<PrCheck>,
    pub commits: Vec<PrCommit>,
    pub threads: Vec<PrThread>,
    pub reviews: Vec<PrReviewEntry>,
    pub comments: Vec<GhComment>,
}

impl PrReview {
    fn unavailable(number: i64, reason: impl Into<String>) -> Self {
        Self {
            available: false,
            reason: Some(reason.into()),
            number,
            slug: String::new(),
            title: String::new(),
            url: String::new(),
            state: String::new(),
            draft: false,
            author: None,
            body: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            base_ref: String::new(),
            head_ref: String::new(),
            base_oid: String::new(),
            head_oid: String::new(),
            same_repo: false,
            mergeable: String::new(),
            merge_state: String::new(),
            review_decision: None,
            merge_methods: vec![],
            viewer: None,
            checks: vec![],
            commits: vec![],
            threads: vec![],
            reviews: vec![],
            comments: vec![],
        }
    }
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct PrDiff {
    pub patch: String,
    pub truncated: bool,
}

#[derive(serde::Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct DraftComment {
    pub path: String,
    pub body: String,
    pub line: Option<i64>, // None: a file-level comment, which the reviews endpoint cannot carry
    pub side: Option<String>,
    pub start_line: Option<i64>,
    pub start_side: Option<String>,
}

// ---------- the repo's slug ----------

static SLUGS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None); // a repo's slug never changes

/// `owner/repo` as gh resolves it for `root`, which is the repo every other gh call here infers.
fn slug_for(root: &str, account: Option<&str>) -> Result<String, String> {
    if let Some(s) = SLUGS.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(root).cloned())) {
        return Ok(s);
    }
    let out = gh(root, account, &["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])?;
    let slug = out.trim().to_string();
    if slug.split('/').count() != 2 {
        return Err(format!("gh named no repository here ({slug:?})"));
    }
    if let Ok(mut g) = SLUGS.lock() {
        g.get_or_insert_with(HashMap::new).insert(root.to_string(), slug.clone());
    }
    Ok(slug)
}

// ---------- the read ----------

const QUERY: &str = r#"query($owner:String!,$name:String!,$number:Int!){
  viewer{login}
  repository(owner:$owner,name:$name){
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    pullRequest(number:$number){
      number title url state isDraft body createdAt updatedAt author{login}
      baseRefName headRefName baseRefOid headRefOid isCrossRepository
      mergeable mergeStateStatus reviewDecision
      commits(last:100){nodes{commit{oid messageHeadline committedDate author{name user{login}}}}}
      rollup: commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
        ... on CheckRun{name conclusion status detailsUrl checkSuite{workflowRun{workflow{name}}}}
        ... on StatusContext{context state targetUrl}
      }}}}}}
      reviewThreads(first:100){nodes{
        id isResolved isOutdated path line startLine originalLine originalStartLine diffSide subjectType
        comments(first:50){nodes{id databaseId author{login} body createdAt url diffHunk}}
      }}
      reviews(last:50){nodes{author{login} state body submittedAt commit{oid}}}
      comments(last:100){nodes{author{login} body createdAt}}
    }
  }
}"#;

/// Everything the review pane draws, in one round trip. Never an error: a PR that cannot be
/// read is one quiet panel with the reason, the way `gh_issue` answers.
#[tauri::command]
pub(crate) async fn pr_review(root: String, number: i64, account: Option<String>) -> PrReview {
    if let Err(e) = valid_number(number) {
        return PrReview::unavailable(number, e);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let acct = account.as_deref();
        let read = slug_for(&root, acct).and_then(|slug| {
            let (owner, name) = slug.split_once('/').unwrap_or_default();
            let q = format!("query={QUERY}");
            let (o, n, num) = (format!("owner={owner}"), format!("name={name}"), format!("number={number}"));
            gh(&root, acct, &["api", "graphql", "-f", &q, "-f", &o, "-f", &n, "-F", &num]).map(|j| (slug, j))
        });
        match read {
            Err(e) => PrReview::unavailable(number, classify(&e, who_for(acct).as_deref())),
            Ok((slug, json)) => match parse_pr_review(&json, number) {
                Some(mut r) => {
                    r.slug = slug;
                    r
                }
                None => PrReview::unavailable(number, graphql_error(&json).unwrap_or_else(|| "no such pull request".into())),
            },
        }
    })
    .await
    .unwrap_or_else(|e| PrReview::unavailable(number, format!("gh task failed: {e}")))
}

fn graphql_error(json: &str) -> Option<String> {
    let v: Value = serde_json::from_str(json).ok()?;
    v.get("errors")?.as_array()?.first()?.get("message")?.as_str().map(str::to_string)
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}
fn login(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|a| a.get("login")).and_then(Value::as_str).map(str::to_string)
}
fn nodes<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(|c| c.get("nodes")).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// The GraphQL answer, flattened. `None` only when there is no pull request at all; any other
/// field gh did not send reads as empty.
pub(crate) fn parse_pr_review(json: &str, number: i64) -> Option<PrReview> {
    let v: Value = serde_json::from_str(json).ok()?;
    let data = v.get("data")?;
    let repo = data.get("repository")?;
    let pr = repo.get("pullRequest").filter(|p| p.is_object())?;
    let viewer = login(data, "viewer");
    let allowed = |k: &str| repo.get(k).and_then(Value::as_bool).unwrap_or(false);
    let merge_methods = [("merge", "mergeCommitAllowed"), ("squash", "squashMergeAllowed"), ("rebase", "rebaseMergeAllowed")]
        .iter()
        .filter(|(_, k)| allowed(k))
        .map(|(m, _)| m.to_string())
        .collect();
    let int = |v: &Value, k: &str| v.get(k).and_then(Value::as_i64);

    let checks = nodes(pr, "rollup")
        .first()
        .and_then(|n| n.get("commit")?.get("statusCheckRollup")?.get("contexts")?.get("nodes")?.as_array())
        .map(|a| a.iter().filter_map(parse_check).collect())
        .unwrap_or_default();
    let commits = nodes(pr, "commits")
        .iter()
        .filter_map(|n| n.get("commit"))
        .map(|c| PrCommit {
            oid: s(c, "oid"),
            headline: s(c, "messageHeadline"),
            author: c.get("author").map(|a| login(a, "user").unwrap_or_else(|| s(a, "name"))).unwrap_or_default(),
            at: s(c, "committedDate"),
        })
        .collect();
    let threads = nodes(pr, "reviewThreads")
        .iter()
        .map(|t| PrThread {
            id: s(t, "id"),
            resolved: t.get("isResolved").and_then(Value::as_bool).unwrap_or(false),
            outdated: t.get("isOutdated").and_then(Value::as_bool).unwrap_or(false),
            path: s(t, "path"),
            line: int(t, "line"),
            start_line: int(t, "startLine"),
            original_line: int(t, "originalLine"),
            original_start_line: int(t, "originalStartLine"),
            side: s(t, "diffSide"),
            subject: s(t, "subjectType"),
            comments: nodes(t, "comments")
                .iter()
                .map(|c| PrComment {
                    id: s(c, "id"),
                    db_id: int(c, "databaseId").unwrap_or(0),
                    author: login(c, "author").unwrap_or_default(),
                    body: s(c, "body"),
                    at: s(c, "createdAt"),
                    url: s(c, "url"),
                    diff_hunk: s(c, "diffHunk"),
                })
                .collect(),
        })
        .collect();
    let reviews = nodes(pr, "reviews")
        .iter()
        .filter_map(|r| {
            let author = login(r, "author").unwrap_or_default();
            let state = s(r, "state");
            // Someone else's pending review is invisible on GitHub; it must be here too.
            if state == "PENDING" && Some(&author) != viewer.as_ref() {
                return None;
            }
            Some(PrReviewEntry {
                author,
                state,
                body: s(r, "body"),
                at: s(r, "submittedAt"),
                commit: r.get("commit").map(|c| s(c, "oid")).unwrap_or_default(),
            })
        })
        .collect();
    let comments = nodes(pr, "comments")
        .iter()
        .map(|c| GhComment { who: login(c, "author").unwrap_or_default(), at: s(c, "createdAt"), body: s(c, "body") })
        .collect();

    Some(PrReview {
        available: true,
        reason: None,
        number: int(pr, "number").unwrap_or(number),
        slug: String::new(),
        title: s(pr, "title"),
        url: s(pr, "url"),
        state: s(pr, "state"),
        draft: pr.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        author: login(pr, "author"),
        body: s(pr, "body"),
        created_at: s(pr, "createdAt"),
        updated_at: s(pr, "updatedAt"),
        base_ref: s(pr, "baseRefName"),
        head_ref: s(pr, "headRefName"),
        base_oid: s(pr, "baseRefOid"),
        head_oid: s(pr, "headRefOid"),
        // Unknown reads as a fork: the one thing it gates is deleting the head branch.
        same_repo: pr.get("isCrossRepository").and_then(Value::as_bool) == Some(false),
        mergeable: s(pr, "mergeable"),
        merge_state: s(pr, "mergeStateStatus"),
        review_decision: pr.get("reviewDecision").and_then(Value::as_str).filter(|d| !d.is_empty()).map(str::to_string),
        merge_methods,
        viewer,
        checks,
        commits,
        threads,
        reviews,
        comments,
    })
}

/// A CheckRun or a StatusContext, one vocabulary for both. A node that is neither has no name.
fn parse_check(n: &Value) -> Option<PrCheck> {
    if let Some(name) = n.get("name").and_then(Value::as_str) {
        let workflow = n
            .pointer("/checkSuite/workflowRun/workflow/name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let state = normalise_check(&s(n, "status"), &s(n, "conclusion"));
        return Some(PrCheck { name: name.to_string(), state: state.into(), url: s(n, "detailsUrl"), workflow });
    }
    let name = n.get("context").and_then(Value::as_str)?;
    Some(PrCheck { name: name.to_string(), state: normalise_check("", &s(n, "state")).into(), url: s(n, "targetUrl"), workflow: String::new() })
}

/// A CheckRun's `status` + `conclusion`, or a StatusContext's `state` alone (status empty).
pub(crate) fn normalise_check(status: &str, conclusion: &str) -> &'static str {
    if !status.is_empty() && status != "COMPLETED" {
        return "pending";
    }
    match conclusion {
        "SUCCESS" => "pass",
        "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => "fail",
        "PENDING" | "EXPECTED" => "pending",
        "SKIPPED" => "skip",
        _ => "neutral",
    }
}

// ---------- the diff, from the user's own clone ----------

/// A full object id, SHA-1 or SHA-256. Anything shorter is ambiguous and anything else could
/// reach git's argv as a flag or a revision expression.
pub(crate) fn is_oid(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The remote whose URL names `slug` (from `git remote -v`), github.com first, so an ssh
/// alias or a mirror still serves; `None` lets the caller fall back to `origin`.
pub(crate) fn remote_for(slug: &str, remotes: &str) -> Option<String> {
    let mut hits: Vec<(bool, &str)> = remotes
        .lines()
        .filter_map(|l| {
            let mut f = l.split_whitespace();
            let (name, url) = (f.next()?, f.next()?);
            let (host, owner_repo) = split_remote(url);
            owner_repo
                .filter(|o| o.eq_ignore_ascii_case(slug))
                .map(|_| (host.as_deref() != Some("github.com"), name))
        })
        .collect();
    hits.sort_by_key(|(not_github, _)| *not_github);
    hits.first().map(|(_, n)| n.to_string())
}

fn has_commit(root: &str, oid: &str) -> bool {
    let probe = format!("{oid}^{{commit}}");
    git_cmd(root, &["cat-file", "-e", &probe]).output().is_ok_and(|o| o.status.success())
}

/// Bring `oids` into the object store without naming them: no ref is written, FETCH_HEAD
/// included, since this is the user's repo and their refs are theirs. Submodules and
/// auto-maintenance are kept out of it for the same reason.
fn fetch_objects(root: &str, remote: &str, what: &[&str]) -> Result<(), String> {
    let mut args = vec![
        "-c", "gc.auto=0", "-c", "maintenance.auto=false",
        "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--quiet", "--", remote,
    ];
    args.extend_from_slice(what);
    let out = git_run(git_cmd(root, &args), 45)?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    Err(err.lines().find(|l| !l.trim().is_empty()).unwrap_or("git fetch failed").trim().to_string())
}

fn ensure_objects(root: &str, number: i64, oids: &[&str]) -> Result<(), String> {
    let missing: Vec<&str> = oids.iter().copied().filter(|o| !has_commit(root, o)).collect();
    if missing.is_empty() {
        return Ok(());
    }
    let remotes = git_cmd(root, &["remote", "-v"]).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    let remote = slug_for(root, None).ok().and_then(|s| remote_for(&s, &remotes)).unwrap_or_else(|| "origin".into());
    let by_oid = fetch_objects(root, &remote, &missing);
    // A fork's head is only reachable from the base repo through the PR's own ref.
    if by_oid.is_err() || missing.iter().any(|o| !has_commit(root, o)) {
        let pull = format!("+refs/pull/{number}/head");
        let _ = fetch_objects(root, &remote, &[&pull]);
    }
    match missing.iter().find(|o| !has_commit(root, o)) {
        None => Ok(()),
        Some(o) => Err(match by_oid {
            Err(e) => format!("commit {} is not in this clone and {remote} would not give it: {e}", &o[..7]),
            Ok(()) => format!("commit {} is not in this clone and {remote} does not have it", &o[..7]),
        }),
    }
}

/// The diff for a PR (`base...head`: against the merge base, as GitHub shows it and anchors
/// its comments) or for "changes since" (`from head`). Prefixes pinned against `diff.noprefix`.
pub(crate) fn diff_args<'a>(revs: &[&'a str], ignore_ws: bool) -> Vec<&'a str> {
    let mut a = vec![
        "-c", "core.quotepath=false", "--no-optional-locks", "diff", "--no-color", "--no-ext-diff", "-M",
        "--src-prefix=a/", "--dst-prefix=b/",
    ];
    if ignore_ws {
        a.push("-w");
    }
    a.extend_from_slice(revs);
    a.push("--");
    a
}

#[tauri::command]
pub(crate) async fn pr_diff(
    root: String,
    number: i64,
    base_oid: String,
    head_oid: String,
    from_oid: Option<String>,
    ignore_ws: bool,
) -> Result<PrDiff, String> {
    valid_number(number)?;
    tauri::async_runtime::spawn_blocking(move || pr_diff_in(&root, number, &base_oid, &head_oid, from_oid.as_deref(), ignore_ws))
        .await
        .map_err(|e| format!("git task failed: {e}"))?
}

fn pr_diff_in(root: &str, number: i64, base: &str, head: &str, from: Option<&str>, ignore_ws: bool) -> Result<PrDiff, String> {
    if ![base, head].iter().chain(from.iter()).all(|o| is_oid(o)) {
        return Err("a pull request's commits are addressed by full object ids".into());
    }
    let mut need = vec![base, head];
    need.extend(from);
    ensure_objects(root, number, &need)?;
    let range = format!("{base}...{head}");
    let revs = match from {
        Some(f) => vec![f, head],
        None => vec![range.as_str()],
    };
    let out = git_run(git_cmd(root, &diff_args(&revs, ignore_ws)), 45)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.lines().find(|l| !l.trim().is_empty()).unwrap_or("git diff failed").trim().to_string());
    }
    let mut patch = String::from_utf8_lossy(&out.stdout).into_owned();
    let truncated = cap_patch(&mut patch);
    Ok(PrDiff { patch, truncated })
}

/// A path as a tree lookup takes it: relative, inside the tree, and never read as a flag.
pub(crate) fn is_tree_path(p: &str) -> bool {
    !p.is_empty()
        && !p.starts_with(['-', '/', '\\'])
        && !p.contains(':')
        && !p.split(['/', '\\']).any(|seg| seg == "..")
}

const BLOB_CAP: usize = 2_000_000;

/// One file at one commit, for "expand context". `cat-file blob` rather than `show`: the raw
/// bytes, with no textconv between the file and the diff it has to line up with.
#[tauri::command]
pub(crate) async fn pr_blob(root: String, oid: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_oid(&oid) || !is_tree_path(&path) {
            return Err("a file is read by full commit id and a path inside the repository".into());
        }
        let spec = format!("{oid}:{path}");
        let out = git_run(git_cmd(&root, &["--no-optional-locks", "cat-file", "blob", &spec]), 20)?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(err.lines().find(|l| !l.trim().is_empty()).unwrap_or("git cat-file failed").trim().to_string());
        }
        if out.stdout.len() > BLOB_CAP {
            return Err(format!("{path} is over 2 MB"));
        }
        if out.stdout.contains(&0) {
            return Err(format!("{path} is binary"));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

// ---------- the writes ----------

fn api(root: &str, account: Option<&str>, method: &str, path: &str, body: &Value) -> Result<Value, String> {
    let out = gh_input(root, account, &["api", "--method", method, path, "--input", "-"], &body.to_string())
        .map_err(|e| classify(&e, who_for(account).as_deref()))?;
    Ok(serde_json::from_str(&out).unwrap_or(Value::Null))
}

pub(crate) fn valid_event(event: &str) -> bool {
    matches!(event, "COMMENT" | "APPROVE" | "REQUEST_CHANGES")
}

/// The reviews endpoint's body: line comments only (a file-level one has no line to sit on),
/// and never the deprecated `position`.
pub(crate) fn review_payload(commit_id: &str, event: &str, body: &str, comments: &[DraftComment]) -> Value {
    let lines: Vec<Value> = comments
        .iter()
        .filter_map(|c| {
            let line = c.line?;
            let mut o = json!({
                "path": c.path, "body": c.body, "line": line,
                "side": c.side.clone().unwrap_or_else(|| "RIGHT".into()),
            });
            if let Some(sl) = c.start_line {
                o["start_line"] = json!(sl);
                o["start_side"] = json!(c.start_side.clone().or_else(|| c.side.clone()).unwrap_or_else(|| "RIGHT".into()));
            }
            Some(o)
        })
        .collect();
    json!({ "commit_id": commit_id, "event": event, "body": body, "comments": lines })
}

pub(crate) fn file_comment_payload(commit_id: &str, c: &DraftComment) -> Value {
    json!({ "body": c.body, "commit_id": commit_id, "path": c.path, "subject_type": "file" })
}

/// Submit a review: one POST carrying every line comment, then each file-level comment on its
/// own after it, since the reviews endpoint has nowhere to put them. Answers the review's URL.
#[tauri::command]
pub(crate) async fn pr_submit_review(
    root: String,
    number: i64,
    commit_id: String,
    event: String,
    body: String,
    comments: Vec<DraftComment>,
    account: Option<String>,
) -> Result<String, String> {
    valid_number(number)?;
    if !valid_event(&event) {
        return Err(format!("{event:?} is not a review verdict"));
    }
    if !is_oid(&commit_id) {
        return Err("a review is anchored to a full commit id".into());
    }
    if comments.iter().any(|c| c.path.is_empty() || c.body.trim().is_empty()) {
        return Err("every comment needs a file and some text".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let acct = account.as_deref();
        let slug = slug_for(&root, acct).map_err(|e| classify(&e, who_for(acct).as_deref()))?;
        let files: Vec<&DraftComment> = comments.iter().filter(|c| c.line.is_none()).collect();
        let has_lines = files.len() < comments.len();
        // A bare COMMENT with no text and no line comments is a review GitHub refuses; the
        // file comments are then the whole of it.
        let mut url = String::new();
        if has_lines || event != "COMMENT" || !body.trim().is_empty() {
            let r = api(&root, acct, "POST", &format!("repos/{slug}/pulls/{number}/reviews"), &review_payload(&commit_id, &event, &body, &comments))?;
            url = s(&r, "html_url");
        }
        let mut failed = 0;
        let mut first_err = String::new();
        for c in &files {
            match api(&root, acct, "POST", &format!("repos/{slug}/pulls/{number}/comments"), &file_comment_payload(&commit_id, c)) {
                Ok(v) if url.is_empty() => url = s(&v, "html_url"),
                Ok(_) => {}
                Err(e) => {
                    failed += 1;
                    if first_err.is_empty() {
                        first_err = e;
                    }
                }
            }
        }
        gh_invalidate(root.clone());
        if failed > 0 {
            let posted = if url.is_empty() { "nothing else was posted" } else { "the review itself was posted" };
            return Err(format!("{failed} of {} file comments did not land ({posted}): {first_err}", files.len()));
        }
        Ok(url)
    })
    .await
    .map_err(|e| format!("gh task failed: {e}"))?
}

/// A number reaches gh's argv (`pr ready <n>`), where a negative one would read as a flag.
fn valid_number(n: i64) -> Result<(), String> {
    if n > 0 { Ok(()) } else { Err(format!("#{n} is not a pull request")) }
}

fn nonempty(body: &str) -> Result<(), String> {
    if body.trim().is_empty() { Err("an empty comment says nothing".into()) } else { Ok(()) }
}

#[tauri::command]
pub(crate) async fn pr_reply(root: String, number: i64, comment_id: i64, body: String, account: Option<String>) -> Result<(), String> {
    valid_number(number)?;
    nonempty(&body)?;
    tauri::async_runtime::spawn_blocking(move || {
        let acct = account.as_deref();
        let slug = slug_for(&root, acct).map_err(|e| classify(&e, who_for(acct).as_deref()))?;
        api(&root, acct, "POST", &format!("repos/{slug}/pulls/{number}/comments/{comment_id}/replies"), &json!({ "body": body }))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("gh task failed: {e}"))?
}

#[tauri::command]
pub(crate) async fn pr_resolve(root: String, thread_id: String, resolve: bool, account: Option<String>) -> Result<(), String> {
    if thread_id.is_empty() {
        return Err("no thread to resolve".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let acct = account.as_deref();
        let verb = if resolve { "resolveReviewThread" } else { "unresolveReviewThread" };
        let q = format!("query=mutation($id:ID!){{{verb}(input:{{threadId:$id}}){{thread{{isResolved}}}}}}");
        let id = format!("id={thread_id}");
        let out = gh(&root, acct, &["api", "graphql", "-f", &q, "-f", &id]).map_err(|e| classify(&e, who_for(acct).as_deref()))?;
        graphql_error(&out).map_or(Ok(()), Err)
    })
    .await
    .map_err(|e| format!("gh task failed: {e}"))?
}

#[tauri::command]
pub(crate) async fn pr_comment(root: String, number: i64, body: String, account: Option<String>) -> Result<(), String> {
    valid_number(number)?;
    nonempty(&body)?;
    tauri::async_runtime::spawn_blocking(move || {
        let acct = account.as_deref();
        let slug = slug_for(&root, acct).map_err(|e| classify(&e, who_for(acct).as_deref()))?;
        api(&root, acct, "POST", &format!("repos/{slug}/issues/{number}/comments"), &json!({ "body": body }))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("gh task failed: {e}"))?
}

/// A branch name as URL path segments: each one percent-encoded, the `/` between them kept,
/// since the refs endpoint reads `heads/feat/x` as the ref's own path.
pub(crate) fn ref_path(branch: &str) -> String {
    branch
        .split('/')
        .map(|seg| {
            seg.bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
                    _ => format!("%{b:02X}"),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// The head branch `pulls/{n}` says may be deleted: only one that lives in the base repo,
/// and never that repo's default branch.
pub(crate) fn deletable_head(pull_json: &str) -> Option<String> {
    let v: Value = serde_json::from_str(pull_json).ok()?;
    let head_repo = v.pointer("/head/repo/full_name")?.as_str()?;
    let base_repo = v.pointer("/base/repo/full_name")?.as_str()?;
    let branch = v.pointer("/head/ref")?.as_str()?;
    let default = v.pointer("/base/repo/default_branch").and_then(Value::as_str);
    (head_repo.eq_ignore_ascii_case(base_repo) && !branch.is_empty() && Some(branch) != default).then(|| branch.to_string())
}

/// Merge through the API with `sha` as a guard, so a push after the review makes GitHub refuse.
/// The branch is deleted through the API too: `gh pr merge --delete-branch` switches the checkout.
#[tauri::command]
pub(crate) async fn pr_merge(
    root: String,
    number: i64,
    method: String,
    head_oid: String,
    delete_branch: bool,
    account: Option<String>,
) -> Result<String, String> {
    valid_number(number)?;
    if !matches!(method.as_str(), "merge" | "squash" | "rebase") {
        return Err(format!("{method:?} is not a merge method"));
    }
    if !is_oid(&head_oid) {
        return Err("a merge is guarded by the full head commit id".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let acct = account.as_deref();
        let who = who_for(acct);
        let slug = slug_for(&root, acct).map_err(|e| classify(&e, who.as_deref()))?;
        api(&root, acct, "PUT", &format!("repos/{slug}/pulls/{number}/merge"), &json!({ "merge_method": method, "sha": head_oid }))?;
        gh_invalidate(root.clone());
        let merged = format!("merged #{number} ({method})");
        if !delete_branch {
            return Ok(merged);
        }
        let pull = match gh(&root, acct, &["api", &format!("repos/{slug}/pulls/{number}")]) {
            Ok(j) => j,
            Err(e) => return Ok(format!("{merged}; branch kept, its PR could not be read: {}", classify(&e, who.as_deref()))),
        };
        let Some(branch) = deletable_head(&pull) else {
            return Ok(format!("{merged}; branch kept (it is a fork's, or the default branch)"));
        };
        let path = format!("repos/{slug}/git/refs/heads/{}", ref_path(&branch));
        Ok(match gh(&root, acct, &["api", "--method", "DELETE", &path]) {
            Ok(_) => format!("{merged}; deleted {branch}"),
            Err(e) => format!("{merged}; {branch} kept: {}", classify(&e, who.as_deref())),
        })
    })
    .await
    .map_err(|e| format!("gh task failed: {e}"))?
}

#[tauri::command]
pub(crate) async fn pr_ready(root: String, number: i64, ready: bool, account: Option<String>) -> Result<(), String> {
    valid_number(number)?;
    tauri::async_runtime::spawn_blocking(move || {
        let acct = account.as_deref();
        let n = number.to_string();
        let mut args = vec!["pr", "ready", n.as_str()];
        if !ready {
            args.push("--undo");
        }
        gh(&root, acct, &args).map_err(|e| classify(&e, who_for(acct).as_deref()))?;
        gh_invalidate(root.clone());
        Ok(())
    })
    .await
    .map_err(|e| format!("gh task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{git, scratch_dir};
    use std::path::Path;

    // Shaped like the real answer for respeak-io/episko#199 and cli/cli#14578, cut down.
    const FULL: &str = r#"{"data":{"viewer":{"login":"me"},"repository":{
      "mergeCommitAllowed":false,"squashMergeAllowed":true,"rebaseMergeAllowed":true,
      "pullRequest":{"number":42,"title":"t","url":"https://github.com/o/r/pull/42","state":"OPEN","isDraft":true,
        "body":"b","createdAt":"c","updatedAt":"u","author":{"login":"alice"},
        "baseRefName":"main","headRefName":"feat/x","baseRefOid":"aa","headRefOid":"bb","isCrossRepository":true,
        "mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","reviewDecision":"CHANGES_REQUESTED",
        "commits":{"nodes":[{"commit":{"oid":"bb","messageHeadline":"h","committedDate":"d","author":{"name":"Bob B","user":null}}}]},
        "rollup":{"nodes":[{"commit":{"statusCheckRollup":{"contexts":{"nodes":[
          {"name":"build","conclusion":null,"status":"IN_PROGRESS","detailsUrl":"https://ci/1","checkSuite":{"workflowRun":{"workflow":{"name":"ci"}}}},
          {"name":"lint","conclusion":"FAILURE","status":"COMPLETED","detailsUrl":null,"checkSuite":{"workflowRun":null}},
          {"context":"netlify","state":"SUCCESS","targetUrl":"https://n/1"},
          {}
        ]}}}}]},
        "reviewThreads":{"nodes":[
          {"id":"T1","isResolved":true,"isOutdated":false,"path":"a.rs","line":10,"startLine":null,"originalLine":10,
           "originalStartLine":null,"diffSide":"RIGHT","subjectType":"LINE",
           "comments":{"nodes":[{"id":"C1","databaseId":101,"author":{"login":"alice"},"body":"x","createdAt":"t1","url":"u1","diffHunk":"@@ -1 +1 @@"}]}},
          {"id":"T2","isResolved":false,"isOutdated":true,"path":"a.rs","line":null,"startLine":null,"originalLine":218,
           "originalStartLine":216,"diffSide":"RIGHT","subjectType":"LINE","comments":{"nodes":[]}},
          {"id":"T3","isResolved":false,"isOutdated":false,"path":"b.md","line":null,"startLine":null,"originalLine":null,
           "originalStartLine":null,"diffSide":"RIGHT","subjectType":"FILE","comments":{"nodes":[{"id":"C3","author":null}]}},
          {"id":"T4","isResolved":false,"isOutdated":false,"path":"a.rs","line":423,"startLine":384,"originalLine":388,
           "originalStartLine":384,"diffSide":"LEFT","subjectType":"LINE","comments":{"nodes":[]}}
        ]},
        "reviews":{"nodes":[
          {"author":{"login":"carol"},"state":"APPROVED","body":"","submittedAt":"s","commit":{"oid":"bb"}},
          {"author":{"login":"dave"},"state":"PENDING","body":"","submittedAt":null,"commit":null},
          {"author":{"login":"me"},"state":"PENDING","body":"draft","submittedAt":null,"commit":{"oid":"bb"}}
        ]},
        "comments":{"nodes":[{"author":{"login":"erin"},"body":"hi","createdAt":"t"}]}
      }}}}"#;

    #[test]
    fn reads_a_whole_pull_request_out_of_one_answer() {
        let r = parse_pr_review(FULL, 42).unwrap();
        assert!(r.available && r.draft);
        assert!(!r.same_repo, "isCrossRepository is a fork");
        assert_eq!(r.merge_methods, vec!["squash", "rebase"]);
        assert_eq!(r.review_decision.as_deref(), Some("CHANGES_REQUESTED"));
        assert_eq!(r.viewer.as_deref(), Some("me"));
        assert_eq!(r.commits[0].author, "Bob B", "a commit with no GitHub user is named by git");

        let c: Vec<(&str, &str, &str, &str)> =
            r.checks.iter().map(|c| (c.name.as_str(), c.state.as_str(), c.url.as_str(), c.workflow.as_str())).collect();
        assert_eq!(c, vec![
            ("build", "pending", "https://ci/1", "ci"),
            ("lint", "fail", "", ""),
            ("netlify", "pass", "https://n/1", ""),
        ], "a node that is neither kind is dropped");

        let t = &r.threads;
        assert!(t[0].resolved && !t[0].outdated && t[0].line == Some(10));
        assert_eq!(t[0].comments[0].db_id, 101);
        assert!(t[1].outdated && t[1].line.is_none() && t[1].original_start_line == Some(216));
        assert_eq!((t[2].subject.as_str(), t[2].line), ("FILE", None));
        assert_eq!(t[2].comments[0].author, "", "a deleted user is an empty name, not a lost comment");
        assert_eq!((t[3].start_line, t[3].line, t[3].side.as_str()), (Some(384), Some(423), "LEFT"));

        let who: Vec<&str> = r.reviews.iter().map(|v| v.author.as_str()).collect();
        assert_eq!(who, vec!["carol", "me"], "another person's pending review stays invisible");
        assert_eq!(r.reviews[1].at, "");
        assert_eq!(r.comments[0].who, "erin");
    }

    #[test]
    fn a_minimal_answer_is_still_a_pull_request() {
        let r = parse_pr_review(r#"{"data":{"repository":{"pullRequest":{}}}}"#, 9).unwrap();
        assert_eq!(r.number, 9);
        assert!(r.checks.is_empty() && r.threads.is_empty() && r.merge_methods.is_empty());
        assert!(!r.same_repo && r.review_decision.is_none() && r.viewer.is_none());
    }

    #[test]
    fn no_pull_request_is_no_read() {
        let missing = r#"{"data":{"repository":{"pullRequest":null}},"errors":[{"message":"Could not resolve to a PullRequest with the number of 9."}]}"#;
        assert!(parse_pr_review(missing, 9).is_none());
        assert_eq!(graphql_error(missing).as_deref(), Some("Could not resolve to a PullRequest with the number of 9."));
        assert!(parse_pr_review("[]", 9).is_none() && parse_pr_review("", 9).is_none());
    }

    #[test]
    fn check_states_collapse_to_five_words() {
        assert_eq!(normalise_check("QUEUED", ""), "pending");
        assert_eq!(normalise_check("COMPLETED", "SUCCESS"), "pass");
        assert_eq!(normalise_check("COMPLETED", "TIMED_OUT"), "fail");
        assert_eq!(normalise_check("COMPLETED", "SKIPPED"), "skip");
        assert_eq!(normalise_check("COMPLETED", "NEUTRAL"), "neutral");
        assert_eq!(normalise_check("", "ERROR"), "fail");
        assert_eq!(normalise_check("", "EXPECTED"), "pending");
    }

    #[test]
    fn only_a_full_object_id_reaches_git() {
        let sha1 = "a".repeat(40);
        assert!(is_oid(&sha1) && is_oid(&"0".repeat(64)));
        for bad in ["--upload-pack=x", "HEAD", "abc1234", "", &"g".repeat(40), &format!("{sha1}^")] {
            assert!(!is_oid(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_tree_path_stays_inside_the_tree() {
        assert!(is_tree_path("src/a.rs") && is_tree_path("a..b/c"));
        for bad in ["", "/etc/passwd", "-x", "../x", "a/../../x", "C:\\x", "a\\..\\x"] {
            assert!(!is_tree_path(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_remote_is_the_one_that_names_the_repo() {
        let remotes = "mirror\thttps://gitlab.com/Owner/Repo.git (fetch)\n\
                       mirror\thttps://gitlab.com/Owner/Repo.git (push)\n\
                       me\tgit@github.com:me/repo.git (fetch)\n\
                       up\tgit@github.com:owner/repo (fetch)\n";
        assert_eq!(remote_for("Owner/Repo", remotes).as_deref(), Some("up"), "github.com first, any case");
        assert_eq!(remote_for("Owner/Repo", "m\thttps://gitlab.com/owner/repo (fetch)\n").as_deref(), Some("m"));
        assert_eq!(remote_for("Owner/Repo", "w\tgithub.com-work:owner/repo.git (fetch)\n").as_deref(), Some("w"), "an ssh alias");
        assert_eq!(remote_for("owner/repo", "origin\thttps://github.com/owner/other (fetch)\n"), None);
    }

    fn draft(path: &str, line: Option<i64>, start: Option<i64>) -> DraftComment {
        DraftComment { path: path.into(), body: "b".into(), line, side: None, start_line: start, start_side: None }
    }

    #[test]
    fn a_review_carries_line_comments_and_leaves_file_ones_for_their_own_call() {
        let cs = [draft("a.rs", Some(5), None), draft("b.rs", Some(9), Some(7)), draft("c.md", None, None)];
        let p = review_payload("c0ffee", "APPROVE", "ok", &cs);
        assert_eq!(p["event"], "APPROVE");
        let lines = p["comments"].as_array().unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], json!({"path":"a.rs","body":"b","line":5,"side":"RIGHT"}));
        assert_eq!(lines[1]["start_line"], 7);
        assert_eq!(lines[1]["start_side"], "RIGHT");
        assert!(lines.iter().all(|c| c.get("position").is_none()));
        assert_eq!(file_comment_payload("c0ffee", &cs[2]),
            json!({"body":"b","commit_id":"c0ffee","path":"c.md","subject_type":"file"}));
        assert!(valid_event("REQUEST_CHANGES") && !valid_event("approve") && !valid_event("DISMISS"));
    }

    #[test]
    fn a_branch_is_deleted_only_from_its_own_repo() {
        let pull = |head: &str, r: &str| format!(
            r#"{{"head":{{"ref":"{r}","repo":{{"full_name":"{head}"}}}},"base":{{"repo":{{"full_name":"o/r","default_branch":"main"}}}}}}"#);
        assert_eq!(deletable_head(&pull("O/R", "feat/x")).as_deref(), Some("feat/x"));
        assert_eq!(deletable_head(&pull("fork/r", "feat/x")), None);
        assert_eq!(deletable_head(&pull("o/r", "main")), None);
        assert_eq!(deletable_head(r#"{"head":{"ref":"x","repo":null},"base":{"repo":{"full_name":"o/r"}}}"#), None, "a deleted fork");
        assert_eq!(ref_path("feat/a b#1"), "feat/a%20b%231");
    }

    fn commit(dir: &Path, msg: &str) {
        git(dir, &["add", "-A"]);
        git(dir, &["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "-m", msg]);
    }
    fn head(dir: &Path) -> String {
        let o = std::process::Command::new("git").current_dir(dir).args(["rev-parse", "HEAD"]).output().unwrap();
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }
    fn refs(dir: &Path) -> String {
        let o = std::process::Command::new("git").current_dir(dir).args(["for-each-ref"]).output().unwrap();
        String::from_utf8_lossy(&o.stdout).to_string()
    }

    #[test]
    fn a_pull_requests_diff_is_against_the_merge_base_and_fetches_without_a_ref() {
        let up = scratch_dir();
        git(&up, &["init", "-q", "-b", "main"]);
        std::fs::write(up.join("f.txt"), "one\n").unwrap();
        commit(&up, "one");
        let base_start = head(&up);
        git(&up, &["switch", "-q", "-c", "feat"]);
        std::fs::write(up.join("f.txt"), "one\ntwo\n").unwrap();
        commit(&up, "two");
        let mid = head(&up);
        std::fs::write(up.join("g.txt"), "new\n").unwrap();
        commit(&up, "three");
        let tip = head(&up);
        git(&up, &["switch", "-q", "main"]);
        std::fs::write(up.join("m.txt"), "main moved\n").unwrap();
        commit(&up, "main moves on");
        let base = head(&up);

        let clone_parent = scratch_dir();
        let src = up.to_string_lossy().to_string();
        git(&clone_parent, &["clone", "-q", "--no-local", "--single-branch", "-b", "main", &src, "c"]);
        let c = clone_parent.join("c");
        let root = c.to_string_lossy().to_string();
        let before = refs(&c);
        assert!(!has_commit(&root, &tip), "the clone starts without the PR's commits");

        let d = pr_diff_in(&root, 1, &base, &tip, None, false).unwrap();
        assert!(!d.truncated);
        assert!(d.patch.contains("diff --git a/f.txt b/f.txt") && d.patch.contains("+two"));
        assert!(d.patch.contains("diff --git a/g.txt b/g.txt"));
        assert!(!d.patch.contains("m.txt"), "three dots: main's own progress is not the PR's");
        assert_eq!(refs(&c), before, "objects were fetched, no ref was written");
        assert!(!c.join(".git/FETCH_HEAD").exists());

        let since = pr_diff_in(&root, 1, &base, &tip, Some(&mid), false).unwrap();
        assert!(since.patch.contains("g.txt") && !since.patch.contains("f.txt"), "{}", since.patch);
        assert!(pr_diff_in(&root, 1, &base_start, &tip, Some("HEAD"), false).is_err());
        assert!(pr_diff_in(&root, 1, "--upload-pack=x", &tip, None, false).is_err());
        assert!(pr_diff_in(&root, 1, &base, &tip[..12], None, false).is_err());

        let ghost = "1".repeat(40);
        let e = pr_diff_in(&root, 1, &base, &ghost, None, false).unwrap_err();
        assert!(e.contains("1111111"), "{e}");
        assert_eq!(refs(&c), before, "a failed fetch and its refs/pull retry write nothing either");

        assert_eq!(std::fs::read_to_string(c.join("f.txt")).unwrap(), "one\n", "the working tree is untouched");
        let _ = std::fs::remove_dir_all(&up);
        let _ = std::fs::remove_dir_all(&clone_parent);
    }

    #[test]
    fn a_blob_is_text_under_the_cap_or_an_error() {
        let dir = scratch_dir();
        git(&dir, &["init", "-q"]);
        std::fs::write(dir.join("a.txt"), "hello\n").unwrap();
        std::fs::write(dir.join("bin"), [0u8, 1, 2]).unwrap();
        commit(&dir, "x");
        let (root, oid) = (dir.to_string_lossy().to_string(), head(&dir));
        let read = |p: &str| tauri::async_runtime::block_on(pr_blob(root.clone(), oid.clone(), p.into()));
        assert_eq!(read("a.txt").unwrap(), "hello\n");
        assert!(read("bin").unwrap_err().contains("binary"));
        assert!(read("../a.txt").is_err() && read("nope.txt").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
