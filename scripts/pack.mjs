// Packs the output of build.sh (miri.wasm and the sysroot) into the files uploaded to a GitHub Release.
//
// Steps:
//   1. Pick only the crates needed to run std programs (CRATES); test, getopts, proc_macro etc. are excluded
//   2. A .rlib is an ar archive; keep only its lib.rmeta member (all .o machine code is stripped). .rmeta is kept as-is
//   3. Compress each file with brotli (quality 11, lgwin 24) and append .bin to its name
//      (so static servers do not add Content-Encoding on their own when they see a .br extension)
//   4. Write manifest.json and NOTICE.txt
//
// All output sits flat in dist/<tag>/ with no subdirectories: GitHub Release assets cannot have subdirectories.
//
// Usage: node scripts/pack.mjs [--miri <miri.wasm>] [--lib <rustlib lib dir of the sysroot>] [--tag <tag>] [--rustc <output of rustc -V>]
//   Defaults to out/miri.wasm and out/sysroot/lib/rustlib/x86_64-unknown-linux-gnu/lib;
//   tag and rustc default to the values in out/build-info.json (written by build.sh).
//
//        node scripts/pack.mjs --notice-only [--tag <tag>]
//   Only rewrites NOTICE.txt in an existing dist/<tag>/, taking tag and rustc from its manifest.json.
//   The .bin files and manifest.json are left untouched.

// brotli compression runs in the libuv thread pool, which has only 4 threads by default
process.env.UV_THREADPOOL_SIZE ??= "16";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import zlib from "node:zlib";

const brotliCompress = promisify(zlib.brotliCompress);

/** Manifest format version; bumped on incompatible changes */
const FORMAT = 2;
const TARGET = "x86_64-unknown-linux-gnu";
const SOURCE = "https://github.com/mutsuntsai/miri-wasm";

/** Crates needed to run std programs (excluding test, getopts, proc_macro, rustc_literal_escaper etc.) */
const CRATES = [
	"addr2line", "adler2", "alloc", "cfg_if", "compiler_builtins", "core", "gimli",
	"hashbrown", "libc", "memchr", "miniz_oxide", "object", "panic_abort", "panic_unwind",
	"rustc_demangle", "rustc_std_workspace_alloc", "rustc_std_workspace_core", "std",
	"std_detect", "sysroot", "unwind",
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "out");

const { values: opts } = parseArgs({
	options: {
		miri: { type: "string", default: path.join(outDir, "miri.wasm") },
		lib: { type: "string", default: path.join(outDir, "sysroot", "lib", "rustlib", TARGET, "lib") },
		tag: { type: "string" },
		rustc: { type: "string" },
		"notice-only": { type: "boolean", default: false },
	},
});

/** Writes NOTICE.txt into distDir */
function writeNotice(distDir, tag, rustc) {
	fs.writeFileSync(path.join(distDir, "NOTICE.txt"), [
		`miri-wasm ${tag} (${rustc})`,
		SOURCE,
		"",
		"The files in this Release are build artifacts of the Rust project (https://github.com/rust-lang/rust, MIT OR Apache-2.0):",
		"  - miri.wasm: Miri and the rustc compiler, compiled to wasm32-wasip1 with the miri-wasm patch applied.",
		`  - All other files: the Rust standard library (${TARGET}, built with cargo miri setup). Only the lib.rmeta member of each rlib is kept.`,
		"Every file is brotli-compressed and has a .bin extension.",
		"",
		"These artifacts are distributed under MIT OR Apache-2.0, the same as the Rust project.",
		"They include third-party crates that Rust depends on; see the license files of each crate in the rust-lang/rust source tree.",
		"The approach is based on LyonSyonII/rubri (https://github.com/LyonSyonII/rubri, MIT License).",
		"",
	].join("\n"));
}

const infoPath = path.join(outDir, "build-info.json");
const info = fs.existsSync(infoPath) ? JSON.parse(fs.readFileSync(infoPath, "utf8")) : {};

if (opts["notice-only"]) {
	const noticeTag = opts.tag ?? info.tag;
	if (!noticeTag) {
		console.error("Missing tag: specify it with --tag, or run build.sh to generate out/build-info.json");
		process.exit(1);
	}
	const distDir = path.join(root, "dist", noticeTag);
	const manifestPath = path.join(distDir, "manifest.json");
	if (!fs.existsSync(manifestPath)) {
		console.error(`No manifest.json found in ${distDir}; run pnpm run pack first`);
		process.exit(1);
	}
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	writeNotice(distDir, manifest.tag, manifest.rustc);
	console.log(`Wrote ${path.join(distDir, "NOTICE.txt")}`);
	process.exit(0);
}

const tag = opts.tag ?? info.tag;
const rustc = opts.rustc ?? info.rustc;
if (!tag || !rustc) {
	console.error("Missing tag or rustc version: run build.sh to generate out/build-info.json, or specify --tag and --rustc");
	process.exit(1);
}
if (!/^nightly-\d{4}-\d{2}-\d{2}$/.test(tag)) {
	console.error(`Tag must be in the form nightly-YYYY-MM-DD: ${tag}`);
	process.exit(1);
}

/** Keeps only the lib.rmeta member of an ar archive */
function stripRlib(buf) {
	const magic = buf.subarray(0, 8).toString("latin1");
	if (magic !== "!<arch>\n") throw new Error("Not an ar archive");
	const parts = [buf.subarray(0, 8)];
	let off = 8;
	let found = false;
	while (off < buf.length) {
		const header = buf.subarray(off, off + 60);
		const name = header.subarray(0, 16).toString("latin1").trim();
		const size = parseInt(header.subarray(48, 58).toString("latin1").trim(), 10);
		if (name.startsWith("lib.rmeta")) {
			found = true;
			parts.push(header, buf.subarray(off + 60, off + 60 + size));
			if (size % 2) parts.push(Buffer.from("\n"));
		}
		off += 60 + size + (size % 2);
	}
	if (!found) throw new Error("No lib.rmeta found in rlib");
	return Buffer.concat(parts);
}

function compress(buf) {
	return brotliCompress(buf, {
		params: {
			[zlib.constants.BROTLI_PARAM_QUALITY]: 11,
			[zlib.constants.BROTLI_PARAM_LGWIN]: 24,
			[zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
		},
	});
}

// Recent cargo-miri builds the sysroot with -Zembed-metadata=no: the rlib only holds a small lib.rmeta
// pointing elsewhere, and the real metadata (including MIR) is in the .rmeta file of the same name.
// Both must go into the sysroot.
const libFiles = fs.readdirSync(opts.lib).filter((f) => {
	const m = /^lib(.+)-[0-9a-f]+\.(rlib|rmeta)$/.exec(f);
	return m && CRATES.includes(m[1]);
}).sort();
const missing = CRATES.filter((c) => !libFiles.some((f) => f.startsWith(`lib${c}-`)));
if (missing.length) {
	console.error(`These crates were not found in the sysroot: ${missing.join(", ")}`);
	process.exit(1);
}
for (const c of CRATES) {
	const n = libFiles.filter((f) => f.startsWith(`lib${c}-`)).length;
	if (n !== 2) {
		console.error(`Crate ${c} should have exactly one .rlib and one .rmeta, but has ${n} files`);
		process.exit(1);
	}
}

const distDir = path.join(root, "dist", tag);
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

const started = Date.now();
const sources = [
	{ src: opts.miri, kind: "miri", name: "miri.wasm" },
	...libFiles.map((f) => ({ src: path.join(opts.lib, f), kind: f.endsWith(".rlib") ? "rlib" : "rmeta", name: f })),
];
const files = await Promise.all(sources.map(async ({ src, kind, name }) => {
	const raw = fs.readFileSync(src);
	const data = kind === "rlib" ? stripRlib(raw) : raw;
	const compressed = await compress(data);
	const outName = `${name}.bin`;
	fs.writeFileSync(path.join(distDir, outName), compressed);
	return {
		kind,
		name,
		path: outName,
		size: compressed.length,
		rawSize: data.length,
		sha256: crypto.createHash("sha256").update(compressed).digest("hex"),
		origSize: raw.length,
	};
}));

const manifest = {
	format: FORMAT,
	tag,
	rustc,
	target: TARGET,
	source: SOURCE,
	files: files.map(({ origSize, ...f }) => f),
};
fs.writeFileSync(path.join(distDir, "manifest.json"), JSON.stringify(manifest, null, "\t") + "\n");
writeNotice(distDir, tag, rustc);

const mb = (n) => (n / 1e6).toFixed(2);
for (const f of files) console.log(`${f.path.padEnd(56)} raw ${mb(f.origSize).padStart(7)} MB → stripped ${mb(f.rawSize).padStart(7)} MB → br ${mb(f.size).padStart(6)} MB`);
const sum = (k, pred = () => true) => files.filter(pred).reduce((s, f) => s + f[k], 0);
const isLib = (f) => f.kind !== "miri";
console.log(`\nmiri.wasm: ${mb(sum("rawSize", (f) => f.kind === "miri"))} MB → br ${mb(sum("size", (f) => f.kind === "miri"))} MB`);
console.log(`sysroot (${CRATES.length} crates, ${libFiles.length} files): raw ${mb(sum("origSize", isLib))} MB → stripped ${mb(sum("rawSize", isLib))} MB → br ${mb(sum("size", isLib))} MB`);
console.log(`Total (br): ${mb(sum("size"))} MB, ${files.length + 2} files (including manifest.json and NOTICE.txt), took ${((Date.now() - started) / 1000).toFixed(0)} s`);
console.log(`Output: ${distDir}`);
