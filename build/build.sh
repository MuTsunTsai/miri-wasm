#!/usr/bin/env bash
# Builds Miri for wasm32-wasip1 (miri.wasm) and an x86_64-unknown-linux-gnu sysroot from the same nightly.
#
# Must run on Linux (or WSL). Requires: git, curl, python3, gcc/g++, rustup.
# The first full build takes about 1-1.5 hours (16 threads, 8 GB RAM) and about 25 GB of disk.
#
# Usage: bash build/build.sh
#   Environment variables:
#     WORK=~/miri-wasm          Work directory (rust sources, wasi-sdk, build output). Keep it on the Linux file system, not under /mnt/c.
#     NIGHTLY=2026-11-13        rustup nightly date (determines the rust commit)
#     JOBS=8                    Parallelism (lower it if you run out of memory)
#     WASI_SDK_VER=34           wasi-sdk major version
#     OUT=<repo>/out            Output directory
#     SYSROOT_ONLY=1            Rebuild only the sysroot and build-info.json (skip steps 2-6, leave miri.wasm untouched)
#
# Output:
#   $OUT/miri.wasm              stripped with llvm-strip
#   $OUT/sysroot/lib/rustlib/x86_64-unknown-linux-gnu/lib/
#   $OUT/build-info.json        tag, rustc version and commit; read by scripts/pack.mjs
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${WORK:-$HOME/miri-wasm}"
NIGHTLY="${NIGHTLY:-2026-11-13}"
JOBS="${JOBS:-8}"
OUT="${OUT:-$HERE/../out}"
WASI_SDK_VER="${WASI_SDK_VER:-34}"
WASI_SDK="$WORK/wasi-sdk-$WASI_SDK_VER.0-x86_64-linux"
TOOLCHAIN="nightly-$NIGHTLY"

mkdir -p "$WORK" "$OUT"
OUT="$(cd "$OUT" && pwd)"
cd "$WORK"

# 1. Install the matching nightly (its commit hash selects the sources, and its cargo-miri builds the sysroot)
rustup toolchain install "$TOOLCHAIN" --profile minimal -c miri -c rust-src
COMMIT="$(rustup run "$TOOLCHAIN" rustc -vV | sed -n 's/^commit-hash: //p')"
echo "== $TOOLCHAIN = rust-lang/rust@$COMMIT"

if [ "${SYSROOT_ONLY:-0}" != 1 ]; then

# 2. rust sources (blobless clone: bootstrap's download-ci-llvm needs the git history)
if [ ! -d rust/.git ]; then
	git clone --filter=blob:none --no-checkout https://github.com/rust-lang/rust.git rust
fi
if [ "$(git -C rust rev-parse HEAD 2>/dev/null || true)" = "$COMMIT" ] \
	&& git -C rust apply --reverse --check "$HERE/miri-wasm.patch" 2>/dev/null; then
	echo "== patch already applied, skipping checkout"
else
	git -C rust fetch --filter=blob:none origin "$COMMIT" || true
	git -C rust reset -q
	git -C rust checkout -f "$COMMIT"
	git -C rust clean -fdq -e build -e bootstrap.toml
	git -C rust apply "$HERE/miri-wasm.patch"
fi

# 3. wasi-sdk (provides the wasm32-wasip1 libc and clang)
if [ ! -d "$WASI_SDK" ]; then
	curl -sSL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$WASI_SDK_VER/wasi-sdk-$WASI_SDK_VER.0-x86_64-linux.tar.gz" | tar xz
fi

# 4. bootstrap config
sed -e "s#@WASI_SDK@#$WASI_SDK#g" -e "s#^jobs = .*#jobs = $JOBS#" "$HERE/bootstrap.toml" > rust/bootstrap.toml

# 5. Build: stage1 is a rustc running on Linux, used to cross-compile rustc_driver and Miri to wasm32-wasip1.
#    cargo-miri is not needed and does not compile on wasip1 (serde has no OsString impl there), so it is excluded.
#    Path remapping: the rust sources are remapped to /rustc/<commit> by rust.remap-debuginfo in bootstrap.toml
#    (bootstrap handles it with cargo's -Ztrim-paths). Paths of dependency crates in the cargo registry
#    (which appear in panic location strings) are remapped to /cargo/registry/src via RUSTFLAGS_NOT_BOOTSTRAP,
#    which only applies to stage1 and later, not to the stage0 bootstrap tools.
CARGO_REGISTRY_SRC="${CARGO_HOME:-$HOME/.cargo}/registry/src"
(cd rust && WASI_SDK_PATH="$WASI_SDK" \
	RUSTFLAGS_NOT_BOOTSTRAP="--remap-path-prefix=$CARGO_REGISTRY_SRC=/cargo/registry/src" \
	./x.py build --stage 2 --host wasm32-wasip1 src/tools/miri \
	--exclude src/tools/miri/cargo-miri)

# 6. Strip the name/DWARF sections (79 MB -> 62 MB; br 9.8 MB -> 8.9 MB); does not affect execution
MIRI_WASM="rust/build/x86_64-unknown-linux-gnu/stage2-tools/wasm32-wasip1/release/miri.wasm"
"$WASI_SDK/bin/llvm-strip" -o "$OUT/miri.wasm" "$MIRI_WASM"
echo "== miri.wasm: $(du -h "$OUT/miri.wasm" | cut -f1)"
if grep -qa "$HOME" "$OUT/miri.wasm"; then
	echo "!! miri.wasm still contains $HOME; use node scripts/scrub-paths.mjs to remove it" >&2
fi

fi # SYSROOT_ONLY

# 7. sysroot: built with cargo-miri from the same nightly (std compiled with cfg(miri) and -Zalways-encode-mir)
#    Note: metadata is no longer embedded in the rlib (-Zembed-metadata=no); keep both .rlib and .rmeta.
#
#    Path remapping: .rmeta records absolute source paths, which show up in compile errors and panic locations.
#    - rust-src -> /rustc/<commit>, same as the standard library of official releases
#    - cargo registry -> /cargo/registry/src, so the builder's home directory is not leaked
#    cargo miri setup ignores RUSTFLAGS and MIRIFLAGS (rustc-build-sysroot overrides CARGO_ENCODED_RUSTFLAGS
#    with fixed flags), but cargo-miri uses the program named by the MIRI environment variable as rustc,
#    so a wrapper script appends --remap-path-prefix to every miri call.
#    rustc-build-sysroot's cache check does not include these flags, so the old sysroot is always removed and rebuilt (about 10–20 seconds).
SYSROOT="$WORK/sysroot-$TOOLCHAIN"
RUST_SRC="$(rustup run "$TOOLCHAIN" rustc --print sysroot)/lib/rustlib/src/rust"
CARGO_REGISTRY_SRC="${CARGO_HOME:-$HOME/.cargo}/registry/src"
REAL_MIRI="$(rustup which --toolchain "$TOOLCHAIN" miri)"
MIRI_WRAPPER="$WORK/miri-remap.sh"
cat > "$MIRI_WRAPPER" <<EOF
#!/bin/sh
exec "$REAL_MIRI" "\$@" "--remap-path-prefix=$RUST_SRC=/rustc/$COMMIT" "--remap-path-prefix=$CARGO_REGISTRY_SRC=/cargo/registry/src"
EOF
chmod +x "$MIRI_WRAPPER"
rm -rf "$SYSROOT"
MIRI="$MIRI_WRAPPER" MIRI_SYSROOT="$SYSROOT" cargo "+$TOOLCHAIN" miri setup --target x86_64-unknown-linux-gnu
#    Copy only .rlib and .rmeta; .d files (cargo dependency info) record real local paths and are not needed
SYSROOT_LIB="$SYSROOT/lib/rustlib/x86_64-unknown-linux-gnu/lib"
if grep -lqa "$HOME" "$SYSROOT_LIB"/*.rlib "$SYSROOT_LIB"/*.rmeta; then
	echo "!! sysroot still contains $HOME:" >&2
	grep -la "$HOME" "$SYSROOT_LIB"/*.rlib "$SYSROOT_LIB"/*.rmeta >&2
	exit 1
fi
rm -rf "$OUT/sysroot"
mkdir -p "$OUT/sysroot/lib/rustlib/x86_64-unknown-linux-gnu/lib"
cp "$SYSROOT_LIB"/*.rlib "$SYSROOT_LIB"/*.rmeta "$OUT/sysroot/lib/rustlib/x86_64-unknown-linux-gnu/lib/"

# 8. Version info (for pack.mjs)
RUSTC_VERSION="$(rustup run "$TOOLCHAIN" rustc -V)"
cat > "$OUT/build-info.json" <<EOF
{
	"tag": "$TOOLCHAIN",
	"rustc": "$RUSTC_VERSION",
	"commit": "$COMMIT"
}
EOF

echo "== Version: $RUSTC_VERSION"
echo "== Done, output in $OUT"
