//! The tree-sitter primitives Lisp calls, as Emacs's treesit.c: parsers as
//! objects, nodes and their relations, and queries with Emacs's
//! predicates. What treesit.el builds on them, node-at, indentation and
//! moving by things, is in `packages/treesit.ts`.
//!
//! A node is held as the path of child indices from its tree's root,
//! with the tree's generation: a node from a tree parsed before the
//! buffer last changed is out of date, as Emacs's are, and using it is an
//! error, `treesit-node-outdated`.

use tree_sitter::{Node, Query, QueryCursor, QueryPredicateArg, StreamingIterator};

use crate::buffer::Buffer;
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::syntax::SyntaxTree;
use crate::variables::Value;

/// A node of a buffer's syntax tree, as Emacs's treesit-node objects.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeRef {
    pub buffer: u64,
    pub parser: u64,
    pub generation: u64,
    /// Child indices from the root.
    pub path: Vec<u32>,
}

/// A tree-sitter object as a value: a parser of a buffer, or a node.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TsObject {
    Parser { buffer: u64, parser: u64 },
    Node(NodeRef),
}

fn error(symbol: &str, message: impl Into<String>) -> Error {
    Error::signal(symbol, message, vec![])
}

fn wrong_type(what: &str, v: Option<&Value>) -> Error {
    Error::signal("wrong-type-argument", format!("Wrong type argument: {what}, {}", v.map_or("nil".into(), |v| format!("{v}"))), vec![])
}

/// The child indices from the root to `node`.
fn path_of(node: Node) -> Vec<u32> {
    let mut path = Vec::new();
    let mut child = node;
    while let Some(parent) = child.parent() {
        let mut cursor = parent.walk();
        let index = parent.children(&mut cursor).position(|c| c.id() == child.id()).unwrap_or(0);
        path.push(index as u32);
        child = parent;
    }
    path.reverse();
    path
}

/// Our own first-child-for-byte, as Emacs's, since tree-sitter's has a bug
/// (Emacs's bug#60127): the first child that ends after `byte`.
fn first_child_for_byte(node: Node, byte: usize, named: bool) -> Option<Node> {
    let mut cursor = node.walk();
    if cursor.goto_first_child_for_byte(byte).is_none() && !cursor.goto_first_child() {
        return None;
    }
    while cursor.node().end_byte() <= byte || (named && !cursor.node().is_named()) {
        if !cursor.goto_next_sibling() {
            return None;
        }
    }
    Some(cursor.node())
}

/// A predicate in a query, as Emacs's string queries write them:
/// `(#equal @a @b)`, `(#match "regexp" @a)` and `(#pred fn @a)`.
enum Predicate {
    Equal(Vec<PredArg>),
    Match(String, u32),
    Pred(String, Vec<u32>),
}

enum PredArg {
    Capture(u32),
    Text(String),
}

/// A query's source as tree-sitter reads it: Emacs's predicates, `#equal`,
/// `#match` and `#pred`, renamed to names it takes for its own general
/// predicates, which need a `?`; its own `#eq?` and `#match?` stay.
fn tree_sitter_source(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut rest = source;
    while let Some(i) = rest.find('#') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let name: String = rest[1..].chars().take_while(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect();
        let follows = rest[1 + name.len()..].chars().next();
        let renamed = match name.as_str() {
            "equal" | "match" | "pred" if follows.is_none_or(|c| c.is_whitespace() || c == ')') => Some(format!("#emacs-{name}?")),
            _ => None,
        };
        match renamed {
            Some(r) => {
                out.push_str(&r);
                rest = &rest[1 + name.len()..];
            }
            None => {
                out.push('#');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn predicates(query: &Query, pattern: usize) -> Result<Vec<Predicate>> {
    let mut found = Vec::new();
    for p in query.general_predicates(pattern) {
        let name = p.operator.trim_end_matches('?').trim_start_matches("emacs-");
        let args: Vec<PredArg> = p
            .args
            .iter()
            .map(|a| match a {
                QueryPredicateArg::Capture(c) => PredArg::Capture(*c),
                QueryPredicateArg::String(s) => PredArg::Text(s.to_string()),
            })
            .collect();
        found.push(match (name, args.as_slice()) {
            ("equal", [_, _]) => Predicate::Equal(args),
            ("match", [PredArg::Text(re), PredArg::Capture(c)]) => Predicate::Match(re.clone(), *c),
            ("match", _) => return Err(error("treesit-query-error", "The first argument to `match' should be a regexp string, not a capture name")),
            ("pred", [PredArg::Text(f), rest @ ..]) => {
                Predicate::Pred(f.clone(), rest.iter().filter_map(|a| if let PredArg::Capture(c) = a { Some(*c) } else { None }).collect())
            }
            _ => return Err(error("treesit-query-error", format!("Invalid predicate: {}", p.operator))),
        });
    }
    Ok(found)
}

impl Editor {
    /// The buffer and parser a parser object names.
    fn ts_parser(&self, buffer: u64, parser: u64) -> Result<(usize, usize)> {
        let b = self.buffer_with_id(buffer).ok_or_else(|| error("treesit-parser-deleted", "Parser's buffer has been killed"))?;
        let p = self.buffers[b].parsers.iter().position(|p| p.id == parser).ok_or_else(|| error("treesit-parser-deleted", "Parser has been deleted"))?;
        Ok((b, p))
    }

    /// Calls `f` with a node, its parser and its buffer, the node found again
    /// in the parser's tree.
    fn with_node<T>(&self, r: &NodeRef, f: impl FnOnce(&Buffer, &SyntaxTree, Node) -> Result<T>) -> Result<T> {
        let (b, p) = self.ts_parser(r.buffer, r.parser)?;
        let (buffer, parser) = (&self.buffers[b], &self.buffers[b].parsers[p]);
        // A node is out of date once its tree is parsed again, which asking
        // for a parser's root does after an edit, as Emacs's are.
        if parser.generation.get() != r.generation {
            return Err(error("treesit-node-outdated", "Node is outdated: the buffer has changed since it was taken"));
        }
        let tree = parser.last_parsed().ok_or_else(|| error("treesit-node-outdated", "Node is outdated"))?;
        let mut node = tree.root_node();
        for &i in &r.path {
            node = node.child(i).ok_or_else(|| error("treesit-node-outdated", "Node is outdated"))?;
        }
        f(buffer, parser, node)
    }

    fn node_value(buffer: u64, parser: &SyntaxTree, node: Option<Node>) -> Value {
        match node {
            Some(node) => Value::Treesit(TsObject::Node(NodeRef { buffer, parser: parser.id, generation: parser.generation.get(), path: path_of(node) })),
            None => Value::Null,
        }
    }

    /// The root node of a parser, parsing first if needed.
    fn root_node(&self, b: usize, p: usize) -> Value {
        let (buffer, parser) = (&self.buffers[b], &self.buffers[b].parsers[p]);
        match parser.parsed(buffer.text()) {
            Some(tree) => Editor::node_value(buffer.id(), parser, Some(tree.root_node())),
            None => Value::Null,
        }
    }

    /// The buffer an argument names, the current one for nil; its base for an
    /// indirect buffer, whose parsers are its base's, as Emacs's.
    fn ts_buffer(&self, v: Option<&Value>) -> Result<usize> {
        let b = match v {
            None | Some(Value::Null) => self.current,
            Some(Value::Buffer(id)) => self.buffer_with_id(*id).ok_or_else(|| Error::new("Selecting deleted buffer"))?,
            Some(v) => v.as_str().and_then(|n| self.find_buffer(n)).ok_or_else(|| wrong_type("bufferp", Some(v)))?,
        };
        Ok(self.buffers[b].base_buffer().and_then(|id| self.buffer_with_id(id)).unwrap_or(b))
    }

    /// Makes a parser for `language` in a buffer, or finds one with the same
    /// language and tag unless `no_reuse`, as `treesit-parser-create`.
    pub fn treesit_parser_create(&mut self, language: &str, buffer: usize, no_reuse: bool, tag: Option<String>) -> Result<Value> {
        let id = self.buffers[buffer].id();
        if !no_reuse
            && let Some(p) = self.buffers[buffer].parsers.iter().find(|p| p.language == language && p.tag == tag)
        {
            return Ok(Value::Treesit(TsObject::Parser { buffer: id, parser: p.id }));
        }
        let grammar = self.grammars.get(language).ok_or_else(|| {
            Error::signal("treesit-load-language-error", format!("No grammar for {language}"), vec![Value::Str(language.to_string())])
        })?;
        let parser = SyntaxTree::new(language, grammar, tag, false)?;
        let pid = parser.id;
        self.buffers[buffer].parsers.insert(0, parser);
        Ok(Value::Treesit(TsObject::Parser { buffer: id, parser: pid }))
    }

    /// Runs one of the tree-sitter primitives by its Lisp name, as scripts
    /// call them.
    pub fn treesit_primitive(&mut self, name: &str, args: &[Value]) -> Result<Value> {
        let arg = |i: usize| args.get(i).filter(|v| **v != Value::Null);
        let flag = |i: usize| arg(i).is_some_and(Value::is_true);
        let node = |i: usize| -> Result<NodeRef> {
            match arg(i) {
                Some(Value::Treesit(TsObject::Node(r))) => Ok(r.clone()),
                v => Err(wrong_type("treesit-node-p", v)),
            }
        };
        let parser = |i: usize| -> Result<(u64, u64)> {
            match arg(i) {
                Some(Value::Treesit(TsObject::Parser { buffer, parser })) => Ok((*buffer, *parser)),
                v => Err(wrong_type("treesit-parser-p", v)),
            }
        };
        let text = |i: usize| -> Result<String> { arg(i).and_then(Value::as_str).map(str::to_string).ok_or_else(|| wrong_type("stringp", arg(i))) };
        let number = |i: usize| -> Result<i64> { arg(i).and_then(Value::as_number).map(|n| n as i64).ok_or_else(|| wrong_type("integerp", arg(i))) };
        // A node function: the node's value from `f`, or nil for no node.
        let on_node = |ed: &Editor, f: &dyn Fn(&Buffer, &SyntaxTree, Node) -> Result<Value>| -> Result<Value> {
            match arg(0) {
                None => Ok(Value::Null),
                Some(_) => ed.with_node(&node(0)?, f),
            }
        };
        let related = |ed: &Editor, f: &dyn Fn(Node) -> Option<Node>| -> Result<Value> {
            on_node(ed, &|b, p, n| Ok(Editor::node_value(b.id(), p, f(n))))
        };
        let char_pos = |b: &Buffer, byte: usize| num(b.text().byte_to_char(byte.min(b.text().len_bytes())));
        Ok(match name {
            "treesit-language-available-p" => Value::Bool(self.grammars.contains_key(text(0)?.as_str())),
            "treesit-parser-create" => {
                let b = self.ts_buffer(arg(1))?;
                let tag = arg(3).and_then(Value::as_str).map(str::to_string);
                self.treesit_parser_create(&text(0)?, b, flag(2), tag)?
            }
            "treesit-parser-delete" => {
                let (b, p) = parser(0)?;
                if let Ok((b, p)) = self.ts_parser(b, p) {
                    self.buffers[b].parsers.remove(p);
                }
                Value::Null
            }
            "treesit-parser-list" => {
                let b = self.ts_buffer(arg(0))?;
                let language = arg(1).and_then(Value::as_str);
                // TAG nil means untagged parsers only, t any, as Emacs's.
                let all_tags = matches!(arg(2), Some(Value::Bool(true)));
                let tag = arg(2).and_then(Value::as_str);
                let buffer = &self.buffers[b];
                Value::List(
                    buffer
                        .parsers
                        .iter()
                        .filter(|p| language.is_none_or(|l| p.language == l) && (all_tags || p.tag.as_deref() == tag))
                        .map(|p| Value::Treesit(TsObject::Parser { buffer: buffer.id(), parser: p.id }))
                        .collect(),
                )
            }
            "treesit-parser-buffer" => {
                let (b, p) = parser(0)?;
                let (b, _) = self.ts_parser(b, p)?;
                Value::Buffer(self.buffers[b].id())
            }
            "treesit-parser-language" => {
                let (b, p) = parser(0)?;
                let (b, p) = self.ts_parser(b, p)?;
                Value::Str(self.buffers[b].parsers[p].language.clone())
            }
            "treesit-parser-tag" => {
                let (b, p) = parser(0)?;
                let (b, p) = self.ts_parser(b, p)?;
                self.buffers[b].parsers[p].tag.clone().map_or(Value::Null, Value::Str)
            }
            "treesit-parser-root-node" => {
                let (b, p) = parser(0)?;
                let (b, p) = self.ts_parser(b, p)?;
                self.root_node(b, p)
            }
            "treesit-node-parser" => {
                let r = node(0)?;
                Value::Treesit(TsObject::Parser { buffer: r.buffer, parser: r.parser })
            }
            "treesit-node-type" => on_node(self, &|_, _, n| Ok(Value::Str(n.kind().to_string())))?,
            "treesit-node-start" => on_node(self, &|b, _, n| Ok(char_pos(b, n.start_byte())))?,
            "treesit-node-end" => on_node(self, &|b, _, n| Ok(char_pos(b, n.end_byte())))?,
            "treesit-node-string" => on_node(self, &|_, _, n| Ok(Value::Str(n.to_sexp())))?,
            "treesit-node-parent" => related(self, &|n| n.parent())?,
            "treesit-node-child" => {
                let (index, named) = (number(1)?, flag(2));
                related(self, &|n| {
                    let count = if named { n.named_child_count() } else { n.child_count() as usize } as i64;
                    let i = if index < 0 { count + index } else { index };
                    if i < 0 {
                        return None;
                    }
                    if named { n.named_child(i as u32) } else { n.child(i as u32) }
                })?
            }
            "treesit-node-child-count" => {
                let named = flag(1);
                on_node(self, &|_, _, n| Ok(num(if named { n.named_child_count() } else { n.child_count() as usize })))?
            }
            "treesit-node-child-by-field-name" => {
                let field = text(1)?;
                related(self, &|n| n.child_by_field_name(&field))?
            }
            "treesit-node-field-name-for-child" => {
                let index = number(1)?;
                on_node(self, &|_, _, n| {
                    let i = if index < 0 { n.child_count() as i64 + index } else { index };
                    Ok(if i < 0 { Value::Null } else { n.field_name_for_child(i as u32).map_or(Value::Null, |f| Value::Str(f.to_string())) })
                })?
            }
            "treesit-node-next-sibling" => {
                let named = flag(1);
                related(self, &|n| if named { n.next_named_sibling() } else { n.next_sibling() })?
            }
            "treesit-node-prev-sibling" => {
                let named = flag(1);
                related(self, &|n| if named { n.prev_named_sibling() } else { n.prev_sibling() })?
            }
            "treesit-node-first-child-for-pos" => {
                let (pos, named) = (number(1)?.max(0) as usize, flag(2));
                on_node(self, &|b, p, n| {
                    let byte = b.text().char_to_byte(pos.min(b.len()));
                    Ok(Editor::node_value(b.id(), p, first_child_for_byte(n, byte, named)))
                })?
            }
            "treesit-node-descendant-for-range" => {
                let (beg, end, named) = (number(1)?.max(0) as usize, number(2)?.max(0) as usize, flag(3));
                on_node(self, &|b, p, n| {
                    let (from, to) = (b.text().char_to_byte(beg.min(b.len())), b.text().char_to_byte(end.min(b.len())));
                    let found = if named { n.named_descendant_for_byte_range(from, to) } else { n.descendant_for_byte_range(from, to) };
                    Ok(Editor::node_value(b.id(), p, found))
                })?
            }
            "treesit-node-check" => {
                let r = node(0)?;
                let property = text(1)?;
                let live = self.ts_parser(r.buffer, r.parser).is_ok();
                match property.trim_start_matches(':') {
                    "live" => Value::Bool(live),
                    "outdated" => Value::Bool(live && self.with_node(&r, |_, _, _| Ok(())).is_err()),
                    prop => self.with_node(&r, |_, _, n| {
                        Ok(Value::Bool(match prop {
                            "named" => n.is_named(),
                            "missing" => n.is_missing(),
                            "extra" => n.is_extra(),
                            "has-error" => n.has_error(),
                            "has-changes" => n.has_changes(),
                            _ => return Err(Error::signal("args-out-of-range", format!("Invalid property: {prop}"), vec![])),
                        }))
                    })?,
                }
            }
            "treesit-node-eq" => match (arg(0), arg(1)) {
                (Some(Value::Treesit(TsObject::Node(a))), Some(Value::Treesit(TsObject::Node(b)))) => Value::Bool(a == b),
                _ => Value::Bool(false),
            },
            "treesit-query-compile" => {
                let language = text(0)?;
                let source = text(1)?;
                self.compiled_query(&language, &source)?;
                Value::Str(source)
            }
            "treesit-query-capture" => self.query_capture(args)?,
            _ => return Err(Error::new(format!("No tree-sitter primitive {name}"))),
        })
    }

    /// Compiles a query for a language, checking its predicates, as
    /// `treesit-query-compile`; compiled queries are kept for using again.
    fn compiled_query(&mut self, language: &str, source: &str) -> Result<std::rc::Rc<Query>> {
        let key = (language.to_string(), source.to_string());
        if let Some(q) = self.treesit_queries.get(&key) {
            return Ok(q.clone());
        }
        let grammar = self.grammars.get(language).ok_or_else(|| error("treesit-load-language-error", format!("No grammar for {language}")))?;
        let query = Query::new(&grammar.language, &tree_sitter_source(source)).map_err(|e| error("treesit-query-error", format!("{e}")))?;
        for pattern in 0..query.pattern_count() {
            predicates(&query, pattern)?;
        }
        let query = std::rc::Rc::new(query);
        self.treesit_queries.insert(key, query.clone());
        Ok(query)
    }

    /// `treesit-query-capture`: NODE (a node, a parser, or a language whose
    /// first parser's root is used), QUERY, BEG, END, NODE-ONLY and GROUPED.
    fn query_capture(&mut self, args: &[Value]) -> Result<Value> {
        let arg = |i: usize| args.get(i).filter(|v| **v != Value::Null);
        let root = match arg(0) {
            Some(Value::Treesit(TsObject::Node(r))) => r.clone(),
            Some(Value::Treesit(TsObject::Parser { buffer, parser })) => {
                let (b, p) = self.ts_parser(*buffer, *parser)?;
                match self.root_node(b, p) {
                    Value::Treesit(TsObject::Node(r)) => r,
                    _ => return Ok(Value::Null),
                }
            }
            Some(v) if v.as_str().is_some() => {
                let language = v.as_str().expect("a string").to_string();
                let b = self.ts_buffer(None)?;
                let parser = self.treesit_parser_create(&language, b, false, None)?;
                return self.query_capture(&[&[parser], &args[1..]].concat());
            }
            v => return Err(wrong_type("treesit-node-p", v)),
        };
        let source = arg(1).and_then(Value::as_str).ok_or_else(|| wrong_type("treesit-query-p", arg(1)))?.to_string();
        let (beg, end) = (arg(2).and_then(Value::as_number), arg(3).and_then(Value::as_number));
        let (node_only, grouped) = (arg(4).is_some_and(Value::is_true), arg(5).is_some_and(Value::is_true));
        let (b, p) = self.ts_parser(root.buffer, root.parser)?;
        let language = self.buffers[b].parsers[p].language.clone();
        let query = self.compiled_query(&language, &source)?;
        // The matches, each its captures as (name, node, text), by index too
        // for the predicates still to check, which may call script functions,
        // and its pattern.
        type Capture = (String, Value, String);
        type Match = (Vec<Capture>, Vec<(u32, Capture)>, usize);
        let matches: Vec<Match> = self.with_node(&root, |buffer, parser, node| {
            let text = buffer.text();
            let mut cursor = QueryCursor::new();
            if let (Some(beg), Some(end)) = (beg, end) {
                let (from, to) = (text.char_to_byte((beg as usize).min(buffer.len())), text.char_to_byte((end as usize).min(buffer.len())));
                cursor.set_byte_range(from..to);
            }
            let source = |n: Node| text.byte_slice(n.byte_range()).chunks().map(str::as_bytes);
            let names = query.capture_names();
            let mut found = Vec::new();
            let mut matches = cursor.matches(&query, node, source);
            while let Some(m) = matches.next() {
                let captures: Vec<(u32, Capture)> = m
                    .captures()
                    .iter()
                    .map(|c| {
                        let value = Editor::node_value(buffer.id(), parser, Some(c.node));
                        (c.index, (names[c.index as usize].to_string(), value, text.byte_slice(c.node.byte_range()).to_string()))
                    })
                    .collect();
                found.push((captures.iter().map(|(_, c)| c.clone()).collect(), captures, m.pattern_index));
            }
            Ok(found)
        })?;
        let mut out = Vec::new();
        for (captures, indexed, pattern) in matches {
            let capture = |i: u32| indexed.iter().find(|(c, _)| *c == i).map(|(_, c)| c);
            let mut pass = true;
            for predicate in predicates(&query, pattern)? {
                pass &= match predicate {
                    Predicate::Equal(args) => {
                        let texts: Vec<Option<String>> = args
                            .iter()
                            .map(|a| match a {
                                PredArg::Capture(c) => capture(*c).map(|c| c.2.clone()),
                                PredArg::Text(t) => Some(t.clone()),
                            })
                            .collect();
                        texts[0].is_some() && texts[0] == texts[1]
                    }
                    Predicate::Match(re, c) => {
                        let Some(c) = capture(c) else { continue };
                        self.string_match(&re, &c.2, 0, false)?.is_some()
                    }
                    Predicate::Pred(f, cs) => {
                        let nodes: Vec<Value> = cs.iter().filter_map(|c| capture(*c).map(|c| c.1.clone())).collect();
                        self.funcall(&Value::Str(f), &nodes)?.is_true()
                    }
                };
            }
            if !pass {
                continue;
            }
            let start = out.len();
            for (name, node, _) in captures {
                out.push(if node_only { node } else { Value::List(vec![Value::Str(name), node]) });
            }
            if grouped && out.len() > start {
                let group: Vec<Value> = out.drain(start..).collect();
                out.push(Value::List(group));
            }
        }
        Ok(Value::List(out))
    }
}

fn num(n: usize) -> Value {
    Value::Number(n as f64)
}
