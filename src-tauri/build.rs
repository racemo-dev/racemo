fn main() {
    println!("cargo:rerun-if-changed=../proto/remote.proto");

    // Compile protobuf definitions using protox (pure-Rust compiler).
    // Avoids the need for a system `protoc` install on dev machines and CI.
    let file_descriptors = protox::compile(["../proto/remote.proto"], ["../proto/"])
        .expect("Failed to compile protobuf");

    prost_build::compile_fds(file_descriptors)
        .expect("Failed to generate Rust code from protobuf");

    tauri_build::build()
}
