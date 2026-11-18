//! imaginarium-mesh-rs — the CLI the studio spawns (wave ticket 46). Grammar, deliberately tiny:
//!
//! ```text
//! imaginarium-mesh-rs simplify --in A.glb --tris N --out B.glb [--json]
//! imaginarium-mesh-rs compare  --a A.glb --b B.glb [--json]
//! imaginarium-mesh-rs --version
//! ```
//!
//! Exit codes: 0 success, 1 a real refusal (the reason goes to stderr, the output file is
//! never written), 2 misuse. `--json` prints the machine-readable summary on stdout.

use std::process::ExitCode;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(Fail::Misuse) => ExitCode::from(2),
        Err(Fail::Refusal(msg)) => {
            eprintln!("imaginarium-mesh-rs: {msg}");
            ExitCode::FAILURE
        }
    }
}

enum Fail {
    Misuse,
    Refusal(String),
}

impl From<String> for Fail {
    fn from(s: String) -> Self {
        Fail::Refusal(s)
    }
}

fn usage() -> &'static str {
    "usage:\n  \
     imaginarium-mesh-rs simplify --in A.glb --tris N --out B.glb [--json]\n  \
     imaginarium-mesh-rs compare  --a A.glb --b B.glb [--json]\n  \
     imaginarium-mesh-rs --version"
}

fn need(flag: &str) -> Fail {
    eprintln!("imaginarium-mesh-rs: {flag} is required\n{}", usage());
    Fail::Misuse
}

/// The flag style the studio passes (`--in FILE`); `--in=FILE` is accepted too.
struct Args {
    rest: Vec<String>,
}

impl Args {
    fn flag(&mut self, name: &str) -> Option<String> {
        let prefix = format!("{name}=");
        let mut value = None;
        let mut keep = Vec::new();
        let mut it = self.rest.iter();
        while let Some(a) = it.next() {
            if value.is_none() && a == name {
                value = it.next().cloned();
                continue;
            }
            if value.is_none() && a.starts_with(&prefix) {
                value = Some(a[prefix.len()..].to_string());
                continue;
            }
            keep.push(a.clone());
        }
        self.rest = keep;
        value
    }

    fn take_bool(&mut self, name: &str) -> bool {
        let had = self.rest.iter().any(|a| a == name);
        if had {
            self.rest.retain(|a| a != name);
        }
        had
    }

    fn reject_stray(&self) -> Result<(), Fail> {
        if self.rest.is_empty() {
            Ok(())
        } else {
            eprintln!(
                "imaginarium-mesh-rs: unexpected arguments: {}\n{}",
                self.rest.join(" "),
                usage()
            );
            Err(Fail::Misuse)
        }
    }
}

fn run() -> Result<(), Fail> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = argv.first() else {
        eprintln!("{}", usage());
        return Err(Fail::Misuse);
    };
    let mut args = Args {
        rest: argv[1..].to_vec(),
    };
    let as_json = args.take_bool("--json");

    match command.as_str() {
        "--version" | "-V" | "version" => {
            args.reject_stray()?;
            if as_json {
                println!(
                    "{}",
                    serde_json::json!({ "name": "imaginarium-mesh-rs", "version": imaginarium_mesh_rs::VERSION })
                );
            } else {
                println!("imaginarium-mesh-rs {}", imaginarium_mesh_rs::VERSION);
            }
            Ok(())
        }
        "simplify" => simplify(&mut args, as_json),
        "compare" => compare(&mut args, as_json),
        other => {
            eprintln!("imaginarium-mesh-rs: unknown command '{other}'\n{}", usage());
            Err(Fail::Misuse)
        }
    }
}

fn simplify(args: &mut Args, as_json: bool) -> Result<(), Fail> {
    let input = args.flag("--in").ok_or_else(|| need("--in"))?;
    let output = args.flag("--out").ok_or_else(|| need("--out"))?;
    let tris_raw = args.flag("--tris").ok_or_else(|| need("--tris"))?;
    let tris: usize = tris_raw.replace('_', "").parse().map_err(|_| {
        Fail::Refusal(format!(
            "--tris must be a whole triangle count, got '{tris_raw}'"
        ))
    })?;
    args.reject_stray()?;

    let bytes = read(&input)?;
    let (mut root, bin) = imaginarium_mesh_rs::glb::load(&bytes).map_err(Fail::Refusal)?;
    let (out, summary) =
        imaginarium_mesh_rs::glb::simplify_glb(&mut root, &bin, tris).map_err(Fail::Refusal)?;
    // Success only now: any refusal above left `--out` completely untouched.
    std::fs::write(&output, &out).map_err(|e| Fail::Refusal(format!("writing {output}: {e}")))?;

    let before: usize = summary.primitives.iter().map(|p| p.triangles_before).sum();
    let after: usize = summary.primitives.iter().map(|p| p.triangles_after).sum();
    if as_json {
        let primitives: Vec<_> = summary
            .primitives
            .iter()
            .map(|p| {
                serde_json::json!({
                    "mesh": p.mesh, "primitive": p.primitive,
                    "triangles": [p.triangles_before, p.triangles_after],
                    "vertices": [p.vertices_before, p.vertices_after],
                    "action": p.action,
                    "error": (p.error as f64 * 1e6).round() / 1e6,
                })
            })
            .collect();
        println!(
            "{}",
            serde_json::json!({
                "name": "imaginarium-mesh-rs", "version": imaginarium_mesh_rs::VERSION, "mode": "simplify",
                "targetTris": tris, "trianglesBefore": before, "trianglesAfter": after,
                "maxError": (summary.max_error as f64 * 1e6).round() / 1e6,
                "primitives": primitives,
                "carried": summary.carried, "dropped": summary.dropped,
                "out": output,
            })
        );
    } else {
        println!("imaginarium-mesh-rs: {input}: {before} -> {after} triangles -> {output}");
    }
    Ok(())
}

fn compare(args: &mut Args, as_json: bool) -> Result<(), Fail> {
    let a = args.flag("--a").ok_or_else(|| need("--a"))?;
    let b = args.flag("--b").ok_or_else(|| need("--b"))?;
    args.reject_stray()?;
    let va = read(&a)?;
    let vb = read(&b)?;
    let value = imaginarium_mesh_rs::glb::compare_bytes(&va, &vb).map_err(Fail::Refusal)?;
    if as_json {
        println!("{value}");
    } else {
        let d = &value["deviation"]["vertexDistance"];
        println!(
            "imaginarium-mesh-rs compare {a} vs {b}: area ratio {}, vertex distance p50 {} p95 {} max {}",
            value["deviation"]["areaRatio"], d["p50"], d["p95"], d["max"]
        );
    }
    Ok(())
}

fn read(path: &str) -> Result<Vec<u8>, Fail> {
    std::fs::read(path).map_err(|e| Fail::Refusal(format!("reading {path}: {e}")))
}
