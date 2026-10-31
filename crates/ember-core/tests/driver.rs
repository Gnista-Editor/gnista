//! The editor on a thread of its own (docs/multithreading.md, step 3):
//! keys in order, frames published once input stops, timers firing with
//! no key, and C-g stopping a long command while the last frame stays
//! there to draw.

use std::rc::Rc;
use std::time::{Duration, Instant};

use ember_core::driver::Driver;
use ember_core::{Editor, Key, KeyCode};

fn driver() -> Driver {
    Driver::spawn(|_| Box::new(()), |ed| {
        ed.redisplay();
        vec![ed.describe_frame(ed.selected_frame(), true, 1.0)]
    }, || {})
}

fn key(s: &str) -> Key {
    Key::parse(s).unwrap()
}

/// Waits until the editor publishes a frame newer than `after`.
fn published_after(d: &Driver, after: u64) -> u64 {
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let generation = d.published().generation;
        if generation > after {
            return generation;
        }
        assert!(Instant::now() < until, "no frame published");
        std::thread::yield_now();
    }
}

#[test]
fn keys_run_in_order_and_frames_follow() {
    let d = driver();
    for c in "hello".chars() {
        d.key(Key { code: KeyCode::Char(c), ctrl: false, meta: false, shift: false });
    }
    d.key(key("C-a"));
    d.key(key("C-k"));
    d.key(key("C-y"));
    assert_eq!(d.with(|ed| (ed.buffer().slice(0..ed.buffer().len()), ed.buffer().point())), ("hello".to_string(), 5));
    d.with(|_| ());
    let seen = published_after(&d, 0);
    let p = d.published();
    assert!(seen >= 1);
    assert!(!p.frames.is_empty(), "the frame is described");
}

#[test]
fn timers_fire_with_no_input() {
    let d = driver();
    d.with(|ed| {
        ed.run_with_timer(0.05, None, Rc::new(|ed: &mut Editor, _| {
            ed.set_variable("fired", ember_core::Value::Bool(true));
            Ok(())
        }));
    });
    let until = Instant::now() + Duration::from_secs(5);
    while !d.with(|ed| ed.variable("fired").is_some_and(|v| v.is_true())) {
        assert!(Instant::now() < until, "the timer never fired");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn c_g_stops_a_long_command_while_the_last_frame_stays() {
    let d = driver();
    d.with(|ed| ed.type_text(&"a".repeat(30_000)));
    let before = published_after(&d, 0);
    // A search that backtracks without end, as a command stuck in a loop.
    d.run(|ed| {
        let options = ember_core::SearchOptions { regexp: true, ..Default::default() };
        let result = ed.search("\\(a*\\)*b", 0, &options);
        ed.set_variable("searched", ember_core::Value::Bool(result.is_err_and(|e| e.is("quit"))));
    });
    std::thread::sleep(Duration::from_millis(200));
    // Meanwhile the screen has the last frame to draw.
    assert!(!d.published().frames.is_empty());
    let asked = Instant::now();
    d.key(key("C-g"));
    let quit = d.with(|ed| ed.variable("searched").is_some_and(|v| v.is_true()));
    assert!(quit, "the search was quit");
    assert!(asked.elapsed() < Duration::from_secs(2), "promptly: {:?}", asked.elapsed());
    // The C-g the search took is not read again as a key.
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)), None);
    assert!(published_after(&d, before) > before);
    // And C-g with nothing running is keyboard-quit.
    d.key(key("C-g"));
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)).as_deref(), Some("Quit"));
}

#[test]
fn a_panic_in_a_command_is_reported_and_the_editor_goes_on() {
    let d = driver();
    d.run(|_| panic!("something broke"));
    assert_eq!(d.with(|ed| ed.echo().map(str::to_string)).as_deref(), Some("Internal error: something broke"));
    d.key(key("x"));
    assert_eq!(d.with(|ed| ed.buffer().slice(0..ed.buffer().len())), "x");
}
