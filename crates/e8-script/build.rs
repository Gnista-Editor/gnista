//! Strips the packages that ship with E8 when it is built, as Emacs
//! byte-compiles its preloaded Lisp, so starting the editor loads
//! JavaScript ready to run. A package that cannot be stripped is left to
//! the editor, which reports it when loading, as it does any script.

use std::fmt::Write;
use std::path::Path;

#[path = "src/strip_js.rs"]
mod strip_js;

fn main() {
    let packages = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages");
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    std::fs::create_dir_all(out.join("packages")).expect("OUT_DIR is writable");
    println!("cargo:rerun-if-changed=src/strip_js.rs");
    println!("cargo:rerun-if-changed={}", packages.display());
    let mut names: Vec<String> = std::fs::read_dir(&packages)
        .expect("packages/ is there")
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.ends_with(".ts") && !n.ends_with(".d.ts"))
        .collect();
    names.sort();
    let mut table = String::from("/// Each shipped package's JavaScript, stripped when E8 was built.\nfn stripped(file: &str) -> Option<&'static str> {\n    match file {\n");
    for name in names {
        let path = packages.join(&name);
        println!("cargo:rerun-if-changed={}", path.display());
        let source = std::fs::read_to_string(&path).expect("a package is UTF-8");
        let file = format!("packages/{name}");
        let Ok(js) = strip_js::strip_js(&file, source, true) else { continue };
        let target = out.join("packages").join(name.replace(".ts", ".js"));
        std::fs::write(&target, js).expect("OUT_DIR is writable");
        writeln!(table, "        {file:?} => Some(include_str!({:?})),", target.display().to_string()).unwrap();
    }
    table.push_str("        _ => None,\n    }\n}\n");
    std::fs::write(out.join("stripped.rs"), table).expect("OUT_DIR is writable");
}
