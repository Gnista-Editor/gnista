use ember_core::display::row_glyphs;
use ember_core::{Editor, Value};

#[test]
fn tab_with_wrap_prefix() {
    let mut ed = Editor::new();
    let w = ed.selected_window();
    ed.set_window_size(w, 21, 10);
    ed.type_text("aaaaaaaaaaaaaaaaaaaaaaaaaa\tbbbbbbbbbbbbbb\n");
    ed.window_buffer_mut().set_point(0);
    let b = ed.window_buffer_mut();
    b.put_text_property(0..40, "wrap-prefix", Value::Str("XX".into()));
    for r in ed.window_rows(4, true) {
        let g = row_glyphs(&r, 8);
        let width: usize = g.iter().map(|g| g.width).sum();
        let t: String = r.segments.iter().map(|s| s.text.as_str()).collect();
        eprintln!("{t:?} width {width}");
    }
}

#[test]
fn rename_unique_own_base() {
    let mut ed = Editor::new();
    ed.get_buffer_create("notes");
    ed.set_prefix_arg(Some(ember_core::PrefixArg::Universal(4)));
    ed.press("C-x x r").unwrap();
    ed.type_text("notes");
    ed.press("RET").unwrap();
    eprintln!("first {}", ed.window_buffer().name);
    ed.set_prefix_arg(Some(ember_core::PrefixArg::Universal(4)));
    ed.press("C-x x r").unwrap();
    ed.type_text("notes");
    ed.press("RET").unwrap();
    eprintln!("second {}", ed.window_buffer().name);
}
