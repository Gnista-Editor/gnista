//! Ember's graphical front end, built on egui.

mod app;
pub mod clipboard;
mod fringe;
pub mod keys;
pub mod metrics;
pub mod modeline;
pub mod theme;

pub use app::EmberApp;
