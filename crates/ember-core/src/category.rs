//! Category tables, as Emacs's category.c: a char-table of each
//! character's category set, the categories `\cX` matches in regexps,
//! with each category's docstring in an extra slot. A category is named
//! by a designator, a printing ASCII character, and a set is written as
//! its designators in order, as `category-set-mnemonics` writes it.
//!
//! As with case tables, the standard table is made as a char-table only
//! when code asks for it, and the generated tables answer for it while
//! it is unchanged.

use std::rc::Rc;

use crate::chartab::{CharRange, CharTable, CharTableId};
use crate::chartab_data::{CATEGORIES, CATEGORY_DOCS};
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::variables::Value;

/// A buffer's category table for looking characters up, while it is not
/// the standard one as generated.
#[derive(Debug)]
pub(crate) struct CategoryMaps {
    table: CharTable,
    defined: [bool; 95],
}

/// The category table last worked out, with what identified it.
pub(crate) type CategoryMapsCache = ((CharTableId, u64), Rc<CategoryMaps>);

impl CategoryMaps {
    /// Whether a character is in a category, or `None` if the table does
    /// not define it.
    pub(crate) fn has(&self, designator: char, c: char) -> Option<bool> {
        let i = (designator as usize).checked_sub(32).filter(|&i| i < 95)?;
        self.defined[i].then(|| self.table.own(c as u32).as_str().is_some_and(|set| set.contains(designator)))
    }
}

/// Whether a character is in one of the standard categories, from the
/// generated tables, or `None` for a designator they do not define.
pub(crate) fn standard_category(designator: char, c: char) -> Option<bool> {
    let (_, runs) = CATEGORIES.iter().find(|(d, _)| *d == designator)?;
    let u = c as u32;
    let i = runs.partition_point(|&(_, last)| last < u);
    Some(runs.get(i).is_some_and(|&(first, _)| first <= u))
}

fn index(designator: char) -> Result<usize> {
    (designator as usize).checked_sub(32).filter(|&i| i < 95).ok_or_else(|| Error::signal("args-out-of-range", format!("Args out of range: {}", designator as u32), Vec::new()))
}

/// A set of designators, in order, each once.
fn normalize(set: impl IntoIterator<Item = char>) -> String {
    let mut chars: Vec<char> = set.into_iter().collect();
    chars.sort_unstable();
    chars.dedup();
    chars.into_iter().collect()
}

impl Editor {
    /// The standard category table, as Emacs's `standard-category-table`.
    pub fn standard_category_table(&mut self) -> CharTableId {
        if let Some(id) = self.standard_category_table {
            return id;
        }
        let mut table = CharTable::new("category-table", Value::Null, 2);
        // Where the categories' runs start and end, and the set between each two.
        let mut points: Vec<u32> = CATEGORIES.iter().flat_map(|(_, runs)| runs.iter().flat_map(|&(f, l)| [f, l + 1])).collect();
        points.sort_unstable();
        points.dedup();
        for pair in points.windows(2) {
            let (first, last) = (pair[0], pair[1] - 1);
            let c = char::from_u32(first).unwrap_or('\0');
            let set: String = CATEGORIES.iter().filter(|(d, _)| standard_category(*d, c) == Some(true)).map(|(d, _)| *d).collect();
            if !set.is_empty() {
                table.set_range(first, last, Value::Str(normalize(set.chars())));
            }
        }
        let mut docs = vec![Value::Null; 95];
        for &(d, doc) in CATEGORY_DOCS {
            docs[d as usize - 32] = Value::Str(doc.to_string());
        }
        table.extras[0] = Value::List(docs);
        table.tick = 0;
        let id = self.add_char_table(table);
        self.standard_category_table = Some(id);
        id
    }

    /// The current buffer's category table, as `category-table`.
    pub fn category_table(&mut self) -> CharTableId {
        match self.buffer().category_table {
            Some(id) => id,
            None => self.standard_category_table(),
        }
    }

    pub fn category_table_p(&self, id: CharTableId) -> bool {
        self.char_table(id).is_ok_and(|t| t.subtype == "category-table")
    }

    fn check_category_table(&mut self, table: Option<CharTableId>) -> Result<CharTableId> {
        let id = match table {
            Some(id) => id,
            None => self.category_table(),
        };
        if !self.category_table_p(id) {
            return Err(Error::signal("wrong-type-argument", "Wrong type argument: category-table-p", Vec::new()));
        }
        Ok(id)
    }

    /// A category table with no categories, as `make-category-table`.
    pub fn make_category_table(&mut self) -> CharTableId {
        let mut table = CharTable::new("category-table", Value::Null, 2);
        table.extras[0] = Value::List(vec![Value::Null; 95]);
        self.add_char_table(table)
    }

    /// A copy of a category table, the current buffer's by default, with
    /// its categories, as `copy-category-table`.
    pub fn copy_category_table(&mut self, table: Option<CharTableId>) -> Result<CharTableId> {
        let id = self.check_category_table(table)?;
        self.copy_char_table(id)
    }

    /// Makes a category table the current buffer's, as `set-category-table`.
    pub fn set_category_table(&mut self, id: CharTableId) -> Result<()> {
        self.check_category_table(Some(id))?;
        let standard = self.standard_category_table == Some(id);
        self.buffer_mut().category_table = (!standard).then_some(id);
        Ok(())
    }

    fn category_docs(&self, id: CharTableId) -> Vec<Value> {
        match self.char_tables.get(&id).and_then(|t| t.extras.first()) {
            Some(Value::List(docs)) => docs.clone(),
            _ => vec![Value::Null; 95],
        }
    }

    /// Defines a category, as `define-category`: its designator and docstring.
    pub fn define_category(&mut self, designator: char, doc: &str, table: Option<CharTableId>) -> Result<()> {
        let id = self.check_category_table(table)?;
        let i = index(designator)?;
        let mut docs = self.category_docs(id);
        if docs[i].is_true() {
            return Err(Error::new(format!("Category ‘{designator}’ is already defined")));
        }
        docs[i] = Value::Str(doc.to_string());
        self.set_char_table_extra_slot(id, 0, Value::List(docs))
    }

    /// A category's docstring, as `category-docstring`.
    pub fn category_docstring(&mut self, designator: char, table: Option<CharTableId>) -> Result<Option<String>> {
        let id = self.check_category_table(table)?;
        let i = index(designator)?;
        Ok(self.category_docs(id)[i].as_str().map(str::to_string))
    }

    /// The first designator no category has, as `get-unused-category`.
    pub fn get_unused_category(&mut self, table: Option<CharTableId>) -> Result<Option<char>> {
        let id = self.check_category_table(table)?;
        let docs = self.category_docs(id);
        Ok((0..95).find(|&i| !docs[i].is_true()).and_then(|i| char::from_u32(i as u32 + 32)))
    }

    /// A character's categories in the current buffer, as Emacs's
    /// `char-category-set` with `category-set-mnemonics`: ".Lalr" for a.
    pub fn char_category_set(&self, c: char) -> String {
        match self.category_maps() {
            Some(maps) => maps.table.own(c as u32).as_str().unwrap_or_default().to_string(),
            None => normalize(CATEGORIES.iter().filter(|(d, _)| standard_category(*d, c) == Some(true)).map(|(d, _)| *d)),
        }
    }

    /// Puts characters in a category, or with `reset` takes them out of it,
    /// as `modify-category-entry`.
    pub fn modify_category_entry(&mut self, range: CharRange, designator: char, table: Option<CharTableId>, reset: bool) -> Result<()> {
        let id = self.check_category_table(table)?;
        index(designator)?;
        let (from, to) = match range {
            CharRange::Char(c) => (c, c),
            CharRange::Range(f, t) => (f.min(t), f.max(t)),
            CharRange::Default => return Err(Error::signal("wrong-type-argument", "Wrong type argument: characterp", Vec::new())),
        };
        let spans = self.char_table(id)?.spans();
        for (first, last, value) in spans {
            let (f, l) = (first.max(from), last.min(to));
            if f > l {
                continue;
            }
            let set = value.as_str().unwrap_or_default();
            let new = if reset { set.chars().filter(|&d| d != designator).collect() } else { normalize(set.chars().chain([designator])) };
            if new != set {
                let value = if new.is_empty() { Value::Null } else { Value::Str(new) };
                self.set_char_table_range(id, CharRange::Range(f, l), value)?;
            }
        }
        Ok(())
    }

    /// The current buffer's category table to look characters up in, or
    /// `None` while it is the standard one as generated.
    pub(crate) fn category_maps(&self) -> Option<Rc<CategoryMaps>> {
        let id = match self.buffer().category_table {
            Some(id) => id,
            None => {
                let standard = self.standard_category_table?;
                if self.char_tables.get(&standard).is_some_and(|t| t.tick == 0) {
                    return None;
                }
                standard
            }
        };
        let tick = self.char_tables.get(&id)?.tick;
        if let Some((key, maps)) = &*self.category_maps_cache.borrow()
            && *key == (id, tick)
        {
            return Some(maps.clone());
        }
        let table = self.char_tables.get(&id)?.clone();
        let docs = self.category_docs(id);
        let mut defined = [false; 95];
        for (i, doc) in docs.iter().enumerate().take(95) {
            defined[i] = doc.is_true();
        }
        let maps = Rc::new(CategoryMaps { table, defined });
        *self.category_maps_cache.borrow_mut() = Some(((id, tick), maps.clone()));
        Some(maps)
    }
}
