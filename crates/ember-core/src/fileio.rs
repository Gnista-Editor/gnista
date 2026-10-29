//! Reading and writing visited files, as Emacs's fileio.c and the parts of
//! files.el that touch the disk: decoding and encoding, backups, the
//! visited file's modification time, auto-saving, and reverting.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::buffer::Buffer;
use crate::coding::{Coding, Eol};
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::variables::Value;

/// What a buffer knows about the file it visits, beyond its name.
#[derive(Clone, Debug, Default)]
pub struct FileState {
    /// When the file was last modified as of visiting or saving it, as
    /// Emacs's `visited-file-modtime`; `None` if it did not exist then.
    pub(crate) modtime: Option<SystemTime>,
    /// Whether `modtime` is known. After the buffer is made to visit
    /// another file it is not, and the file counts as unchanged, as a
    /// cleared modtime does in Emacs.
    pub(crate) modtime_known: bool,
    /// Whether the file was backed up since it was visited, as Emacs's
    /// `buffer-backed-up`: only the first save makes a backup.
    pub(crate) backed_up: bool,
    /// Where the buffer is auto-saved, as `buffer-auto-save-file-name`;
    /// `None` while auto-saving is off.
    pub(crate) auto_save: Option<PathBuf>,
    /// The buffer's tick when it was last auto-saved or saved.
    pub(crate) auto_saved_tick: u64,
    /// Lets edits go ahead although the file changed on disk, while the
    /// user's answer or a revert has them made.
    pub(crate) allow_supersession: bool,
    /// Set when an edit was refused because the file changed on disk, for
    /// the editor to ask what to do.
    pub(crate) threatened: bool,
}

/// The modification time of a file, if it exists.
fn modtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Where Emacs auto-saves a file: `#name#` beside it.
pub fn auto_save_file_name(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    path.with_file_name(format!("#{name}#"))
}

/// Where the first save backs a file up: `name~` beside it, as Emacs's
/// `make-backup-file-name` without version control.
pub fn backup_file_name(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push("~");
    PathBuf::from(name)
}

/// Whether files there are backed up, as Emacs's
/// `normal-backup-enable-predicate`: not in the temporary directory.
fn backup_enabled(path: &Path) -> bool {
    let temp = std::env::temp_dir();
    let real_temp = fs::canonicalize(&temp).unwrap_or_else(|_| temp.clone());
    let real = path.parent().and_then(|p| fs::canonicalize(p).ok()).unwrap_or_else(|| path.to_path_buf());
    !(path.starts_with(&temp) || real.starts_with(&real_temp))
}

/// Reads a file and decodes it.
pub(crate) fn read_file(path: &Path) -> Result<(String, Coding)> {
    let bytes = fs::read(path).map_err(|e| Error::new(format!("Opening input file: {e}, {}", path.display())))?;
    Ok(Coding::decode(&bytes))
}

impl Buffer {
    /// The buffer's coding system, from `buffer-file-coding-system`.
    fn coding(&self) -> Coding {
        match self.locals.get("buffer-file-coding-system") {
            Some(Value::Str(name)) => Coding::parse(name, Eol::Unix).unwrap_or_default(),
            // Not visited from a file: the variable's default.
            _ => Coding { charset: crate::coding::Charset::Utf8, eol: Eol::Unix },
        }
    }

    pub(crate) fn set_coding(&mut self, coding: Coding) {
        self.locals.insert("buffer-file-coding-system".into(), Value::Str(coding.name()));
    }

    /// What the mode line shows for the coding, as `U:` or `-\`.
    pub fn coding_mnemonic(&self) -> String {
        self.coding().mnemonic()
    }

    /// Whether the buffer has changes its auto-save file does not have yet.
    pub(crate) fn needs_auto_save(&self) -> bool {
        self.file.auto_save.is_some() && self.is_modified() && self.file.auto_saved_tick != self.modified_tick()
    }

    /// Whether the file changed on disk since it was visited or saved: the
    /// negation of Emacs's `verify-visited-file-modtime`, for a file that
    /// still exists.
    pub fn visited_file_changed(&self) -> bool {
        let Some(path) = &self.path else { return false };
        if !self.file.modtime_known {
            return false;
        }
        match modtime(path) {
            Some(now) => self.file.modtime != Some(now),
            None => false,
        }
    }

    /// Takes the file's current modification time as the one visited, as
    /// Emacs's `set-visited-file-modtime`.
    pub fn set_visited_file_modtime(&mut self) {
        self.file.modtime = self.path.as_deref().and_then(modtime);
        self.file.modtime_known = true;
    }

    /// Refuses the first change to an unmodified buffer whose file changed
    /// on disk, as Emacs's lock_file does before asking
    /// `ask-user-about-supersession-threat`. A file with the same text as
    /// the buffer is no threat, as `userlock--check-content-unchanged` says.
    pub(crate) fn check_supersession(&mut self) -> Result<()> {
        if self.is_modified() || self.file.allow_supersession || !self.visited_file_changed() {
            return Ok(());
        }
        let path = self.path.clone().expect("visited_file_changed checks it");
        if read_file(&path).is_ok_and(|(text, _)| *self.text() == text.as_str()) {
            self.set_visited_file_modtime();
            return Ok(());
        }
        self.file.threatened = true;
        Err(Error::new(format!("File changed on disk: {}", crate::files::abbreviate_path(&path))))
    }
}

impl Editor {
    /// Decodes a visited file into a new buffer, noting its coding and
    /// modification time. A missing file gives an empty buffer.
    pub(crate) fn read_visited_file(path: &Path) -> Result<Buffer> {
        // A new file is written with buffer-file-coding-system's default.
        let (text, coding) = match fs::metadata(path) {
            Ok(_) => read_file(path).map(|(text, coding)| (text, Some(coding)))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (String::new(), None),
            Err(e) => return Err(e.into()),
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        let mut buffer = Buffer::new(name);
        buffer.set_text(&text);
        buffer.path = Some(path.to_path_buf());
        if let Some(coding) = coding {
            buffer.set_coding(coding);
        }
        buffer.set_visited_file_modtime();
        Ok(buffer)
    }

    /// Writes the current buffer to its file, as Emacs's
    /// `basic-save-buffer-2`: the first save backs the old file up as
    /// `name~`, renaming it unless `backup-by-copying` or a hard link says to
    /// copy, and the file is written in the buffer's coding, through to the
    /// disk. With `file-precious-flag`, the text goes to a new file that
    /// then replaces the old one, so a failed write leaves the old intact.
    /// Afterwards the buffer is unmodified and its auto-save file deleted.
    pub fn write_visited_file(&mut self) -> Result<()> {
        let make_backups = self.variable("make-backup-files").is_none_or(|v| v.is_true());
        let by_copying = self.variable("backup-by-copying").is_some_and(|v| v.is_true());
        let precious = self.variable("file-precious-flag").is_some_and(|v| v.is_true());
        let delete_auto_save = self.variable("delete-auto-save-files").is_none_or(|v| v.is_true());
        let path = self.buffers[self.current].path.clone().ok_or_else(|| Error::new("Buffer is not visiting a file"))?;
        self.check_permission(&format!("write {}", crate::files::abbreviate_path(&path)))?;
        let b = &mut self.buffers[self.current];
        // Through symbolic links to the file itself, as Emacs's file-chase-links.
        let real = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        let (bytes, coding) = b.coding().encode(&b.text().to_string());
        let old = fs::metadata(&real).ok();
        let mut renamed = false;
        if let Some(meta) = &old
            && make_backups
            && !b.file.backed_up
            && backup_enabled(&real)
        {
            use std::os::unix::fs::MetadataExt;
            let backup = backup_file_name(&real);
            let result = if by_copying || precious || meta.nlink() > 1 {
                fs::copy(&real, &backup).map(drop)
            } else {
                renamed = true;
                fs::rename(&real, &backup)
            };
            result.map_err(|e| Error::new(format!("Cannot write backup file {}: {e}", backup.display())))?;
            b.file.backed_up = true;
        }
        let written = if precious {
            let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let temp = real.with_file_name(format!(".{name}.ember-{}", std::process::id()));
            write_synced(&temp, &bytes, old.as_ref()).and_then(|()| fs::rename(&temp, &real)).inspect_err(|_| {
                let _ = fs::remove_file(&temp);
            })
        } else {
            write_synced(&real, &bytes, old.as_ref().filter(|_| renamed))
        };
        written.map_err(|e| Error::new(format!("Writing {}: {e}", path.display())))?;
        let b = &mut self.buffers[self.current];
        if coding != b.coding() {
            b.set_coding(coding);
        }
        b.mark_saved();
        b.set_visited_file_modtime();
        b.file.auto_saved_tick = b.modified_tick();
        if delete_auto_save && let Some(auto) = b.file.auto_save.clone() {
            let _ = fs::remove_file(auto);
        }
        Ok(())
    }

    /// Replaces the current buffer's text with a file's, as reverting does,
    /// and returns the coding the file was read with. Only what differs is
    /// replaced, as Emacs's `insert-file-contents` with REPLACE: text the
    /// same at the start and the end stays, with point and the mark in it,
    /// and point within what changed keeps its place in proportion. The
    /// change can be undone. Read-only buffers are reverted too.
    pub fn replace_with_file(&mut self, path: &Path) -> Result<Coding> {
        let (new, coding) = read_file(path)?;
        let b = &mut self.buffers[self.current];
        b.widen();
        let old = b.text().to_string();
        let old_chars: Vec<char> = old.chars().collect();
        let new_chars: Vec<char> = new.chars().collect();
        let prefix = old_chars.iter().zip(&new_chars).take_while(|(a, b)| a == b).count();
        let room = old_chars.len().min(new_chars.len()) - prefix;
        let suffix = old_chars.iter().rev().zip(new_chars.iter().rev()).take(room).take_while(|(a, b)| a == b).count();
        let (old_end, new_end) = (old_chars.len() - suffix, new_chars.len() - suffix);
        let point = b.point();
        let point = if point <= prefix {
            point
        } else if point >= old_end {
            point + new_end - old_end
        } else {
            prefix + (point - prefix) * (new_end - prefix) / (old_end - prefix)
        };
        let read_only = std::mem::replace(&mut b.read_only, false);
        b.file.allow_supersession = true;
        let replaced = b.delete(prefix..old_end).and_then(|_| {
            let middle: String = new_chars[prefix..new_end].iter().collect();
            b.insert_at(prefix, &middle)
        });
        b.file.allow_supersession = false;
        b.read_only = read_only;
        replaced?;
        b.set_point(point);
        Ok(coding)
    }

    /// Reverts the current buffer to its file: replaces its text with the
    /// file's, then marks it unmodified and as visited now.
    pub fn revert_to_visited_file(&mut self) -> Result<()> {
        let b = &self.buffers[self.current];
        let path = b.path.clone().ok_or_else(|| Error::new("Buffer does not seem to be associated with any file"))?;
        if !path.exists() {
            return Err(Error::new(format!("File {} no longer exists!", path.display())));
        }
        // Reverting leaves the region as it was, as in Emacs.
        let changed = self.buffers[self.current].take_changed();
        let replaced = self.replace_with_file(&path);
        self.buffers[self.current].set_changed(changed);
        let coding = replaced?;
        let b = &mut self.buffers[self.current];
        b.set_coding(coding);
        b.mark_saved();
        b.set_visited_file_modtime();
        b.file.auto_saved_tick = b.modified_tick();
        Ok(())
    }

    /// Replaces the current buffer's text with its auto-save file's, as
    /// `recover-file` does once asked. The buffer is left modified, its
    /// coding kept, and point at the start.
    pub fn recover_from_auto_save(&mut self) -> Result<()> {
        let b = &self.buffers[self.current];
        let path = b.path.clone().ok_or_else(|| Error::new("This buffer is not visiting a file"))?;
        let auto = auto_save_file_name(&path);
        let (text, _) = read_file(&auto)?;
        let b = &mut self.buffers[self.current];
        let read_only = std::mem::replace(&mut b.read_only, false);
        b.file.allow_supersession = true;
        let len = b.len();
        let replaced = b.delete(0..len).and_then(|_| b.insert_at(0, &text));
        b.file.allow_supersession = false;
        b.read_only = read_only;
        replaced?;
        b.set_point(0);
        b.file.auto_saved_tick = b.modified_tick();
        Ok(())
    }

    /// Auto-saves every buffer that changed since it was last saved or
    /// auto-saved, as Emacs's `do-auto-save`, and says so unless `quiet`.
    /// Returns whether anything was written.
    pub fn do_auto_save(&mut self, quiet: bool) -> bool {
        let mut saved = false;
        let mut failed = None;
        for b in &mut self.buffers {
            if !b.needs_auto_save() {
                continue;
            }
            let auto = b.file.auto_save.clone().expect("needs_auto_save checks it");
            // Emacs writes auto-save files in its own coding, UTF-8 with
            // Unix line ends, whatever the visited file uses.
            match fs::write(&auto, b.text().to_string()) {
                Ok(()) => {
                    b.file.auto_saved_tick = b.modified_tick();
                    saved = true;
                }
                Err(e) => failed = Some(format!("Auto-saving {}: {e}", b.name)),
            }
        }
        if let Some(message) = failed {
            self.message = Some(message);
        } else if saved && !quiet {
            self.message = Some("Auto-saving...done".into());
        }
        saved
    }

    /// Makes the current buffer visit another file, as Emacs's
    /// `set-visited-file-name`: the buffer takes the file's name, the next
    /// save backs nothing up unless the file is there, and auto-saving
    /// moves to the new name.
    pub fn set_visited_file_name(&mut self, path: &Path) -> Result<()> {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| Error::new("Not a file name"))?;
        let b = &self.buffers[self.current];
        let name = if b.name == name { name } else { self.unique_buffer_name(&name) };
        let b = &mut self.buffers[self.current];
        b.name = name;
        b.path = Some(path.to_path_buf());
        b.file.modtime_known = false;
        b.file.backed_up = false;
        b.set_modified(true);
        if b.file.auto_save.is_some() {
            b.file.auto_save = Some(auto_save_file_name(path));
        }
        Ok(())
    }

    /// Asks the front end to exit, as Emacs's `kill-emacs`.
    pub fn kill_emacs(&mut self) -> Result<()> {
        self.check_permission("quit Ember")?;
        self.quit = true;
        Ok(())
    }

    /// Turns auto-saving on or off for the current buffer, as
    /// `auto-save-mode`. Only buffers visiting files auto-save.
    pub fn set_auto_save(&mut self, on: bool) {
        let b = &mut self.buffers[self.current];
        b.file.auto_save = if on { b.path.as_deref().map(auto_save_file_name) } else { None };
    }

    /// Whether the current buffer auto-saves.
    pub fn auto_saving(&self) -> bool {
        self.buffers[self.current].file.auto_save.is_some()
    }

    /// Whether a file's auto-save file is newer than it, as
    /// `after-find-file` checks to suggest `recover-this-file`.
    pub fn has_newer_auto_save(path: &Path) -> bool {
        match (modtime(&auto_save_file_name(path)), modtime(path)) {
            (Some(auto), Some(file)) => auto > file,
            (Some(_), None) => true,
            _ => false,
        }
    }
}

/// Writes bytes to a file and through to the disk, giving it `like`'s
/// permissions when it is new, as Emacs's `set-file-modes` after a backup
/// by renaming.
fn write_synced(path: &Path, bytes: &[u8], like: Option<&fs::Metadata>) -> std::io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    if let Some(meta) = like {
        fs::set_permissions(path, meta.permissions())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_save_and_backup_names_are_emacs_names() {
        let path = Path::new("/notes/today.org");
        assert_eq!(auto_save_file_name(path), Path::new("/notes/#today.org#"));
        assert_eq!(backup_file_name(path), Path::new("/notes/today.org~"));
    }
}
