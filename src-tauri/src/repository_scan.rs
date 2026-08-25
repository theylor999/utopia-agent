//! One-shot scan of a repositories root.
//!
//! The user points at the folder that holds their clones once. This module
//! lists its immediate children, keeps the ones that are Git repositories, and
//! assigns each one a feature slice role, so creating a feature never needs a
//! repository to be picked by hand.
//!
//! Role detection reuses `project_detector::detect_project_stack` as the
//! primary signal. The folder name is only a tiebreaker, added on top of the
//! stack signal, never the sole reason a role is assigned.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

use crate::feature_workspace::FeatureRole;
use crate::git_control::main_repository_root;
use crate::project_detector::{detect_project_stack, ProjectStack, StackDetection};
use crate::worktrees::git_arg;

/// Canonical role order, matching `feature_workspace`. Used as the tiebreaker
/// when two roles score the same for one repository.
const ROLE_ORDER: [FeatureRole; 3] = [
    FeatureRole::Backend,
    FeatureRole::Frontend,
    FeatureRole::Scripts,
];

/// Folder-name fragments that hint at a role. A hint alone never assigns a
/// role: it is added to the stack signal, which must also be non-zero.
const FRONTEND_HINTS: &[&str] = &["front", "web", "ui", "client", "site"];
const BACKEND_HINTS: &[&str] = &["back", "api", "server", "service", "srv"];
const SCRIPTS_HINTS: &[&str] = &["script", "tool", "job", "cron", "automation", "batch"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedRepository {
    /// Folder name, as shown in the picker the user came from.
    pub name: String,
    /// Main repository root, resolved the same way the feature flow resolves a
    /// source, so the value can be stored as a role preference as it is.
    pub path: String,
    /// Role the scan assigned, or `None` when a better match took every role.
    pub role: Option<FeatureRole>,
    /// Score behind `role`, so the UI can show how strong the guess was.
    pub score: u32,
    pub stack: StackDetection,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedEntry {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryScan {
    pub root: String,
    /// Git repositories found directly inside the root, in folder-name order.
    pub repositories: Vec<ScannedRepository>,
    /// Immediate children that are not Git repositories, reported instead of
    /// being silently dropped.
    pub skipped: Vec<SkippedEntry>,
}

/// Stack signal for one role. Derived only from `detect_project_stack`.
fn stack_signal(detection: &StackDetection, role: FeatureRole) -> u32 {
    match role {
        FeatureRole::Frontend => {
            if detection.has_frontend && !detection.has_backend {
                3
            } else if detection.has_frontend {
                1
            } else {
                0
            }
        }
        FeatureRole::Backend => {
            if detection.has_backend && !detection.has_frontend {
                2
            } else if detection.has_backend {
                1
            } else if detection.stack == ProjectStack::Unknown {
                // Nothing recognized: the languages this detector does not read
                // (C#, Java, Kotlin, PHP) are overwhelmingly server side.
                1
            } else {
                0
            }
        }
        FeatureRole::Scripts => {
            let mut score = 0;
            if detection.stack == ProjectStack::Cli {
                score += 2;
            }
            if detection.stack == ProjectStack::Unknown {
                score += 1;
            }
            score
        }
    }
}

/// Folder-name tiebreaker for one role.
fn name_signal(name: &str, role: FeatureRole) -> u32 {
    let lowered = name.to_lowercase();
    let hints = match role {
        FeatureRole::Backend => BACKEND_HINTS,
        FeatureRole::Frontend => FRONTEND_HINTS,
        FeatureRole::Scripts => SCRIPTS_HINTS,
    };
    if hints.iter().any(|hint| lowered.contains(hint)) {
        2
    } else {
        0
    }
}

/// Combined score. Zero when the stack says nothing about the role, so a folder
/// name can never assign a role on its own.
fn role_score(name: &str, detection: &StackDetection, role: FeatureRole) -> u32 {
    let stack = stack_signal(detection, role);
    if stack == 0 {
        0
    } else {
        stack + name_signal(name, role)
    }
}

fn is_git_worktree(path: &Path) -> bool {
    let marker = path.join(".git");
    marker.is_dir() || marker.is_file()
}

/// Assigns at most one role per repository and at most one repository per role,
/// highest score first. Ties fall back to canonical role order, then to the
/// folder name, so the result is deterministic.
fn assign_roles(repositories: &mut [ScannedRepository]) {
    let mut candidates: Vec<(u32, usize, usize)> = Vec::new();
    for (index, repository) in repositories.iter().enumerate() {
        for (role_index, role) in ROLE_ORDER.iter().enumerate() {
            let score = role_score(&repository.name, &repository.stack, *role);
            if score > 0 {
                candidates.push((score, role_index, index));
            }
        }
    }
    candidates.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then(left.1.cmp(&right.1))
            .then_with(|| repositories[left.2].name.cmp(&repositories[right.2].name))
    });

    let mut taken_roles = [false; ROLE_ORDER.len()];
    for (score, role_index, index) in candidates {
        if taken_roles[role_index] || repositories[index].role.is_some() {
            continue;
        }
        taken_roles[role_index] = true;
        repositories[index].role = Some(ROLE_ORDER[role_index]);
        repositories[index].score = score;
    }
}

pub(crate) fn scan_repositories(root: &str) -> Result<RepositoryScan, String> {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return Err("invalid_repositories_root".to_string());
    }
    let root_path = PathBuf::from(trimmed)
        .canonicalize()
        .map_err(|_| "directory_not_found".to_string())?;
    if !root_path.is_dir() {
        return Err("directory_not_found".to_string());
    }

    let mut names: Vec<String> = fs::read_dir(&root_path)
        .map_err(|error| format!("scan_failed:{error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();

    let mut repositories = Vec::new();
    let mut skipped = Vec::new();
    for name in names {
        let path = root_path.join(&name);
        if !is_git_worktree(&path) {
            skipped.push(SkippedEntry {
                name,
                reason: "not_a_git_repository".to_string(),
            });
            continue;
        }
        let resolved = match main_repository_root(&git_arg(&path)) {
            Ok(resolved) => resolved,
            Err(_) => {
                skipped.push(SkippedEntry {
                    name,
                    reason: "not_a_git_repository".to_string(),
                });
                continue;
            }
        };
        let stack = match detect_project_stack(git_arg(&resolved)) {
            Ok(stack) => stack,
            Err(_) => {
                skipped.push(SkippedEntry {
                    name,
                    reason: "stack_detection_failed".to_string(),
                });
                continue;
            }
        };
        repositories.push(ScannedRepository {
            name,
            path: git_arg(&resolved),
            role: None,
            score: 0,
            stack,
        });
    }

    assign_roles(&mut repositories);

    Ok(RepositoryScan {
        root: git_arg(&root_path),
        repositories,
        skipped,
    })
}

#[tauri::command]
pub async fn feature_repository_scan(root: String) -> Result<RepositoryScan, String> {
    tokio::task::spawn_blocking(move || scan_repositories(&root))
        .await
        .map_err(|error| format!("feature_repository_scan:blocking task failed:{error}"))?
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
        std::env::temp_dir().join(format!("alethe-repository-scan-{label}-{nanos}"))
    }

    fn init_repo(path: &Path) {
        fs::create_dir_all(path).expect("repo directory");
        for args in [
            vec!["init"],
            vec!["config", "user.email", "alethe@example.test"],
            vec!["config", "user.name", "Alethe Test"],
        ] {
            let output = Command::new("git")
                .current_dir(path)
                .args(&args)
                .output()
                .expect("git must run in test");
            assert!(output.status.success(), "git {args:?} failed");
        }
    }

    fn role_of(scan: &RepositoryScan, name: &str) -> Option<FeatureRole> {
        scan.repositories
            .iter()
            .find(|repository| repository.name == name)
            .expect("repository must be scanned")
            .role
    }

    #[test]
    fn assigns_roles_from_the_stack_and_skips_folders_without_git() {
        let base = temp_root("roles");
        // Shaped like the real repositories root: a C#-style backend the stack
        // detector cannot read, a Vite frontend, a Python scripts repository,
        // and a plain folder that is not a repository at all.
        let backend = base.join("nplan");
        let frontend = base.join("nplan-forecast");
        let scripts = base.join("nplan-forecast-scripts");
        init_repo(&backend);
        init_repo(&frontend);
        init_repo(&scripts);
        fs::write(backend.join("NPlan.sln"), "solution\n").expect("fixture file");
        fs::write(
            frontend.join("package.json"),
            r#"{"scripts":{"dev":"vite"},"dependencies":{"react":"18.0.0"}}"#,
        )
        .expect("fixture file");
        fs::write(scripts.join("requirements.txt"), "pandas\n").expect("fixture file");
        fs::create_dir_all(base.join("_shared-hooks")).expect("non-repo folder");
        fs::write(base.join("_shared-hooks").join("pre-commit"), "#!/bin/sh\n")
            .expect("fixture file");

        let scan = scan_repositories(&git_arg(&base)).expect("scan succeeds");

        assert_eq!(scan.repositories.len(), 3);
        assert_eq!(role_of(&scan, "nplan"), Some(FeatureRole::Backend));
        assert_eq!(role_of(&scan, "nplan-forecast"), Some(FeatureRole::Frontend));
        assert_eq!(
            role_of(&scan, "nplan-forecast-scripts"),
            Some(FeatureRole::Scripts)
        );
        assert_eq!(scan.skipped.len(), 1);
        assert_eq!(scan.skipped[0].name, "_shared-hooks");
        assert_eq!(scan.skipped[0].reason, "not_a_git_repository");
        // The stored path is the one the feature flow will resolve.
        let backend_path = scan
            .repositories
            .iter()
            .find(|repository| repository.name == "nplan")
            .expect("backend repository")
            .path
            .clone();
        assert_eq!(
            backend_path.to_lowercase(),
            git_arg(&main_repository_root(&git_arg(&backend)).unwrap()).to_lowercase()
        );

        fs::remove_dir_all(base).expect("cleanup fixture");
    }

    #[test]
    fn a_name_hint_never_assigns_a_role_on_its_own() {
        let base = temp_root("name-only");
        let frontend = base.join("web");
        init_repo(&frontend);
        fs::write(
            frontend.join("package.json"),
            r#"{"scripts":{"dev":"vite"},"dependencies":{"react":"18.0.0"}}"#,
        )
        .expect("fixture file");

        let scan = scan_repositories(&git_arg(&base)).expect("scan succeeds");
        assert_eq!(role_of(&scan, "web"), Some(FeatureRole::Frontend));

        // A frontend repository never wins the scripts role, however the folder
        // is named, because the scripts stack signal is zero for it.
        let detection = scan.repositories[0].stack.clone();
        assert_eq!(role_score("scripts-web", &detection, FeatureRole::Scripts), 0);
        assert!(role_score("scripts-web", &detection, FeatureRole::Frontend) > 0);

        fs::remove_dir_all(base).expect("cleanup fixture");
    }

    #[test]
    fn a_name_hint_breaks_a_tie_between_backend_and_scripts() {
        let base = temp_root("tiebreak");
        let api = base.join("orders-api");
        let jobs = base.join("nightly-jobs");
        init_repo(&api);
        init_repo(&jobs);
        // Both are Python: the stack signal alone ties backend and scripts.
        fs::write(api.join("requirements.txt"), "fastapi\n").expect("fixture file");
        fs::write(jobs.join("requirements.txt"), "click\n").expect("fixture file");

        let scan = scan_repositories(&git_arg(&base)).expect("scan succeeds");
        assert_eq!(role_of(&scan, "orders-api"), Some(FeatureRole::Backend));
        assert_eq!(role_of(&scan, "nightly-jobs"), Some(FeatureRole::Scripts));

        fs::remove_dir_all(base).expect("cleanup fixture");
    }

    #[test]
    fn rejects_an_empty_or_missing_repositories_root() {
        assert_eq!(
            scan_repositories("   ").unwrap_err(),
            "invalid_repositories_root"
        );
        assert_eq!(
            scan_repositories("D:/definitely-not-a-real-root-xyz").unwrap_err(),
            "directory_not_found"
        );
    }
}
