// HTTP client for scripts/smoke-test.sh. Drives a running EmDash site the way
// a browser would, using a software passkey (WebAuthn "none" attestation,
// ES256) so admin login can be tested without a real authenticator.
//
//   node smoke-client.mjs setup   <state.json>   gate checks, setup wizard, first admin
//   node smoke-client.mjs write   <state.json>   passkey login, create and publish a post, upload media
//   node smoke-client.mjs verify  <state.json>   after a restart: session, post and media are still there
//
// Needs Node 20 or later. Uses only built-in modules.
import { createHash, generateKeyPairSync, randomBytes, sign, createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SITE = (process.env.SITE_URL ?? "").replace(/\/$/, "");
const SETUP_PASSWORD = process.env.EMDASH_SETUP_PASSWORD ?? "";
const COLLECTION = process.env.SMOKE_COLLECTION ?? "posts";
// URL prefix where entries of COLLECTION are rendered, or "none" if the
// starter has no route for them.
const PUBLIC_PREFIX = process.env.SMOKE_PUBLIC_PREFIX ?? `/${COLLECTION}`;
const TEMPLATE = process.env.EMDASH_TEMPLATE ?? "blog";
const [phase, stateFile] = process.argv.slice(2);

if (!SITE || !phase || !stateFile) {
	console.error("usage: SITE_URL=... EMDASH_SETUP_PASSWORD=... node smoke-client.mjs <setup|write|verify> <state.json>");
	process.exit(2);
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (data) => createHash("sha256").update(data).digest();
const rpId = new URL(SITE).hostname;

function fail(message, extra) {
	console.error(`FAIL: ${message}`);
	if (extra !== undefined) console.error(typeof extra === "string" ? extra : JSON.stringify(extra, null, 2));
	process.exit(1);
}

function ok(message) {
	console.log(`  ok  ${message}`);
}

function expect(condition, message, extra) {
	if (!condition) fail(message, extra);
	ok(message);
}

// ---- Cookie-aware fetch -----------------------------------------------------

class Jar {
	constructor(cookies = {}) {
		this.cookies = { ...cookies };
	}
	header() {
		return Object.entries(this.cookies)
			.map(([k, v]) => `${k}=${v}`)
			.join("; ");
	}
	store(res) {
		for (const line of res.headers.getSetCookie()) {
			const [pair, ...attrs] = line.split(";");
			const eq = pair.indexOf("=");
			const name = pair.slice(0, eq).trim();
			const value = pair.slice(eq + 1).trim();
			const expired = attrs.some((a) => {
				const [k, v] = a.trim().split("=");
				if (k.toLowerCase() === "max-age") return Number(v) <= 0;
				if (k.toLowerCase() === "expires") return new Date(v).getTime() < Date.now();
				return false;
			});
			if (expired || value === "") delete this.cookies[name];
			else this.cookies[name] = value;
		}
	}
}

async function request(jar, method, path, { json, form, headers = {} } = {}) {
	const h = { Origin: SITE, "X-EmDash-Request": "1", ...headers };
	const cookie = jar?.header();
	if (cookie) h.Cookie = cookie;
	let body;
	if (json !== undefined) {
		h["Content-Type"] = "application/json";
		body = JSON.stringify(json);
	} else if (form !== undefined) {
		body = form;
	}
	const res = await fetch(`${SITE}${path}`, { method, headers: h, body, redirect: "manual" });
	jar?.store(res);
	const buffer = Buffer.from(await res.arrayBuffer());
	let data;
	try {
		data = JSON.parse(buffer.toString("utf8"));
	} catch {
		data = undefined;
	}
	return { status: res.status, headers: res.headers, buffer, text: buffer.toString("utf8"), data };
}

const basic = (password) => ({
	Authorization: `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`,
});

// ---- Minimal CBOR encoder (enough for WebAuthn attestation objects) ----------

function cborHead(major, n) {
	if (n < 24) return Buffer.from([(major << 5) | n]);
	if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
	if (n < 0x10000) {
		const b = Buffer.alloc(3);
		b[0] = (major << 5) | 25;
		b.writeUInt16BE(n, 1);
		return b;
	}
	const b = Buffer.alloc(5);
	b[0] = (major << 5) | 26;
	b.writeUInt32BE(n, 1);
	return b;
}

function cbor(value) {
	if (typeof value === "number") return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
	if (typeof value === "string") {
		const s = Buffer.from(value, "utf8");
		return Buffer.concat([cborHead(3, s.length), s]);
	}
	if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), Buffer.from(value)]);
	if (value instanceof Map) {
		const parts = [cborHead(5, value.size)];
		for (const [k, v] of value) parts.push(cbor(k), cbor(v));
		return Buffer.concat(parts);
	}
	throw new Error(`cbor: unsupported value ${value}`);
}

// ---- Software authenticator --------------------------------------------------

function createCredential(options) {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const jwk = publicKey.export({ format: "jwk" });
	const credentialId = randomBytes(16);
	const coseKey = cbor(
		new Map([
			[1, 2], // kty: EC2
			[3, -7], // alg: ES256
			[-1, 1], // crv: P-256
			[-2, Buffer.from(jwk.x, "base64url")],
			[-3, Buffer.from(jwk.y, "base64url")],
		]),
	);
	const idLength = Buffer.alloc(2);
	idLength.writeUInt16BE(credentialId.length);
	const authData = Buffer.concat([
		sha256(options.rp?.id ?? rpId),
		Buffer.from([0x45]), // user present, user verified, attested credential data
		Buffer.alloc(4), // sign count 0
		Buffer.alloc(16), // AAGUID
		idLength,
		credentialId,
		coseKey,
	]);
	const attestationObject = cbor(
		new Map([
			["fmt", "none"],
			["attStmt", new Map()],
			["authData", authData],
		]),
	);
	const clientDataJSON = Buffer.from(
		JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: SITE, crossOrigin: false }),
	);
	return {
		credential: {
			id: b64url(credentialId),
			rawId: b64url(credentialId),
			type: "public-key",
			response: {
				clientDataJSON: b64url(clientDataJSON),
				attestationObject: b64url(attestationObject),
				transports: ["internal"],
			},
			authenticatorAttachment: "platform",
		},
		saved: {
			credentialId: b64url(credentialId),
			privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
			counter: 0,
		},
	};
}

function getAssertion(options, saved) {
	saved.counter += 1;
	const counter = Buffer.alloc(4);
	counter.writeUInt32BE(saved.counter);
	const authenticatorData = Buffer.concat([sha256(options.rpId ?? rpId), Buffer.from([0x05]), counter]);
	const clientDataJSON = Buffer.from(
		JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: SITE, crossOrigin: false }),
	);
	const signature = sign(
		"sha256",
		Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
		createPrivateKey(saved.privateKeyPem),
	);
	return {
		id: saved.credentialId,
		rawId: saved.credentialId,
		type: "public-key",
		response: {
			clientDataJSON: b64url(clientDataJSON),
			authenticatorData: b64url(authenticatorData),
			signature: b64url(signature),
		},
		authenticatorAttachment: "platform",
	};
}

async function passkeyLogin(state, label) {
	const jar = new Jar();
	const opts = await request(jar, "POST", "/_emdash/api/auth/passkey/options", { json: {} });
	if (opts.status !== 200) fail(`${label}: passkey options returned ${opts.status}`, opts.text);
	const assertion = getAssertion(opts.data.data.options, state.passkey);
	const verify = await request(jar, "POST", "/_emdash/api/auth/passkey/verify", {
		json: { credential: assertion },
	});
	expect(verify.status === 200, `${label}: admin signs in with the passkey`, verify.text);
	expect(jar.cookies["astro-session"], `${label}: a session cookie is set`);
	return jar;
}

// A valid 1x1 PNG with random content so every run uploads different bytes.
function samplePng() {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buf) => {
		let c = 0xffffffff;
		for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([len, body, sum]);
	};
	const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
	// One RGBA pixel in a random colour, after the scanline filter byte.
	const idat = deflateSync(Buffer.concat([Buffer.from([0]), randomBytes(3), Buffer.from([255])]));
	return Buffer.concat([
		Buffer.from("89504e470d0a1a0a", "hex"),
		chunk("IHDR", ihdr),
		chunk("tEXt", Buffer.from(`Comment\0railway-smoke-${randomBytes(8).toString("hex")}`)),
		chunk("IDAT", idat),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// ---- Phases -------------------------------------------------------------------

async function setupPhase() {
	const state = {};
	const anon = new Jar();

	let r = await request(anon, "GET", "/_emdash/api/setup/status");
	expect(r.status === 200 && r.data?.data?.needsSetup === true, "fresh site reports that setup is needed", r.text);

	r = await request(anon, "GET", "/_emdash/admin/setup");
	expect(r.status === 401, "setup wizard is locked without the setup password", `HTTP ${r.status}`);
	r = await request(anon, "GET", "/_emdash/admin/setup", { headers: basic("wrong-password") });
	expect(r.status === 401, "setup wizard rejects a wrong setup password", `HTTP ${r.status}`);
	r = await request(anon, "POST", "/_emdash/api/setup", {
		json: { title: "Hijacked", includeContent: false },
	});
	expect(r.status === 401, "setup API is locked without the setup password", r.text);
	r = await request(anon, "POST", "/_emdash/api/setup/admin", { json: { email: "intruder@example.com" } });
	expect(r.status === 401, "admin creation is locked without the setup password", r.text);

	const owner = new Jar();
	r = await request(owner, "GET", "/_emdash/admin/setup", { headers: basic(SETUP_PASSWORD) });
	expect(r.status === 200 && /<html/i.test(r.text), "setup wizard opens with the setup password", `HTTP ${r.status}`);
	expect(owner.cookies.emdash_railway_setup, "setup password cookie is set for the wizard");

	for (let i = 0; ; i++) {
		r = await request(owner, "POST", "/_emdash/api/setup", {
			json: { title: "Railway Smoke Test", tagline: "Checked by scripts/smoke-test.sh", includeContent: false },
		});
		if (r.status !== 200) fail("setup step 1 (site details) failed", r.text);
		if (r.data.data.seedComplete) break;
		if (i > 30) fail("seed did not complete", r.text);
	}
	ok("setup step 1 (site details) completed");

	r = await request(owner, "POST", "/_emdash/api/setup/admin", {
		json: { email: "admin@example.com", name: "Smoke Admin" },
	});
	if (r.status !== 200) fail("setup step 2 (admin details) failed", r.text);
	const { credential, saved } = createCredential(r.data.data.options);
	r = await request(owner, "POST", "/_emdash/api/setup/admin/verify", { json: { credential } });
	expect(r.status === 200 && r.data?.data?.user?.role === 50, "first admin is created with a passkey", r.text);
	state.passkey = saved;

	r = await request(new Jar(), "GET", "/_emdash/api/setup/status");
	expect(r.data?.data?.needsSetup === false, "site reports setup as complete", r.text);

	// Even with the setup password, a second admin cannot be created.
	const late = new Jar();
	await request(late, "GET", "/_emdash/admin/setup", { headers: basic(SETUP_PASSWORD) });
	r = await request(late, "POST", "/_emdash/api/setup/admin", { json: { email: "second@example.com" } });
	expect(r.status === 400, "setup cannot create a second admin", r.text);

	writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

async function writePhase() {
	const state = JSON.parse(readFileSync(stateFile, "utf8"));

	let r = await request(new Jar(), "POST", `/_emdash/api/content/${COLLECTION}`, {
		json: { data: { title: "Anonymous" } },
	});
	expect(r.status === 401 || r.status === 403, "anonymous visitors cannot create content", `HTTP ${r.status}`);

	const jar = await passkeyLogin(state, "write");
	r = await request(jar, "GET", "/_emdash/api/auth/me");
	expect(r.status === 200 && r.data?.data?.email === "admin@example.com", "session belongs to the admin", r.text);

	const png = samplePng();
	const form = new FormData();
	form.append("file", new Blob([png], { type: "image/png" }), "railway-smoke.png");
	form.append("alt", "Smoke test image");
	r = await request(jar, "POST", "/_emdash/api/media", { form });
	const media = r.data?.data?.item;
	expect((r.status === 200 || r.status === 201) && media?.url, "admin uploads an image", r.text);
	r = await request(null, "GET", media.url);
	expect(r.status === 200 && r.buffer.equals(png), "the uploaded image is served back unchanged", `HTTP ${r.status}`);

	const title = `Railway smoke test ${randomBytes(4).toString("hex")}`;
	const slug = `railway-smoke-${randomBytes(4).toString("hex")}`;
	r = await request(jar, "POST", `/_emdash/api/content/${COLLECTION}`, {
		json: {
			slug,
			data: {
				title,
				...(COLLECTION === "posts" || COLLECTION === "projects"
					? {
							featured_image: {
								id: media.id,
								provider: "local",
								alt: "Smoke test image",
								mimeType: "image/png",
								meta: { storageKey: media.storageKey },
							},
						}
					: {}),
				...(COLLECTION === "posts" ? { excerpt: "Written by the Railway template smoke test." } : {}),
				...(COLLECTION !== "pages" || TEMPLATE !== "marketing" ? { content: [
					{
						_type: "block",
						_key: "a1",
						style: "normal",
						markDefs: [],
						children: [{ _type: "span", _key: "s1", text: "This post was written through the EmDash API.", marks: [] }],
					},
				] } : {}),
			},
		},
	});
	const item = r.data?.data?.item ?? r.data?.data;
	expect((r.status === 200 || r.status === 201) && item?.id, "admin creates a post (database write)", r.text);
	r = await request(jar, "POST", `/_emdash/api/content/${COLLECTION}/${item.id}/publish`, { json: {} });
	expect(r.status === 200, "admin publishes the post", r.text);

	if (PUBLIC_PREFIX !== "none") {
		r = await request(null, "GET", `${PUBLIC_PREFIX}/${slug}`);
		expect(r.status === 200 && r.text.includes(title), "the published post renders on the public site", `HTTP ${r.status}`);
		if (COLLECTION === "posts" || COLLECTION === "projects") {
			const key = media.storageKey;
			const src = [...r.text.matchAll(/\bsrc="([^"]+)"/g)]
				.map((m) => m[1].replaceAll("&amp;", "&"))
				.find((u) => u.includes(key) || decodeURIComponent(u).includes(key));
			expect(src, "the post page shows the uploaded image", r.text.slice(0, 2000));
			const img = await request(null, "GET", src.startsWith("http") ? new URL(src).pathname + new URL(src).search : src);
			expect(
				img.status === 200 && (img.headers.get("content-type") ?? "").startsWith("image/"),
				`the image on the page loads (${src.split("?")[0]})`,
				`HTTP ${img.status} ${img.headers.get("content-type")}`,
			);
		}
	}

	if (TEMPLATE === "blog") {
		// EmDash's full-text search is SQLite-only. On PostgreSQL the page must
		// still render, with no results.
		r = await request(null, "GET", "/search?q=railway");
		expect(r.status === 200 && /<html/i.test(r.text), "the search page renders", `HTTP ${r.status}`);
	}

	state.session = jar.cookies;
	state.post = { slug, title, id: item.id };
	state.media = { url: media.url, sha256: sha256(png).toString("hex"), storageKey: media.storageKey };
	writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

async function verifyPhase() {
	const state = JSON.parse(readFileSync(stateFile, "utf8"));

	let r = await request(new Jar(state.session), "GET", "/_emdash/api/auth/me");
	expect(r.status === 200 && r.data?.data?.email === "admin@example.com", "the admin session survived the restart", r.text);

	if (PUBLIC_PREFIX !== "none") {
		r = await request(null, "GET", `${PUBLIC_PREFIX}/${state.post.slug}`);
		expect(r.status === 200 && r.text.includes(state.post.title), "the post survived the restart", `HTTP ${r.status}`);
	}
	r = await request(new Jar(state.session), "GET", `/_emdash/api/content/${COLLECTION}/${state.post.id}`);
	expect(r.status === 200 && r.text.includes(state.post.title), "the post is still in the database", r.text);

	r = await request(null, "GET", state.media.url);
	expect(
		r.status === 200 && sha256(r.buffer).toString("hex") === state.media.sha256,
		"the uploaded image survived the restart",
		`HTTP ${r.status}`,
	);

	await passkeyLogin(state, "verify");

	r = await request(null, "GET", "/");
	expect(r.status === 200 && /<html/i.test(r.text), "the home page renders", `HTTP ${r.status}`);

	r = await request(new Jar(), "GET", "/_emdash/api/setup/status");
	expect(r.data?.data?.needsSetup === false, "setup is still complete", r.text);

	writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

const phases = { setup: setupPhase, write: writePhase, verify: verifyPhase };
if (!phases[phase]) fail(`unknown phase ${phase}`);
await phases[phase]();
