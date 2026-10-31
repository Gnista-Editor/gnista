//! Ember's graphical front end, built on egui.

mod app;
pub mod clipboard;
mod fringe;
mod image;
pub mod keys;
pub mod metrics;
pub mod modeline;
pub mod theme;

pub use app::EmberApp;
