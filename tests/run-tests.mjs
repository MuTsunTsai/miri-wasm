// Functional tests: read the packed output in dist/<tag>/ directly to make sure the Release files work.
//
// Usage: node tests/run-tests.mjs [dist/<tag> directory] [--verbose]
//   Without a directory, the latest tag under dist/ is used. --verbose prints the output of each test.

import { load, resolveDist, run } from "./miri.mjs";

const dir = resolveDist(process.argv.slice(2).find((a) => !a.startsWith("--")));
const miri = await load(dir);
console.log(`${miri.manifest.tag} (${miri.manifest.rustc}), ${miri.manifest.files.length} files, all sha256 match`);
console.log(`Load: brotli decompress ${miri.tDecompress.toFixed(0)} ms, WebAssembly.compile ${miri.tCompile.toFixed(0)} ms`);

const GEN = `fn main() {\n    let gen = 1;\n    println!("{gen}");\n}\n`;
const RPIT = `fn evens(v: &Vec<i32>) -> impl Iterator<Item = i32> {\n    v.iter().copied().filter(|x| x % 2 == 0)\n}\n\nfn main() {\n    let v = vec![1, 2, 3, 4];\n    println!("{:?}", evens(&v).collect::<Vec<_>>());\n}\n`;

const cases = [
	["hello world", `fn main() {\n    println!("Hello, world!");\n}\n`, {},
		(r) => r.status === "ok" && r.stdout === "Hello, world!\n"],
	["`gen` as an identifier (allowed in 2021)", GEN, { edition: "2021" },
		(r) => r.status === "ok" && r.stdout === "1\n"],
	["`gen` as an identifier (reserved in 2024, should fail)", GEN, { edition: "2024" },
		(r) => r.status === "compile-error" && /reserved keyword|expected identifier/.test(r.stderr)],
	["RPIT captures lifetimes automatically (should fail in 2021)", RPIT, { edition: "2021" },
		(r) => r.status === "compile-error"],
	["RPIT captures lifetimes automatically (allowed in 2024)", RPIT, { edition: "2024" },
		(r) => r.status === "ok" && r.stdout === "[2, 4]\n"],
	["Compile error (E0308 mismatched types)", `fn main() {\n    let x: i32 = "hello";\n    println!("{x}");\n}\n`, {},
		(r) => r.status === "compile-error" && /^error\[E0308\]: mismatched types/m.test(r.stderr)],
	["panic (index out of bounds)", `fn main() {\n    let v = vec![1, 2, 3];\n    let i = v.len() + 2;\n    println!("before");\n    println!("{}", v[i]);\n}\n`, {},
		(r) => r.status === "runtime-error" && /thread 'main' \(\d+\) panicked at/.test(r.stderr) && r.stdout === "before\n"],
	["LazyLock", `use std::collections::HashMap;\nuse std::sync::LazyLock;\n\nstatic MAP: LazyLock<HashMap<&str, i32>> = LazyLock::new(|| {\n    println!("init");\n    HashMap::from([("a", 1), ("b", 2)])\n});\n\nfn main() {\n    println!("{}", MAP["a"] + MAP["b"]);\n}\n`, {},
		(r) => r.status === "ok" && r.stdout === "init\n3\n"],
	["let chains (edition 2024)", `fn main() {\n    let v = Some(3);\n    if let Some(x) = v && x > 2 {\n        println!("big {x}");\n    }\n}\n`, {},
		(r) => r.status === "ok" && r.stdout === "big 3\n"],
	["Strict mode detects UB (dangling pointer)", `fn main() {\n    let p = {\n        let x = 5;\n        &x as *const i32\n    };\n    println!("{}", unsafe { *p });\n}\n`, { strict: true },
		(r) => r.status === "runtime-error" && /Undefined Behavior/.test(r.stderr)],
	["Removed flag -Zmir-emit-retag=false should be rejected", `fn main() {}\n`, { extra: ["-Zmir-emit-retag=false"] },
		(r) => r.status === "compile-error" && /unknown unstable option/.test(r.stderr)],
];

const indent = (s) => s.replace(/\n$/, "").replace(/^/gm, "    │ ");
let failed = 0;
for (const [title, code, o, ok] of cases) {
	const r = run(miri, code, o);
	const pass = ok(r);
	if (!pass) failed++;
	console.log(`\n${pass ? "✓" : "✗"} ${title}: ${r.status} (exit ${r.exitCode}${r.trap ? `, trap: ${r.trap}` : ""}, ${r.ms.toFixed(0)} ms)`);
	if (!pass || process.argv.includes("--verbose")) {
		if (r.stdout) console.log(indent(r.stdout));
		if (r.stderr) console.log(indent(r.stderr));
	}
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
