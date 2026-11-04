/// A prefix argument, in the forms Emacs uses (its "raw" prefix argument).
///
/// Prefix commands build one up and leave it for the next command, which reads
/// it as [`Editor::current_prefix_arg`](crate::Editor::current_prefix_arg) or,
/// more often, as a count with [`Editor::prefix_numeric`](crate::Editor::prefix_numeric).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrefixArg {
    /// `C-u` typed once (4) or more times (16, 64), Emacs's list `(4)`.
    Universal(i64),
    /// A number typed as digits, such as `M-5` or `C-u 1 2`.
    Number(i64),
    /// A minus sign with no digits, such as `C--` alone.
    Minus,
}

impl PrefixArg {
    /// The argument as a count, as Emacs's `prefix-numeric-value` gives it.
    pub fn numeric(self) -> i64 {
        match self {
            PrefixArg::Universal(n) | PrefixArg::Number(n) => n,
            PrefixArg::Minus => -1,
        }
    }
}

/// The count for an optional prefix argument: 1 when there is none.
pub fn prefix_numeric_value(arg: Option<PrefixArg>) -> i64 {
    arg.map_or(1, PrefixArg::numeric)
}
