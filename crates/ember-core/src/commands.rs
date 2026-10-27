//! The built-in commands and their default key bindings.

use crate::buffer::Buffer;
use crate::command::{Arg, Command, ParamKind};
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::files::expand_file_name;
use crate::key::{KeyCode, format_keys};
use crate::keymap::Lookup;
use crate::prefix::PrefixArg;
use crate::variables::Value;

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
    def_motion(
        ed,
        "forward-char",
        "Move point forward a character, or as many as the prefix argument says.\n\nA negative argument moves backward.",
        |ed, _| move_chars(ed, ed.prefix_numeric()),
    );
    def_motion(
        ed,
        "backward-char",
        "Move point backward a character, or as many as the prefix argument says.\n\nA negative argument moves forward.",
        |ed, _| move_chars(ed, -ed.prefix_numeric()),
    );
    def_motion(
        ed,
        "next-line",
        "Move point down a line, or as many as the prefix argument says.\n\nRepeated line moves keep to the column where they started.",
        |ed, _| line_move(ed, ed.prefix_numeric()),
    );
    def_motion(
        ed,
        "previous-line",
        "Move point up a line, or as many as the prefix argument says.\n\nRepeated line moves keep to the column where they started.",
        |ed, _| line_move(ed, -ed.prefix_numeric()),
    );
    def_motion(
        ed,
        "move-beginning-of-line",
        "Move point to the beginning of the line.\n\nWith a prefix argument N, move forward N - 1 lines first. Where text is hidden, this is the start of the row on screen, as in Emacs.",
        |ed, _| {
            let n = ed.prefix_numeric();
            let b = ed.buffer();
            let pos = if n == 1 { b.point() } else { forward_line(b, b.point(), n - 1) };
            let row = ed.row_line_in(b, b.line_of(pos));
            let b = ed.buffer_mut();
            b.set_point(b.line_start(row));
            Ok(())
        },
    );
    def_motion(
        ed,
        "move-end-of-line",
        "Move point to the end of the line.\n\nWith a prefix argument N, move forward N - 1 lines first. Where text is hidden, this is the end of the row on screen, after the hidden text, as in Emacs.",
        |ed, _| {
            let n = ed.prefix_numeric();
            let b = ed.buffer();
            let pos = if n == 1 { b.point() } else { forward_line(b, b.point(), n - 1) };
            // Past hidden text that runs on from the end of the line, to the row's end.
            let mut end = b.line_end(b.line_of(pos));
            while ed.invisible_in(b, end).is_some() {
                end = b.line_end(b.line_of(ed.skip_invisible_in(b, end).0));
            }
            ed.buffer_mut().set_point(end);
            Ok(())
        },
    );
    def_motion(
        ed,
        "forward-word",
        "Move point forward to the end of a word, or as many words as the prefix argument says.\n\nA negative argument moves backward.",
        |ed, _| {
            let n = ed.prefix_numeric();
            let b = ed.buffer_mut();
            b.set_point(move_words(b, b.point(), n));
            Ok(())
        },
    );
    def_motion(
        ed,
        "backward-word",
        "Move point back to the start of a word, or as many words as the prefix argument says.\n\nA negative argument moves forward.",
        |ed, _| {
            let n = ed.prefix_numeric();
            let b = ed.buffer_mut();
            b.set_point(move_words(b, b.point(), -n));
            Ok(())
        },
    );
    def_motion(
        ed,
        "beginning-of-buffer",
        "Move point to the beginning of the buffer.\n\nUnless the region is active, leaves the mark where point was. With a numeric prefix argument N, move to N tenths of the way through the buffer instead, at the start of the next line. Plain C-u does not leave the mark.",
        |ed, _| {
            let arg = ed.current_prefix_arg();
            let b = ed.buffer_mut();
            if !matches!(arg, Some(PrefixArg::Universal(_))) && !b.is_mark_active() {
                b.push_mark(b.point(), false);
            }
            match arg {
                Some(arg @ (PrefixArg::Number(_) | PrefixArg::Minus)) => {
                    let pos = (1 + tenths(b.len(), arg.numeric())).clamp(0, b.len() as i64) as usize;
                    b.set_point(forward_line(b, pos, 1));
                }
                _ => b.set_point(0),
            }
            Ok(())
        },
    );
    def_motion(
        ed,
        "end-of-buffer",
        "Move point to the end of the buffer.\n\nUnless the region is active, leaves the mark where point was. With a numeric prefix argument N, move to N tenths of the way from the end instead, at the start of the next line. Plain C-u does not leave the mark.",
        |ed, _| {
            let arg = ed.current_prefix_arg();
            let b = ed.buffer_mut();
            if !matches!(arg, Some(PrefixArg::Universal(_))) && !b.is_mark_active() {
                b.push_mark(b.point(), false);
            }
            match arg {
                Some(arg @ (PrefixArg::Number(_) | PrefixArg::Minus)) => {
                    let pos = (b.len() as i64 - tenths(b.len(), arg.numeric())).clamp(0, b.len() as i64) as usize;
                    b.set_point(forward_line(b, pos, 1));
                }
                _ => b.set_point(b.len()),
            }
            Ok(())
        },
    );
    def_motion(ed, "scroll-up-command", "Scroll the text up by nearly a screen, showing later lines.\n\nWith a numeric prefix argument, scroll that many lines; with C-- alone, scroll the other way.", |ed, _| {
        match ed.current_prefix_arg() {
            None => {}
            Some(PrefixArg::Minus) => return scroll_screen_down(ed),
            Some(arg) => return scroll_lines_or_error(ed, arg.numeric()),
        }
        let step = scroll_step(ed) as i64;
        let b = ed.window_buffer();
        let (top, moved) = ed.move_rows_in(b, ed.row_line_in(b, b.top_line), step);
        let point_row = ed.row_line_in(b, b.line_of(b.point()));
        let b = ed.window_buffer_mut();
        if moved < step {
            b.set_point(b.len());
            return err("End of buffer");
        }
        b.top_line = top;
        if point_row < top {
            b.set_point(b.line_start(top));
        }
        Ok(())
    });
    def_motion(ed, "scroll-down-command", "Scroll the text down by nearly a screen, showing earlier lines.\n\nWith a numeric prefix argument, scroll that many lines; with C-- alone, scroll the other way.", |ed, _| {
        match ed.current_prefix_arg() {
            None => scroll_screen_down(ed),
            Some(PrefixArg::Minus) => ed.call("scroll-up-command", Vec::new()),
            Some(arg) => scroll_lines_or_error(ed, -arg.numeric()),
        }
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
            // Like mwheel-scroll in Emacs, reaching either end is not an
            // error, and the window under the mouse scrolls.
            match ed.last_mouse.map(|m| m.window) {
                Some(window) => ed.with_selected_window(window, |ed| scroll_lines(ed, lines)),
                None => scroll_lines(ed, lines),
            };
            Ok(())
        },
    );
    def(ed, "scroll-up-line", "Scroll the text up a line, or as many as the prefix argument says.", |ed, _| {
        scroll_lines_or_error(ed, ed.prefix_numeric())
    });
    def(ed, "scroll-down-line", "Scroll the text down a line, or as many as the prefix argument says.", |ed, _| {
        scroll_lines_or_error(ed, -ed.prefix_numeric())
    });
    def(
        ed,
        "recenter",
        "Scroll so the line with point is in the middle of the window.\n\nWith a numeric prefix argument N, put it on line N of the window instead, counting from the bottom if N is negative.",
        |ed, _| {
            let height = ed.viewport_height() as i64;
            let arg = ed.current_prefix_arg();
            let b = ed.window_buffer();
            let point_row = ed.row_line_in(b, b.line_of(b.point()));
            let row = match arg {
                Some(arg @ (PrefixArg::Number(_) | PrefixArg::Minus)) => {
                    let n = arg.numeric();
                    if n >= 0 { n.min(height - 1) } else { (height + n).max(0) }
                }
                _ => height / 2,
            };
            let top = ed.move_rows_in(b, point_row, -row).0;
            ed.window_buffer_mut().top_line = top;
            Ok(())
        },
    );
}

/// Moves point `n` characters, backward if negative. Like Emacs, going past
/// either end stops there and signals an error.
fn move_chars(ed: &mut Editor, n: i64) -> Result<()> {
    let b = ed.buffer_mut();
    let target = b.point() as i64 + n;
    if target < 0 {
        b.set_point(0);
        return err("Beginning of buffer");
    }
    if target > b.len() as i64 {
        b.set_point(b.len());
        return err("End of buffer");
    }
    b.set_point(target as usize);
    Ok(())
}

/// The start of the line `n` lines from the one containing `pos`, as Emacs's
/// `forward-line` moves: line 0 is the current line, and going past the last
/// line stops at the end of the buffer.
fn forward_line(b: &Buffer, pos: usize, n: i64) -> usize {
    let line = b.line_of(pos) as i64 + n;
    if line < 0 {
        0
    } else if line as usize >= b.line_count() {
        b.len()
    } else {
        b.line_start(line as usize)
    }
}

/// `n` tenths of `size`, rounding towards zero as Emacs's integer division does.
fn tenths(size: usize, n: i64) -> i64 {
    size as i64 * n / 10
}

/// The position after moving `n` words from `pos`, backward if negative.
fn move_words(b: &Buffer, mut pos: usize, n: i64) -> usize {
    for _ in 0..n.unsigned_abs() {
        pos = if n > 0 { word_end(b, pos) } else { word_start(b, pos) };
    }
    pos
}

/// Scrolls `lines` lines, signalling an error if the window cannot scroll at all.
fn scroll_lines_or_error(ed: &mut Editor, lines: i64) -> Result<()> {
    if scroll_lines(ed, lines as isize) {
        Ok(())
    } else if lines < 0 {
        err("Beginning of buffer")
    } else {
        err("End of buffer")
    }
}

/// Scrolls back by nearly a screen, as M-v does.
fn scroll_screen_down(ed: &mut Editor) -> Result<()> {
    let step = scroll_step(ed) as i64;
    let height = ed.viewport_height() as i64;
    let b = ed.window_buffer();
    let old_top = ed.row_line_in(b, b.top_line);
    let top = ed.move_rows_in(b, old_top, -step).0;
    let bottom = ed.move_rows_in(b, top, height - 1).0;
    let point_row = ed.row_line_in(b, b.line_of(b.point()));
    let b = ed.window_buffer_mut();
    if old_top == 0 {
        b.set_point(0);
        return err("Beginning of buffer");
    }
    b.top_line = top;
    if point_row > bottom {
        b.set_point(b.line_start(bottom));
    }
    Ok(())
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
    let b = ed.window_buffer();
    let (top, moved) = ed.move_rows_in(b, ed.row_line_in(b, b.top_line), lines as i64);
    if moved == 0 {
        return false;
    }
    let bottom = ed.move_rows_in(b, top, height as i64 - 1).0;
    let point_row = ed.row_line_in(b, b.line_of(b.point()));
    let target = point_row.clamp(top, bottom);
    let b = ed.window_buffer_mut();
    b.top_line = top;
    if target != point_row {
        let start = b.line_start(target);
        b.set_point((start + goal).min(b.line_end(target)));
    }
    true
}

/// Commands after which scrolling and line moves keep the earlier goal column.
const SCROLL_KEEPS_COLUMN: &[&str] =
    &["next-line", "previous-line", "mwheel-scroll", "scroll-up-line", "scroll-down-line"];

/// Moves point `n` lines, up if negative, keeping the goal column.
fn line_move(ed: &mut Editor, n: i64) -> Result<()> {
    let continuing = ed.last_command().is_some_and(|c| SCROLL_KEEPS_COLUMN.contains(&c));
    let b = ed.buffer();
    let line = b.line_of(b.point());
    let goal = match ed.goal_column {
        Some(goal) if continuing => goal,
        _ => b.column(b.point()),
    };
    ed.goal_column = Some(goal);
    // Lines inside hidden text are skipped, as Emacs's line-move-ignore-invisible does.
    let b = ed.buffer();
    let (target, moved) = ed.move_rows_in(b, ed.row_line_in(b, line), n);
    let b = ed.buffer_mut();
    if moved != n {
        if n > 0 {
            b.set_point(b.len());
            return err("End of buffer");
        }
        b.set_point(0);
        return err("Beginning of buffer");
    }
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
    def(ed, "self-insert-command", "Insert the character you typed, as many times as the prefix argument says.", |ed, _| {
        let c = ed
            .last_key
            .and_then(|k| k.printable())
            .ok_or_else(|| Error::new("self-insert-command must be run from a key"))?;
        let n = ed.prefix_numeric();
        if n < 0 {
            return Err(Error::new(format!("Negative repetition argument {n}")));
        }
        // In overwrite mode each character replaces the one after point,
        // except at the end of a line, as in Emacs.
        if ed.variable("overwrite-mode").is_some_and(|v| v.is_true()) {
            let b = ed.buffer_mut();
            let p = b.point();
            let line_end = b.line_end(b.line_of(p));
            b.delete(p..(p + n as usize).min(line_end))?;
        }
        ed.buffer_mut().insert(&c.to_string().repeat(n as usize))
    });
    ed.define_command(
        Command::new("insert", "Insert text at point.", |ed, args| {
            let text = args[0].as_str()?.to_string();
            ed.buffer_mut().insert(&text)
        })
        .param("text", ParamKind::String, "Insert: "),
    );
    def(ed, "newline", "Insert a newline, or as many as the prefix argument says.", |ed, _| {
        let n = ed.prefix_numeric().max(0) as usize;
        ed.buffer_mut().insert(&"\n".repeat(n))
    });
    def(ed, "indent-for-tab-command", "Indent the current line. For now this inserts a tab.", |ed, _| {
        ed.buffer_mut().insert("\t")
    });
    def(
        ed,
        "delete-backward-char",
        "Delete the character before point, or as many as the prefix argument says.\n\nWith a prefix argument, the characters are killed rather than deleted, so they can be yanked back. If the region is active, delete it instead, as the variable delete-active-region says.",
        |ed, _| {
            if delete_active_region(ed)? {
                return Ok(());
            }
            delete_chars(ed, -ed.prefix_numeric())
        },
    );
    def(
        ed,
        "delete-forward-char",
        "Delete the character after point, or as many as the prefix argument says.\n\nWith a prefix argument, the characters are killed rather than deleted. If the region is active, delete it instead, as the variable delete-active-region says.",
        |ed, _| {
            if delete_active_region(ed)? {
                return Ok(());
            }
            delete_chars(ed, ed.prefix_numeric())
        },
    );
    def(ed, "ignore", "Do nothing. A pre-command-hook function can make a command this one, to cancel it.", |_, _| Ok(()));
    def(
        ed,
        "delete-char",
        "Delete the character after point, or as many as the prefix argument says.\n\nWith a prefix argument, the characters are killed rather than deleted, so they can be yanked back.",
        |ed, _| delete_chars(ed, ed.prefix_numeric()),
    );
    def(
        ed,
        "undo",
        "Undo the last change, or as many changes as the prefix argument says.\n\nRepeat to undo earlier changes. Undoing is itself a change, so after any other command, undo undoes the undos: it redoes.",
        |ed, _| {
            let mut continuing = ed.last_command() == Some("undo");
            let mut redid = false;
            for _ in 0..ed.prefix_numeric().max(1) {
                redid = ed.buffer_mut().undo(continuing)?;
                continuing = true;
            }
            ed.message(if redid { "Redo" } else { "Undo" });
            Ok(())
        },
    );
    def(
        ed,
        "undo-redo",
        "Undo the last undo, or as many as the prefix argument says: redo.\n\nUnlike undoing an undo with undo, this leaves no trace in the undo history.",
        |ed, _| {
            for _ in 0..ed.prefix_numeric().max(1) {
                ed.buffer_mut().undo_redo()?;
            }
            // So that a following undo carries on from here.
            ed.set_this_command("undo");
            ed.message("Redo");
            Ok(())
        },
    );
    def(
        ed,
        "set-mark-command",
        "Set the mark at point and activate the region, saving the old mark on the mark ring.\n\nRepeating it straight away deactivates the region, leaving the mark set. With C-u, jump to the mark instead and take the previous one from the mark ring, so repeating C-u C-SPC goes back through earlier marks.",
        |ed, _| {
            let arg = ed.current_prefix_arg();
            let repeated = ed.last_command() == Some("set-mark-command");
            let b = ed.buffer_mut();
            if let Some(PrefixArg::Universal(4)) = arg {
                let mark = b.mark().ok_or_else(|| Error::new("No mark set in this buffer"))?;
                let popped = b.point() == mark;
                b.set_point(mark);
                b.pop_mark();
                if popped {
                    ed.message("Mark popped");
                }
            } else if repeated && b.is_mark_active() && b.mark() == Some(b.point()) {
                b.deactivate_mark();
                ed.message("Mark deactivated");
            } else {
                b.push_mark(b.point(), true);
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
        b.push_mark(b.point(), false);
        b.push_mark(b.len(), true);
        b.set_point(0);
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
        "Kill the rest of the line, or the newline if only spaces and tabs are left.\n\nWith a prefix argument N, kill N whole lines, newlines included; 0 kills back to the start of the line, and a negative N kills lines backward. Consecutive kills join into one kill ring entry.",
        |ed, _| {
            let arg = ed.current_prefix_arg();
            let b = ed.buffer_mut();
            let p = b.point();
            let to = match arg {
                Some(arg) => forward_line(b, p, arg.numeric()),
                None => {
                    if p >= b.len() {
                        return err("End of buffer");
                    }
                    let end = b.line_end(b.line_of(p));
                    let rest_is_blank = b.slice(p..end).chars().all(|c| c == ' ' || c == '\t');
                    if rest_is_blank && end < b.len() { end + 1 } else { end }
                }
            };
            let killed = b.delete(p.min(to)..p.max(to))?;
            ed.kill(killed, to < p);
            Ok(())
        },
    );
    def(
        ed,
        "kill-word",
        "Kill forward to the end of a word, or as many words as the prefix argument says.\n\nA negative argument kills backward.",
        |ed, _| kill_words(ed, ed.prefix_numeric()),
    );
    def(
        ed,
        "backward-kill-word",
        "Kill back to the start of a word, or as many words as the prefix argument says.\n\nA negative argument kills forward.",
        |ed, _| kill_words(ed, -ed.prefix_numeric()),
    );
    def(ed, "kill-region", "Kill the text between point and the mark.", |ed, _| {
        let region = region(ed.buffer())?;
        let killed = ed.buffer_mut().delete(region)?;
        ed.kill(killed, false);
        Ok(())
    });
    def(ed, "kill-ring-save", "Copy the text between point and the mark to the kill ring.", |ed, _| {
        let region = region(ed.buffer())?;
        let text = ed.buffer().slice(region);
        ed.kill_new(text);
        ed.buffer_mut().deactivate_mark();
        Ok(())
    });
    def(
        ed,
        "yank",
        "Insert the most recent kill, leaving the mark at its start.\n\nWith a numeric prefix argument N, insert the Nth most recent kill. With plain C-u, leave point at the start and the mark at the end.",
        |ed, _| {
            let arg = ed.current_prefix_arg();
            // Emacs sets the mark before it looks at the kill ring, even if it is empty.
            let b = ed.buffer_mut();
            b.push_mark(b.point(), false);
            let back = match arg {
                None | Some(PrefixArg::Universal(_)) => 0,
                Some(PrefixArg::Minus) => -2,
                Some(PrefixArg::Number(n)) => n - 1,
            };
            let text = ed.current_kill(back)?;
            let b = ed.buffer_mut();
            b.insert(&text)?;
            if let Some(PrefixArg::Universal(_)) = arg {
                let mark = b.mark().expect("set above");
                b.set_mark(Some(b.point()));
                b.set_point(mark);
            }
            Ok(())
        },
    );
}

/// Deletes `n` characters after point, or before it if negative. With a
/// prefix argument they are killed instead, as Emacs's delete-char does.
/// Like Emacs, asking for more characters than there are deletes nothing.
fn delete_chars(ed: &mut Editor, n: i64) -> Result<()> {
    let kill = ed.current_prefix_arg().is_some();
    let b = ed.buffer_mut();
    let p = b.point() as i64;
    let (start, end) = if n >= 0 { (p, p + n) } else { (p + n, p) };
    if start < 0 {
        return err("Beginning of buffer");
    }
    if end > b.len() as i64 {
        return err("End of buffer");
    }
    let deleted = b.delete(start as usize..end as usize)?;
    if kill {
        ed.kill(deleted, n < 0);
        ed.set_this_command("kill-region");
    }
    Ok(())
}

/// Deletes the active region for DEL and <delete>, as Emacs does when
/// `delete-active-region` is on and there is no count other than 1. Kills it
/// instead if the variable is "kill". Returns whether it did.
fn delete_active_region(ed: &mut Editor) -> Result<bool> {
    let setting = ed.variable("delete-active-region").unwrap_or(Value::Null);
    let region = ed.buffer().active_region().filter(|r| !r.is_empty());
    let (Some(region), true) = (region, setting.is_true() && ed.prefix_numeric() == 1) else {
        return Ok(false);
    };
    let deleted = ed.buffer_mut().delete(region)?;
    if setting.as_str() == Some("kill") {
        ed.kill(deleted, false);
        ed.set_this_command("kill-region");
    }
    Ok(true)
}

/// Kills `n` words after point, or before it if negative.
fn kill_words(ed: &mut Editor, n: i64) -> Result<()> {
    let b = ed.buffer_mut();
    let p = b.point();
    let to = move_words(b, p, n);
    let killed = b.delete(p.min(to)..p.max(to))?;
    ed.kill(killed, to < p);
    Ok(())
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
        ed.run_hooks("before-save-hook")?;
        let b = ed.window_buffer_mut();
        b.save()?;
        let path = b.path.as_ref().expect("checked above").display().to_string();
        ed.message(format!("Wrote {path}"));
        ed.run_hooks("after-save-hook")
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
            ed.run_hooks("before-save-hook")?;
            ed.window_buffer_mut().save()?;
            ed.message(format!("Wrote {}", path.display()));
            ed.run_hooks("after-save-hook")
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
            "Read a command name, with completion, and run it.\n\nA prefix argument given to M-x goes to the command it runs.",
            |ed, args| {
                ed.set_prefix_arg(ed.current_prefix_arg());
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
            let found = match ed.lookup(keys) {
                Lookup::Unbound => ed.lookup(&unshifted),
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
    let keys = ed.keys_for(name);
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
        ("<delete>", "delete-forward-char"),
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
        ("C-?", "undo-redo"),
        ("C-M-_", "undo-redo"),
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
    // Emacs on macOS follows the Mac convention that Home and End go to the
    // ends of the document (ns-win.el); elsewhere they go to the ends of the line.
    if cfg!(target_os = "macos") {
        ed.global_map.bind_str("<home>", "beginning-of-buffer");
        ed.global_map.bind_str("<end>", "end-of-buffer");
    }
    for (keys, command) in [
        ("RET", "exit-minibuffer"),
        ("TAB", "minibuffer-complete"),
        ("C-g", "keyboard-quit"),
    ] {
        ed.minibuffer_map.bind_str(keys, command);
    }
}
