//! Case tables, as Emacs's casetab.c: a char-table of each character's
//! lower case, with its upper case, its canonical form for folding, and
//! its equivalents in extra slots. Each buffer has one, the standard one
//! unless code sets its own, which changing case and folding case in
//! searches follow, as a Turkish table maps I to ı.
//!
//! The standard table is the one generated from Emacs's; it is made as a
//! char-table only when code asks for it, and while it is unchanged the
//! generated tables answer for it, so ordinary buffers fold case as fast
//! as before.

use std::collections::HashMap;
use std::rc::Rc;

use crate::chartab::{CharTable, CharTableId};
use crate::editor::Editor;
use crate::error::{Error, Result};
use crate::variables::Value;

/// A buffer's case table worked out for looking characters up: each
/// character's lower and upper case where they are not itself.
#[derive(Debug, Default)]
pub(crate) struct CaseMaps {
    pub(crate) down: HashMap<char, char>,
    pub(crate) up: HashMap<char, char>,
}

/// The case table last worked out, with what identified it.
pub(crate) type CaseMapsCache = ((CharTableId, u64, u64), Rc<CaseMaps>);

impl CaseMaps {
    pub(crate) fn downcase(&self, c: char) -> char {
        self.down.get(&c).copied().unwrap_or(c)
    }

    pub(crate) fn upcase(&self, c: char) -> char {
        self.up.get(&c).copied().unwrap_or(c)
    }
}

/// The characters a table maps to others, from its runs of character values.
fn mapping(table: &CharTable) -> HashMap<char, char> {
    let mut out = HashMap::new();
    for (first, last, value) in table.spans() {
        let Value::Number(to) = value else { continue };
        let Some(to) = char::from_u32(to as u32) else { continue };
        for c in first..=last.min(first + 0xFFFF) {
            if let Some(c) = char::from_u32(c)
                && c != to
            {
                out.insert(c, to);
            }
        }
    }
    out
}

impl Editor {
    /// The standard case table, as Emacs's `standard-case-table`.
    pub fn standard_case_table(&mut self) -> CharTableId {
        if let Some(id) = self.standard_case_table {
            return id;
        }
        let mut up = CharTable::new("case-table", Value::Null, 3);
        for &(c, u) in crate::chartab_data::UPCASE {
            up.set_range(c, c, Value::Number(u as f64));
        }
        let mut down = CharTable::new("case-table", Value::Null, 3);
        for &(c, d) in crate::chartab_data::DOWNCASE {
            down.set_range(c, c, Value::Number(d as f64));
        }
        (up.tick, down.tick) = (0, 0);
        let up = self.add_char_table(up);
        let down_id = self.add_char_table(down);
        let table = self.char_tables.get_mut(&down_id).expect("just made");
        table.extras[0] = Value::CharTable(up);
        self.standard_case_table = Some(down_id);
        down_id
    }

    /// The current buffer's case table, as `current-case-table`.
    pub fn current_case_table(&mut self) -> CharTableId {
        match self.buffer().case_table {
            Some(id) => id,
            None => self.standard_case_table(),
        }
    }

    /// Whether a value is a case table, as `case-table-p`: a char-table of
    /// subtype `case-table` whose extra slots are char-tables or nil.
    pub fn case_table_p(&self, id: CharTableId) -> bool {
        let Ok(table) = self.char_table(id) else { return false };
        table.subtype == "case-table"
            && table.extras.len() >= 3
            && table.extras[..3].iter().all(|e| matches!(e, Value::Null | Value::CharTable(_)))
    }

    /// Makes a case table the current buffer's, as `set-case-table`,
    /// working out its upper cases if it has none: each character the
    /// table lowers to another is that one's upper case.
    pub fn set_case_table(&mut self, id: CharTableId) -> Result<()> {
        self.complete_case_table(id)?;
        let standard = self.standard_case_table == Some(id);
        self.buffer_mut().case_table = (!standard).then_some(id);
        Ok(())
    }

    /// Makes a case table the standard one, which buffers without their
    /// own use, as `set-standard-case-table`.
    pub fn set_standard_case_table(&mut self, id: CharTableId) -> Result<()> {
        self.complete_case_table(id)?;
        self.standard_case_table = Some(id);
        for b in &mut self.buffers {
            if b.case_table == Some(id) {
                b.case_table = None;
            }
        }
        Ok(())
    }

    fn complete_case_table(&mut self, id: CharTableId) -> Result<()> {
        if !self.case_table_p(id) {
            return Err(Error::signal("wrong-type-argument", "Wrong type argument: case-table-p", Vec::new()));
        }
        if self.char_table(id)?.extras[0] == Value::Null {
            let down = mapping(self.char_table(id)?);
            let mut up = CharTable::new("case-table", Value::Null, 3);
            for (c, d) in down {
                up.set_range(d as u32, d as u32, Value::Number(c as u32 as f64));
            }
            let up = self.add_char_table(up);
            self.set_char_table_extra_slot(id, 0, Value::CharTable(up))?;
        }
        Ok(())
    }

    /// The current buffer's case table to look characters up in, or `None`
    /// while it is the standard one as generated, which the generated
    /// tables answer for faster.
    pub(crate) fn case_maps(&self) -> Option<Rc<CaseMaps>> {
        let id = match self.buffer().case_table {
            Some(id) => id,
            None => {
                let standard = self.standard_case_table?;
                let up = self.char_tables.get(&standard)?.extras.first().and_then(|e| if let Value::CharTable(u) = e { Some(*u) } else { None });
                let pristine = self.char_tables.get(&standard).is_some_and(|t| t.tick == 0)
                    && up.and_then(|u| self.char_tables.get(&u)).is_none_or(|t| t.tick == 0);
                if pristine {
                    return None;
                }
                standard
            }
        };
        let key = self.case_table_key(id);
        if let Some((k, maps)) = &*self.case_maps_cache.borrow()
            && *k == key
        {
            return Some(maps.clone());
        }
        let table = self.char_tables.get(&id)?;
        let down = mapping(table);
        let up = match table.extras.first() {
            Some(Value::CharTable(u)) => self.char_tables.get(u).map(mapping).unwrap_or_default(),
            _ => down.iter().map(|(&c, &d)| (d, c)).collect(),
        };
        let maps = Rc::new(CaseMaps { down, up });
        *self.case_maps_cache.borrow_mut() = Some((key, maps.clone()));
        Some(maps)
    }

    /// What identifies a case table as it is now: its id, its upper-case
    /// table's, and how many times each has changed.
    pub(crate) fn case_table_key(&self, id: CharTableId) -> (CharTableId, u64, u64) {
        let table = self.char_tables.get(&id);
        let up = table.and_then(|t| t.extras.first()).and_then(|e| if let Value::CharTable(u) = e { self.char_tables.get(u) } else { None });
        (id, table.map_or(0, |t| t.tick), up.map_or(0, |t| t.tick))
    }
}
