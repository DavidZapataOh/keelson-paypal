use sp1_build::{BuildArgs, build_program_with_args};

fn main() {
    // The program is built in SP1's pinned image so its ELF, and the verifying key
    // `EngineProofVerifier` holds, are the same on every machine and every build.
    build_program_with_args(
        "../program",
        BuildArgs {
            docker: true,
            tag: "v6.10.0".to_string(),
            ..Default::default()
        },
    );
}
