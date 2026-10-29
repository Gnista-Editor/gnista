//! Questions a command asks partway through, as Emacs's `yes-or-no-p`,
//! `y-or-n-p` and `read-char-choice`.
//!
//! Emacs's Lisp waits for the answer; Ember's commands return first, and
//! the answer runs a function given with the question, in the context the
//! command asked in, which is how a script's `await ember.yOrNP(...)`
//! carries on. The question opens the minibuffer as a prompt does, so
//! front ends show it, `C-g` quits it, and the agent and tests see an open
//! prompt to answer.

use crate::command::ParamKind;
use crate::editor::{Editor, Prompt, Resume};
use crate::error::{Error, Result};
use crate::key::{Key, KeyCode};
use crate::variables::{HookFn, Value};

pub(crate) struct Question {
    /// The question without what it says about answering.
    text: String,
    /// The keys that answer it, or `None` for an answer typed out.
    chars: Option<Vec<char>>,
    /// The answers that can be typed out, for a question not read by key.
    answers: Vec<String>,
    /// What the full prompt adds after the question, such as `(y or n) `.
    choices: String,
    then: HookFn,
    /// Called if the question is quit rather than answered.
    pub(crate) quit: Option<HookFn>,
    /// The asking command's context, given back for `then`.
    resume: Option<Resume>,
}

impl Editor {
    /// Asks a question answered by typing "yes" or "no" and RET, as Emacs's
    /// `yes-or-no-p`. `then` is called with true or false.
    pub fn yes_or_no_p(&mut self, question: &str, then: HookFn) -> Result<()> {
        let to_bool: HookFn = std::rc::Rc::new(move |ed, args| {
            let yes = matches!(args.first(), Some(Value::Str(a)) if a == "yes");
            then(ed, &[Value::Bool(yes)])
        });
        self.read_answer(question, &["yes", "no"], to_bool)
    }

    /// Asks a question answered by typing one of `answers` and RET, as
    /// Emacs's `read-answer` and the long form of `read-multiple-choice`.
    /// `then` is called with the answer.
    pub fn read_answer(&mut self, question: &str, answers: &[&str], then: HookFn) -> Result<()> {
        let choices = match answers {
            [a, b] => format!("({a} or {b}) "),
            _ => format!("({}) ", answers.join(", ")),
        };
        let answers = answers.iter().map(|a| a.to_string()).collect();
        self.ask(Question { text: question.to_string(), chars: None, answers, choices, then, quit: None, resume: None })
    }

    /// Asks a question answered by typing y or n, as Emacs's `y-or-n-p`.
    /// `then` is called with true or false.
    pub fn y_or_n_p(&mut self, question: &str, then: HookFn) -> Result<()> {
        let to_bool: HookFn = std::rc::Rc::new(move |ed, args| {
            let yes = matches!(args.first(), Some(Value::Str(c)) if c == "y");
            then(ed, &[Value::Bool(yes)])
        });
        self.ask(Question { text: question.to_string(), chars: Some(vec!['y', 'n']), answers: Vec::new(), choices: "(y or n) ".into(), then: to_bool, quit: None, resume: None })
    }

    /// Asks a question answered by one of `chars`, as Emacs's
    /// `read-char-choice`; the prompt says what the choices are. `then` is
    /// called with the character typed, as a string.
    pub fn read_char_choice(&mut self, prompt: &str, chars: &[char], then: HookFn) -> Result<()> {
        self.ask(Question { text: prompt.to_string(), chars: Some(chars.to_vec()), answers: Vec::new(), choices: String::new(), then, quit: None, resume: None })
    }

    /// Whether the open prompt is a question answered by a single key.
    pub fn prompt_reads_char(&self) -> bool {
        self.question.as_ref().is_some_and(|q| q.chars.is_some())
    }

    fn ask(&mut self, mut question: Question) -> Result<()> {
        if self.prompt.is_some() {
            return Err(Error::new("Command attempted to use minibuffer while in minibuffer"));
        }
        question.resume = Some(self.resume_point());
        self.open_question(question, "");
        Ok(())
    }

    fn open_question(&mut self, question: Question, preface: &str) {
        let history = if question.chars.is_some() { "read-char-history" } else { "yes-or-no-p-history" };
        let text = format!("{preface}{}{}", question.text, question.choices);
        self.question = Some(question);
        self.open_prompt(Prompt::new(&text, ParamKind::String, history), "");
    }

    /// Answers a question with what was typed. Anything but one of its
    /// answers asks again, as Emacs does.
    pub(crate) fn answer_typed(&mut self, answer: &str) -> bool {
        let Some(question) = self.question.take() else { return false };
        if question.answers.iter().any(|a| a == answer) {
            self.run_answer(&question, Value::Str(answer.to_string()));
        } else {
            let answers = match question.answers.as_slice() {
                [rest @ .., last] if !rest.is_empty() => format!("{} or {last}", rest.join(", ")),
                all => all.join(""),
            };
            self.message(format!("Please answer {answers}."));
            self.open_question(question, "");
        }
        true
    }

    /// Answers a question read by a single key. Returns false if no such
    /// question is open, or for `C-g`, which quits it as a prompt.
    pub(crate) fn answer_key(&mut self, key: Key) -> bool {
        let Some(chars) = self.question.as_ref().and_then(|q| q.chars.clone()) else { return false };
        if key == Key::parse("C-g").expect("C-g parses") {
            return false;
        }
        let typed = match key {
            Key { code: KeyCode::Char(c), ctrl: false, meta: false, .. } => Some(c),
            _ => None,
        };
        let question = self.question.take().expect("checked above");
        match typed.filter(|c| chars.contains(c)) {
            Some(c) => {
                self.close_prompt();
                self.run_answer(&question, Value::Str(c.to_string()));
            }
            None => {
                let preface = match chars.as_slice() {
                    ['y', 'n'] => "Please answer y or n.  ",
                    _ => "",
                };
                self.close_prompt();
                self.open_question(question, preface);
            }
        }
        true
    }

    /// Runs what answers a question, showing its error as a command's.
    fn run_answer(&mut self, question: &Question, answer: Value) {
        if let Some(resume) = &question.resume {
            self.resume(resume);
        }
        if let Err(e) = (question.then)(self, &[answer]) {
            self.prompt_waiters_clear();
            self.fail(e);
            return;
        }
        self.run_prompt_waiters();
    }

    /// Forgets any open question, as `C-g` does, and returns it.
    pub(crate) fn drop_question(&mut self) -> Option<Question> {
        self.question.take()
    }
}
