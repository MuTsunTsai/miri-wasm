// Benchmarks: hello world, a plain loop (tests/bench/loop.rs), and sorting 20,000 numbers.
//
// Usage: node tests/bench.mjs [dist/<tag> directory]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load, resolveDist, run } from "./miri.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const miri = await load(resolveDist(process.argv[2]));
console.log(`${miri.manifest.tag}: brotli decompress ${miri.tDecompress.toFixed(0)} ms, WebAssembly.compile ${miri.tCompile.toFixed(0)} ms`);

function measure(title, code, times, opts) {
	const rs = Array.from({ length: times }, () => run(miri, code, opts));
	const bad = rs.find((r) => r.status !== "ok");
	if (bad) {
		console.log(`${title}: ${bad.status}\n${bad.stderr}`);
		process.exit(1);
	}
	console.log(`${title}: ${rs.map((r) => `${r.ms.toFixed(0)} ms`).join(", ")}  output ${rs[0].stdout.trim()}`);
}

const HELLO = `fn main() {\n    println!("Hello, world!");\n}\n`;
const SORT = `fn main() {\n    let mut v: Vec<u64> = (0..20000).map(|i| (i * 7919) % 10007).collect();\n    v.sort();\n    let s: u64 = v.iter().sum();\n    println!("{s}");\n}\n`;

measure("hello world", HELLO, 6);
measure("hello world (strict)", HELLO, 2, { strict: true });
const LOOP = fs.readFileSync(path.join(here, "bench", "loop.rs"), "utf8");
measure("Plain loop, 300,000 iterations", LOOP, 3);
measure("Plain loop, 300,000 iterations (-Zmir-opt-level=3)", LOOP, 3, { extra: ["-Zmir-opt-level=3"] });
measure("Sorting 20,000 numbers", SORT, 2);
