//! The user's configuration directory: `init.ts`, plus the `ember.d.ts` and
//! `tsconfig.json` that let editors and `tsc` check it.

use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use ember_core::Editor;
use crate::{Scripting, type_definitions};

/// `$EMBER_CONFIG_DIR`, else `$XDG_CONFIG_HOME/ember`, else `~/.config/ember`.
pub fn config_dir() -> PathBuf {
    if let Some(dir) = env::var_os("EMBER_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    let base = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".config"));
    base.join("ember")
}

/// Starts scripting, loads `init.ts` unless `load_init` is false, and writes
/// the type files. Problems are shown in the echo area; the editor starts anyway.
pub fn setup(ed: &mut Editor, load_init: bool) -> Option<Scripting> {
    setup_with(ed, load_init, |_, _| Ok(()))
}

/// Like [`setup`], installing extensions such as Ember's agent once the
/// packages are loaded and before `init.ts`, so it can configure them.
pub fn setup_with(
    ed: &mut Editor,
    load_init: bool,
    extensions: impl FnOnce(&mut Editor, &Scripting) -> ember_core::Result<()>,
) -> Option<Scripting> {
    setup_in(ed, &config_dir(), load_init, extensions)
}

/// As [`setup_with`], with the configuration in `dir`.
pub fn setup_in(
    ed: &mut Editor,
    dir: &Path,
    load_init: bool,
    extensions: impl FnOnce(&mut Editor, &Scripting) -> ember_core::Result<()>,
) -> Option<Scripting> {
    let dir = dir.to_path_buf();
    let scripting = match Scripting::start(ed) {
        Ok((scripting, failures)) => {
            for e in failures {
                ed.message(format!("Error loading a package: {e}"));
            }
            scripting
        }
        Err(e) => {
            ed.message(format!("Scripting is unavailable: {e}"));
            return None;
        }
    };
    ed.set_variable("user-emacs-directory", ember_core::Value::Str(format!("{}/", dir.display())));
    ed.set_variable("load-path", ember_core::Value::List(vec![ember_core::Value::Str(dir.join("packages").display().to_string())]));
    if let Err(e) = extensions(ed, &scripting) {
        ed.message(format!("An extension failed to load: {e}"));
    }
    if load_init {
        self::load_init(ed, &scripting, &dir);
    }
    // As Emacs runs them once its init file is loaded, with -q too.
    for hook in ["after-init-hook", "emacs-startup-hook"] {
        if let Err(e) = ed.run_hooks(hook) {
            ed.message(format!("Error in {hook}: {e}"));
        }
    }
    if let Err(e) = write_type_files(ed, &dir) {
        ed.message(format!("Could not write ember.d.ts: {e}"));
    }
    Some(scripting)
}

/// Loads `init.ts` if there is one. Errors are shown in the echo area, as
/// Emacs reports a broken init file, and the editor starts anyway.
pub fn load_init(ed: &mut Editor, scripting: &Scripting, dir: &Path) {
    let init = dir.join("init.ts");
    if init.exists()
        && let Err(e) = scripting.load_file(ed, &init)
    {
        // The error already starts with the file and line.
        ed.message(e.to_string());
    }
}

const TSCONFIG: &str = r#"{
  // Written by Ember. Lets `tsc -p .` and editors check init.ts against ember.d.ts.
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "es2023",
    "lib": ["es2023"],
    "types": [],
    // Each .ts file is its own module, as Ember runs each file in its own scope.
    "moduleDetection": "force",
    // Ember erases types rather than compiling them, so enums and the like are not allowed.
    "erasableSyntaxOnly": true
  },
  "include": ["*.ts"]
}
"#;

/// Writes `ember.d.ts` when it has changed, and `tsconfig.json` if there is
/// none. Does nothing if the configuration directory does not exist.
pub fn write_type_files(ed: &Editor, dir: &Path) -> io::Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    let dts_path = dir.join("ember.d.ts");
    let dts = type_definitions(ed);
    if fs::read_to_string(&dts_path).ok().as_deref() != Some(dts.as_str()) {
        fs::write(&dts_path, dts)?;
    }
    let tsconfig = dir.join("tsconfig.json");
    if !tsconfig.exists() {
        fs::write(tsconfig, TSCONFIG)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_requires_packages_from_the_config_directory() {
        // As a user's own package, outside Ember: found in packages/, along load-path.
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("packages")).unwrap();
        fs::write(dir.path().join("packages/my-own.ts"), "import { truthy } from \"subr\";\nember.setVariable(\"my-own-loaded\", truthy(1));\n").unwrap();
        fs::write(dir.path().join("init.ts"), "ember.require(\"my-own\");\n").unwrap();
        let mut ed = Editor::new();
        let _scripting = setup_in(&mut ed, dir.path(), true, |_, _| Ok(())).unwrap();
        assert_eq!(ed.variable("my-own-loaded"), Some(ember_core::Value::Bool(true)));
    }

    #[test]
    fn loads_init_and_writes_type_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("init.ts"),
            "ember.defineCommand({ name: \"from-init\", run: () => {} });",
        )
        .unwrap();
        let mut ed = Editor::new();
        let scripting = Scripting::new(&mut ed).unwrap();
        load_init(&mut ed, &scripting, dir.path());
        assert!(ed.command("from-init").is_some());
        write_type_files(&ed, dir.path()).unwrap();
        let dts = fs::read_to_string(dir.path().join("ember.d.ts")).unwrap();
        assert!(dts.contains("\"from-init\": [];"));
        assert!(dir.path().join("tsconfig.json").exists());
    }

    #[test]
    fn a_broken_init_is_reported_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("init.ts"), "let x: = 1;").unwrap();
        let mut ed = Editor::new();
        let scripting = Scripting::new(&mut ed).unwrap();
        load_init(&mut ed, &scripting, dir.path());
        let echo = ed.echo().unwrap();
        assert!(echo.contains("init.ts:1:"), "{echo}");
    }

    #[test]
    fn missing_config_dir_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        write_type_files(&Editor::new(), &missing).unwrap();
        assert!(!missing.exists());
    }
}
