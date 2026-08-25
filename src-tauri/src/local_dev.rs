//! Local-only development state for a created feature worktree.
//!
//! Two jobs live here, both scoped to worktrees this app creates:
//!
//! 1. The backend authentication bypass. Two narrow edits let a locally run API
//!    answer without a token. The edits are deliberately insecure development
//!    state, so this module also owns the detector that keeps them out of the
//!    index and out of a commit.
//! 2. The shared `node_modules` link. A frontend worktree borrows one installed
//!    dependency tree instead of running an install per worktree.
//!
//! The text transforms are pure functions over file contents, so their shape
//! checks and their idempotency are unit-tested without touching a repository.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use crate::git_control::hide_console;
#[cfg(windows)]
use std::process::Command;

/// Controller whose `[AllowAnonymous]` attribute opens every endpoint locally.
const CONTROLLER_BASE_FILE: &str = "NPlan.Api/Controllers/NPlanControllerBase.cs";
/// Extension whose `GetUserId()` returns a fixed id locally.
const USER_ID_FILE: &str = "NPlan.Core/Extensions/HttpContextExtensions.cs";
const AUTHORIZATION_USING: &str = "using Microsoft.AspNetCore.Authorization;";
const CONTROLLER_BASE_TYPE: &str = "NPlanControllerBase";
const USER_ID_METHOD: &str = "GetUserId(";

/// What one file's patch attempt produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatchOutcome {
    /// Patched content, different from the input.
    Applied(String),
    /// The bypass is already there, byte for byte. Nothing to write.
    AlreadyApplied,
    /// The file does not have the shape the patch expects. Nothing is written
    /// and the reason travels to the UI instead.
    UnexpectedShape(&'static str),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BypassFileReport {
    /// Path relative to the worktree, as configured above.
    pub file: String,
    /// `applied`, `already_applied`, `updated`, `unexpected_shape`,
    /// `file_missing`, or `write_failed`.
    pub status: String,
    /// Reason behind a non-success status. Empty otherwise.
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAuthBypassReport {
    pub worktree: String,
    pub user_id: u32,
    pub files: Vec<BypassFileReport>,
    /// True only when every file ended up carrying the bypass.
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeModulesLinkReport {
    pub worktree: String,
    pub store: String,
    /// `created`, `already_present`, `not_configured`, `store_missing`, or
    /// `link_failed`.
    pub status: String,
    pub detail: String,
}

impl NodeModulesLinkReport {
    /// True when the worktree can run its dev server: either the link was made
    /// now or a dependency tree was already there.
    pub fn usable(&self) -> bool {
        self.status == "created" || self.status == "already_present"
    }
}

// --- shared shape helpers ---

fn line_indent(line: &str) -> String {
    line.chars().take_while(|c| *c == ' ' || *c == '\t').collect()
}

/// Line ending the file already uses, so a patched file does not mix styles.
fn dominant_newline(source: &str) -> &'static str {
    if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

/// Index of the line declaring `NPlanControllerBase` as a type.
fn controller_base_declaration(lines: &[&str]) -> Option<usize> {
    lines.iter().position(|line| {
        let trimmed = line.trim_start();
        !trimmed.starts_with("//")
            && !trimmed.starts_with('*')
            && trimmed.contains(CONTROLLER_BASE_TYPE)
            && (trimmed.contains("class ") || trimmed.contains("record "))
    })
}

/// True when `[AllowAnonymous]` already sits in the attribute block directly
/// above the `NPlanControllerBase` declaration. Shared by the patcher's
/// idempotency check and by the commit guard, so the two can never disagree.
pub fn has_allow_anonymous_on_controller_base(source: &str) -> bool {
    let lines: Vec<&str> = source.lines().collect();
    let Some(declaration) = controller_base_declaration(&lines) else {
        return false;
    };
    // Walk upwards over the attribute block, blank lines, and comments.
    for index in (0..declaration).rev() {
        let trimmed = lines[index].trim();
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('*') {
            continue;
        }
        if trimmed.starts_with('[') {
            if trimmed.contains("AllowAnonymous") {
                return true;
            }
            continue;
        }
        break;
    }
    false
}

/// Index of the line that opens the body of `GetUserId`, plus the index of the
/// declaration itself. `None` when the method is absent or expression-bodied.
fn user_id_body(lines: &[&str]) -> Option<(usize, usize)> {
    let declaration = lines.iter().position(|line| {
        let trimmed = line.trim_start();
        !trimmed.starts_with("//") && trimmed.contains(USER_ID_METHOD)
    })?;
    // An expression-bodied method has no block to insert a statement into.
    if lines[declaration].contains("=>") {
        return None;
    }
    if lines[declaration].trim_end().ends_with('{') {
        return Some((declaration, declaration));
    }
    // The brace may sit on its own line, optionally after a constraint clause.
    for index in (declaration + 1)..lines.len().min(declaration + 5) {
        let trimmed = lines[index].trim();
        if trimmed == "{" {
            return Some((declaration, index));
        }
        if trimmed.is_empty() || trimmed.starts_with("where ") {
            continue;
        }
        return None;
    }
    None
}

/// Index of the first statement line inside a body opened at `brace`.
fn first_statement(lines: &[&str], brace: usize) -> Option<usize> {
    ((brace + 1)..lines.len()).find(|index| {
        let trimmed = lines[*index].trim();
        !trimmed.is_empty() && !trimmed.starts_with("//") && !trimmed.starts_with("/*")
    })
}

/// Fixed id a `GetUserId` body already returns as its first statement, when it
/// has one. Shared by the patcher and the commit guard.
pub fn hardcoded_user_id(source: &str) -> Option<u32> {
    let lines: Vec<&str> = source.lines().collect();
    let (_, brace) = user_id_body(&lines)?;
    let statement = first_statement(&lines, brace)?;
    parse_literal_return(lines[statement])
}

/// `return <digits>;` written as a whole statement, ignoring indentation.
fn parse_literal_return(line: &str) -> Option<u32> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix("return")?;
    // `returnValue;` must not match: a separator is required.
    if !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    let value = rest.trim().strip_suffix(';')?.trim();
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

// --- the two patches ---

/// Adds the authorization `using` and `[AllowAnonymous]` above the
/// `NPlanControllerBase` declaration. Idempotent: a file that already carries
/// the attribute reports `AlreadyApplied` and is never rewritten.
pub fn patch_controller_base(source: &str) -> PatchOutcome {
    let newline = dominant_newline(source);
    let mut lines: Vec<String> = source.lines().map(str::to_string).collect();
    let borrowed: Vec<&str> = lines.iter().map(String::as_str).collect();
    let Some(declaration) = controller_base_declaration(&borrowed) else {
        return PatchOutcome::UnexpectedShape("controller_base_declaration_not_found");
    };
    if has_allow_anonymous_on_controller_base(source) {
        return PatchOutcome::AlreadyApplied;
    }

    let indent = line_indent(&lines[declaration]);
    lines.insert(declaration, format!("{indent}[AllowAnonymous]"));

    let has_using = lines
        .iter()
        .any(|line| line.trim() == AUTHORIZATION_USING);
    if !has_using {
        let insert_at = using_insertion_point(&lines);
        lines.insert(insert_at, AUTHORIZATION_USING.to_string());
    }

    let mut patched = lines.join(newline);
    if source.ends_with('\n') {
        patched.push_str(newline);
    }
    PatchOutcome::Applied(patched)
}

/// Line the authorization `using` is inserted at: after the last leading
/// `using` directive, or at the top when the file has none.
fn using_insertion_point(lines: &[String]) -> usize {
    let mut last_using = None;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with("using ") && trimmed.ends_with(';') {
            last_using = Some(index);
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') {
            continue;
        }
        break;
    }
    last_using.map(|index| index + 1).unwrap_or(0)
}

/// Makes `return <user_id>;` the first statement of `GetUserId`. Idempotent:
/// a body that already starts with that exact return reports `AlreadyApplied`,
/// and one that starts with a different fixed id is rewritten to `user_id`
/// instead of gaining a second unreachable return.
pub fn patch_get_user_id(source: &str, user_id: u32) -> PatchOutcome {
    let newline = dominant_newline(source);
    let mut lines: Vec<String> = source.lines().map(str::to_string).collect();
    let borrowed: Vec<&str> = lines.iter().map(String::as_str).collect();
    let Some((declaration, brace)) = user_id_body(&borrowed) else {
        return PatchOutcome::UnexpectedShape("get_user_id_body_not_found");
    };
    let statement = first_statement(&borrowed, brace);
    let existing = statement.and_then(|index| parse_literal_return(borrowed[index]));

    let indent = format!("{}    ", line_indent(&lines[declaration]));
    let replacement = format!("{indent}return {user_id};");

    match (existing, statement) {
        (Some(current), _) if current == user_id => return PatchOutcome::AlreadyApplied,
        (Some(_), Some(index)) => {
            lines[index] = replacement;
        }
        _ => lines.insert(brace + 1, replacement),
    }

    let mut patched = lines.join(newline);
    if source.ends_with('\n') {
        patched.push_str(newline);
    }
    PatchOutcome::Applied(patched)
}

// --- the commit guard ---

/// Marker the guard found in a change, or `None` when the change is clean.
pub fn bypass_in_source(source: &str) -> Option<&'static str> {
    if has_allow_anonymous_on_controller_base(source) {
        return Some("allow_anonymous_on_controller_base");
    }
    if hardcoded_user_id(source).is_some() {
        return Some("hardcoded_get_user_id");
    }
    None
}

/// Marker the guard found among the added lines of a unified diff.
///
/// A hunk is judged with its own context: an added `[AllowAnonymous]` only
/// counts when that hunk or its file mentions `NPlanControllerBase`, and an
/// added `return <digits>;` only counts inside `GetUserId`. Judging the whole
/// diff at once would flag unrelated files that happen to sit in the same
/// commit.
pub fn bypass_in_diff(diff: &str) -> Option<&'static str> {
    let mut file = String::new();
    let mut hunk: Vec<&str> = Vec::new();
    let mut result = None;

    let mut flush = |file: &str, hunk: &[&str], result: &mut Option<&'static str>| {
        if result.is_some() || hunk.is_empty() {
            return;
        }
        let mentions_controller =
            file.contains(CONTROLLER_BASE_TYPE) || hunk.iter().any(|line| line.contains(CONTROLLER_BASE_TYPE));
        let mentions_user_id =
            file.contains("HttpContextExtensions") || hunk.iter().any(|line| line.contains("GetUserId"));
        for line in hunk {
            let Some(added) = added_payload(line) else { continue };
            if mentions_controller && added.contains("[AllowAnonymous]") {
                *result = Some("allow_anonymous_on_controller_base");
                return;
            }
            if mentions_user_id && parse_literal_return(added).is_some() {
                *result = Some("hardcoded_get_user_id");
                return;
            }
        }
    };

    for line in diff.lines() {
        if let Some(path) = line.strip_prefix("+++ ") {
            flush(&file, &hunk, &mut result);
            hunk.clear();
            file = path.trim().to_string();
            continue;
        }
        if line.starts_with("--- ") || line.starts_with("diff --git ") {
            flush(&file, &hunk, &mut result);
            hunk.clear();
            continue;
        }
        if line.starts_with("@@") {
            flush(&file, &hunk, &mut result);
            hunk.clear();
            // The `@@ ... @@ <section>` tail names the enclosing member.
            hunk.push(line);
            continue;
        }
        hunk.push(line);
    }
    flush(&file, &hunk, &mut result);
    result
}

/// Content of an added diff line, or `None` for context, removals, and headers.
fn added_payload(line: &str) -> Option<&str> {
    if line.starts_with("+++") {
        return None;
    }
    line.strip_prefix('+')
}

/// Error a blocked stage or commit rejects with. The marker travels so the UI
/// can name which half of the bypass was found.
pub fn bypass_blocked_error(marker: &str) -> String {
    format!("local_auth_bypass_blocked:{marker}")
}

/// Folders never walked when scanning a staged directory.
const SKIPPED_DIRECTORIES: &[&str] = &[".git", "node_modules", "bin", "obj", "dist", "target"];
/// Upper bound on files read during one stage check, so staging the repository
/// root can never turn into an unbounded walk.
const MAX_SCANNED_FILES: usize = 4000;

/// Scans the C# files under `paths` for the bypass. Returns the first marker
/// found. Paths are relative to `root`, exactly as the Git panel sends them.
pub fn bypass_in_paths(root: &Path, paths: &[String]) -> Option<&'static str> {
    let mut budget = MAX_SCANNED_FILES;
    for path in paths {
        let target = root.join(path.trim_start_matches(['.', '/', '\\']));
        if let Some(marker) = scan_for_bypass(&target, &mut budget) {
            return Some(marker);
        }
    }
    None
}

fn scan_for_bypass(target: &Path, budget: &mut usize) -> Option<&'static str> {
    if *budget == 0 {
        return None;
    }
    let metadata = fs::symlink_metadata(target).ok()?;
    if metadata.is_dir() {
        let entries = fs::read_dir(target).ok()?;
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if SKIPPED_DIRECTORIES.contains(&name.as_ref()) {
                continue;
            }
            if let Some(marker) = scan_for_bypass(&entry.path(), budget) {
                return Some(marker);
            }
        }
        return None;
    }
    if !metadata.is_file() {
        return None;
    }
    let is_csharp = target
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("cs"));
    if !is_csharp {
        return None;
    }
    *budget -= 1;
    let source = fs::read_to_string(target).ok()?;
    bypass_in_source(&source)
}

// --- filesystem side ---

fn resolved_directory(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("directory_not_found".to_string());
    }
    let candidate = PathBuf::from(trimmed);
    if !candidate.is_dir() {
        return Err("directory_not_found".to_string());
    }
    Ok(candidate)
}

fn apply_patch_to_file(worktree: &Path, relative: &str, outcome_of: impl Fn(&str) -> PatchOutcome) -> BypassFileReport {
    let target = worktree.join(relative);
    let report = |status: &str, detail: String| BypassFileReport {
        file: relative.to_string(),
        status: status.to_string(),
        detail,
    };
    let source = match fs::read_to_string(&target) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return report("file_missing", String::new())
        }
        Err(error) => return report("read_failed", error.to_string()),
    };
    match outcome_of(&source) {
        PatchOutcome::AlreadyApplied => report("already_applied", String::new()),
        PatchOutcome::UnexpectedShape(reason) => report("unexpected_shape", reason.to_string()),
        PatchOutcome::Applied(patched) => {
            let updated = bypass_in_source(&source).is_some();
            match fs::write(&target, patched) {
                Ok(()) => report(if updated { "updated" } else { "applied" }, String::new()),
                Err(error) => report("write_failed", error.to_string()),
            }
        }
    }
}

/// Applies both bypass edits inside one created worktree.
pub fn apply_local_auth_bypass_inner(
    worktree: String,
    user_id: u32,
) -> Result<LocalAuthBypassReport, String> {
    let root = resolved_directory(&worktree)?;
    let files = vec![
        apply_patch_to_file(&root, CONTROLLER_BASE_FILE, patch_controller_base),
        apply_patch_to_file(&root, USER_ID_FILE, |source| {
            patch_get_user_id(source, user_id)
        }),
    ];
    let complete = files
        .iter()
        .all(|file| matches!(file.status.as_str(), "applied" | "already_applied" | "updated"));
    Ok(LocalAuthBypassReport {
        worktree: root.to_string_lossy().into_owned(),
        user_id,
        files,
        complete,
    })
}

/// Links `<worktree>/node_modules` to a shared dependency store.
///
/// A worktree that already has anything at `node_modules` — a real install or
/// an older link — is left exactly as it is. Nothing is ever deleted here.
pub fn link_shared_node_modules_inner(
    worktree: String,
    store: String,
) -> Result<NodeModulesLinkReport, String> {
    let root = resolved_directory(&worktree)?;
    let store_trimmed = store.trim().to_string();
    let report = |status: &str, detail: String| NodeModulesLinkReport {
        worktree: root.to_string_lossy().into_owned(),
        store: store_trimmed.clone(),
        status: status.to_string(),
        detail,
    };
    if store_trimmed.is_empty() {
        return Ok(report("not_configured", String::new()));
    }
    let link = root.join("node_modules");
    if fs::symlink_metadata(&link).is_ok() {
        return Ok(report("already_present", String::new()));
    }
    let target = PathBuf::from(&store_trimmed);
    if !target.is_dir() {
        return Ok(report("store_missing", store_trimmed.clone()));
    }
    match create_directory_link(&link, &target) {
        Ok(()) => Ok(report("created", String::new())),
        Err(error) => Ok(report("link_failed", error)),
    }
}

/// Windows directory junction, which needs no elevation, or a plain symlink
/// elsewhere.
#[cfg(windows)]
fn create_directory_link(link: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // `mklink` is a `cmd` builtin, so the whole invocation is handed over as one
    // raw string: Rust's per-argument quoting is not what `cmd` parses.
    let mut command = Command::new("cmd");
    command.arg("/C").raw_arg(format!(
        "mklink /J \"{}\" \"{}\"",
        link.display(),
        target.display()
    ));
    hide_console(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("mklink_exec_failed:{error}"))?;
    if output.status.success() && fs::symlink_metadata(link).is_ok() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if stderr.is_empty() { stdout } else { stderr })
}

#[cfg(not(windows))]
fn create_directory_link(link: &Path, target: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn local_auth_bypass_apply(
    worktree: String,
    user_id: u32,
) -> Result<LocalAuthBypassReport, String> {
    tokio::task::spawn_blocking(move || apply_local_auth_bypass_inner(worktree, user_id))
        .await
        .map_err(|error| format!("local_auth_bypass_apply:blocking task failed:{error}"))?
}

#[tauri::command]
pub async fn shared_node_modules_link(
    worktree: String,
    store: String,
) -> Result<NodeModulesLinkReport, String> {
    tokio::task::spawn_blocking(move || link_shared_node_modules_inner(worktree, store))
        .await
        .map_err(|error| format!("shared_node_modules_link:blocking task failed:{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const CONTROLLER: &str = "using System;\nusing Microsoft.AspNetCore.Mvc;\n\nnamespace NPlan.Api.Controllers\n{\n    [ApiController]\n    [Route(\"api/[controller]\")]\n    public abstract class NPlanControllerBase : ControllerBase\n    {\n        protected int Something() => 1;\n    }\n}\n";

    const USER_ID: &str = "using System;\n\nnamespace NPlan.Core.Extensions\n{\n    public static class HttpContextExtensions\n    {\n        public static int GetUserId(this HttpContext context)\n        {\n            var claim = context.User.FindFirst(\"sub\");\n            return int.Parse(claim.Value);\n        }\n    }\n}\n";

    fn applied(outcome: PatchOutcome) -> String {
        match outcome {
            PatchOutcome::Applied(text) => text,
            other => panic!("expected an applied patch, got {other:?}"),
        }
    }

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("alethe-local-dev-{label}-{nanos}"))
    }

    #[test]
    fn adds_the_using_and_the_attribute_above_the_controller_base() {
        let patched = applied(patch_controller_base(CONTROLLER));
        assert!(patched.contains(AUTHORIZATION_USING));
        let attribute = patched
            .lines()
            .position(|line| line.trim() == "[AllowAnonymous]")
            .expect("attribute must be inserted");
        let declaration = patched
            .lines()
            .position(|line| line.contains("class NPlanControllerBase"))
            .expect("declaration must survive");
        assert_eq!(attribute + 1, declaration);
        // The insert keeps the declaration's indentation.
        assert!(patched.contains("    [AllowAnonymous]\n    public abstract class"));
        // The using lands after the last existing one, never inside the body.
        assert!(patched.starts_with(
            "using System;\nusing Microsoft.AspNetCore.Mvc;\nusing Microsoft.AspNetCore.Authorization;\n"
        ));
    }

    #[test]
    fn patching_the_controller_base_twice_changes_nothing_the_second_time() {
        let once = applied(patch_controller_base(CONTROLLER));
        assert_eq!(patch_controller_base(&once), PatchOutcome::AlreadyApplied);
        // A hand-written variant with the using already present is recognized too.
        let hand_written = CONTROLLER
            .replace(
                "using Microsoft.AspNetCore.Mvc;",
                "using Microsoft.AspNetCore.Mvc;\nusing Microsoft.AspNetCore.Authorization;",
            )
            .replace(
                "    public abstract class",
                "    [AllowAnonymous]\n    public abstract class",
            );
        assert_eq!(
            patch_controller_base(&hand_written),
            PatchOutcome::AlreadyApplied
        );
    }

    #[test]
    fn an_attribute_on_another_type_is_not_mistaken_for_the_bypass() {
        let other = CONTROLLER.replace(
            "namespace NPlan.Api.Controllers\n{",
            "namespace NPlan.Api.Controllers\n{\n    [AllowAnonymous]\n    public class HealthController : ControllerBase { }\n",
        );
        assert!(!has_allow_anonymous_on_controller_base(&other));
        assert!(matches!(
            patch_controller_base(&other),
            PatchOutcome::Applied(_)
        ));
    }

    #[test]
    fn reports_an_unexpected_shape_instead_of_writing_something_broken() {
        let refactored = "using System;\n\npublic interface IController { }\n";
        assert_eq!(
            patch_controller_base(refactored),
            PatchOutcome::UnexpectedShape("controller_base_declaration_not_found")
        );
        let expression_bodied =
            "public static int GetUserId(this HttpContext context) => context.Count;\n";
        assert_eq!(
            patch_get_user_id(expression_bodied, 9),
            PatchOutcome::UnexpectedShape("get_user_id_body_not_found")
        );
    }

    #[test]
    fn makes_the_fixed_return_the_first_statement_of_get_user_id() {
        let patched = applied(patch_get_user_id(USER_ID, 9));
        let lines: Vec<&str> = patched.lines().collect();
        let method = lines
            .iter()
            .position(|line| line.contains("GetUserId("))
            .expect("declaration must survive");
        // Declaration, its brace, then the fixed return — nothing between them.
        assert_eq!(lines[method + 1].trim(), "{");
        assert_eq!(lines[method + 2].trim(), "return 9;");
        // The body indentation matches the method's own, plus one level.
        assert!(patched.contains("            return 9;"));
        // The original body survives below the inserted return.
        assert!(patched.contains("var claim = context.User.FindFirst"));
        assert_eq!(hardcoded_user_id(&patched), Some(9));
    }

    #[test]
    fn patching_get_user_id_twice_never_duplicates_the_return() {
        let once = applied(patch_get_user_id(USER_ID, 9));
        assert_eq!(patch_get_user_id(&once, 9), PatchOutcome::AlreadyApplied);
        assert_eq!(once.matches("return 9;").count(), 1);
        // A previously applied patch with another id is rewritten, not stacked.
        let rewritten = applied(patch_get_user_id(&once, 7));
        assert_eq!(rewritten.matches("return 7;").count(), 1);
        assert!(!rewritten.contains("return 9;"));
        assert_eq!(hardcoded_user_id(&rewritten), Some(7));
    }

    #[test]
    fn keeps_crlf_files_on_crlf() {
        let crlf = CONTROLLER.replace('\n', "\r\n");
        let patched = applied(patch_controller_base(&crlf));
        // Every line ending stays CRLF: no lone LF is introduced anywhere.
        assert_eq!(patched.matches('\n').count(), patched.matches("\r\n").count());
        assert!(patched.contains("    [AllowAnonymous]\r\n"));
        assert_eq!(patch_controller_base(&patched), PatchOutcome::AlreadyApplied);
    }

    #[test]
    fn the_guard_sees_the_bypass_in_source_and_ignores_clean_files() {
        assert_eq!(bypass_in_source(CONTROLLER), None);
        assert_eq!(bypass_in_source(USER_ID), None);
        assert_eq!(
            bypass_in_source(&applied(patch_controller_base(CONTROLLER))),
            Some("allow_anonymous_on_controller_base")
        );
        assert_eq!(
            bypass_in_source(&applied(patch_get_user_id(USER_ID, 9))),
            Some("hardcoded_get_user_id")
        );
        // A method that legitimately returns a constant later in the body is
        // not the bypass: only the first statement counts.
        let legitimate = USER_ID.replace(
            "return int.Parse(claim.Value);",
            "if (claim == null) return 0;\n            return int.Parse(claim.Value);",
        );
        assert_eq!(bypass_in_source(&legitimate), None);
    }

    #[test]
    fn the_guard_blocks_a_cached_diff_that_adds_either_half() {
        let controller_diff = "diff --git a/NPlan.Api/Controllers/NPlanControllerBase.cs b/NPlan.Api/Controllers/NPlanControllerBase.cs\n--- a/NPlan.Api/Controllers/NPlanControllerBase.cs\n+++ b/NPlan.Api/Controllers/NPlanControllerBase.cs\n@@ -5,6 +5,7 @@ namespace NPlan.Api.Controllers\n     [ApiController]\n+    [AllowAnonymous]\n     public abstract class NPlanControllerBase : ControllerBase\n";
        assert_eq!(
            bypass_in_diff(controller_diff),
            Some("allow_anonymous_on_controller_base")
        );
        let user_diff = "diff --git a/NPlan.Core/Extensions/HttpContextExtensions.cs b/NPlan.Core/Extensions/HttpContextExtensions.cs\n--- a/NPlan.Core/Extensions/HttpContextExtensions.cs\n+++ b/NPlan.Core/Extensions/HttpContextExtensions.cs\n@@ -7,6 +7,7 @@ public static int GetUserId(this HttpContext context)\n         {\n+            return 9;\n             var claim = context.User.FindFirst(\"sub\");\n";
        assert_eq!(bypass_in_diff(user_diff), Some("hardcoded_get_user_id"));
    }

    #[test]
    fn the_guard_lets_an_unrelated_change_through() {
        let clean = "diff --git a/NPlan.Api/Controllers/OrderController.cs b/NPlan.Api/Controllers/OrderController.cs\n--- a/NPlan.Api/Controllers/OrderController.cs\n+++ b/NPlan.Api/Controllers/OrderController.cs\n@@ -10,6 +10,7 @@ public class OrderController\n     public int Total()\n     {\n+        return 42;\n     }\n";
        assert_eq!(bypass_in_diff(clean), None);
        // An added attribute in a file that never mentions the base controller
        // is not this bypass.
        let other_attribute = "diff --git a/NPlan.Api/Controllers/PingController.cs b/NPlan.Api/Controllers/PingController.cs\n--- a/NPlan.Api/Controllers/PingController.cs\n+++ b/NPlan.Api/Controllers/PingController.cs\n@@ -1,3 +1,4 @@ public class PingController\n+[AllowAnonymous]\n public class PingController { }\n";
        assert_eq!(bypass_in_diff(other_attribute), None);
    }

    #[test]
    fn applies_both_edits_inside_a_worktree_and_stays_idempotent() {
        let root = temp_dir("apply");
        fs::create_dir_all(root.join("NPlan.Api/Controllers")).expect("controller directory");
        fs::create_dir_all(root.join("NPlan.Core/Extensions")).expect("extension directory");
        fs::write(root.join(CONTROLLER_BASE_FILE), CONTROLLER).expect("controller file");
        fs::write(root.join(USER_ID_FILE), USER_ID).expect("extension file");

        let first = apply_local_auth_bypass_inner(root.to_string_lossy().into_owned(), 9)
            .expect("first apply");
        assert!(first.complete);
        assert_eq!(
            first.files.iter().map(|f| f.status.as_str()).collect::<Vec<_>>(),
            vec!["applied", "applied"]
        );

        let after_first = fs::read_to_string(root.join(USER_ID_FILE)).expect("read back");
        let second = apply_local_auth_bypass_inner(root.to_string_lossy().into_owned(), 9)
            .expect("second apply");
        assert!(second.complete);
        assert_eq!(
            second.files.iter().map(|f| f.status.as_str()).collect::<Vec<_>>(),
            vec!["already_applied", "already_applied"]
        );
        assert_eq!(
            fs::read_to_string(root.join(USER_ID_FILE)).expect("read back"),
            after_first,
            "a second apply must not rewrite the file"
        );
        // The guard now refuses to stage either file.
        assert_eq!(
            bypass_in_paths(&root, &[CONTROLLER_BASE_FILE.to_string()]),
            Some("allow_anonymous_on_controller_base")
        );
        assert_eq!(
            bypass_in_paths(&root, &[".".to_string()]),
            Some("allow_anonymous_on_controller_base")
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn reports_a_refactored_backend_instead_of_writing_anything() {
        let root = temp_dir("shape");
        fs::create_dir_all(root.join("NPlan.Api/Controllers")).expect("controller directory");
        fs::write(
            root.join(CONTROLLER_BASE_FILE),
            "public interface IThing { }\n",
        )
        .expect("controller file");
        let report = apply_local_auth_bypass_inner(root.to_string_lossy().into_owned(), 9)
            .expect("apply");
        assert!(!report.complete);
        assert_eq!(report.files[0].status, "unexpected_shape");
        assert_eq!(report.files[0].detail, "controller_base_declaration_not_found");
        // The second file is simply absent here, and that is reported as such.
        assert_eq!(report.files[1].status, "file_missing");
        assert_eq!(
            fs::read_to_string(root.join(CONTROLLER_BASE_FILE)).expect("read back"),
            "public interface IThing { }\n"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn links_a_worktree_to_the_shared_store_once() {
        let base = temp_dir("link");
        let worktree = base.join("front");
        let store = base.join("shared/node_modules");
        fs::create_dir_all(&worktree).expect("worktree");
        fs::create_dir_all(store.join(".bin")).expect("store");

        let created = link_shared_node_modules_inner(
            worktree.to_string_lossy().into_owned(),
            store.to_string_lossy().into_owned(),
        )
        .expect("link");
        assert_eq!(created.status, "created", "detail: {}", created.detail);
        assert!(created.usable());
        assert!(worktree.join("node_modules/.bin").is_dir());

        let again = link_shared_node_modules_inner(
            worktree.to_string_lossy().into_owned(),
            store.to_string_lossy().into_owned(),
        )
        .expect("second link");
        assert_eq!(again.status, "already_present");
        assert!(again.usable());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn never_replaces_a_real_node_modules_and_says_when_the_store_is_missing() {
        let base = temp_dir("guarded");
        let worktree = base.join("front");
        fs::create_dir_all(worktree.join("node_modules/react")).expect("real install");
        let report = link_shared_node_modules_inner(
            worktree.to_string_lossy().into_owned(),
            base.join("absent").to_string_lossy().into_owned(),
        )
        .expect("link");
        assert_eq!(report.status, "already_present");
        assert!(worktree.join("node_modules/react").is_dir());

        let empty = base.join("empty");
        fs::create_dir_all(&empty).expect("empty worktree");
        let missing = link_shared_node_modules_inner(
            empty.to_string_lossy().into_owned(),
            base.join("absent").to_string_lossy().into_owned(),
        )
        .expect("link");
        assert_eq!(missing.status, "store_missing");
        assert!(!missing.usable());
        assert!(!empty.join("node_modules").exists());

        let unset = link_shared_node_modules_inner(
            empty.to_string_lossy().into_owned(),
            "   ".to_string(),
        )
        .expect("link");
        assert_eq!(unset.status, "not_configured");
        assert!(!unset.usable());
        fs::remove_dir_all(&base).ok();
    }
}
