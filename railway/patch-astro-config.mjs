// Rewrites an EmDash Node template's astro.config.mjs for Railway:
//   - SQLite file  -> PostgreSQL (connection details come from PG* variables
//     at runtime, see docker-entrypoint.sh)
//   - ./uploads    -> /data/uploads on the volume
//   - sessions     -> /data/sessions on the volume, so logins survive redeploys
//
// EmDash serializes the database config into the build, so a connection string
// must not appear here. pg reads PGHOST, PGUSER and so on when the pool opens.
//
// Every replacement must match exactly once. If a template changes shape the
// build fails here instead of producing a site that silently uses SQLite.
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
	console.error("usage: node patch-astro-config.mjs <astro.config.mjs>");
	process.exit(1);
}

let source = readFileSync(file, "utf8");

const replacements = [
	{
		name: "database import",
		pattern: /import \{ sqlite \} from "emdash\/db";/g,
		replacement: 'import { postgres } from "emdash/db";\nimport { sessionDrivers } from "astro/config";',
	},
	{
		name: "database adapter",
		pattern: /database: sqlite\(\{[^}]*\}\),/g,
		replacement:
			"database: postgres({ pool: { max: 10, connectionTimeoutMillis: 10_000 } }),",
	},
	{
		name: "uploads directory",
		pattern: /directory: "\.\/uploads",/g,
		replacement: 'directory: "/data/uploads",',
	},
	{
		name: "session driver",
		pattern: /export default defineConfig\(\{/g,
		replacement:
			'export default defineConfig({\n\tsession: { driver: sessionDrivers.fsLite({ base: "/data/sessions" }) },',
	},
];

for (const { name, pattern, replacement } of replacements) {
	const matches = source.match(pattern) ?? [];
	if (matches.length !== 1) {
		console.error(`patch-astro-config: expected one match for ${name}, found ${matches.length}`);
		console.error(source);
		process.exit(1);
	}
	source = source.replace(pattern, replacement);
}

writeFileSync(file, source);
console.log(source);
