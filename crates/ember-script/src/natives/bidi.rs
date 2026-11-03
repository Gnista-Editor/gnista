//! The bidi primitives for scripts, as Emacs's xdisp.c and
//! `get-char-code-property` have them ([ADR 0047]).
//!
//! [ADR 0047]: ../../../../docs/adr/0047-bidirectional-text.md

use ember_core::bidi::{self, Direction};

use crate::*;
use crate::natives::{natives, Opt};

/// A character given as a one-character string or a code point.
fn char_of(value: &EditorValue) -> Option<char> {
    match value {
        EditorValue::Str(s) => {
            let mut chars = s.chars();
            chars.next().filter(|_| chars.next().is_none())
        }
        EditorValue::Number(n) => char::from_u32(*n as u32),
        _ => None,
    }
}

natives! {
    fn currentBidiParagraphDirection(ed) -> String {
        let dir = ed.current_bidi_paragraph_direction(None).ok_or_else(|| Error::new("No such buffer"))?;
        Ok(dir.name().to_string())
    }

    /// Move point to the character on its right on display, or its left for a
    /// negative direction, wherever that is in the buffer, as
    /// move-point-visually; signals beginning-of-buffer or end-of-buffer.
    /// Returns the new point.
    pub fn movePointVisually(ed, direction: i64) -> usize {
        ed.move_point_visually(direction)
    }

    fn bidiResolvedLevels(ed, vpos: Opt<usize>) -> Option<Vec<u8>> {
        Ok(ed.bidi_resolved_levels(vpos.0))
    }

    /// In the current buffer, or in `object` when it is a string.
    fn bidiFindOverriddenDirectionality(ed, from: usize, to: usize, object: EditorValue, rtl: bool) -> Option<usize> {
        let base = if rtl { Direction::RightToLeft } else { Direction::LeftToRight };
        if let EditorValue::Str(s) = object {
            let chars: Vec<char> = s.chars().collect();
            let (from, to) = (from.min(chars.len()), to.min(chars.len()));
            // As bidi.c, line by line, the first found in the range.
            let mut start = 0;
            for line in chars.split(|&c| c == '\n') {
                if let Some(i) = bidi::first_overridden(line, base.level()) {
                    let found = start + i;
                    if found >= from {
                        return Ok((found < to).then_some(found));
                    }
                }
                start += line.len() + 1;
            }
            return Ok(None);
        }
        Ok(ed.bidi_find_overridden_directionality(ed.buffer(), from, to, base))
    }

    fn getCharCodeProperty(ed, c: EditorValue, property: String) -> Option<String> {
        let Some(c) = char_of(&c) else {
            return Err(Error::signal("wrong-type-argument", "Expected a character", Vec::new()));
        };
        Ok(match property.as_str() {
            "bidi-class" => Some(bidi::bidi_class(c).name().to_string()),
            "mirroring" => bidi::mirror(c).map(String::from),
            "paired-bracket" => bidi::paired_bracket(c).map(|(p, _)| p.to_string()),
            "bracket-type" => Some(
                match bidi::paired_bracket(c) {
                    Some((_, true)) => "o",
                    Some((_, false)) => "c",
                    None => "n",
                }
                .to_string(),
            ),
            "mirrored" => Some(if bidi::mirrored(c) { "Y" } else { "N" }.to_string()),
            _ => None,
        })
    }
}
