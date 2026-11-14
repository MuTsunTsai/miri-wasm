// Erases the builder's home directory path from miri.wasm.
//
// The miri.wasm built from nightly-2026-11-13 has no path remapping, so panic location strings from
// dependency crates contain /home/<user>/.cargo/registry/src/... This script replaces the user name with
// the same number of "x" characters, e.g. /home/alice/.cargo → /home/xxxxx/.cargo.
//
// Only same-length byte replacements are made: wasm data segments store their lengths separately, and so do
// Rust &str values, so keeping the length unchanged does not break anything. After replacing, the result is
// verified to still be a valid module with WebAssembly.compile.
//
// A miri.wasm rebuilt with rust.remap-debuginfo in build/bootstrap.toml and RUSTFLAGS_NOT_BOOTSTRAP in build.sh
// contains no home directory, so this step is not needed (the script reports that there is nothing to replace).
//
// Usage: node scripts/scrub-paths.mjs [path to miri.wasm, default out/miri.wasm]
//   Overwrites the file in place; safe to run repeatedly.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.resolve(process.argv[2] ?? path.join(root, "out", "miri.wasm"));

const buf = fs.readFileSync(file);
// latin1 maps each byte to one character, so string indices equal byte offsets
const text = buf.toString("latin1");

// /home/<user>/.cargo/ or /home/<user>/.rustup/
const pattern = /\/home\/([A-Za-z0-9._-]+)\/\.(cargo|rustup)\//g;
const users = new Map();
let count = 0;
for (const m of text.matchAll(pattern)) {
	const user = m[1];
	if (/^x+$/.test(user)) continue; // already replaced
	const start = m.index + "/home/".length;
	buf.fill("x".charCodeAt(0), start, start + user.length);
	users.set(user, (users.get(user) ?? 0) + 1);
	count++;
}

if (!count) {
	console.log(`${file}: no /home/<user>/.cargo or .rustup paths found, nothing to do`);
	process.exit(0);
}

// Make sure the result is still a valid wasm module
await WebAssembly.compile(buf);

// Make sure the user names are completely gone (including occurrences outside the paths above)
const after = buf.toString("latin1");
const remaining = [...users.keys()].filter((u) => after.includes(u));
if (remaining.length) {
	console.error(`Still present after replacement: ${remaining.join(", ")} (outside /home/<user>/.cargo paths; please check manually)`);
	process.exit(1);
}

fs.writeFileSync(file, buf);
for (const [user, n] of users) console.log(`/home/${user}/ → /home/${"x".repeat(user.length)}/: ${n} occurrences`);
console.log(`Wrote ${file} (size unchanged: ${buf.length} bytes, WebAssembly.compile passed)`);
