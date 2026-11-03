//! Files.

use crate::natives::{natives, Field, Fields, Opt};
use crate::*;

natives! {
    /// What a symbolic link points to, as file-symlink-p, or undefined if the file is not one.
    pub fn fileSymlinkP(ed, file: String) -> Option<String> {
        ed.file_symlink_p(&file)
    }

    /// Whether `a` was modified after `b`, or exists where `b` does not, as file-newer-than-file-p.
    pub fn fileNewerThanFileP(ed, a: String, b: String) -> bool {
        ed.file_newer_than_file_p(&a, &b)
    }

    fn fileModes(ed, file: String, nofollow: Opt<bool>) -> Option<u32> {
        ed.file_modes(&file, nofollow.0.unwrap_or(false))
    }

    /// Set a file's mode bits, as set-file-modes.
    pub fn setFileModes(ed, file: String, mode: u32) {
        ed.set_file_modes(&file, mode)
    }

    /// Set when a file was last modified and read, in milliseconds since 1970, or to now, as set-file-times.
    #[ts = "(file: string, time?: number): void"]
    pub fn setFileTimes(ed, file: String, time: Opt<Option<f64>>) {
        ed.set_file_times(&file, time.0.flatten())
    }

    /// A file's name with the symbolic links in it followed, as file-truename.
    pub fn fileTruename(ed, file: String) -> String {
        ed.file_truename(&file)
    }

    fn makeTempFile(ed, prefix: String, dir: bool, suffix: String, text: Opt<Option<String>>) -> String {
        ed.make_temp_file(&prefix, dir, &suffix, text.0.flatten().as_deref())
    }

    fn findFileNameHandler(ed, file: String, operation: String) -> EditorValue {
        let handler = ed.find_file_name_handler(&file, &operation);
        Ok(handler.unwrap_or(EditorValue::Null))
    }

    /// A file name with $VAR and ${VAR} from the environment, and starting again after // or /~, as substitute-in-file-name.
    pub fn substituteInFileName(ed, file: String) -> String {
        ember_core::substitute_in_file_name(&file)
    }

    fn fileNameConcat(ed, parts: Vec<String>) -> String {
        Ok(ember_core::file_name_concat(&parts.iter().map(String::as_str).collect::<Vec<_>>()))
    }

    /// `[file, characters inserted]`.
    fn insertFileContents(ed, file: String, options: Fields) -> EditorValue {
        let at = |name| options.number(name).map(|n| n as usize);
        let (name, n) = ed.insert_file_contents(&file, options.flag("visit"), at("beg"), at("end"), options.flag("replace"))?;
        Ok(EditorValue::List(vec![EditorValue::Str(name), EditorValue::Number(n as f64)]))
    }

    /// `start` is null for the whole buffer, text to write, or where the region starts.
    fn writeRegion(ed, start: EditorValue, end: Option<usize>, file: String, options: Fields) {
        let source = match start {
            EditorValue::Null => ember_core::WriteSource::Buffer,
            EditorValue::Str(text) => ember_core::WriteSource::Text(text),
            start => {
                let a = start.as_number().unwrap_or(0.0) as usize;
                ember_core::WriteSource::Region(a, end.unwrap_or(a))
            }
        };
        let visit = match options.get("visit") {
            Some(EditorValue::Str(name)) => ember_core::Visit::Name(name.clone()),
            Some(EditorValue::Bool(true)) => ember_core::Visit::Yes,
            _ if options.flag("quiet") => ember_core::Visit::Quiet,
            _ => ember_core::Visit::No,
        };
        ed.write_region(source, &file, options.flag("append"), visit, options.flag("mustbenew"))
    }

    /// Whose lock a file has, as file-locked-p: true for Ember's own, the other process's user@host (pid N), or undefined.
    #[ts = "(file: string): true | string | undefined"]
    pub fn fileLockedP(ed, file: String) -> Field {
        Ok(match ed.file_locked_p(&file)? {
            ember_core::filelock::LockOwner::None => Field::Undefined,
            ember_core::filelock::LockOwner::Me => Field::from(true),
            ember_core::filelock::LockOwner::Other(owner) => Field::from(owner),
        })
    }

    /// Whether a file exists, through symbolic links, as file-exists-p. A file name handler may answer.
    pub fn fileExistsP(ed, file: String) -> bool {
        ed.file_exists_p(&file)
    }

    /// Whether Ember can read a file, as file-readable-p.
    pub fn fileReadableP(ed, file: String) -> bool {
        ed.file_readable_p(&file)
    }

    /// Whether Ember could write a file: the file if it exists, else its directory, as file-writable-p.
    pub fn fileWritableP(ed, file: String) -> bool {
        ed.file_writable_p(&file)
    }

    /// Whether a file can be run, or a directory entered, as file-executable-p.
    pub fn fileExecutableP(ed, file: String) -> bool {
        ed.file_executable_p(&file)
    }

    /// Whether a file is a regular file, through symbolic links, as file-regular-p.
    pub fn fileRegularP(ed, file: String) -> bool {
        ed.file_regular_p(&file)
    }

    /// Whether a directory can be listed and entered, as file-accessible-directory-p.
    pub fn fileAccessibleDirectoryP(ed, file: String) -> bool {
        ed.file_accessible_directory_p(&file)
    }

    /// Whether a file name is absolute, starting with / or ~, as file-name-absolute-p.
    pub fn fileNameAbsoluteP(ed, file: String) -> bool {
        Ok(ember_core::file_name_absolute_p(&file))
    }

    /// A file name with the home directory written as ~, as Emacs's abbreviate-file-name.
    pub fn abbreviateFileName(ed, file: String) -> String {
        let short = abbreviate_path(Path::new(&file));
        Ok(if file.ends_with('/') && !short.ends_with('/') { short + "/" } else { short })
    }
}
