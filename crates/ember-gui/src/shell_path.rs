//! The PATH the user's login shell sets up, for an app opened from Finder,
//! which gets launchd's short PATH instead, as Emacs.app users fetch it
//! with exec-path-from-shell. Without it, programs installed with Homebrew,
//! Nix or a language's own installer, such as language servers and direnv,
//! are not found.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// What goes before the PATH in the shell's output, so what its startup
/// files print does not get in.
const MARKER: &str = "__EMBER_PATH__";

/// Asks a shell, started as a login and interactive shell so its startup
/// files run, for its PATH, as exec-path-from-shell does. Gives up after
/// `timeout`, for a startup file that waits.
pub fn login_shell_path(shell: &str, timeout: Duration) -> Option<String> {
    let mut child = Command::new(shell)
        .args(["-l", "-i", "-c", &format!("echo {MARKER}; printenv PATH")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let path = out.split_once(MARKER)?.1.trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// Whether Ember was opened as an app, from Finder or the Dock, rather than
/// from a shell, whose PATH it has already: launchd is its parent.
pub fn opened_as_app() -> bool {
    std::os::unix::process::parent_id() == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_path_a_shell_sets_up() {
        let dir = tempfile::tempdir().unwrap();
        // A shell whose startup files print first, as some do.
        let shell = dir.path().join("shell");
        std::fs::write(&shell, "#!/bin/sh\necho 'Welcome!'\nPATH=/opt/tools/bin:/usr/bin\nexport PATH\nshift 3\nexec /bin/sh -c \"$1\"\n").unwrap();
        std::fs::set_permissions(&shell, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let path = login_shell_path(shell.to_str().unwrap(), Duration::from_secs(5));
        assert_eq!(path.as_deref(), Some("/opt/tools/bin:/usr/bin"));
    }

    #[test]
    fn a_shell_that_hangs_is_given_up_on() {
        let dir = tempfile::tempdir().unwrap();
        let shell = dir.path().join("shell");
        std::fs::write(&shell, "#!/bin/sh\nsleep 10\n").unwrap();
        std::fs::set_permissions(&shell, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let started = Instant::now();
        assert_eq!(login_shell_path(shell.to_str().unwrap(), Duration::from_millis(200)), None);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
