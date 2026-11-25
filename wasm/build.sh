#!/bin/sh
# Build proseka-core for wasm32-unknown-unknown and copy the artifact
# next to the web sources. Requires a Rust toolchain with the
# wasm32-unknown-unknown target (rustup target add wasm32-unknown-unknown).
set -e
cd "$(dirname "$0")/proseka-core"
export PATH="$HOME/.cargo/bin:$PATH"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/proseka_core.wasm ../proseka_core.wasm
ls -lh ../proseka_core.wasm
