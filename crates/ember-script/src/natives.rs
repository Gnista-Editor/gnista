//! The table of native functions: each one written once, by name, with its
//! parameters' and result's types and its documentation, in the `natives!`
//! tables of the modules under `natives/`.
//!
//! An entry is a function of the editor and its arguments, in Rust types,
//! with nothing of the script engine in it:
//!
//! ```ignore
//! natives! {
//!     /// The column point is on, as current-column.
//!     pub fn currentColumn(ed) -> usize {
//!         Ok(ed.current_column())
//!     }
//! }
//! ```
//!
//! From the table the macro writes the engine's binding: a function on the
//! prelude's `native` object that converts the arguments ([`Param`]), runs
//! the body with the editor (`with_editor`, so every call is a safe point
//! for quitting) and converts the result back ([`Ret`]). An entry marked
//! `pub` is also `ember.NAME` itself, with no wrapper in prelude.js, and
//! [`declarations`] writes its declaration in `ember.d.ts` from its
//! documentation and types, or from a `#[ts = "..."]` signature where the
//! TypeScript says more than the Rust types do. Another engine is another
//! set of [`Param`] and [`Ret`] implementations and another arm of the
//! macro; the entries stay as they are.
//!
//! Every call is a safe point, where a quit asked for is signalled, except
//! for an entry marked `#[safe_point = false]`, which must run while a quit
//! unwinds (`unbind`) or reads the quit flag itself.
//!
//! Natives that need the engine itself (`defineCommand`, which keeps a
//! script's functions as its prompts and collections) are written by hand
//! in lib.rs.

mod bidi;
mod chartab;
mod editor;
mod files;
mod images;
mod search;
mod text;
mod treesit;
mod variables;
mod windows;

use ember_core::{PrefixArg, Value as EditorValue};
use rquickjs::{Coerced, Ctx, FromJs, IntoJs, Value};

/// A native function, as its entry in a table describes it.
pub(crate) struct Native {
    pub name: &'static str,
    pub doc: &'static str,
    /// Each parameter's name and Rust type.
    pub params: &'static [(&'static str, &'static str)],
    pub ret: &'static str,
    /// Whether it is `ember.NAME` as well as `native.NAME`.
    pub public: bool,
    /// Its TypeScript signature, as `(a: string): number`, where the one
    /// worked out from the Rust types would say less.
    pub ts: Option<&'static str>,
}

/// Defines native functions: see the module's documentation.
macro_rules! natives {
    (@ts) => { None };
    (@ts $ts:literal) => { Some($ts) };
    (@ret) => { () };
    (@ret $ret:ty) => { $ret };
    (@retname) => { "()" };
    (@retname $ret:ty) => { stringify!($ret) };
    ($(
        $(#[doc = $doc:literal])*
        $(#[ts = $ts:literal])?
        $(#[safe_point = $safe_point:literal])?
        $vis:vis fn $name:ident($ed:ident $(, $arg:ident: $ty:ty)* $(,)?) $(-> $ret:ty)? $body:block
    )*) => {
        #[allow(non_snake_case, unused_imports, unused_variables, unused_mut, clippy::needless_question_mark, clippy::unnecessary_wraps)]
        mod body {
            use super::*;
            $(
                pub(super) fn $name($ed: &mut ember_core::Editor $(, $arg: $ty)*) -> ember_core::Result<natives!(@ret $($ret)?)> $body
            )*
        }

        /// This module's natives.
        pub(crate) const TABLE: &[$crate::natives::Native] = &[$(
            $crate::natives::Native {
                name: stringify!($name),
                doc: concat!($($doc, "\n",)*),
                params: &[$((stringify!($arg), stringify!($ty))),*],
                ret: natives!(@retname $($ret)?),
                public: !stringify!($vis).is_empty(),
                ts: natives!(@ts $($ts)?),
            },
        )*];

        /// Puts this module's natives on `native`, and the public ones on `api`.
        pub(crate) fn install<'js>(
            ctx: &rquickjs::Ctx<'js>,
            native: &rquickjs::Object<'js>,
            api: &rquickjs::Object<'js>,
        ) -> rquickjs::Result<()> {
            $(
                let function = rquickjs::Function::new(
                    ctx.clone(),
                    |ctx: rquickjs::Ctx<'js>
                     $(, $arg: <$ty as $crate::natives::Param>::Js<'js>)*|
                     -> rquickjs::Result<rquickjs::Value<'js>> {
                        $(let $arg = <$ty as $crate::natives::Param>::take(&ctx, $arg)?;)*
                        let value = if true $(&& $safe_point)? {
                            $crate::with_editor(&ctx, |ed| body::$name(ed $(, $arg)*))?
                        } else {
                            $crate::with_editor_unchecked(&ctx, |ed| body::$name(ed $(, $arg)*))?
                        };
                        $crate::natives::Ret::give(value, &ctx)
                    },
                )?;
                if !stringify!($vis).is_empty() {
                    api.set(stringify!($name), function.clone())?;
                }
                native.set(stringify!($name), function)?;
            )*
            Ok(())
        }
    };
}
pub(crate) use natives;

/// An optional last argument, which may be left out.
pub(crate) struct Opt<T>(pub Option<T>);

/// The rest of the arguments.
pub(crate) struct Rest<T>(pub Vec<T>);

/// A prefix argument, as scripts write them: null, a number, "-" or [4].
pub(crate) struct Prefix(pub Option<PrefixArg>);

/// A command's argument as a script gives it: null or undefined is no
/// text, `[4]` is C-u's `(4)`, anything else its text, as `String(x)`
/// gives it.
pub(crate) struct ArgText(pub String);

/// Any value: the editor value it is, or none for one no editor value
/// holds, such as an object, for predicates that answer false for those.
pub(crate) struct Any(pub Option<EditorValue>);

/// An object of options, as `{ visit: true, beg: 0 }`: each property that
/// is an editor value, by name.
pub(crate) struct Fields(pub Vec<(String, EditorValue)>);

impl Fields {
    pub fn get(&self, name: &str) -> Option<&EditorValue> {
        self.0.iter().find(|(n, _)| n == name).map(|(_, v)| v).filter(|v| !matches!(v, EditorValue::Null))
    }

    pub fn string(&self, name: &str) -> Option<String> {
        self.get(name).and_then(EditorValue::as_str).map(str::to_string)
    }

    pub fn number(&self, name: &str) -> Option<f64> {
        self.get(name).and_then(EditorValue::as_number)
    }

    /// Whether it is true, as `Boolean(x)`, false when left out.
    pub fn flag(&self, name: &str) -> bool {
        self.get(name).is_some_and(EditorValue::is_true)
    }

    pub fn strings(&self, name: &str) -> Option<Vec<String>> {
        match self.get(name)? {
            EditorValue::List(items) => Some(items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()),
            _ => None,
        }
    }
}

/// Face attributes as scripts give them, as an object: see `face_attrs_from_js`.
pub(crate) struct FaceAttrValues(pub Vec<(String, EditorValue)>);

/// A face attribute's value, a plist given as an object: see `plist_or_value_to_js`.
pub(crate) struct PlistOrValue(pub EditorValue);

/// A position in a window, or none: see `posn_to_js`.
pub(crate) struct Posn(pub Option<ember_core::layout::Posn>);

/// An object a native returns, as plain data: its properties in order.
#[derive(Default)]
pub(crate) struct Record(Vec<(&'static str, Field)>);

impl Record {
    pub fn new() -> Self {
        Record::default()
    }

    pub fn with(mut self, name: &'static str, value: impl Into<Field>) -> Self {
        self.0.push((name, value.into()));
        self
    }
}

/// A property of a [`Record`]: undefined, an editor value, text, a
/// number, a boolean, another record, or a list of these.
pub(crate) enum Field {
    Undefined,
    Value(EditorValue),
    Record(Record),
    List(Vec<Field>),
    FaceAttrs(Box<ember_core::FaceAttrs>),
}

impl<T: Into<Field>> From<Option<T>> for Field {
    fn from(v: Option<T>) -> Self {
        v.map_or(Field::Undefined, Into::into)
    }
}

impl<T: Into<Field>> From<Vec<T>> for Field {
    fn from(v: Vec<T>) -> Self {
        Field::List(v.into_iter().map(Into::into).collect())
    }
}

impl From<Record> for Field {
    fn from(r: Record) -> Self {
        Field::Record(r)
    }
}

impl From<EditorValue> for Field {
    fn from(v: EditorValue) -> Self {
        Field::Value(v)
    }
}

impl From<String> for Field {
    fn from(s: String) -> Self {
        Field::Value(EditorValue::Str(s))
    }
}

impl From<&str> for Field {
    fn from(s: &str) -> Self {
        Field::Value(EditorValue::Str(s.to_string()))
    }
}

impl From<bool> for Field {
    fn from(b: bool) -> Self {
        Field::Value(EditorValue::Bool(b))
    }
}

macro_rules! field_from_number {
    ($($t:ty),*) => {$(
        impl From<$t> for Field {
            fn from(n: $t) -> Self {
                Field::Value(EditorValue::Number(n as f64))
            }
        }
    )*};
}
field_from_number!(f64, f32, i64, i32, u64, u32, u8, usize);

/// A value a native takes, converted from the script's.
pub(crate) trait Conv: Sized {
    type Js<'js>: FromJs<'js>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self>;
}

/// A parameter of a native: a value, or an optional or rest argument.
pub(crate) trait Param: Sized {
    type Js<'js>: rquickjs::function::FromParam<'js>;
    fn take<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self>;
}

/// An argument left out is undefined, as JavaScript passes it to a
/// function of its own, rather than an error.
impl<T: Conv> Param for T {
    type Js<'js> = rquickjs::function::Opt<Value<'js>>;
    fn take<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        let value = js.0.unwrap_or_else(|| Value::new_undefined(ctx.clone()));
        T::conv(ctx, T::Js::from_js(ctx, value)?)
    }
}

impl<T: Conv> Param for Opt<T> {
    type Js<'js> = rquickjs::function::Opt<T::Js<'js>>;
    fn take<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        js.0.map(|v| T::conv(ctx, v)).transpose().map(Opt)
    }
}

impl<T: Conv> Param for Rest<T> {
    type Js<'js> = rquickjs::function::Rest<T::Js<'js>>;
    fn take<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        js.0.into_iter().map(|v| T::conv(ctx, v)).collect::<rquickjs::Result<_>>().map(Rest)
    }
}

/// Text is coerced, as `String(x)` does; so is a boolean, as `Boolean(x)`.
impl Conv for String {
    type Js<'js> = Coerced<String>;
    fn conv<'js>(_: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        Ok(js.0)
    }
}

impl Conv for bool {
    type Js<'js> = Coerced<bool>;
    fn conv<'js>(_: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        Ok(js.0)
    }
}

macro_rules! conv_as_is {
    ($($t:ty),*) => {$(
        impl Conv for $t {
            type Js<'js> = $t;
            fn conv<'js>(_: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
                Ok(js)
            }
        }
    )*};
}
conv_as_is!(f64, i64, i32, u64, u32, u8, usize);

/// Null or undefined is `None`.
impl<T: Conv> Conv for Option<T> {
    type Js<'js> = Option<T::Js<'js>>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        js.map(|v| T::conv(ctx, v)).transpose()
    }
}

impl<T: Conv> Conv for Vec<T> {
    type Js<'js> = Vec<T::Js<'js>>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        js.into_iter().map(|v| T::conv(ctx, v)).collect()
    }
}

impl Conv for EditorValue {
    type Js<'js> = Value<'js>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        crate::value_from_js(ctx, js)
    }
}

/// A string or propertized string.
impl Conv for ember_core::Text {
    type Js<'js> = Value<'js>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        crate::text_from_js(ctx, js)
    }
}

/// A script's function, as the editor holds one: the same function each time.
impl Conv for ember_core::Function {
    type Js<'js> = rquickjs::Function<'js>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        match crate::function_from_js(ctx, js)? {
            EditorValue::Function(function) => Ok(function),
            _ => unreachable!("a function converts to one"),
        }
    }
}

impl Conv for Any {
    type Js<'js> = Value<'js>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        Ok(Any(crate::value_from_js(ctx, js).ok()))
    }
}

impl Conv for ArgText {
    type Js<'js> = Value<'js>;
    fn conv<'js>(_: &Ctx<'js>, value: Self::Js<'js>) -> rquickjs::Result<Self> {
        Ok(ArgText(if value.is_null() || value.is_undefined() {
            String::new()
        } else if let Some(list) = value.as_array() {
            format!("({})", list.get::<Coerced<String>>(0)?.0)
        } else {
            value.get::<Coerced<String>>()?.0
        }))
    }
}

/// Each own property that is an editor value; others, such as objects, are left out.
impl Conv for Fields {
    type Js<'js> = rquickjs::Object<'js>;
    fn conv<'js>(ctx: &Ctx<'js>, object: Self::Js<'js>) -> rquickjs::Result<Self> {
        let mut fields = Vec::new();
        for entry in object.props::<String, Value>() {
            let (name, value) = entry?;
            if let Some(value) = crate::convert_from_js(ctx, value)? {
                fields.push((name, value));
            }
        }
        Ok(Fields(fields))
    }
}

impl Conv for FaceAttrValues {
    type Js<'js> = rquickjs::Object<'js>;
    fn conv<'js>(_: &Ctx<'js>, object: Self::Js<'js>) -> rquickjs::Result<Self> {
        crate::face_attr_values_from_js(&object).map(FaceAttrValues)
    }
}

impl Conv for ember_core::FaceAttrs {
    type Js<'js> = rquickjs::Object<'js>;
    fn conv<'js>(_: &Ctx<'js>, object: Self::Js<'js>) -> rquickjs::Result<Self> {
        crate::face_attrs_from_js(&object)
    }
}

impl Conv for Prefix {
    type Js<'js> = Value<'js>;
    fn conv<'js>(ctx: &Ctx<'js>, js: Self::Js<'js>) -> rquickjs::Result<Self> {
        crate::prefix_from_js(ctx, js).map(Prefix)
    }
}

/// What a native returns, converted to the script's value.
pub(crate) trait Ret {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>>;
}

macro_rules! ret_as_is {
    ($($t:ty),*) => {$(
        impl Ret for $t {
            fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
                self.into_js(ctx)
            }
        }
    )*};
}
ret_as_is!((), bool, String, &'static str, f64, i64, i32, u64, u32, u8, usize, char);

/// `None` is undefined, as Emacs's nil is to scripts.
impl<T: Ret> Ret for Option<T> {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        match self {
            Some(v) => v.give(ctx),
            None => Ok(Value::new_undefined(ctx.clone())),
        }
    }
}

impl<T: Ret> Ret for Vec<T> {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        let list = rquickjs::Array::new(ctx.clone())?;
        for (i, item) in self.into_iter().enumerate() {
            list.set(i, item.give(ctx)?)?;
        }
        Ok(list.into_value())
    }
}

impl<A: Ret, B: Ret> Ret for (A, B) {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        vec![self.0.give(ctx)?, self.1.give(ctx)?].into_js(ctx)
    }
}

impl<A: Ret, B: Ret, C: Ret> Ret for (A, B, C) {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        vec![self.0.give(ctx)?, self.1.give(ctx)?, self.2.give(ctx)?].into_js(ctx)
    }
}

impl Ret for EditorValue {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        crate::value_to_js(ctx, &self)
    }
}

impl Ret for Record {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        let object = rquickjs::Object::new(ctx.clone())?;
        for (name, field) in self.0 {
            object.set(name, field.give(ctx)?)?;
        }
        Ok(object.into_value())
    }
}

impl Ret for Field {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        match self {
            Field::Undefined => Ok(Value::new_undefined(ctx.clone())),
            Field::Value(v) => v.give(ctx),
            Field::Record(r) => r.give(ctx),
            Field::List(items) => items.give(ctx),
            Field::FaceAttrs(attrs) => attrs.give(ctx),
        }
    }
}

impl<T: Ret> Ret for Box<T> {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        (*self).give(ctx)
    }
}

impl Ret for ember_core::FaceAttrs {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        crate::face_attrs_to_js(ctx, &self).map(rquickjs::Object::into_value)
    }
}

impl Ret for PlistOrValue {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        crate::plist_or_value_to_js(ctx, &self.0)
    }
}

impl Ret for Posn {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        crate::posn_to_js(ctx, self.0)
    }
}

impl Ret for ember_core::Match {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        crate::match_to_js(ctx, &self).map(rquickjs::Object::into_value)
    }
}

/// Text properties, as an object of each property's value.
impl Ret for ember_core::Props {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        crate::props_to_js(ctx, &self).map(rquickjs::Object::into_value)
    }
}

impl Ret for Prefix {
    fn give<'js>(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        crate::prefix_to_js(ctx, self.0)
    }
}

/// Every table, in the order they are installed.
const TABLES: &[&[Native]] = &[
    editor::TABLE,
    variables::TABLE,
    text::TABLE,
    bidi::TABLE,
    treesit::TABLE,
    windows::TABLE,
    search::TABLE,
    files::TABLE,
    chartab::TABLE,
    images::TABLE,
];

/// Every native in the tables.
pub(crate) fn tables() -> impl Iterator<Item = &'static Native> {
    TABLES.iter().flat_map(|t| t.iter())
}

/// Puts every native in the tables on `native`, and the public ones on `api`.
pub(crate) fn install<'js>(ctx: &Ctx<'js>, native: &rquickjs::Object<'js>, api: &rquickjs::Object<'js>) -> rquickjs::Result<()> {
    editor::install(ctx, native, api)?;
    variables::install(ctx, native, api)?;
    text::install(ctx, native, api)?;
    bidi::install(ctx, native, api)?;
    treesit::install(ctx, native, api)?;
    windows::install(ctx, native, api)?;
    search::install(ctx, native, api)?;
    files::install(ctx, native, api)?;
    chartab::install(ctx, native, api)?;
    images::install(ctx, native, api)?;
    Ok(())
}

/// The declarations in `ember.d.ts` of the public natives.
pub(crate) fn declarations() -> String {
    let mut out = String::new();
    for native in tables().filter(|n| n.public) {
        out += &crate::types::js_doc(native.doc.trim_end(), "  ");
        let signature = native.ts.map(str::to_string).unwrap_or_else(|| signature(native));
        out += &format!("  function {}{signature};\n", native.name);
    }
    out
}

/// A signature from the Rust types: `(column: number): number`.
fn signature(native: &Native) -> String {
    let params: Vec<String> = native
        .params
        .iter()
        .map(|(name, ty)| {
            let ty = ty.replace(' ', "");
            if let Some(inner) = ty.strip_prefix("Opt<").and_then(|t| t.strip_suffix('>')) {
                format!("{name}?: {}", ts_type(inner))
            } else if let Some(inner) = ty.strip_prefix("Rest<").and_then(|t| t.strip_suffix('>')) {
                format!("...{name}: {}[]", ts_type(inner))
            } else {
                format!("{name}: {}", ts_type(&ty))
            }
        })
        .collect();
    format!("({}): {}", params.join(", "), ts_type(&native.ret.replace(' ', "")))
}

/// The TypeScript type of a Rust type, without spaces.
fn ts_type(ty: &str) -> String {
    if let Some(inner) = ty.strip_prefix("Option<").and_then(|t| t.strip_suffix('>')) {
        return format!("{} | undefined", ts_type(inner));
    }
    if let Some(inner) = ty.strip_prefix("Vec<").and_then(|t| t.strip_suffix('>')) {
        let inner = ts_type(inner);
        return if inner.contains(' ') { format!("({inner})[]") } else { format!("{inner}[]") };
    }
    match ty {
        "()" => "void",
        "bool" => "boolean",
        "String" | "&'staticstr" | "char" => "string",
        "f64" | "i64" | "i32" | "u64" | "u32" | "u8" | "usize" => "number",
        "Prefix" => "PrefixArg",
        "Text" | "ember_core::Text" => "string | PropertizedString",
        _ => "Value",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A public native is `ember`'s function as it is, so prelude.js must
    /// not define it again, which would hide it.
    #[test]
    fn public_natives_are_not_defined_again() {
        for native in tables().filter(|n| n.public) {
            for form in [format!("\n    {}:", native.name), format!("\n    {}(", native.name)] {
                assert!(!crate::PRELUDE.contains(&form), "{} is a public native and defined in prelude.js too", native.name);
            }
        }
    }

    #[test]
    fn each_native_has_one_entry() {
        let mut names: Vec<&str> = tables().map(|n| n.name).collect();
        names.sort_unstable();
        let twice: Vec<_> = names.windows(2).filter(|w| w[0] == w[1]).map(|w| w[0]).collect();
        assert!(twice.is_empty(), "defined twice: {twice:?}");
    }

    #[test]
    fn signatures_follow_the_rust_types() {
        let native = Native { name: "f", doc: "", params: &[("a", "String"), ("b", "Opt<usize>")], ret: "Option<Vec<String>>", public: true, ts: None };
        assert_eq!(signature(&native), "(a: string, b?: number): string[] | undefined");
    }
}
