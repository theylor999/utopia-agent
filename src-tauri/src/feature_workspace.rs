//! Transactional feature workspaces backed by named Git worktrees.
//!
//! The frontend supplies intent only. This module owns branch validation,
//! repository resolution, deterministic paths, collision checks, Git mutation,
//! and rollback.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::git_control::{checked_output, git_command, main_repository_root};
use crate::worktrees::git_arg;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FeatureKind {
    Backend,
    Frontend,
    BackendFrontend,
    Scripts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FeatureRole {
    Backend,
    Frontend,
    Scripts,
}

impl FeatureRole {
    fn as_str(self) -> &'static str {
        match self {
            Self::Backend => "backend",
            Self::Frontend => "frontend",
            Self::Scripts => "scripts",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureWorkspaceSource {
    pub role: FeatureRole,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureWorkspaceRequest {
    pub kind: FeatureKind,
    pub category: String,
    pub name: String,
    pub sources: Vec<FeatureWorkspaceSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureWorkspaceItem {
    pub role: FeatureRole,
    pub source: String,
    pub destination: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureWorkspacePlan {
    pub branch: String,
    pub workspace_root: String,
    pub items: Vec<FeatureWorkspaceItem>,
}

pub type FeatureWorkspaceResult = FeatureWorkspacePlan;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureWorkspaceRemovalItem {
    pub role: FeatureRole,
    pub source: String,
    pub destination: String,
    pub worktree_removed: bool,
    pub branch_removed: bool,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureWorkspaceRemovalResult {
    pub branch: String,
    pub workspace_root: String,
    pub items: Vec<FeatureWorkspaceRemovalItem>,
    pub workspace_root_removed: bool,
    pub errors: Vec<String>,
    pub complete: bool,
}

#[derive(Debug, Clone)]
struct ResolvedFeatureWorkspace {
    plan: FeatureWorkspacePlan,
    roots: Vec<PathBuf>,
    workspace_root: PathBuf,
    destinations: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
struct CreatedWorkspaceItem {
    index: usize,
    branch_oid: String,
}

#[derive(Debug, Clone)]
struct RegisteredWorktree {
    branch: Option<String>,
}

#[tauri::command]
pub async fn feature_workspace_plan(
    request: FeatureWorkspaceRequest,
) -> Result<FeatureWorkspacePlan, String> {
    tokio::task::spawn_blocking(move || feature_workspace_plan_inner(request))
        .await
        .map_err(|error| format!("feature_workspace_plan:blocking task failed:{error}"))?
}

#[tauri::command]
pub async fn feature_workspace_create(
    request: FeatureWorkspaceRequest,
) -> Result<FeatureWorkspaceResult, String> {
    tokio::task::spawn_blocking(move || feature_workspace_create_inner(request))
        .await
        .map_err(|error| format!("feature_workspace_create:blocking task failed:{error}"))?
}

#[tauri::command]
pub async fn feature_workspace_remove(
    workspace: FeatureWorkspaceResult,
) -> Result<FeatureWorkspaceRemovalResult, String> {
    tokio::task::spawn_blocking(move || feature_workspace_remove_inner(workspace))
        .await
        .map_err(|error| format!("feature_workspace_remove:blocking task failed:{error}"))?
}

pub(crate) fn feature_workspace_plan_inner(
    request: FeatureWorkspaceRequest,
) -> Result<FeatureWorkspacePlan, String> {
    Ok(resolve_request(request, true)?.plan)
}

pub(crate) fn feature_workspace_create_inner(
    request: FeatureWorkspaceRequest,
) -> Result<FeatureWorkspaceResult, String> {
    let resolved = resolve_request(request, true)?;
    create_planned_workspace(&resolved, add_named_worktree)
}

pub(crate) fn feature_workspace_remove_inner(
    workspace: FeatureWorkspaceResult,
) -> Result<FeatureWorkspaceRemovalResult, String> {
    let resolved = resolve_workspace_descriptor(&workspace)?;
    let mut items = Vec::with_capacity(resolved.plan.items.len());

    for (index, item) in resolved.plan.items.iter().enumerate() {
        items.push(remove_workspace_item(
            item,
            &resolved.roots[index],
            &resolved.destinations[index],
            &resolved.plan.branch,
        ));
    }

    let mut errors = Vec::new();
    let workspace_root_removed = match fs::remove_dir(&resolved.workspace_root) {
        Ok(()) => true,
        Err(error) if error.kind() == ErrorKind::NotFound => true,
        Err(error) => {
            errors.push(format!("workspace_root_remove:{error}"));
            false
        }
    };
    let complete = workspace_root_removed
        && errors.is_empty()
        && items.iter().all(|item| {
            item.worktree_removed && item.branch_removed && item.errors.is_empty()
        });

    Ok(FeatureWorkspaceRemovalResult {
        branch: resolved.plan.branch,
        workspace_root: resolved.plan.workspace_root,
        items,
        workspace_root_removed,
        errors,
        complete,
    })
}

fn expected_roles(kind: FeatureKind) -> &'static [FeatureRole] {
    match kind {
        FeatureKind::Backend => &[FeatureRole::Backend],
        FeatureKind::Frontend => &[FeatureRole::Frontend],
        FeatureKind::BackendFrontend => &[FeatureRole::Backend, FeatureRole::Frontend],
        FeatureKind::Scripts => &[FeatureRole::Scripts],
    }
}

fn resolve_request(
    request: FeatureWorkspaceRequest,
    check_collisions: bool,
) -> Result<ResolvedFeatureWorkspace, String> {
    let expected = expected_roles(request.kind);
    if request.sources.len() != expected.len() {
        return Err("invalid_source_count".to_string());
    }

    let mut sources_by_role = HashMap::with_capacity(request.sources.len());
    for source in &request.sources {
        if sources_by_role.insert(source.role, source).is_some() {
            return Err("invalid_source_roles".to_string());
        }
    }
    if expected
        .iter()
        .any(|role| !sources_by_role.contains_key(role))
    {
        return Err("invalid_source_roles".to_string());
    }

    let category = request.category.trim();
    let name = request.name.trim();
    if category.is_empty()
        || name.is_empty()
        || category.contains('/')
        || category.contains('\\')
        || name.contains('/')
        || name.contains('\\')
    {
        return Err("invalid_branch".to_string());
    }
    let branch = format!("{category}/{name}");

    let mut roots = Vec::with_capacity(expected.len());
    let mut unique_roots = HashSet::with_capacity(expected.len());
    for role in expected {
        let source = sources_by_role
            .get(role)
            .expect("validated feature role must have a source");
        let root = main_repository_root(source.path.trim())?;
        let root_key = comparable_path(&root);
        if !unique_roots.insert(root_key) {
            return Err(format!("duplicate_source:{}", git_arg(&root)));
        }
        roots.push(root);
    }

    validate_branch(&roots[0], &branch)?;
    let workspace_parent = roots[0]
        .parent()
        .ok_or_else(|| "invalid_repository_root".to_string())?;
    let workspace_root = workspace_parent.join(branch_slug(&branch)?);
    let destinations: Vec<PathBuf> = expected
        .iter()
        .map(|role| workspace_root.join(role.as_str()))
        .collect();
    let items = expected
        .iter()
        .enumerate()
        .map(|(index, role)| FeatureWorkspaceItem {
            role: *role,
            source: git_arg(&roots[index]),
            destination: git_arg(&destinations[index]),
        })
        .collect();
    let resolved = ResolvedFeatureWorkspace {
        plan: FeatureWorkspacePlan {
            branch,
            workspace_root: git_arg(&workspace_root),
            items,
        },
        roots,
        workspace_root,
        destinations,
    };

    if check_collisions {
        preflight(&resolved)?;
    }
    Ok(resolved)
}

fn validate_branch(root: &Path, branch: &str) -> Result<(), String> {
    let output = git_command(root, &["check-ref-format", "--branch", branch])?;
    if output.status.success() {
        Ok(())
    } else {
        Err("invalid_branch".to_string())
    }
}

fn branch_slug(branch: &str) -> Result<String, String> {
    let mut slug = String::with_capacity(branch.len());
    let mut separator = false;
    for character in branch.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            separator = false;
        } else if !separator && !slug.is_empty() {
            slug.push('-');
            separator = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        Err("invalid_branch".to_string())
    } else {
        Ok(slug)
    }
}

fn preflight(resolved: &ResolvedFeatureWorkspace) -> Result<(), String> {
    if path_occupied(&resolved.workspace_root)? {
        return Err(format!(
            "destination_exists:{}",
            git_arg(&resolved.workspace_root)
        ));
    }

    for (index, item) in resolved.plan.items.iter().enumerate() {
        ensure_item_available(
            item,
            &resolved.roots[index],
            &resolved.destinations[index],
            &resolved.plan.branch,
        )?;
    }
    Ok(())
}

fn ensure_item_available(
    item: &FeatureWorkspaceItem,
    root: &Path,
    destination: &Path,
    branch: &str,
) -> Result<(), String> {
    if local_branch_exists(root, branch)? {
        return Err(format!("branch_exists:{}: {}", item.role.as_str(), item.source));
    }
    if path_occupied(destination)? || registered_worktree(root, destination)?.is_some() {
        return Err(format!(
            "destination_exists:{}: {}",
            item.role.as_str(),
            item.destination
        ));
    }
    Ok(())
}

fn path_occupied(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("path_check_failed:{error}")),
    }
}

fn revision_oid(root: &Path, revision: &str) -> Result<String, String> {
    let output = checked_output(root, &["rev-parse", "--verify", revision])?;
    let oid = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if oid.is_empty() {
        Err("git_command_failed".to_string())
    } else {
        Ok(oid)
    }
}

fn local_branch_oid(root: &Path, branch: &str) -> Result<Option<String>, String> {
    let reference = format!("refs/heads/{branch}");
    let output = git_command(root, &["rev-parse", "--verify", "--quiet", &reference])?;
    if output.status.success() {
        let oid = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return if oid.is_empty() {
            Err("git_command_failed".to_string())
        } else {
            Ok(Some(oid))
        };
    }
    if output.status.code() == Some(1) {
        return Ok(None);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        "git_command_failed".to_string()
    } else {
        format!("git_command_failed:{stderr}")
    })
}

fn local_branch_exists(root: &Path, branch: &str) -> Result<bool, String> {
    Ok(local_branch_oid(root, branch)?.is_some())
}

fn registered_worktree(
    root: &Path,
    destination: &Path,
) -> Result<Option<RegisteredWorktree>, String> {
    let output = checked_output(root, &["worktree", "list", "--porcelain"])?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut current_path: Option<PathBuf> = None;
    let mut current_branch = None;

    for line in text.lines().chain(std::iter::once("")) {
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(PathBuf::from(path));
        } else if let Some(branch) = line.strip_prefix("branch ") {
            current_branch = Some(branch.to_string());
        } else if line.is_empty() {
            if current_path
                .as_deref()
                .is_some_and(|path| same_path(path, destination))
            {
                return Ok(Some(RegisteredWorktree {
                    branch: current_branch,
                }));
            }
            current_path = None;
            current_branch = None;
        }
    }
    Ok(None)
}

fn comparable_path(path: &Path) -> String {
    let value = git_arg(path).replace('\\', "/");
    let trimmed = value.trim_end_matches('/');
    #[cfg(windows)]
    {
        trimmed.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        trimmed.to_string()
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    comparable_path(left) == comparable_path(right)
}

fn add_named_worktree(root: &Path, branch: &str, destination: &Path) -> Result<(), String> {
    let destination = git_arg(destination);
    checked_output(
        root,
        &[
            "worktree",
            "add",
            "--no-track",
            "-b",
            branch,
            &destination,
            "HEAD",
        ],
    )?;
    Ok(())
}

fn create_planned_workspace<F>(
    resolved: &ResolvedFeatureWorkspace,
    mut add_worktree: F,
) -> Result<FeatureWorkspaceResult, String>
where
    F: FnMut(&Path, &str, &Path) -> Result<(), String>,
{
    fs::create_dir(&resolved.workspace_root).map_err(|error| {
        if error.kind() == ErrorKind::AlreadyExists {
            format!("destination_exists:{}", resolved.plan.workspace_root)
        } else {
            format!("mkdir_failed:{error}")
        }
    })?;

    let mut created = Vec::with_capacity(resolved.plan.items.len());
    for (index, item) in resolved.plan.items.iter().enumerate() {
        if let Err(error) = ensure_item_available(
            item,
            &resolved.roots[index],
            &resolved.destinations[index],
            &resolved.plan.branch,
        ) {
            let rollback_errors = rollback_created(resolved, &created, None);
            return Err(create_error(error, rollback_errors));
        }
        let branch_oid = match revision_oid(&resolved.roots[index], "HEAD") {
            Ok(oid) => oid,
            Err(error) => {
                let rollback_errors = rollback_created(resolved, &created, None);
                return Err(create_error(error, rollback_errors));
            }
        };

        match add_worktree(
            &resolved.roots[index],
            &resolved.plan.branch,
            &resolved.destinations[index],
        ) {
            Ok(()) => created.push(CreatedWorkspaceItem { index, branch_oid }),
            Err(error) => {
                let rollback_errors = rollback_created(resolved, &created, Some(index));
                return Err(create_error(error, rollback_errors));
            }
        }
    }

    Ok(resolved.plan.clone())
}

fn rollback_created(
    resolved: &ResolvedFeatureWorkspace,
    created: &[CreatedWorkspaceItem],
    failed_add: Option<usize>,
) -> Vec<String> {
    let mut errors = Vec::new();
    if let Some(index) = failed_add {
        record_failed_add_residue(resolved, index, &mut errors);
    }
    for created_item in created.iter().rev() {
        rollback_item(resolved, created_item, &mut errors);
    }

    match fs::remove_dir(&resolved.workspace_root) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => errors.push(format!("workspace_root_remove:{error}")),
    }
    errors
}

fn record_failed_add_residue(
    resolved: &ResolvedFeatureWorkspace,
    index: usize,
    errors: &mut Vec<String>,
) {
    let item = &resolved.plan.items[index];
    let root = &resolved.roots[index];
    let destination = &resolved.destinations[index];

    match registered_worktree(root, destination) {
        Ok(Some(_)) => errors.push(format!(
            "{}:failed_add_worktree_ownership_unknown",
            item.role.as_str()
        )),
        Ok(None) => {}
        Err(error) => errors.push(format!("{}:worktree_list:{error}", item.role.as_str())),
    }
    match path_occupied(destination) {
        Ok(true) => errors.push(format!(
            "{}:failed_add_destination_ownership_unknown",
            item.role.as_str()
        )),
        Ok(false) => {}
        Err(error) => errors.push(format!("{}:{error}", item.role.as_str())),
    }
    match local_branch_exists(root, &resolved.plan.branch) {
        Ok(true) => errors.push(format!(
            "{}:failed_add_branch_ownership_unknown",
            item.role.as_str()
        )),
        Ok(false) => {}
        Err(error) => errors.push(format!("{}:branch_check:{error}", item.role.as_str())),
    }
}

fn rollback_item(
    resolved: &ResolvedFeatureWorkspace,
    created: &CreatedWorkspaceItem,
    errors: &mut Vec<String>,
) {
    let item = &resolved.plan.items[created.index];
    let root = &resolved.roots[created.index];
    let destination = &resolved.destinations[created.index];
    let expected_ref = format!("refs/heads/{}", resolved.plan.branch);

    let owns_worktree = match registered_worktree(root, destination) {
        Ok(Some(worktree)) if worktree.branch.as_deref() == Some(expected_ref.as_str()) => {
            match local_branch_oid(root, &resolved.plan.branch) {
                Ok(Some(oid)) if oid == created.branch_oid => true,
                Ok(_) => {
                    errors.push(format!(
                        "{}:branch_ownership_mismatch",
                        item.role.as_str()
                    ));
                    false
                }
                Err(error) => {
                    errors.push(format!("{}:branch_check:{error}", item.role.as_str()));
                    false
                }
            }
        }
        Ok(Some(_)) => {
            errors.push(format!(
                "{}:worktree_ownership_mismatch",
                item.role.as_str()
            ));
            false
        }
        Ok(None) => {
            errors.push(format!("{}:worktree_ownership_lost", item.role.as_str()));
            false
        }
        Err(error) => {
            errors.push(format!("{}:worktree_list:{error}", item.role.as_str()));
            false
        }
    };

    if !owns_worktree {
        return;
    }
    let destination_arg = git_arg(destination);
    if let Err(error) = checked_output(
        root,
        &["worktree", "remove", "--force", &destination_arg],
    ) {
        errors.push(format!("{}:worktree_remove:{error}", item.role.as_str()));
        return;
    }
    if let Err(error) = delete_owned_branch(root, &resolved.plan.branch, &created.branch_oid) {
        errors.push(format!("{}:branch_remove:{error}", item.role.as_str()));
    }
}

fn create_error(error: String, rollback_errors: Vec<String>) -> String {
    if rollback_errors.is_empty() {
        error
    } else {
        format!(
            "feature_workspace_create_failed:{error};rollback_failed:{}",
            rollback_errors.join("|")
        )
    }
}

fn delete_branch(root: &Path, branch: &str) -> Result<(), String> {
    checked_output(root, &["branch", "-D", "--", branch])?;
    Ok(())
}

fn delete_owned_branch(root: &Path, branch: &str, expected_oid: &str) -> Result<(), String> {
    match local_branch_oid(root, branch)? {
        None => Ok(()),
        Some(current_oid) if current_oid == expected_oid => delete_branch(root, branch),
        Some(_) => Err("branch_ownership_mismatch".to_string()),
    }
}

fn resolve_workspace_descriptor(
    workspace: &FeatureWorkspaceResult,
) -> Result<ResolvedFeatureWorkspace, String> {
    let mut branch_parts = workspace.branch.split('/');
    let category = branch_parts.next().unwrap_or_default();
    let name = branch_parts.next().unwrap_or_default();
    if category.is_empty() || name.is_empty() || branch_parts.next().is_some() {
        return Err("invalid_workspace_descriptor".to_string());
    }

    let kind = match workspace.items.as_slice() {
        [item] if item.role == FeatureRole::Backend => FeatureKind::Backend,
        [item] if item.role == FeatureRole::Frontend => FeatureKind::Frontend,
        [item] if item.role == FeatureRole::Scripts => FeatureKind::Scripts,
        [backend, frontend]
            if backend.role == FeatureRole::Backend && frontend.role == FeatureRole::Frontend =>
        {
            FeatureKind::BackendFrontend
        }
        _ => return Err("invalid_workspace_descriptor".to_string()),
    };
    let request = FeatureWorkspaceRequest {
        kind,
        category: category.to_string(),
        name: name.to_string(),
        sources: workspace
            .items
            .iter()
            .map(|item| FeatureWorkspaceSource {
                role: item.role,
                path: item.source.clone(),
            })
            .collect(),
    };
    let resolved = resolve_request(request, false)?;
    if resolved.plan.branch != workspace.branch
        || !same_path(
            Path::new(&resolved.plan.workspace_root),
            Path::new(&workspace.workspace_root),
        )
        || resolved.plan.items.len() != workspace.items.len()
        || resolved
            .plan
            .items
            .iter()
            .zip(&workspace.items)
            .any(|(expected, actual)| {
                expected.role != actual.role
                    || !same_path(Path::new(&expected.source), Path::new(&actual.source))
                    || !same_path(
                        Path::new(&expected.destination),
                        Path::new(&actual.destination),
                    )
            })
    {
        return Err("invalid_workspace_descriptor".to_string());
    }
    Ok(resolved)
}

fn remove_workspace_item(
    item: &FeatureWorkspaceItem,
    root: &Path,
    destination: &Path,
    branch: &str,
) -> FeatureWorkspaceRemovalItem {
    let mut errors = Vec::new();
    let mut owned_branch_oid = None;
    let expected_ref = format!("refs/heads/{branch}");
    let worktree_removed = match registered_worktree(root, destination) {
        Ok(Some(worktree)) if worktree.branch.as_deref() == Some(expected_ref.as_str()) => {
            match local_branch_oid(root, branch) {
                Ok(oid) => owned_branch_oid = oid,
                Err(error) => {
                    errors.push(format!("branch_check:{error}"));
                    return FeatureWorkspaceRemovalItem {
                        role: item.role,
                        source: item.source.clone(),
                        destination: item.destination.clone(),
                        worktree_removed: false,
                        branch_removed: false,
                        errors,
                    };
                }
            }
            let destination_arg = git_arg(destination);
            match checked_output(
                root,
                &["worktree", "remove", "--force", &destination_arg],
            ) {
                Ok(_) => true,
                Err(error) => {
                    errors.push(format!("worktree_remove:{error}"));
                    false
                }
            }
        }
        Ok(Some(_)) => {
            errors.push("worktree_ownership_mismatch".to_string());
            false
        }
        Ok(None) => match path_occupied(destination) {
            Ok(false) => true,
            Ok(true) => {
                errors.push("destination_not_registered".to_string());
                false
            }
            Err(error) => {
                errors.push(error);
                false
            }
        },
        Err(error) => {
            errors.push(format!("worktree_list:{error}"));
            false
        }
    };

    let branch_removed = if !worktree_removed {
        false
    } else if let Some(expected_oid) = owned_branch_oid {
        match delete_owned_branch(root, branch, &expected_oid) {
            Ok(()) => true,
            Err(error) => {
                errors.push(format!("branch_remove:{error}"));
                false
            }
        }
    } else {
        match local_branch_oid(root, branch) {
            Ok(None) => true,
            Ok(Some(_)) => {
                errors.push("branch_ownership_unknown".to_string());
                false
            }
            Err(error) => {
                errors.push(format!("branch_check:{error}"));
                false
            }
        }
    };

    FeatureWorkspaceRemovalItem {
        role: item.role,
        source: item.source.clone(),
        destination: item.destination.clone(),
        worktree_removed,
        branch_removed,
        errors,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("alethe-feature-workspace-{label}-{nanos}"))
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .expect("git must run in test");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo(path: &Path) {
        fs::create_dir_all(path).expect("repo directory");
        run_git(path, &["init"]);
        run_git(path, &["config", "user.email", "alethe@example.test"]);
        run_git(path, &["config", "user.name", "Alethe Test"]);
        fs::write(path.join("README.txt"), "fixture\n").expect("fixture file");
        run_git(path, &["add", "README.txt"]);
        run_git(path, &["commit", "-m", "fixture"]);
    }

    fn source(role: FeatureRole, path: &Path) -> FeatureWorkspaceSource {
        FeatureWorkspaceSource {
            role,
            path: git_arg(path),
        }
    }

    fn request(
        kind: FeatureKind,
        name: &str,
        sources: Vec<FeatureWorkspaceSource>,
    ) -> FeatureWorkspaceRequest {
        FeatureWorkspaceRequest {
            kind,
            category: "feature".to_string(),
            name: name.to_string(),
            sources,
        }
    }

    #[test]
    fn rejects_branch_that_git_check_ref_format_rejects() {
        let base = temp_root("invalid-branch");
        let repo = base.join("api");
        init_repo(&repo);
        let request = request(
            FeatureKind::Backend,
            "invalid name",
            vec![source(FeatureRole::Backend, &repo)],
        );

        assert_eq!(
            feature_workspace_plan_inner(request).unwrap_err(),
            "invalid_branch"
        );
        fs::remove_dir_all(base).expect("cleanup fixture");
    }

    #[test]
    fn rejects_wrong_source_count_before_resolving_paths() {
        let request = request(
            FeatureKind::BackendFrontend,
            "paired",
            vec![FeatureWorkspaceSource {
                role: FeatureRole::Backend,
                path: "does-not-need-to-exist".to_string(),
            }],
        );

        assert_eq!(
            feature_workspace_plan_inner(request).unwrap_err(),
            "invalid_source_count"
        );
    }

    #[test]
    fn plans_backend_frontend_and_scripts_as_single_role_workspaces() {
        let base = temp_root("single-kinds");
        let repo = base.join("repo");
        init_repo(&repo);

        for (kind, role, name) in [
            (FeatureKind::Backend, FeatureRole::Backend, "backend-work"),
            (
                FeatureKind::Frontend,
                FeatureRole::Frontend,
                "frontend-work",
            ),
            (FeatureKind::Scripts, FeatureRole::Scripts, "scripts-work"),
        ] {
            let plan = feature_workspace_plan_inner(request(
                kind,
                name,
                vec![source(role, &repo)],
            ))
            .expect("single-role plan");
            assert_eq!(plan.items.len(), 1);
            assert_eq!(plan.items[0].role, role);
            assert!(Path::new(&plan.items[0].destination)
                .ends_with(Path::new(&format!("feature-{name}")).join(role.as_str())));
        }

        fs::remove_dir_all(base).expect("cleanup fixture");
    }

    #[test]
    fn rejects_branch_and_destination_collisions_during_plan() {
        let base = temp_root("collisions");
        let repo = base.join("api");
        init_repo(&repo);
        let request = request(
            FeatureKind::Backend,
            "collision",
            vec![source(FeatureRole::Backend, &repo)],
        );

        run_git(&repo, &["branch", "feature/collision"]);
        let branch_error = feature_workspace_plan_inner(request.clone()).unwrap_err();
        assert!(branch_error.starts_with("branch_exists:"));
        run_git(&repo, &["branch", "-D", "feature/collision"]);

        fs::create_dir(base.join("feature-collision")).expect("workspace collision");
        let destination_error = feature_workspace_plan_inner(request).unwrap_err();
        assert!(destination_error.starts_with("destination_exists:"));
        fs::remove_dir_all(base).expect("cleanup fixture");
    }

    #[test]
    fn paired_plan_is_canonical_and_rejects_duplicate_repositories() {
        let base = temp_root("paired-plan");
        let backend = base.join("api");
        let frontend = base.join("web");
        init_repo(&backend);
        init_repo(&frontend);
        let paired = request(
            FeatureKind::BackendFrontend,
            "paired-plan",
            vec![
                source(FeatureRole::Frontend, &frontend),
                source(FeatureRole::Backend, &backend),
            ],
        );

        let plan = feature_workspace_plan_inner(paired).expect("paired plan");
        assert_eq!(plan.branch, "feature/paired-plan");
        assert_eq!(
            plan.items.iter().map(|item| item.role).collect::<Vec<_>>(),
            vec![FeatureRole::Backend, FeatureRole::Frontend]
        );
        assert!(Path::new(&plan.items[0].destination)
            .ends_with(Path::new("feature-paired-plan").join("backend")));
        assert!(Path::new(&plan.items[1].destination)
            .ends_with(Path::new("feature-paired-plan").join("frontend")));

        let duplicate = request(
            FeatureKind::BackendFrontend,
            "duplicate",
            vec![
                source(FeatureRole::Backend, &backend),
                source(FeatureRole::Frontend, &backend),
            ],
        );
        assert!(
            feature_workspace_plan_inner(duplicate)
                .unwrap_err()
                .starts_with("duplicate_source:")
        );
        fs::remove_dir_all(base).expect("cleanup fixture");
    }

    #[test]
    fn rolls_back_created_worktrees_and_only_their_branches_in_lifo_order() {
        let base = temp_root("rollback");
        let backend = base.join("api");
        let frontend = base.join("web");
        init_repo(&backend);
        init_repo(&frontend);
        let resolved = resolve_request(
            request(
                FeatureKind::BackendFrontend,
                "rollback",
                vec![
                    source(FeatureRole::Backend, &backend),
                    source(FeatureRole::Frontend, &frontend),
                ],
            ),
            true,
        )
        .expect("valid plan");
        let mut attempts = 0;

        let error = create_planned_workspace(&resolved, |root, branch, destination| {
            attempts += 1;
            if attempts == 2 {
                Err("injected_second_add_failure".to_string())
            } else {
                add_named_worktree(root, branch, destination)
            }
        })
        .unwrap_err();

        assert_eq!(error, "injected_second_add_failure");
        assert!(!resolved.workspace_root.exists());
        assert!(resolved
            .destinations
            .iter()
            .all(|destination| !destination.exists()));
        assert!(resolved
            .roots
            .iter()
            .all(|root| !local_branch_exists(root, &resolved.plan.branch).unwrap()));
        fs::remove_dir_all(base).expect("cleanup fixture");
    }

    #[test]
    fn remove_is_idempotent_after_successful_creation() {
        let base = temp_root("idempotent-remove");
        let repo = base.join("api");
        init_repo(&repo);
        let request = request(
            FeatureKind::Backend,
            "idempotent-remove",
            vec![source(FeatureRole::Backend, &repo)],
        );
        let created = feature_workspace_create_inner(request).expect("created workspace");

        let first = feature_workspace_remove_inner(created.clone()).expect("first cleanup");
        assert!(first.complete);
        assert!(first.workspace_root_removed);
        assert!(first.items[0].worktree_removed);
        assert!(first.items[0].branch_removed);

        let second = feature_workspace_remove_inner(created).expect("idempotent cleanup");
        assert!(second.complete);
        assert!(second.workspace_root_removed);
        assert!(second.items[0].worktree_removed);
        assert!(second.items[0].branch_removed);
        fs::remove_dir_all(base).expect("cleanup fixture");
    }

    #[test]
    fn remove_reports_partial_cleanup_without_deleting_unregistered_content() {
        let base = temp_root("partial-remove");
        let repo = base.join("api");
        init_repo(&repo);
        let plan = feature_workspace_plan_inner(request(
            FeatureKind::Backend,
            "partial-remove",
            vec![source(FeatureRole::Backend, &repo)],
        ))
        .expect("valid plan");
        fs::create_dir_all(&plan.items[0].destination).expect("unregistered destination");

        let cleanup = feature_workspace_remove_inner(plan).expect("cleanup report");

        assert!(!cleanup.complete);
        assert!(!cleanup.workspace_root_removed);
        assert!(!cleanup.items[0].worktree_removed);
        assert!(!cleanup.items[0].branch_removed);
        assert_eq!(
            cleanup.items[0].errors,
            vec!["destination_not_registered".to_string()]
        );
        assert!(!cleanup.errors.is_empty());
        fs::remove_dir_all(base).expect("cleanup fixture");
    }
}
