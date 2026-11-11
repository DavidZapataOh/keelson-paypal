use std::path::Path;

use sp1_build::{BuildArgs, build_program_with_args};

fn main() {
    // The program is built in SP1's pinned image so its ELF, and the verifying key
    // `EngineProofVerifier` holds, are the same on every machine and every build. The image
    // mounts the repository root: the engine crates the program links inherit its workspace.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    build_program_with_args(
        "../program",
        BuildArgs {
            docker: true,
            tag: "v6.10.0".to_string(),
            workspace_directory: Some(
                root.canonicalize()
                    .expect("the repository root")
                    .to_string_lossy()
                    .into_owned(),
            ),
            ..Default::default()
        },
    );
}
