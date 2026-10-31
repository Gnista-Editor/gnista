//! The bidi primitives for scripts, as Emacs's xdisp.c and
//! `get-char-code-property` have them ([ADR 0047]).
//!
//! [ADR 0047]: ../../../docs/adr/0047-bidirectional-text.md

use ember_core::Error;
use ember_core::bidi::{self, Direction};
use rquickjs::function::Opt;
use rquickjs::{Ctx, Function, Object, Value};

use super::with_editor;

/// A character given as a one-character string or a code point.
fn char_of(value: &Value<'_>) -> Option<char> {
    if let Some(s) = value.as_string().and_then(|s| s.to_string().ok()) {
        let mut chars = s.chars();
        return chars.next().filter(|_| chars.next().is_none());
    }
    value.as_number().and_then(|n| char::from_u32(n as u32))
}

pub(crate) fn install_native_bidi<'js>(ctx: &Ctx<'js>, native: &Object<'js>) -> rquickjs::Result<()> {
    native.set(
        "currentBidiParagraphDirection",
        Function::new(ctx.clone(), |ctx: Ctx<'js>| {
            with_editor(&ctx, |ed| {
                let dir = ed.current_bidi_paragraph_direction(None).ok_or_else(|| Error::new("No such buffer"))?;
                Ok(dir.name().to_string())
            })
        })?,
    )?;
    native.set(
        "movePointVisually",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, direction: i64| with_editor(&ctx, |ed| ed.move_point_visually(direction)))?,
    )?;
    native.set(
        "bidiResolvedLevels",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, vpos: Opt<usize>| with_editor(&ctx, |ed| Ok(ed.bidi_resolved_levels(vpos.0))))?,
    )?;
    native.set(
        "bidiFindOverriddenDirectionality",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, from: usize, to: usize, object: Value<'js>, rtl: bool| {
            let base = if rtl { Direction::RightToLeft } else { Direction::LeftToRight };
            let string = object.as_string().and_then(|s| s.to_string().ok());
            with_editor(&ctx, |ed| {
                if let Some(s) = string {
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
            })
        })?,
    )?;
    native.set(
        "getCharCodeProperty",
        Function::new(ctx.clone(), |ctx: Ctx<'js>, c: Value<'js>, property: String| -> rquickjs::Result<Option<String>> {
            let Some(c) = char_of(&c) else { return Err(rquickjs::Exception::throw_type(&ctx, "Expected a character")) };
            Ok(match property.as_str() {
                "bidi-class" => Some(bidi::bidi_class(c).name().to_string()),
                "mirroring" => bidi::mirror(c).map(String::from),
                "paired-bracket" => bidi::paired_bracket(c).map(|(p, _)| p.to_string()),
                "bracket-type" => Some(match bidi::paired_bracket(c) {
                    Some((_, true)) => "o",
                    Some((_, false)) => "c",
                    None => "n",
                }
                .to_string()),
                "mirrored" => Some(if bidi::mirrored(c) { "Y" } else { "N" }.to_string()),
                _ => None,
            })
        })?,
    )?;
    Ok(())
}
