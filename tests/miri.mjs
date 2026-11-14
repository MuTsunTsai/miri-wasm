// Loads the packed output in dist/<tag>/ and runs Miri with @bjorn3/browser_wasi_shim (same as in the browser, no threads).
// This mirrors how a downstream consumer (e.g. https://github.com/mutsuntsai/learn-rust) runs Miri in a Web Worker.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { ConsoleStdout, Directory, File, OpenFile, PreopenDirectory, WASI } from "@bjorn3/browser_wasi_shim";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Speed-up flags: disable most UB checks so ordinary programs run faster */
export const FAST_FLAGS = [
	"-Zmiri-permissive-provenance",
	"-Zmiri-preemption-rate=0",
	"-Zmiri-disable-alignment-check",
	"-Zmiri-disable-data-race-detector",
	"-Zmiri-disable-stacked-borrows",
	"-Zmiri-disable-validation",
];

/** The given directory, or the latest tag under dist/ (tags are dates, so string sorting works) */
export function resolveDist(dir) {
	if (dir) return path.resolve(dir);
	const distRoot = path.join(root, "dist");
	const tags = fs.existsSync(distRoot) ? fs.readdirSync(distRoot).filter((d) => fs.existsSync(path.join(distRoot, d, "manifest.json"))).sort() : [];
	if (!tags.length) throw new Error("No packed output under dist/; run pnpm run pack first");
	return path.join(distRoot, tags.at(-1));
}

/** Reads the manifest, verifies the size and sha256 of every file, decompresses them and compiles miri.wasm */
export async function load(dir) {
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
	if (manifest.format !== 2) throw new Error(`Unsupported manifest format: ${manifest.format}`);
	let t0 = performance.now();
	let miriBytes;
	const libs = new Map();
	for (const f of manifest.files) {
		if (f.path.includes("/") || f.path.includes("\\")) throw new Error(`Files must not be in subdirectories: ${f.path}`);
		const compressed = fs.readFileSync(path.join(dir, f.path));
		if (compressed.length !== f.size) throw new Error(`${f.path} size mismatch: ${compressed.length} ≠ ${f.size}`);
		const hash = crypto.createHash("sha256").update(compressed).digest("hex");
		if (hash !== f.sha256) throw new Error(`${f.path} sha256 mismatch`);
		const raw = zlib.brotliDecompressSync(compressed);
		if (raw.length !== f.rawSize) throw new Error(`${f.path} decompressed size mismatch: ${raw.length} ≠ ${f.rawSize}`);
		if (f.kind === "miri") miriBytes = raw;
		else libs.set(f.name, new File(raw, { readonly: true }));
	}
	const tDecompress = performance.now() - t0;
	t0 = performance.now();
	const module = await WebAssembly.compile(miriBytes);
	const tCompile = performance.now() - t0;
	return { manifest, module, libs, tDecompress, tCompile };
}

/**
 * Runs a Rust program.
 * When strict is true, FAST_FLAGS are not added, so UB can be detected.
 */
export function run({ module, libs }, code, { edition = "2024", strict = false, flags = FAST_FLAGS, extra = [] } = {}) {
	let stdout = "";
	let stderr = "";
	const dec = { out: new TextDecoder(), err: new TextDecoder() };
	const sysroot = new PreopenDirectory("/sysroot", new Map([
		["lib", new Directory(new Map([
			["rustlib", new Directory(new Map([
				["x86_64-unknown-linux-gnu", new Directory(new Map([["lib", new Directory(libs)]]))],
			]))],
		]))],
	]));
	const fds = [
		new OpenFile(new File(new Uint8Array())),
		new ConsoleStdout((b) => { stdout += dec.out.decode(b, { stream: true }); }),
		new ConsoleStdout((b) => { stderr += dec.err.decode(b, { stream: true }); }),
		new PreopenDirectory("/tmp", new Map()),
		sysroot,
		new PreopenDirectory("/", new Map([["main.rs", new File(new TextEncoder().encode(code))]])),
	];
	const args = [
		"miri", "--sysroot", "/sysroot", "main.rs",
		"--target", "x86_64-unknown-linux-gnu",
		"--edition", edition,
		"-Cpanic=abort",
		"-Zmiri-ignore-leaks",
		"-Zmiri-disable-isolation",
		...(strict ? [] : flags),
		...extra,
		"--color=never",
	];
	// RUSTC_ICE=0: at startup rustc calls std::process::id() to name the ICE report file, which panics on wasip1
	const wasi = new WASI(args, ["RUST_BACKTRACE=0", "RUSTC_ICE=0"], fds, { debug: false });
	let exitCode = -1;
	let trap = null;
	const start = performance.now();
	try {
		exitCode = wasi.start(new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi.wasiImport }));
	} catch (err) {
		if (err instanceof WebAssembly.RuntimeError) trap = err.message;
		else stderr += `\n[internal error] ${err.message}\n`;
	}
	const ms = performance.now() - start;
	const marker = stderr.search(/^error: abnormal termination: the program aborted execution/m);
	if (marker >= 0) stderr = stderr.slice(0, marker).trimEnd() + "\n";
	// On a compile error rustc traps before printing "aborting due to", so look for lines starting with error instead
	let status;
	if (exitCode !== 0 && /^error(\[E\d+\])?:/m.test(stderr) && !/panicked at/.test(stderr) && !/Undefined Behavior/.test(stderr)) status = "compile-error";
	else if (exitCode === 0) status = "ok";
	else status = "runtime-error";
	return { status, exitCode, trap, stdout, stderr, ms };
}
