//! Timers, as Emacs's `run-with-timer` and `run-with-idle-timer`, and
//! auto-saving after a while idle or a number of keys, as Emacs's
//! keyboard loop does.
//!
//! The editor has no thread of its own: front ends call
//! [`Editor::run_timers`] when [`Editor::next_timer_in`] says one is due,
//! and after each key. Tests move the clock with [`Editor::advance_clock`].

use std::time::{Duration, Instant};

use crate::editor::Editor;
use crate::variables::HookFn;

pub(crate) struct Timer {
    id: u64,
    kind: TimerKind,
    f: HookFn,
}

enum TimerKind {
    /// Runs at `due`, then every `repeat` if given.
    At { due: Instant, repeat: Option<Duration> },
    /// Runs once the editor has been idle for `after`, and again in later
    /// idle spells if `repeat`.
    Idle { after: Duration, repeat: bool, fired: bool },
}

pub(crate) struct Timers {
    list: Vec<Timer>,
    next_id: u64,
    /// How far tests have moved the clock on.
    skew: Duration,
    /// When the last key came, which idle time counts from.
    last_input: Instant,
    /// Keys since the last auto-save, as Emacs's count for `auto-save-interval`.
    keys_since_auto_save: usize,
    /// Whether this idle spell auto-saved already.
    idle_auto_saved: bool,
}

impl Default for Timers {
    fn default() -> Timers {
        Timers {
            list: Vec::new(),
            next_id: 1,
            skew: Duration::ZERO,
            last_input: Instant::now(),
            keys_since_auto_save: 0,
            idle_auto_saved: false,
        }
    }
}

impl Editor {
    /// The editor's clock: now, moved on by any [`Editor::advance_clock`].
    pub fn now(&self) -> Instant {
        Instant::now() + self.timers.skew
    }

    /// Moves the clock on and runs the timers that came due, for tests.
    pub fn advance_clock(&mut self, by: Duration) {
        self.timers.skew += by;
        self.run_timers();
    }

    /// Runs `f` after `secs` seconds, and then every `repeat` seconds if
    /// given, as Emacs's `run-with-timer`. Returns the timer, to cancel it.
    pub fn run_with_timer(&mut self, secs: f64, repeat: Option<f64>, f: HookFn) -> u64 {
        let due = self.now() + Duration::from_secs_f64(secs.max(0.0));
        let repeat = repeat.filter(|r| *r > 0.0).map(Duration::from_secs_f64);
        self.add_timer(TimerKind::At { due, repeat }, f)
    }

    /// Runs `f` once the editor has been idle for `secs` seconds, as Emacs's
    /// `run-with-idle-timer`: with `repeat`, in each idle spell that long.
    pub fn run_with_idle_timer(&mut self, secs: f64, repeat: bool, f: HookFn) -> u64 {
        let after = Duration::from_secs_f64(secs.max(0.0));
        self.add_timer(TimerKind::Idle { after, repeat, fired: false }, f)
    }

    fn add_timer(&mut self, kind: TimerKind, f: HookFn) -> u64 {
        let id = self.timers.next_id;
        self.timers.next_id += 1;
        self.timers.list.push(Timer { id, kind, f });
        id
    }

    /// Stops a timer, as Emacs's `cancel-timer`.
    pub fn cancel_timer(&mut self, id: u64) {
        self.timers.list.retain(|t| t.id != id);
    }

    /// Notes a key typed: idle time starts again.
    pub(crate) fn note_input(&mut self) {
        self.timers.last_input = self.now();
        self.timers.idle_auto_saved = false;
        for timer in &mut self.timers.list {
            if let TimerKind::Idle { fired, .. } = &mut timer.kind {
                *fired = false;
            }
        }
    }

    /// Counts a key once its command ran, and auto-saves after more than
    /// `auto-save-interval` keys, though not more often than every 20, as
    /// Emacs's read_char does.
    pub(crate) fn count_key_for_auto_save(&mut self) {
        self.timers.keys_since_auto_save += 1;
        let interval = self.variable("auto-save-interval").and_then(|v| v.as_number()).unwrap_or(300.0);
        if interval > 0.0 && self.timers.keys_since_auto_save as f64 > interval.max(20.0) {
            self.timers.keys_since_auto_save = 0;
            self.do_auto_save(false);
        }
    }

    fn auto_save_timeout(&self) -> Option<Duration> {
        let secs = self.variable("auto-save-timeout").and_then(|v| v.as_number()).unwrap_or(30.0);
        (secs > 0.0).then(|| Duration::from_secs_f64(secs))
    }

    /// Runs the timers that are due, and auto-saves after
    /// `auto-save-timeout` seconds idle. They run while a prompt is open
    /// too, as Emacs's do, in the minibuffer as the current buffer; code
    /// that acts on another buffer makes it current, as with-current-buffer does.
    pub fn run_timers(&mut self) {
        self.poll_processes();
        // Output inserted in a buffer sharing its text shows in the others.
        self.sync_shared_text();
        let now = self.now();
        let idle = now.saturating_duration_since(self.timers.last_input);
        if !self.timers.idle_auto_saved
            && let Some(timeout) = self.auto_save_timeout()
            && idle >= timeout
        {
            self.timers.idle_auto_saved = true;
            self.timers.keys_since_auto_save = 0;
            self.do_auto_save(false);
        }
        let mut due = Vec::new();
        self.timers.list.retain_mut(|timer| match &mut timer.kind {
            TimerKind::At { due: at, repeat } if *at <= now => {
                due.push(timer.f.clone());
                match repeat {
                    Some(every) => {
                        // A timer that fell behind runs once, not once per missed period.
                        while *at <= now {
                            *at += *every;
                        }
                        true
                    }
                    None => false,
                }
            }
            TimerKind::Idle { after, repeat, fired } if !*fired && idle >= *after => {
                due.push(timer.f.clone());
                *fired = true;
                *repeat
            }
            _ => true,
        });
        for f in due {
            if let Err(e) = f(self, &[]) {
                self.message(format!("Error running timer: {e}"));
            }
        }
    }

    /// How long until a timer or idle auto-save is due, if any is waiting,
    /// for a front end to wake then.
    pub fn next_timer_in(&self) -> Option<Duration> {
        let now = self.now();
        let idle_until = |after: Duration| (self.timers.last_input + after).saturating_duration_since(now);
        let mut next: Option<Duration> = None;
        let mut consider = |d: Duration| next = Some(next.map_or(d, |n| n.min(d)));
        for timer in &self.timers.list {
            match timer.kind {
                TimerKind::At { due, .. } => consider(due.saturating_duration_since(now)),
                TimerKind::Idle { after, fired: false, .. } => consider(idle_until(after)),
                TimerKind::Idle { .. } => {}
            }
        }
        if !self.timers.idle_auto_saved
            && let Some(timeout) = self.auto_save_timeout()
            && self.buffers.iter().any(|b| b.needs_auto_save())
        {
            consider(idle_until(timeout));
        }
        // Often while a process runs, to take its output in.
        if self.processes_running() {
            consider(Duration::from_millis(30));
        }
        next
    }
}
