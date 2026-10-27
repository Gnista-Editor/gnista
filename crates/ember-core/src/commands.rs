//! The built-in commands and their default key bindings.

use crate::buffer::Buffer;
use crate::command::{Arg, Command, ParamKind};
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::files::expand_file_name;
use crate::key::{KeyCode, format_keys};
use crate::keymap::Lookup;

/// Commands whose kills join onto the previous kill when run back to back.
pub(crate) const KILL_COMMANDS: &[&str] =
    &["kill-line", "kill-region", "kill-word", "backward-kill-word"];

fn def(
    ed: &mut Editor,
    name: &str,
    doc: &str,
    run: impl Fn(&mut Editor, &[Arg]) -> Result<()> + 'static,
) {
    ed.define_command(Command::new(name, doc, run));
}

/// Defines a movement command that Shift selection applies to.
fn def_motion(
    ed: &mut Editor,
    name: &str,
    doc: &str,
    run: impl Fn(&mut Editor, &[Arg]) -> Result<()> + 'static,
) {
    ed.define_command(Command::new(name, doc, run).shift_select());
}

fn err<T>(message: &str) -> Result<T> {
    Err(Error::new(message))
}

pub(crate) fn install(ed: &mut Editor) {
    movement(ed);
    editing(ed);
    killing(ed);
    files_and_buffers(ed);
    minibuffer(ed);
    help(ed);
    bind_defaults(ed);
}

fn movement(ed: &mut Editor) {
    def_motion(ed, "forward-char", "Move point one character forward.", |ed, _| {
        let b = ed.buffer_mut();
        if b.point() >= b.len() {
            return err("End of buffer");
        }
        b.set_point(b.point() + 1);
        Ok(())
    });
    def_motion(ed, "backward-char", "Move point one character backward.", |ed, _| {
        let b = ed.buffer_mut();
        if b.point() == 0 {
            return err("Beginning of buffer");
        }
        b.set_point(b.point() - 1);
        Ok(())
    });
    def_motion(
        ed,
        "next-line",
        "Move point to the next line.\n\nRepeated line moves keep to the column where they started.",
        |ed, _| line_move(ed, true),
    );
    def_motion(
        ed,
        "previous-line",
        "Move point to the previous line.\n\nRepeated line moves keep to the column where they started.",
        |ed, _| line_move(ed, false),
    );
    def_motion(ed, "move-beginning-of-line", "Move point to the beginning of the line.", |ed, _| {
        let b = ed.buffer_mut();
        b.set_point(b.line_start(b.line_of(b.point())));
        Ok(())
    });
    def_motion(ed, "move-end-of-line", "Move point to the end of the line.", |ed, _| {
        let b = ed.buffer_mut();
        b.set_point(b.line_end(b.line_of(b.point())));
        Ok(())
    });
    def_motion(ed, "forward-word", "Move point forward to the end of the next word.", |ed, _| {
        let b = ed.buffer_mut();
        b.set_point(word_end(b, b.point()));
        Ok(())
    });
    def_motion(ed, "backward-word", "Move point back to the start of the previous word.", |ed, _| {
        let b = ed.buffer_mut();
        b.set_point(word_start(b, b.point()));
        Ok(())
    });
    def_motion(ed, "beginning-of-buffer", "Move point to the beginning of the buffer.\n\nUnless the region is active, leaves the mark where point was.", |ed, _| {
        let b = ed.buffer_mut();
        if !b.is_mark_active() {
            b.set_mark(Some(b.point()));
        }
        b.set_point(0);
        Ok(())
    });
    def_motion(ed, "end-of-buffer", "Move point to the end of the buffer.\n\nUnless the region is active, leaves the mark where point was.", |ed, _| {
        let b = ed.buffer_mut();
        if !b.is_mark_active() {
            b.set_mark(Some(b.point()));
        }
        b.set_point(b.len());
        Ok(())
    });
    def_motion(ed, "scroll-up-command", "Scroll the text up by nearly a screen, showing later lines.", |ed, _| {
        let step = scroll_step(ed);
        let b = ed.window_buffer_mut();
        let last = b.line_count() - 1;
        if b.top_line + step > last {
            b.set_point(b.len());
            return err("End of buffer");
        }
        b.top_line += step;
        if b.line_of(b.point()) < b.top_line {
            b.set_point(b.line_start(b.top_line));
        }
        Ok(())
    });
    def_motion(ed, "scroll-down-command", "Scroll the text down by nearly a screen, showing earlier lines.", |ed, _| {
        let step = scroll_step(ed);
        let height = ed.viewport_height();
        let b = ed.window_buffer_mut();
        if b.top_line == 0 {
            b.set_point(0);
            return err("Beginning of buffer");
        }
        b.top_line = b.top_line.saturating_sub(step);
        let bottom = b.top_line + height - 1;
        if b.line_of(b.point()) > bottom {
            b.set_point(b.line_start(bottom));
        }
        Ok(())
    });
    def(
        ed,
        "mwheel-scroll",
        "Scroll the window for the mouse wheel or a trackpad.\n\nScrolls by as many lines as the wheel event carries. Point stays where it is unless it would leave the window.",
        |ed, _| {
            let lines = ed.wheel_lines as isize;
            let lines = match ed.last_key.map(|k| k.code) {
                Some(KeyCode::WheelUp) => -lines,
                _ => lines,
            };
            // Like mwheel-scroll in Emacs, reaching either end is not an error.
            scroll_lines(ed, lines);
            Ok(())
        },
    );
    def(ed, "scroll-up-line", "Scroll the text up one line, showing the next line.", |ed, _| {
        if scroll_lines(ed, 1) { Ok(()) } else { err("End of buffer") }
    });
    def(ed, "scroll-down-line", "Scroll the text down one line, showing the previous line.", |ed, _| {
        if scroll_lines(ed, -1) { Ok(()) } else { err("Beginning of buffer") }
    });
    def(ed, "recenter", "Scroll so the line with point is in the middle of the window.", |ed, _| {
        let height = ed.viewport_height();
        let b = ed.window_buffer_mut();
        b.top_line = b.line_of(b.point()).saturating_sub(height / 2);
        Ok(())
    });
}

/// Scrolls the window by `lines`, positive towards the end of the buffer,
/// until the last line is at the top. Point stays put unless it would leave
/// the window; then it moves to the nearest visible line, keeping its column
/// across repeated scrolls as line moves do. Returns whether anything scrolled.
fn scroll_lines(ed: &mut Editor, lines: isize) -> bool {
    let continuing = ed.last_command().is_some_and(|c| SCROLL_KEEPS_COLUMN.contains(&c));
    let height = ed.viewport_height();
    let b = ed.window_buffer();
    let goal = match ed.goal_column {
        Some(goal) if continuing => goal,
        _ => b.column(b.point()),
    };
    ed.goal_column = Some(goal);
    let b = ed.window_buffer_mut();
    let last = b.line_count() - 1;
    let top = (b.top_line as isize + lines).clamp(0, last as isize) as usize;
    if top == b.top_line {
        return false;
    }
    b.top_line = top;
    let line = b.line_of(b.point());
    let target = line.clamp(top, top + height.saturating_sub(1));
    if target != line {
        let start = b.line_start(target);
        b.set_point((start + goal).min(b.line_end(target)));
    }
    true
}

/// Commands after which scrolling and line moves keep the earlier goal column.
const SCROLL_KEEPS_COLUMN: &[&str] =
    &["next-line", "previous-line", "mwheel-scroll", "scroll-up-line", "scroll-down-line"];

fn line_move(ed: &mut Editor, down: bool) -> Result<()> {
    let continuing = ed.last_command().is_some_and(|c| SCROLL_KEEPS_COLUMN.contains(&c));
    let b = ed.buffer();
    let line = b.line_of(b.point());
    let goal = match ed.goal_column {
        Some(goal) if continuing => goal,
        _ => b.column(b.point()),
    };
    ed.goal_column = Some(goal);
    let b = ed.buffer_mut();
    let target = if down {
        if line + 1 >= b.line_count() {
            b.set_point(b.len());
            return err("End of buffer");
        }
        line + 1
    } else {
        if line == 0 {
            b.set_point(0);
            return err("Beginning of buffer");
        }
        line - 1
    };
    let start = b.line_start(target);
    b.set_point((start + goal).min(b.line_end(target)));
    Ok(())
}

/// How far a screen scroll moves: the window height less two lines of context.
fn scroll_step(ed: &Editor) -> usize {
    ed.viewport_height().saturating_sub(2).max(1)
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric()
}

fn word_end(b: &Buffer, mut pos: usize) -> usize {
    while b.char_at(pos).is_some_and(|c| !is_word_char(c)) {
        pos += 1;
    }
    while b.char_at(pos).is_some_and(is_word_char) {
        pos += 1;
    }
    pos
}

fn word_start(b: &Buffer, mut pos: usize) -> usize {
    while pos > 0 && b.char_at(pos - 1).is_some_and(|c| !is_word_char(c)) {
        pos -= 1;
    }
    while pos > 0 && b.char_at(pos - 1).is_some_and(is_word_char) {
        pos -= 1;
    }
    pos
}

fn editing(ed: &mut Editor) {
    def(ed, "self-insert-command", "Insert the character you typed.", |ed, _| {
        let c = ed
            .last_key
            .and_then(|k| k.printable())
            .ok_or_else(|| Error::new("self-insert-command must be run from a key"))?;
        ed.buffer_mut().insert(c.encode_utf8(&mut [0; 4]))
    });
    ed.define_command(
        Command::new("insert", "Insert text at point.", |ed, args| {
            let text = args[0].as_str()?.to_string();
            ed.buffer_mut().insert(&text)
        })
        .param("text", ParamKind::String, "Insert: "),
    );
    def(ed, "newline", "Insert a newline.", |ed, _| ed.buffer_mut().insert("\n"));
    def(ed, "indent-for-tab-command", "Indent the current line. For now this inserts a tab.", |ed, _| {
        ed.buffer_mut().insert("\t")
    });
    def(ed, "delete-backward-char", "Delete the character before point.", |ed, _| {
        let b = ed.buffer_mut();
        if b.point() == 0 {
            return err("Beginning of buffer");
        }
        let p = b.point();
        b.delete(p - 1..p).map(drop)
    });
    def(ed, "delete-char", "Delete the character after point.", |ed, _| {
        let b = ed.buffer_mut();
        if b.point() >= b.len() {
            return err("End of buffer");
        }
        let p = b.point();
        b.delete(p..p + 1).map(drop)
    });
    def(ed, "undo", "Undo the last change. Repeat to undo earlier changes.", |ed, _| {
        ed.buffer_mut().undo()
    });
    def(
        ed,
        "set-mark-command",
        "Set the mark at point and activate the region.\n\nRepeating it straight away deactivates the region, leaving the mark set.",
        |ed, _| {
            let repeated = ed.last_command() == Some("set-mark-command");
            let b = ed.buffer_mut();
            if repeated && b.is_mark_active() && b.mark() == Some(b.point()) {
                b.deactivate_mark();
                ed.message("Mark deactivated");
            } else {
                b.activate_mark();
                ed.message("Mark set");
            }
            Ok(())
        },
    );
    def(ed, "exchange-point-and-mark", "Put the mark where point is and point where the mark was.", |ed, _| {
        let b = ed.buffer_mut();
        let mark = b.mark().ok_or_else(|| Error::new("No mark set in this buffer"))?;
        b.set_mark(Some(b.point()));
        b.set_point(mark);
        b.activate_region();
        Ok(())
    });
    def(ed, "mark-whole-buffer", "Put point at the beginning of the buffer and the mark at the end.", |ed, _| {
        let b = ed.buffer_mut();
        b.set_mark(Some(b.len()));
        b.set_point(0);
        b.activate_region();
        Ok(())
    });
    def(ed, "keyboard-quit", "Cancel the current prompt or key sequence, and deactivate the region.", |ed, _| {
        ed.window_buffer_mut().deactivate_mark();
        ed.abort();
        err("Quit")
    });
}

fn killing(ed: &mut Editor) {
    def(
        ed,
        "kill-line",
        "Kill the rest of the line, or the newline if only whitespace is left.\n\nConsecutive kills join into one kill ring entry.",
        |ed, _| {
            let b = ed.buffer_mut();
            let p = b.point();
            if p >= b.len() {
                return err("End of buffer");
            }
            let end = b.line_end(b.line_of(p));
            let rest_is_blank = b.slice(p..end).trim().is_empty();
            let to = if rest_is_blank && end < b.len() { end + 1 } else { end };
            let killed = b.delete(p..to)?;
            ed.kill(killed, false);
            Ok(())
        },
    );
    def(ed, "kill-word", "Kill forward to the end of the next word.", |ed, _| {
        let b = ed.buffer_mut();
        let p = b.point();
        let killed = b.delete(p..word_end(b, p))?;
        ed.kill(killed, false);
        Ok(())
    });
    def(ed, "backward-kill-word", "Kill back to the start of the previous word.", |ed, _| {
        let b = ed.buffer_mut();
        let p = b.point();
        let killed = b.delete(word_start(b, p)..p)?;
        ed.kill(killed, true);
        Ok(())
    });
    def(ed, "kill-region", "Kill the text between point and the mark.", |ed, _| {
        let region = region(ed.buffer())?;
        let killed = ed.buffer_mut().delete(region)?;
        ed.kill(killed, false);
        Ok(())
    });
    def(ed, "kill-ring-save", "Copy the text between point and the mark to the kill ring.", |ed, _| {
        let region = region(ed.buffer())?;
        let text = ed.buffer().slice(region);
        ed.kill_ring.push(text);
        ed.buffer_mut().deactivate_mark();
        Ok(())
    });
    def(ed, "yank", "Insert the most recent kill, leaving the mark at its start.", |ed, _| {
        let text = ed
            .kill_ring
            .last()
            .cloned()
            .ok_or_else(|| Error::new("Kill ring is empty"))?;
        let b = ed.buffer_mut();
        b.set_mark(Some(b.point()));
        b.insert(&text)
    });
}

fn region(b: &Buffer) -> Result<std::ops::Range<usize>> {
    b.region()
        .ok_or_else(|| Error::new("The mark is not set now, so there is no region"))
}

fn files_and_buffers(ed: &mut Editor) {
    ed.define_command(
        Command::new(
            "find-file",
            "Visit a file in a buffer.\n\nA file that does not exist yet is created when the buffer is saved.",
            |ed, args| {
                let path = expand_file_name(args[0].as_str()?);
                ed.visit_file(&path)
            },
        )
        .param("file", ParamKind::File, "Find file: "),
    );
    def(ed, "save-buffer", "Save the current buffer to its file.", |ed, _| {
        let b = ed.window_buffer_mut();
        if b.path.is_none() {
            return err("Buffer is not visiting a file; use write-file (C-x C-w)");
        }
        if !b.is_modified() {
            ed.message("(No changes need to be saved)");
            return Ok(());
        }
        b.save()?;
        let path = b.path.as_ref().expect("checked above").display().to_string();
        ed.message(format!("Wrote {path}"));
        Ok(())
    });
    ed.define_command(
        Command::new("write-file", "Write the current buffer to a file and visit that file.", |ed, args| {
            let path = expand_file_name(args[0].as_str()?);
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .ok_or_else(|| Error::new("Not a file name"))?;
            let name = ed.unique_buffer_name(&name);
            let b = ed.window_buffer_mut();
            b.path = Some(path.clone());
            b.name = name;
            b.save()?;
            ed.message(format!("Wrote {}", path.display()));
            Ok(())
        })
        .param("file", ParamKind::File, "Write file: "),
    );
    ed.define_command(
        Command::new(
            "switch-to-buffer",
            "Show a buffer in the window, creating it if it does not exist.\n\nEmpty input switches to the buffer shown before this one.",
            |ed, args| {
                let name = match args[0].as_str()? {
                    "" => ed
                        .other_buffer()
                        .map(str::to_string)
                        .ok_or_else(|| Error::new("No other buffer"))?,
                    name => name.to_string(),
                };
                ed.switch_to_buffer(&name);
                Ok(())
            },
        )
        .param("buffer", ParamKind::Buffer, "Switch to buffer: "),
    );
    ed.define_command(
        Command::new(
            "kill-buffer",
            "Close a buffer. Empty input closes the current one.\n\nRefuses to close a file buffer with unsaved changes.",
            |ed, args| {
                let name = match args[0].as_str()? {
                    "" => ed.window_buffer().name.clone(),
                    name => name.to_string(),
                };
                ed.kill_buffer(&name)
            },
        )
        .param("buffer", ParamKind::Buffer, "Kill buffer: "),
    );
    def(
        ed,
        "save-buffers-kill-terminal",
        "Quit the editor.\n\nIf file buffers have unsaved changes, asks you to repeat the command to quit anyway.",
        |ed, _| {
            let unsaved: Vec<&str> = ed
                .buffers()
                .iter()
                .filter(|b| b.path.is_some() && b.is_modified())
                .map(|b| b.name.as_str())
                .collect();
            if !unsaved.is_empty() && ed.last_command() != Some("save-buffers-kill-terminal") {
                return Err(Error::new(format!(
                    "Unsaved changes in {}; repeat to quit anyway",
                    unsaved.join(", ")
                )));
            }
            ed.quit = true;
            Ok(())
        },
    );
}

fn minibuffer(ed: &mut Editor) {
    def(ed, "exit-minibuffer", "Finish the minibuffer input and pass it to the waiting command.", |ed, _| {
        let prompt = ed.prompt.as_ref().ok_or_else(|| Error::new("Not in the minibuffer"))?;
        let input = ed.minibuffer.slice(0..ed.minibuffer.len());
        let value = if prompt.kind == ParamKind::Command && ed.command(&input).is_none() {
            match ed.completions(ParamKind::Command, &input).as_slice() {
                [only] => only.clone(),
                _ => return err("[No match]"),
            }
        } else {
            input
        };
        ed.prompt = None;
        ed.minibuffer.set_text("");
        ed.supply_arg(Arg::Str(value));
        Ok(())
    });
    def(ed, "minibuffer-complete", "Complete the minibuffer input as far as it is unambiguous.", |ed, _| {
        let kind = ed.prompt.as_ref().ok_or_else(|| Error::new("Not in the minibuffer"))?.kind;
        let input = ed.minibuffer.slice(0..ed.minibuffer.len());
        let candidates = ed.completions(kind, &input);
        if candidates.is_empty() {
            return err("[No match]");
        }
        let common = common_prefix(&candidates);
        if common.len() > input.len() {
            ed.minibuffer.set_text(&common);
            ed.minibuffer.set_point(ed.minibuffer.len());
        } else if candidates.len() == 1 {
            ed.message("[Sole completion]");
        }
        Ok(())
    });
    ed.define_command(
        Command::new(
            "execute-extended-command",
            "Read a command name, with completion, and run it.",
            |ed, args| {
                ed.run_interactive(args[0].as_str()?);
                Ok(())
            },
        )
        .param("command", ParamKind::Command, "M-x "),
    );
}

fn common_prefix(items: &[String]) -> String {
    let Some(first) = items.first() else { return String::new() };
    let mut len = first.len();
    for item in &items[1..] {
        len = first
            .char_indices()
            .zip(item.chars())
            .take_while(|((_, a), b)| a == b)
            .last()
            .map_or(0, |((i, a), _)| i + a.len_utf8())
            .min(len);
    }
    first[..len].to_string()
}

fn help(ed: &mut Editor) {
    ed.define_command(
        Command::new("describe-command", "Show the documentation of a command.", |ed, args| {
            let text = describe(ed, args[0].as_str()?)?;
            ed.show_help(&text);
            Ok(())
        })
        .param("command", ParamKind::Command, "Describe command: "),
    );
    ed.define_command(
        Command::new("describe-key", "Show which command a key sequence runs.", |ed, args| {
            let keys = args[0].as_keys()?;
            // Fall back to the key without Shift, as typing it would.
            let unshifted: Vec<_> = keys.iter().map(|k| k.unshifted()).collect();
            let found = match ed.global_map.lookup(keys) {
                Lookup::Unbound => ed.global_map.lookup(&unshifted),
                found => found,
            };
            let name = match found {
                Lookup::Command(name) => name,
                _ if keys.len() == 1 && keys[0].printable().is_some() => {
                    "self-insert-command".to_string()
                }
                _ => return Err(Error::new(format!("{} is undefined", format_keys(keys)))),
            };
            let text = format!("{} runs the command {name}.\n\n{}", format_keys(keys), describe(ed, &name)?);
            ed.show_help(&text);
            Ok(())
        })
        .param("key", ParamKind::Keys, "Describe key: "),
    );
    def(ed, "describe-bindings", "List all key bindings.", |ed, _| {
        let mut text = String::from("Key             Command\n---             -------\n");
        for (keys, command) in ed.global_map.bindings() {
            text += &format!("{:<15} {command}\n", format_keys(&keys));
        }
        ed.show_help(&text);
        Ok(())
    });
}

fn describe(ed: &Editor, name: &str) -> Result<String> {
    let command = ed
        .command(name)
        .ok_or_else(|| Error::new(format!("No such command: {name}")))?;
    let mut text = format!("{name} is a command.\n\n");
    let keys = ed.global_map.keys_for(name);
    if keys.is_empty() {
        text += "It is not bound to any keys.\n\n";
    } else {
        let keys: Vec<String> = keys.iter().map(|k| format_keys(k)).collect();
        text += &format!("It is bound to {}.\n\n", keys.join(", "));
    }
    if !command.params.is_empty() {
        text += "Parameters:\n";
        for p in &command.params {
            text += &format!("  {} ({})\n", p.name, p.kind.describe());
        }
        text += "\n";
    }
    text += &command.doc;
    text.push('\n');
    if command.shift_select {
        text += "\nWith Shift held, it selects text as it moves (shift selection).\n";
    }
    if let Some(source) = &command.source {
        text += &format!("\nDefined in {source}.\n");
    }
    Ok(text)
}

fn bind_defaults(ed: &mut Editor) {
    let global = [
        ("C-f", "forward-char"),
        ("<right>", "forward-char"),
        ("C-b", "backward-char"),
        ("<left>", "backward-char"),
        ("C-n", "next-line"),
        ("<down>", "next-line"),
        ("C-p", "previous-line"),
        ("<up>", "previous-line"),
        ("C-a", "move-beginning-of-line"),
        ("<home>", "move-beginning-of-line"),
        ("C-e", "move-end-of-line"),
        ("<end>", "move-end-of-line"),
        ("M-f", "forward-word"),
        ("M-b", "backward-word"),
        ("M-<", "beginning-of-buffer"),
        ("M->", "end-of-buffer"),
        ("C-v", "scroll-up-command"),
        ("<next>", "scroll-up-command"),
        ("M-v", "scroll-down-command"),
        ("<prior>", "scroll-down-command"),
        ("C-l", "recenter"),
        ("<wheel-up>", "mwheel-scroll"),
        ("<wheel-down>", "mwheel-scroll"),
        ("RET", "newline"),
        ("TAB", "indent-for-tab-command"),
        ("DEL", "delete-backward-char"),
        ("C-d", "delete-char"),
        ("<delete>", "delete-char"),
        ("C-k", "kill-line"),
        ("M-d", "kill-word"),
        ("M-DEL", "backward-kill-word"),
        ("C-w", "kill-region"),
        ("M-w", "kill-ring-save"),
        ("C-y", "yank"),
        ("C-SPC", "set-mark-command"),
        ("C-@", "set-mark-command"),
        ("C-x C-x", "exchange-point-and-mark"),
        ("C-x h", "mark-whole-buffer"),
        ("C-/", "undo"),
        ("C-_", "undo"),
        ("C-x u", "undo"),
        ("C-g", "keyboard-quit"),
        ("M-x", "execute-extended-command"),
        ("C-x C-f", "find-file"),
        ("C-x C-s", "save-buffer"),
        ("C-x C-w", "write-file"),
        ("C-x b", "switch-to-buffer"),
        ("C-x k", "kill-buffer"),
        ("C-x C-c", "save-buffers-kill-terminal"),
        ("C-h f", "describe-command"),
        ("C-h k", "describe-key"),
        ("C-h b", "describe-bindings"),
    ];
    for (keys, command) in global {
        ed.global_map.bind_str(keys, command);
    }
    for (keys, command) in [
        ("RET", "exit-minibuffer"),
        ("TAB", "minibuffer-complete"),
        ("C-g", "keyboard-quit"),
    ] {
        ed.minibuffer_map.bind_str(keys, command);
    }
}
