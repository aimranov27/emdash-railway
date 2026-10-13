/**
 * Setup password gate, added by the Railway template.
 *
 * EmDash lets whoever opens /_emdash/admin/setup first create the admin
 * account. On a public Railway URL that is a takeover risk, so when
 * EMDASH_SETUP_PASSWORD is set the setup wizard and its API need that
 * password. The browser asks for it with a standard sign-in prompt (any
 * username). A cookie scoped to /_emdash/ then carries the proof to the
 * wizard's API calls.
 *
 * The status endpoint stays open because the login page reads it. Once the
 * admin exists EmDash refuses every setup call on its own, so the gate is
 * only a second lock after that.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { defineMiddleware } from "astro:middleware";

const COOKIE = "emdash_railway_setup";
const SETUP_PAGE = "/_emdash/admin/setup";
const SETUP_API = "/_emdash/api/setup";
const OPEN_PATHS = new Set(["/_emdash/api/setup/status"]);

function proof(password: string): string {
	return createHash("sha256").update(`emdash-railway-setup:${password}`).digest("hex");
}

function sameText(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

function under(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

function passwordFromBasicAuth(header: string | null): string | null {
	if (!header || !header.toLowerCase().startsWith("basic ")) return null;
	const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
	const colon = decoded.indexOf(":");
	return colon === -1 ? null : decoded.slice(colon + 1);
}

const LOCKED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Setup is locked</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#222}code{background:#f2f2f2;padding:.1rem .3rem;border-radius:3px}</style>
</head><body>
<h1>Setup is locked</h1>
<p>This EmDash site has not been set up yet. To create the admin account, reload this page and sign in with:</p>
<ul><li>Username: anything, for example <code>admin</code></li>
<li>Password: the value of <code>EMDASH_SETUP_PASSWORD</code> in your Railway service's <strong>Variables</strong> tab</li></ul>
</body></html>`;

export const onRequest = defineMiddleware((context, next) => {
	const password = process.env.EMDASH_SETUP_PASSWORD;
	if (!password) return next();

	const path = context.url.pathname.replace(/\/+$/, "") || "/";
	const gated =
		!OPEN_PATHS.has(path) && (under(path, SETUP_PAGE) || under(path, SETUP_API));
	if (!gated) return next();

	const expected = proof(password);
	const cookie = context.cookies.get(COOKIE)?.value;
	if (cookie && sameText(cookie, expected)) return next();

	const given = passwordFromBasicAuth(context.request.headers.get("authorization"));
	if (given !== null && sameText(proof(given), expected)) {
		const siteUrl = process.env.EMDASH_SITE_URL || process.env.SITE_URL || "";
		context.cookies.set(COOKIE, expected, {
			path: "/_emdash/",
			httpOnly: true,
			sameSite: "strict",
			secure: siteUrl.startsWith("https:"),
			maxAge: 60 * 60 * 12,
		});
		return next();
	}

	if (under(path, SETUP_API)) {
		return new Response(
			JSON.stringify({
				error: {
					code: "SETUP_LOCKED",
					message: "Open /_emdash/admin/setup and enter EMDASH_SETUP_PASSWORD first.",
				},
			}),
			{ status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" } },
		);
	}

	return new Response(LOCKED_PAGE, {
		status: 401,
		headers: {
			"www-authenticate": 'Basic realm="EmDash setup", charset="UTF-8"',
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		},
	});
});
