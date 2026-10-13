// Astro bundles EmDash's code into dist/, and the bundle imports EmDash's
// dependencies by bare name from the app root. If another package needs a
// different version of one of them, npm hoists that version to the top level
// and nests EmDash's copy, so the bundle loads the wrong one.
// (Example: the Marketing starter's icon tooling needs modern-tar 0.8 while
// EmDash needs 0.7.)
//
// This adds every dependency that npm had to nest under emdash or
// @emdash-cms/* to package.json with EmDash's version range. Run `npm install`
// afterwards so those versions become the top-level copies. With --check it
// only fails if anything is still nested.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

const owners = ["node_modules/emdash"];
if (existsSync("node_modules/@emdash-cms")) {
	for (const name of readdirSync("node_modules/@emdash-cms")) owners.push(`node_modules/@emdash-cms/${name}`);
}

const check = process.argv.includes("--check");
const root = readJson("package.json");
const nested = {};
for (const dir of owners) {
	const pkg = readJson(join(dir, "package.json"));
	for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
		if (name === "emdash" || name.startsWith("@emdash-cms/")) continue;
		if (!existsSync(join(dir, "node_modules", name, "package.json"))) continue;
		(nested[name] ??= new Set()).add(range);
	}
}

// Several EmDash packages can ask for different ranges of the same package.
// A space-separated list is the intersection of ranges in npm's semver syntax.
// That doesn't work for ranges that contain "||", so those must match exactly.
for (const [name, set] of Object.entries(nested)) {
	const ranges = [...set];
	if (ranges.length > 1 && ranges.some((r) => r.includes("||"))) {
		console.error(`hoist-emdash-deps: ${name} is needed as ${ranges.join(" and ")}`);
		process.exit(1);
	}
	nested[name] = ranges.join(" ");
}

if (Object.keys(nested).length === 0) {
	console.log("hoist-emdash-deps: no conflicts");
	process.exit(0);
}
if (check || Object.keys(nested).every((name) => root.dependencies?.[name])) {
	console.error(`hoist-emdash-deps: still nested after promotion: ${JSON.stringify(nested)}`);
	process.exit(1);
}
root.dependencies = { ...root.dependencies, ...nested };
writeFileSync("package.json", `${JSON.stringify(root, null, 2)}\n`);
console.log(`hoist-emdash-deps: added ${JSON.stringify(nested)}`);
