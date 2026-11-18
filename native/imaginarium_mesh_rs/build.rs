// Build the vendored meshoptimizer simplifier translation unit into the crate.
// The sources are pinned byte-for-byte (see VENDORING.md); nothing here downloads.
fn main() {
    cc::Build::new()
        .cpp(true)
        .file("vendor/meshoptimizer/src/simplifier.cpp")
        .include("vendor/meshoptimizer/src")
        .flag_if_supported("-std=c++11")
        .warnings(false)
        .compile("meshoptimizer_simplifier");
    println!("cargo:rerun-if-changed=vendor/meshoptimizer/src/simplifier.cpp");
    println!("cargo:rerun-if-changed=vendor/meshoptimizer/src/meshoptimizer.h");
}
