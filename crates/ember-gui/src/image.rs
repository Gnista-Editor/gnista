//! Images drawn ([ADR 0046]): the core decodes an image's pixels when it
//! is first drawn, and they are kept here as egui textures, by the core's
//! id for the image and the scale an SVG was drawn at. A texture not drawn
//! for a while is dropped, as is one whose image the core forgot.
//!
//! [ADR 0046]: ../../../docs/adr/0046-images.md

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use egui::{Color32, ColorImage, Painter, Pos2, Rect, Stroke, StrokeKind, TextureHandle, TextureOptions, pos2, vec2};
use ember_core::frame_description::FrameDescription;
use ember_core::image::ImageGlyph;

/// How many frames a texture is kept for after it was last drawn.
const KEEP_FRAMES: u64 = 600;

#[derive(Default)]
struct Textures {
    /// By image id and scale: the texture, if the image decoded, and the frame it was last drawn in.
    map: HashMap<(u64, u32), (Option<TextureHandle>, u64)>,
    last_sweep: u64,
}

fn textures(ctx: &egui::Context) -> Arc<Mutex<Textures>> {
    ctx.data_mut(|d| d.get_temp_mut_or_default::<Arc<Mutex<Textures>>>(egui::Id::unique("ember-images")).clone())
}

/// An image's texture, decoded and uploaded the first time it is drawn.
fn texture(ctx: &egui::Context, fd: &FrameDescription, image: &ImageGlyph) -> Option<TextureHandle> {
    let scale = ctx.pixels_per_point();
    let key = (image.id, scale.to_bits());
    let frame = ctx.cumulative_pass_nr();
    let textures = textures(ctx);
    let mut textures = textures.lock().expect("not poisoned");
    if frame > textures.last_sweep + KEEP_FRAMES {
        textures.last_sweep = frame;
        textures.map.retain(|_, (_, last)| *last + KEEP_FRAMES > frame);
    }
    if let Some((handle, last)) = textures.map.get_mut(&key) {
        *last = frame;
        return handle.clone();
    }
    let handle = fd.images.get(&image.id).cloned().flatten().map(|rgba| {
        let pixels = ColorImage::from_rgba_unmultiplied([rgba.width as usize, rgba.height as usize], &rgba.pixels);
        // Smooth when shrinking, sharp pixels when enlarging, as Emacs's
        // default image-transform-smoothing chooses.
        let enlarged = image.width * scale >= rgba.width as f32;
        let options = if enlarged { TextureOptions::NEAREST } else { TextureOptions::LINEAR };
        ctx.load_texture(format!("ember-image-{}", image.id), pixels, options)
    });
    textures.map.insert(key, (handle.clone(), frame));
    handle
}

/// Draws an image glyph whose box starts at `top_left`: the part of the
/// image its slice shows, inside its margins, with its relief; or an
/// empty box, as Emacs draws an image it could not load.
pub fn draw_image(painter: &Painter, fd: &FrameDescription, image: &ImageGlyph, top_left: Pos2, ink: Color32) {
    let (dx, dy) = image.image_offset();
    let [sx, sy, sw, sh] = image.slice;
    let rect = Rect::from_min_size(pos2(top_left.x + dx, top_left.y + dy), vec2(sw, sh));
    if image.failed {
        painter.rect_stroke(rect, 0.0, Stroke::new(1.0, ink), StrokeKind::Inside);
        return;
    }
    if let Some(texture) = texture(painter.ctx(), fd, image) {
        let uv = Rect::from_min_max(pos2(sx / image.width, sy / image.height), pos2((sx + sw) / image.width, (sy + sh) / image.height));
        painter.image(texture.id(), rect, uv, Color32::WHITE);
    }
    if image.relief != 0.0 {
        let width = image.relief.abs();
        let outer = rect.expand(width);
        painter.rect_stroke(outer, 0.0, Stroke::new(width, ink.gamma_multiply(0.5)), StrokeKind::Inside);
    }
}

/// The rectangle an image glyph's box takes from `top_left`, the cursor's
/// frame when it is on the image, as Emacs draws a box round an image.
pub fn glyph_rect(image: &ImageGlyph, top_left: Pos2) -> Rect {
    let (dx, dy) = image.image_offset();
    Rect::from_min_size(pos2(top_left.x + dx, top_left.y + dy), vec2(image.slice[2], image.slice[3]))
}
