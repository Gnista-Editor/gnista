//! Fringe bitmaps drawn: Emacs's standard ones as shapes 8 points wide,
//! and those `define-fringe-bitmap` defined from their bits, centred in a
//! row of the fringe.

use egui::{Color32, Painter, Pos2, Rect, Shape, Stroke, StrokeKind, pos2, vec2};
use ember_core::{Editor, FringeAlign};

/// How wide a bitmap is drawn, as Emacs's are 8 pixels.
const WIDTH: f32 = 8.0;

/// Draws a fringe bitmap by name in a row of a fringe.
pub fn draw_bitmap(painter: &Painter, ed: &Editor, name: &str, row: Rect, color: Color32) {
    if let Some(bitmap) = ed.fringe_bitmap(name) {
        draw_bits(painter, &bitmap.bits, bitmap.width, bitmap.align, row, color);
        return;
    }
    let h = row.height().min(14.0);
    let r = Rect::from_center_size(row.center(), vec2(WIDTH, h));
    let stroke = Stroke::new(1.5, color);
    let line = |points: Vec<Pos2>| Shape::line(points, stroke);
    let at = |x: f32, y: f32| pos2(r.left() + x * r.width(), r.top() + y * r.height());
    let shapes: Vec<Shape> = match name {
        "left-arrow" => vec![line(vec![at(1.0, 0.5), at(0.0, 0.5)]), line(vec![at(0.45, 0.2), at(0.0, 0.5), at(0.45, 0.8)])],
        "right-arrow" => vec![line(vec![at(0.0, 0.5), at(1.0, 0.5)]), line(vec![at(0.55, 0.2), at(1.0, 0.5), at(0.55, 0.8)])],
        "up-arrow" => vec![line(vec![at(0.5, 1.0), at(0.5, 0.0)]), line(vec![at(0.1, 0.35), at(0.5, 0.0), at(0.9, 0.35)])],
        "down-arrow" => vec![line(vec![at(0.5, 0.0), at(0.5, 1.0)]), line(vec![at(0.1, 0.65), at(0.5, 1.0), at(0.9, 0.65)])],
        // A line goes on in the next row: down and back to the left.
        "right-curly-arrow" => vec![
            line(vec![at(0.1, 0.15), at(0.9, 0.15), at(0.9, 0.85), at(0.15, 0.85)]),
            line(vec![at(0.45, 0.6), at(0.15, 0.85), at(0.45, 1.0)]),
        ],
        // A line came from the row before: in from the left and on.
        "left-curly-arrow" => vec![
            line(vec![at(0.9, 0.85), at(0.1, 0.85), at(0.1, 0.15), at(0.85, 0.15)]),
            line(vec![at(0.55, 0.0), at(0.85, 0.15), at(0.55, 0.4)]),
        ],
        "left-triangle" => vec![Shape::convex_polygon(vec![at(1.0, 0.1), at(0.1, 0.5), at(1.0, 0.9)], color, Stroke::NONE)],
        "right-triangle" => vec![Shape::convex_polygon(vec![at(0.0, 0.1), at(0.9, 0.5), at(0.0, 0.9)], color, Stroke::NONE)],
        "top-left-angle" => vec![line(vec![at(0.2, 0.9), at(0.2, 0.1), at(0.9, 0.1)])],
        "top-right-angle" => vec![line(vec![at(0.1, 0.1), at(0.8, 0.1), at(0.8, 0.9)])],
        "bottom-left-angle" => vec![line(vec![at(0.2, 0.1), at(0.2, 0.9), at(0.9, 0.9)])],
        "bottom-right-angle" => vec![line(vec![at(0.1, 0.9), at(0.8, 0.9), at(0.8, 0.1)])],
        "left-bracket" => vec![line(vec![at(0.8, 0.0), at(0.3, 0.0), at(0.3, 1.0), at(0.8, 1.0)])],
        "right-bracket" => vec![line(vec![at(0.2, 0.0), at(0.7, 0.0), at(0.7, 1.0), at(0.2, 1.0)])],
        "filled-rectangle" => vec![Shape::rect_filled(r.shrink2(vec2(0.0, 0.0)), 0.0, color)],
        "hollow-rectangle" => vec![Shape::rect_stroke(r.shrink(0.75), 0.0, stroke, StrokeKind::Inside)],
        "filled-square" => vec![Shape::rect_filled(Rect::from_center_size(r.center(), vec2(WIDTH - 2.0, WIDTH - 2.0)), 0.0, color)],
        "hollow-square" => vec![Shape::rect_stroke(Rect::from_center_size(r.center(), vec2(WIDTH - 2.0, WIDTH - 2.0)), 0.0, stroke, StrokeKind::Inside)],
        "vertical-bar" => vec![Shape::rect_filled(Rect::from_center_size(row.center(), vec2(2.0, row.height())), 0.0, color)],
        "horizontal-bar" => vec![Shape::rect_filled(Rect::from_center_size(r.center(), vec2(WIDTH, 2.0)), 0.0, color)],
        "empty-line" => vec![Shape::rect_filled(Rect::from_center_size(r.center(), vec2(WIDTH - 2.0, 1.5)), 0.0, color)],
        "large-circle" => vec![Shape::circle_stroke(r.center(), WIDTH / 2.0 - 0.5, stroke)],
        "exclamation-mark" => vec![
            line(vec![at(0.5, 0.0), at(0.5, 0.65)]),
            Shape::circle_filled(at(0.5, 0.9), 1.0, color),
        ],
        // A bitmap Ember does not know shows as Emacs's for an unknown one.
        _ => vec![
            line(vec![at(0.15, 0.25), at(0.3, 0.05), at(0.7, 0.05), at(0.85, 0.25), at(0.5, 0.5), at(0.5, 0.7)]),
            Shape::circle_filled(at(0.5, 0.92), 1.0, color),
        ],
    };
    painter.with_clip_rect(row).extend(shapes);
}

/// Draws a bitmap's rows of bits, a point to a bit, lined up in the row as it says.
fn draw_bits(painter: &Painter, bits: &[u16], width: u8, align: FringeAlign, row: Rect, color: Color32) {
    let height = bits.len() as f32;
    let top = match align {
        FringeAlign::Top => row.top(),
        FringeAlign::Center => row.center().y - height / 2.0,
        FringeAlign::Bottom => row.bottom() - height,
    };
    let left = (row.center().x - f32::from(width) / 2.0).round();
    let top = top.round();
    // One mesh, without the feathering that would all but erase a dot a
    // point square, as egui draws text backgrounds.
    let mut mesh = egui::Mesh::default();
    for (y, line) in bits.iter().enumerate() {
        for x in 0..width {
            if line & (1 << (width - 1 - x)) != 0 {
                mesh.add_colored_rect(Rect::from_min_size(pos2(left + f32::from(x), top + y as f32), vec2(1.0, 1.0)), color);
            }
        }
    }
    painter.with_clip_rect(row).add(Shape::mesh(mesh));
}
