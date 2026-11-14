# miri-wasm

[Miri](https://github.com/rust-lang/miri) from rust-lang/rust, compiled to `wasm32-wasip1` so that Rust programs can be interpreted directly in the browser.

- **No threads, no SharedArrayBuffer.** It runs on [`@bjorn3/browser_wasi_shim`](https://github.com/bjorn3/browser_wasi_shim), so your site does not need COOP/COEP headers.
- **Modern Rust.** Built from a recent nightly, with editions 2015 through 2024.
- **Ready-to-download artifacts.** Each GitHub Release contains a brotli-compressed `miri.wasm`, a stripped x86_64 sysroot, and a `manifest.json` describing them.

This is for anyone who wants to run user-written Rust in a web page without a server: online playgrounds, interactive tutorials, and similar tools. It powers the code exercises of a downstream interactive Rust course ([learn-rust](https://github.com/mutsuntsai/learn-rust)), which downloads the Release assets listed in `manifest.json` at build time.

If you only want to *use* the prebuilt compiler, skip to [Using a Release](#using-a-release) and [Running Miri](#running-miri). The [Building](#building) section is only needed to produce a new release.

## Contents

- [Supported versions](#supported-versions)
- [Using a Release](#using-a-release)
- [Running Miri](#running-miri)
- [Known limitations](#known-limitations)
- [Building](#building)
- [Packing](#packing)
- [Testing](#testing)
- [What the patch changes](#what-the-patch-changes)
- [License](#license)

## Supported versions

| Release tag | rustc | Editions |
| --- | --- | --- |
| `nightly-2026-11-13` | `rustc 1.102.0-nightly (8eb778d04 2026-11-12)` | 2015–2024 |

Miri can only be built from nightly, so releases are named after the rustup nightly date. The rust sources change from nightly to nightly, so the patch may need adjusting when moving to a new version.

## Using a Release

- Tags are named after the nightly date: `nightly-YYYY-MM-DD`, e.g. `nightly-2026-11-13`.
- Every file in `dist/<tag>/` is uploaded as a release asset.
- Download URL: `https://github.com/mutsuntsai/miri-wasm/releases/download/<tag>/<file name>`.
- Each asset is brotli-compressed and has a `.bin` suffix (not `.br`), so static servers do not add a `Content-Encoding` header on their own. Decompress it yourself after downloading.

### Manifest format

`manifest.json` (format 2):

```json
{
	"format": 2,
	"tag": "nightly-2026-11-13",
	"rustc": "rustc 1.102.0-nightly (8eb778d04 2026-11-12)",
	"target": "x86_64-unknown-linux-gnu",
	"source": "https://github.com/mutsuntsai/miri-wasm",
	"files": [
		{ "kind": "miri", "name": "miri.wasm", "path": "miri.wasm.bin", "size": 8880426, "rawSize": 62209909, "sha256": "a6666dc6…" },
		{ "kind": "rlib", "name": "libaddr2line-8661fb94e2132ec9.rlib", "path": "libaddr2line-8661fb94e2132ec9.rlib.bin", "size": 374, "rawSize": 1416, "sha256": "5a79240d…" },
		{ "kind": "rmeta", "name": "libaddr2line-8661fb94e2132ec9.rmeta", "path": "libaddr2line-8661fb94e2132ec9.rmeta.bin", "size": 148970, "rawSize": 352118, "sha256": "088ccf34…" }
	]
}
```

| Field | Description |
| --- | --- |
| `format` | Manifest format version; bumped on incompatible changes |
| `tag` | Release tag |
| `rustc` | Output of `rustc -V` |
| `target` | Target of the sysroot; pass it to Miri as `--target` |
| `source` | URL of this project |
| `files[].kind` | `miri`, `rlib` or `rmeta` |
| `files[].name` | Actual file name after decompression. `rlib` and `rmeta` files go under `lib/rustlib/<target>/lib/` in the sysroot |
| `files[].path` | Release asset file name |
| `files[].size` | Compressed size in bytes |
| `files[].rawSize` | Decompressed size in bytes |
| `files[].sha256` | sha256 of the compressed content (full hex) |

## Running Miri

Example with `@bjorn3/browser_wasi_shim` 0.4.2 (see [tests/miri.mjs](tests/miri.mjs) for the complete code):

- Decompress the `rlib` and `rmeta` files into `/sysroot/lib/rustlib/x86_64-unknown-linux-gnu/lib/`, put the source at `/main.rs`, and provide a writable `/tmp`.
- Arguments:

  ```
  miri --sysroot /sysroot main.rs --target x86_64-unknown-linux-gnu --edition 2024
       -Cpanic=abort -Zmiri-ignore-leaks -Zmiri-disable-isolation --color=never
  ```

- Speed-up flags (these disable most UB checks; leave them out when you want UB detection):

  ```
  -Zmiri-permissive-provenance -Zmiri-preemption-rate=0 -Zmiri-disable-alignment-check
  -Zmiri-disable-data-race-detector -Zmiri-disable-stacked-borrows -Zmiri-disable-validation
  ```

- Environment: `RUSTC_ICE=0` is **required**. At startup rustc calls `std::process::id()` to name the ICE report file, which panics on wasip1. `RUST_BACKTRACE=0` is also recommended.

### Flag changes

- `-Zmir-emit-retag=false` has been removed from rustc. Passing it fails with `unknown unstable option`.
- `-Zmir-opt-level=3` still works, but prints a warning to stderr on every run (`warning: You have explicitly enabled MIR optimizations, ...` and `warning: 1 warning emitted`). It only affects the MIR of the user's own program: a plain loop runs about 1.8x faster (1.55 s → 0.87 s), while sorting in the standard library is unchanged. If you use it, filter out those two warning lines yourself.
- All other `-Zmiri-*` flags are still available.

### Output differences from older builds

Compared with the Miri from rubri (around Rust 1.77):

- On a compile error, the WASM module exits with a trap (`unreachable`) and **no longer prints** `error: aborting due to N previous errors` or `For more information about this error...`: with panic=abort on wasm, rustc aborts before printing the summary. To detect a compile error, look for stderr lines starting with `error:` or `error[E....]:` (excluding panics and UB).
- Panic messages include a thread ID: `thread 'main' (1000) panicked at ...`. There is also an extra trailing line: `note: in Miri, you may have to set MIRIFLAGS=-Zmiri-env-forward=RUST_BACKTRACE ...`.
- When the program aborts (including on panic), stderr ends with `error: abnormal termination: the program aborted execution`; you can cut everything from that line on.
- Sysroot rlibs no longer embed their metadata (`-Zembed-metadata=no`), so you must provide both the `.rlib` and the `.rmeta` files. `adler` was renamed to `adler2`.

## Known limitations

- **Sorting is slow.** Since 1.81 the standard library uses driftsort and ipnsort, which take many more interpreted steps than the old implementation. Sorting 20,000 numbers takes about 18 s (about 8 s with rubri's 1.77). The interpreter itself is only about 10% slower: with `-Zmir-opt-level=3` on both, a plain loop of 300,000 iterations takes about 0.87 s (rubri: about 0.82 s).
- The download is about 32.5 MB (brotli), about 4 MB more than rubri.
- No networking: creating a socket always fails (Unsupported).
- No proc macros or external crates; only std is available.
- There are no threads whose stack size could be configured, so rustc's stack is fixed at 8 MiB. Extremely deep recursion (e.g. huge macro expansions) may overflow the stack.
- Only an x86_64-unknown-linux-gnu sysroot is provided, and `cfg!(target_os)` and friends reflect that target.

Benchmarks (Node 24, browser_wasi_shim 0.4.2):

| | rubri (~1.77) | nightly-2026-11-13 (1.102) |
| --- | --- | --- |
| miri.wasm (raw → br) | 47.2 → 8.98 MB | 62.2 → 8.88 MB |
| sysroot (stripped → br) | 81.2 → 19.4 MB | 92.7 → 23.6 MB |
| Total (br) | 28.4 MB | 32.5 MB |
| brotli decompress + compile | ~430 + 55 ms | ~500 + 75 ms |
| hello world: first run | ~510 ms | ~490 ms |
| hello world: average after that | ~133 ms | ~170 ms |
| Plain loop, 300,000 iterations (`tests/bench/loop.rs`) | ~820 ms (with `-Zmir-opt-level=3`) | ~1550 ms; ~870 ms with `-Zmir-opt-level=3` |
| Sorting 20,000 numbers | ~8 s | ~18 s |

## Building

### Repository layout

| Path | Contents |
| --- | --- |
| `build/build.sh` | Build script; runs on Linux or WSL |
| `build/bootstrap.toml` | rust bootstrap config; build.sh substitutes `@WASI_SDK@` and `jobs` |
| `build/miri-wasm.patch` | Changes to the rust sources (see [What the patch changes](#what-the-patch-changes)) |
| `scripts/pack.mjs` | Packs the build output into release assets |
| `scripts/scrub-paths.mjs` | Erases the builder's home directory from miri.wasm (see [Path remapping](#path-remapping)) |
| `tests/run-tests.mjs` | Functional tests against `dist/<tag>/` in Node |
| `tests/bench.mjs` | Benchmarks |
| `out/` | Output of build.sh (not version-controlled) |
| `dist/<tag>/` | Output of pack, i.e. the files to upload to a Release (not version-controlled) |

### Requirements

- Linux or WSL (x86_64).
- git, curl, python3, gcc/g++, rustup.
- [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) 34, which provides the wasm32-wasip1 libc, clang and llvm-strip. build.sh downloads it into the work directory automatically.
- About 25 GB of disk. The first build takes about 1–1.5 hours (16 threads, 8 GB RAM).
- Packing and testing need Node 24+ and pnpm, on either Windows or Linux.

### Steps

```sh
# Run inside WSL. The build takes a long time, so use tmux to survive shell disconnects.
# WSL may shut down when idle; keep `wsl -e sleep 14400` running on the Windows side.
cd /path/to/miri-wasm
tmux new-session -d -s miri 'bash build/build.sh > ~/miri-wasm-build.log 2>&1'
tail -f ~/miri-wasm-build.log
```

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `WORK` | `~/miri-wasm` | Work directory: rust sources, wasi-sdk, intermediate build output. Keep it on the Linux file system, not under `/mnt/c` |
| `NIGHTLY` | `2026-11-13` | rustup nightly date; determines the rust commit |
| `JOBS` | `8` | Parallelism. WSL gets about 8 GB of RAM by default; higher values can OOM |
| `WASI_SDK_VER` | `34` | wasi-sdk major version |
| `OUT` | `<repo>/out` | Output directory |
| `SYSROOT_ONLY` | (unset) | Set to `1` to rebuild only the sysroot and `build-info.json`, skipping steps 2–6 and leaving `miri.wasm` untouched |

build.sh does the following, in order:

1. Installs the matching nightly (with the miri and rust-src components) and reads its commit hash.
2. Fetches the rust sources with a blobless clone, checks out that commit and applies the patch. If the patch is already applied, it skips this and builds incrementally.
3. Downloads wasi-sdk.
4. Generates `bootstrap.toml`.
5. Runs `./x.py build --stage 2 --host wasm32-wasip1 src/tools/miri`: this first builds a stage1 rustc that runs on Linux, then uses it to cross-compile rustc_driver and Miri to wasm32-wasip1.
6. Strips the name and DWARF sections with llvm-strip (79 MB → 62 MB).
7. Builds an x86_64-unknown-linux-gnu sysroot with `cargo miri setup` from the same nightly, and copies only the `.rlib` and `.rmeta` files to `out/`.
8. Writes `out/build-info.json` (tag, rustc version, commit).

Output: `out/miri.wasm`, `out/sysroot/lib/rustlib/x86_64-unknown-linux-gnu/lib/`, `out/build-info.json`.

### Path remapping

`.rmeta` files and `miri.wasm` record absolute source paths, which show up in compile errors seen by users (e.g. `--> .../library/core/src/slice/index.rs` under a `help`) and in panic locations. To avoid leaking the builder's home directory and to match the paths of the official rustc, build.sh remaps them:

| Artifact | Original path | Remapped to | How |
| --- | --- | --- | --- |
| sysroot | `<toolchain>/lib/rustlib/src/rust` | `/rustc/<commit>` (same as official releases) | `--remap-path-prefix` |
| sysroot | `$CARGO_HOME/registry/src` | `/cargo/registry/src` | `--remap-path-prefix` |
| miri.wasm | rust sources | `/rustc/<commit>` | `rust.remap-debuginfo = true` in `bootstrap.toml` |
| miri.wasm | `$CARGO_HOME/registry/src` | `/cargo/registry/src` | `--remap-path-prefix` in `RUSTFLAGS_NOT_BOOTSTRAP` |

- `cargo miri setup` ignores `RUSTFLAGS` and `MIRIFLAGS`: rustc-build-sysroot pins `CARGO_ENCODED_RUSTFLAGS` to `-Cdebug-assertions=off -Coverflow-checks=on`. However, cargo-miri uses the program named by the `MIRI` environment variable as its compiler, so build.sh generates `$WORK/miri-remap.sh`, which wraps the real miri and appends `--remap-path-prefix` to every call. rustc-build-sysroot's cache check does not include these flags, so the old sysroot is always deleted and rebuilt (about 10–20 seconds).
- After both steps, build.sh checks that the output no longer contains `$HOME`.

**The miri.wasm of `nightly-2026-11-13`** was built before these settings were added, so panic location strings from dependency crates contain `/home/<user>/.cargo/registry/src/...`. To avoid rebuilding rustc (several hours), `scripts/scrub-paths.mjs` performs a same-length byte replacement that turns the user name into the same number of `x` characters (e.g. `/home/alice/` → `/home/xxxxx/`). wasm data segments and Rust `&str` values store their lengths separately, so a same-length replacement does not break anything; the script also verifies the result with `WebAssembly.compile`:

```sh
node scripts/scrub-paths.mjs   # overwrites out/miri.wasm in place; safe to run repeatedly
```

A miri.wasm rebuilt with the new remap settings contains no home directory, so **this step is not needed** (if you run it anyway, the script reports that there is nothing to replace).

## Packing

```sh
pnpm install
pnpm run pack   # note the "run": `pnpm pack` is a built-in pnpm command
```

By default this reads from `out/` and writes to `dist/<tag>/`. You can also specify the inputs:

```sh
node scripts/pack.mjs --miri <miri.wasm> --lib <rustlib lib dir of the sysroot> --tag nightly-YYYY-MM-DD --rustc "rustc 1.xx.0-nightly (...)"
```

To regenerate only `NOTICE.txt` in an existing `dist/<tag>/` (leaving the `.bin` files and `manifest.json` untouched), add `--notice-only`.

What packing does:

- Picks only the 21 crates needed to run std programs: `addr2line`, `adler2`, `alloc`, `cfg_if`, `compiler_builtins`, `core`, `gimli`, `hashbrown`, `libc`, `memchr`, `miniz_oxide`, `object`, `panic_abort`, `panic_unwind`, `rustc_demangle`, `rustc_std_workspace_alloc`, `rustc_std_workspace_core`, `std`, `std_detect`, `sysroot`, `unwind`. `test`, `getopts`, `proc_macro`, `rustc_literal_escaper`, `rustc_std_workspace_std` and others are excluded.
- Each crate has both a `.rlib` and a `.rmeta` file, and both must go into the sysroot (see [Output differences from older builds](#output-differences-from-older-builds)).
- `.rlib` files keep only their `lib.rmeta` member; all machine code is stripped. `.rmeta` files are kept as-is.
- Each file is compressed with brotli (quality 11, lgwin 24) and given a `.bin` suffix, so static servers do not add `Content-Encoding` when they see `.br`.
- All files sit flat in `dist/<tag>/` with no subdirectories, because GitHub Release assets cannot have subdirectories.

Compression takes about 2–3 minutes.

## Testing

```sh
pnpm test              # uses the latest tag under dist/
pnpm test -- --verbose # prints the output of each test
node tests/run-tests.mjs dist/nightly-2026-11-13
pnpm run bench         # benchmarks
```

The tests read the packed output directly. They first verify the size and sha256 of every file, then run the following with browser_wasi_shim: hello world, `gen` under editions 2021 and 2024, RPIT lifetime capture, compile errors, panics, `LazyLock`, let chains, UB detection in strict mode, and rejection of a removed flag.

## What the patch changes

`build/miri-wasm.patch`:

**rustc (so that rustc_driver runs on wasip1, which has no threads and no dlopen)**
- `rustc_driver/Cargo.toml`: adds `lib` to the crate types. wasm does not support dylibs, so an rlib is needed for static linking.
- `rustc_interface/src/util.rs`: on wasi, runs the compiler on the main thread instead of spawning a new one. The stack size is set by the linker argument `-zstack-size=8MiB` instead.
- `rustc_metadata/src/host_dylib.rs`: on wasi, `load_symbol_from_dylib` always returns an error, since there is no libloading.
- `rustc_session/src/filesearch.rs`: on wasi there is no rustc_driver.so to derive the sysroot from, so it defaults to `/sysroot`.

**bootstrap**
- `build_steps/compile.rs`: when the host is wasm, also puts the `.rlib` of each rustc crate into the sysroot. Normally only `.rmeta` is copied, because on regular platforms the object code lives in librustc_driver.so.
- `build_steps/tool.rs`: builds Miri with `--bins` only, not `--all-targets`. Test targets cannot be linked on wasm.

**Miri**
- `Cargo.toml` and `shims/unix/{mod,socket}.rs`: `socket2` does not support wasip1, and mio has no UdpSocket on WASI. So on wasi, `tcp_socket` and `udp_socket` are not compiled; a new `shims/unix/wasi_net.rs` provides stubs that always return Unsupported when creating a host socket.
- `shims/{files,os_str}.rs`, `shims/unix/fs.rs`, `shims/windows/foreign_items.rs`: these only had `cfg(unix)` and `cfg(windows)` branches; adds branches that work on wasi.
- `shims/env.rs`: `std::process::id()` panics on wasi, so `getpid` returns a fixed value of 1000.
- `concurrency/blocking_io.rs`: on wasi, mio's `poll` is not called, since there are no host sockets to wait on, and browser_wasi_shim's `poll_oneoff` returns invalid results that cause a panic.

## License

This project is licensed under [MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE-APACHE), the same as the Rust project, since the patch modifies [rust-lang/rust](https://github.com/rust-lang/rust).

- The files in each Release are build artifacts of the Rust project (Miri, rustc and the standard library). They are copyrighted by the Rust project contributors and distributed under MIT OR Apache-2.0; the third-party crates they include are under their own licenses.
- The approach of compiling Miri to WASM and running it in the browser with a WASI shim is based on [LyonSyonII/rubri](https://github.com/LyonSyonII/rubri) (MIT).

See [NOTICE](NOTICE) for details.
