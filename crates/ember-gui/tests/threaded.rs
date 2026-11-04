//! The window with the editor on a thread of its own
//! (docs/multithreading.md, step 3): it keeps drawing while a command runs
//! for seconds, and C-g stops the command.

use std::time::{Duration, Instant};

use egui::{Key, Modifiers, vec2};
use egui_kittest::Harness;
use ember_gui::EmberApp;

fn harness() -> Harness<'static, EmberApp> {
    let mut harness = Harness::builder().with_size(vec2(640.0, 360.0)).build_eframe(|cc| {
        ember_gui::theme::install_fonts(&cc.egui_ctx, false);
        EmberApp::threaded(&cc.egui_ctx, |_| None).silent()
    });
    harness.run_steps(2);
    harness
}

/// Steps frames until `done`, or fails after a few seconds.
fn step_until(h: &mut Harness<'_, EmberApp>, mut done: impl FnMut(&mut Harness<'_, EmberApp>) -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while !done(h) {
        assert!(Instant::now() < until, "timed out");
        h.step();
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn keys_reach_the_editor_on_its_thread() {
    let mut h = harness();
    h.event(egui::Event::Text("threads".into()));
    h.step();
    step_until(&mut h, |h| h.state_mut().with_editor(|ed| ed.window_buffer().slice(0..ed.window_buffer().len())) == "threads");
}

#[test]
fn the_window_draws_while_a_command_runs_and_c_g_stops_it() {
    let mut h = harness();
    // A command that runs until it is quit, as a script stuck in a loop.
    h.state_mut().run(|ed| {
        let start = Instant::now();
        let quit = loop {
            if ed.maybe_quit().is_err() {
                break true;
            }
            if start.elapsed() > Duration::from_secs(20) {
                break false;
            }
            std::hint::spin_loop();
        };
        ed.set_variable("stopped", ember_core::Value::Bool(quit));
        ed.set_variable("ran", ember_core::Value::Number(start.elapsed().as_millis() as f64));
    });
    // Frames go on being drawn, none waiting on the editor.
    let started = Instant::now();
    for _ in 0..30 {
        let frame = Instant::now();
        h.step();
        assert!(frame.elapsed() < Duration::from_millis(500), "a frame took {:?}", frame.elapsed());
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(started.elapsed() < Duration::from_secs(10));
    let asked = Instant::now();
    h.key_press_modifiers(Modifiers::CTRL, Key::G);
    h.step();
    let stopped = h.state_mut().with_editor(|ed| ed.variable("stopped").is_some_and(|v| v.is_true()));
    assert!(stopped, "C-g stopped the command");
    let ran = h.state_mut().with_editor(|ed| ed.variable("ran").and_then(|v| v.as_number()).unwrap_or(0.0));
    assert!(ran >= 300.0, "it ran through the frames, until C-g: {ran} ms");
    assert!(asked.elapsed() < Duration::from_secs(1), "promptly: {:?}", asked.elapsed());
}

#[test]
fn the_echo_area_grows_for_a_minibuffer_of_several_lines() {
    let mut h = harness();
    // A prompt of three lines, as vertico's list of candidates makes the minibuffer.
    h.state_mut().run(|ed| {
        let _ = ed.read_from_minibuffer(ember_core::Reading::new("one\ntwo\nthree: ", ember_core::ParamKind::String));
    });
    step_until(&mut h, |h| h.state_mut().with_editor(|ed| ed.mini_window_lines()) == 3);
    h.key_press_modifiers(Modifiers::CTRL, Key::G);
    h.step();
}
