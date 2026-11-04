//! Ember's graphical front end, built on egui.

mod app;
pub mod clipboard;
mod fringe;
mod image;
pub mod keys;
pub mod metrics;
pub mod modeline;
#[cfg(unix)]
pub mod shell_path;
pub mod theme;

pub use app::{EmberApp, transparent_title_bar};
