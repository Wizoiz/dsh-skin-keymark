/**
 * dsh-skin-keymark — host half.
 *
 * Durable, origin-independent persistence for the browser half.
 *
 * The browser half seeds its in-memory cache from localStorage (so the first
 * paint is correct), then loads the authoritative state from this API and
 * re-applies it; writes are debounced and pushed here as the full state.
 *
 * DSH Desktop binds its web server to an OS-assigned port on every launch
 * (profile.js forces the webserver row to `port: 0`, and the launcher passes
 * `--port 0`), so the GUI origin changes on every restart and localStorage
 * "forgets" the saved skin — the data is still in the leveldb, just under the
 * previous port's origin. This host half gives the browser half a stable
 * channel that survives origin changes:
 *
 *   - a state file at `$DSH_HOME/dsh-skin-keymark.json` (default `~/.dsh/...`),
 *     written atomically (tmp + rename);
 *   - a fenced JSON API at `/dsh-skin-keymark/api` — POST `{method:"get"}`
 *     returns the whole state object, POST `{method:"set", patch:{...}}`
 *     merges the patch into it.
 *
 * Route security: the same trust fence as dsh-dream-skin's /dream-skin routes
 * — loopback (or a configured trusted authority) Host header and same-origin
 * browser markers only. This is a DNS-rebinding / cross-site defense, not
 * authentication.
 */

import { homedir } from "node:os";
import {
	readFileSync,
	writeFileSync,
	renameSync,
	mkdirSync,
	createReadStream,
	createWriteStream,
	statSync,
	readdirSync,
	unlinkSync
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, extname } from "node:path";

/** State file name inside the DSH home directory. */
const STATE_FILENAME = "dsh-skin-keymark.json";
/** Max accepted request body (wallpapers are base64 data URLs, can be MBs). */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Route prefix owned by this plugin. */
const API_PREFIX = "/dsh-skin-keymark/api";
/** Directory (inside the DSH home) holding uploaded wallpaper media. */
const MEDIA_DIRNAME = "dsh-skin-keymark-media";
/** Route prefix for upload + playback of local wallpaper media. */
const MEDIA_PREFIX = "/dsh-skin-keymark/media";
/** Upload cap — this is a wallpaper clip store, not a general file host. */
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
/** Extensions accepted for an upload (container formats only). */
const MEDIA_EXTENSIONS = new Set(["mp4", "m4v", "webm", "ogv", "ogg", "mov", "mkv", "avi", "ts", "gif"]);
/** Content types served back for the known extensions. */
const MEDIA_MIME = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	ogv: "video/ogg",
	ogg: "video/ogg",
	mov: "video/quicktime",
	mkv: "video/x-matroska",
	avi: "video/x-msvideo",
	ts: "video/mp2t",
	gif: "image/gif"
};
/**
 * Cache policy for stored media. Every file is content-addressed (its name is
 * the sha256 of the bytes), so a URL can never point at different content and
 * the browser may keep it forever. Without this the whole clip (10-30 MB) was
 * re-pulled on every launch because the response carried `no-store`.
 */
const MEDIA_CACHE_CONTROL = "private, max-age=31536000, immutable";
/**
 * Boot seed: the saved state inlined into the page before any module runs, so
 * the browser half's first paint is correct even when localStorage is empty
 * (fresh install, cleared storage, or a changed origin). A data-URL wallpaper
 * can be ~1 MB, so a seed past this size is skipped — the client then falls
 * back to localStorage and the asynchronous /api pull rather than bloating
 * every index response.
 */
const BOOT_SEED_MAX_CHARS = 24000;
/** Global the browser half reads to recover that seed. */
const BOOT_GLOBAL_NAME = "__DSH_SKIN_KEYMARK_BOOT__";

/** Plugin identity for cordis.yml rows. */
export const name = "dsh-skin-keymark";
/**
 * Services required before mounting: the web server routes. The trust fence's
 * non-loopback host list used to arrive through a `webRuntime` service; DSH
 * 0.2.1-rc.2 removed that service, so it is now resolved defensively (see
 * `trustedHostsOf`) instead of being declared as a hard dependency.
 */
export const inject = ["webServer"];

// ── state file ─────────────────────────────────────────────────────────────

/** Absolute path of the state file under the DSH home directory. */
function statePath() {
	const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, STATE_FILENAME);
}

/** Read the state object; `{}` when absent or corrupt. */
function readState() {
	try {
		const parsed = JSON.parse(readFileSync(statePath(), "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** Persist the state object atomically (tmp + rename, direct-write fallback). */
function writeState(state) {
	const file = statePath();
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	const body = JSON.stringify(state);
	// The state file holds the user's wallpaper data URLs (personal images),
	// so keep it owner-only on POSIX (mode is ignored on Windows).
	writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
	try {
		renameSync(tmp, file);
	} catch {
		// rename can fail on Windows if the target is transiently locked; a
		// direct write is a safe fallback for this single-process case.
		writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
	}
}

// ── media store (local wallpaper files) ────────────────────────────────────
//
// A local video cannot travel through the state file: it is far past the JSON
// body cap and localStorage quota. Instead the browser pushes the raw bytes
// once to this store, keeps only the returned relative URL in `state`, and the
// <video> streams it back from the SAME origin. Same origin also means the
// browser half's canvas readback is not tainted, so the readability sampler
// works on local videos too.

/** Absolute directory holding uploaded wallpaper media. */
function mediaDir() {
	const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, MEDIA_DIRNAME);
}

/** Absolute path of a stored media file, or undefined for a bad name. */
function mediaFilePath(name) {
	if (typeof name !== "string" || !/^[a-f0-9]{64}\.[a-z0-9]{1,5}$/.test(name)) return undefined;
	return join(mediaDir(), name);
}

/**
 * Stream one upload to disk, keyed by its content hash so re-importing the
 * same file is idempotent. Resolves `{name,size}` or `{tooLarge:true}`.
 */
function saveMedia(req, ext) {
	return new Promise((resolve) => {
		const dir = mediaDir();
		mkdirSync(dir, { recursive: true });
		const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const hash = createHash("sha256");
		const ws = createWriteStream(tmp);
		let size = 0;
		let settled = false;
		const bail = () => {
			if (settled) return;
			settled = true;
			try { ws.destroy(); } catch { /* ignore */ }
			try { unlinkSync(tmp); } catch { /* ignore */ }
			resolve({ tooLarge: true });
		};
		req.on("data", (chunk) => {
			if (settled) return;
			size += chunk.length;
			if (size > MAX_MEDIA_BYTES) { req.destroy(); bail(); return; }
			hash.update(chunk);
			if (!ws.write(chunk)) {
				req.pause();
				ws.once("drain", () => req.resume());
			}
		});
		req.on("error", bail);
		req.on("end", () => {
			if (settled) return;
			ws.end(() => {
				if (settled) return;
				settled = true;
				const name = `${hash.digest("hex")}.${ext}`;
				try {
					renameSync(tmp, join(dir, name));
				} catch {
					// Destination already exists (Windows refuses to rename onto a
					// live file); the stored copy is byte-identical, so drop the tmp.
					try { unlinkSync(tmp); } catch { /* ignore */ }
				}
				resolve({ name, size });
			});
		});
		ws.on("error", bail);
	});
}

/** Serve one stored media file, with byte-range support so seeking works. */
function serveMedia(req, res, name) {
	const file = mediaFilePath(name);
	let stat;
	try { stat = statSync(file); } catch { stat = null; }
	if (!file || !stat) {
		writeJson(res, 404, { ok: false, error: { code: "not-found", message: "unknown media" } });
		return;
	}
	const type = MEDIA_MIME[extname(file).slice(1).toLowerCase()] || "application/octet-stream";
	const match = /^bytes=(\d*)-(\d*)$/.exec((req.headers.range || "").trim());
	if (match) {
		const start = match[1] === "" ? Math.max(0, stat.size - Number(match[2] || 0)) : Number(match[1]);
		const end = match[1] === "" || match[2] === "" ? stat.size - 1 : Math.min(Number(match[2]), stat.size - 1);
		if (!isFinite(start) || !isFinite(end) || start > end || start >= stat.size) {
			res.writeHead(416, { "content-range": `bytes */${stat.size}` });
			res.end();
			return;
		}
		res.writeHead(206, {
			"content-type": type,
			"content-length": String(end - start + 1),
			"content-range": `bytes ${start}-${end}/${stat.size}`,
			"accept-ranges": "bytes",
			"cache-control": MEDIA_CACHE_CONTROL
		});
		createReadStream(file, { start, end }).pipe(res);
		return;
	}
	res.writeHead(200, {
		"content-type": type,
		"content-length": String(stat.size),
		"accept-ranges": "bytes",
		"cache-control": MEDIA_CACHE_CONTROL
	});
	createReadStream(file).pipe(res);
}

// ── media library (the panel's "素材库") ──────────────────────────────────
//
// The media dir is a content-addressed store, so re-importing a file is
// idempotent. On top of it we keep an ordered index (newest first) so the
// browser half can offer the previously-used clips without re-uploading.

/** The library index: `[{name,size,at}]`, newest first (bad rows dropped). */
function readLibrary() {
	const saved = readState();
	const raw = typeof saved.library === "string" ? saved.library : "";
	try {
		const list = JSON.parse(raw);
		return Array.isArray(list) ? list.filter((entry) => entry && typeof entry.name === "string") : [];
	} catch {
		return [];
	}
}

/** Persist the library index (capped so the state file stays small). */
function writeLibrary(list) {
	const saved = readState();
	saved.library = JSON.stringify(list.slice(0, 60));
	writeState(saved);
}

/** Record one stored media file (idempotent by name; never fails an upload). */
function addToLibrary(name, size) {
	try {
		const list = readLibrary().filter((entry) => entry.name !== name);
		list.unshift({ name, size: Number(size) || 0, at: Date.now() });
		writeLibrary(list);
	} catch {
		/* library bookkeeping must never fail an upload */
	}
}

/** Drop one file from the library index (a missing entry is a no-op). */
function removeFromLibrary(name) {
	try {
		writeLibrary(readLibrary().filter((entry) => entry.name !== name));
	} catch {
		/* index bookkeeping is best-effort */
	}
}

/**
 * Delete stored media the user no longer owns: temp files, soft-deletes older
 * than a week, and any file that is neither in the library nor referenced by
 * the saved state. Library files are kept even when not currently selected.
 */
function gcMedia() {
	try {
		const saved = readState();
		const blob = typeof saved.state === "string" ? saved.state : "";
		const keep = new Set(readLibrary().map((entry) => entry.name));
		const dir = mediaDir();
		const now = Date.now();
		for (const file of readdirSync(dir)) {
			if (file.startsWith(".tmp-") || file.endsWith(".tmp")) {
				try { unlinkSync(join(dir, file)); } catch { /* ignore */ }
				continue;
			}
			const cut = file.lastIndexOf(".deleted-");
			if (cut !== -1) {
				const ts = Number(file.slice(cut + ".deleted-".length));
				if (!isFinite(ts) || now - ts > 7 * 24 * 60 * 60 * 1000) {
					try { unlinkSync(join(dir, file)); } catch { /* ignore */ }
				}
				continue;
			}
			if (!keep.has(file) && blob.indexOf(file) === -1) {
				try { unlinkSync(join(dir, file)); } catch { /* ignore */ }
			}
		}
	} catch {
		/* no media dir yet — nothing to collect */
	}
}

/** Handle one fenced media request (upload or playback). */
async function handleMedia(req, res) {
	const raw = typeof req.url === "string" ? req.url : "";
	const qIndex = raw.indexOf("?");
	const pathOnly = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
	const query = qIndex >= 0 ? raw.slice(qIndex + 1) : "";
	// The prefix registration may hand us either the full path or the tail;
	// accepting both keeps this independent of the webServer's routing shape.
	const rest = pathOnly.startsWith(MEDIA_PREFIX) ? pathOnly.slice(MEDIA_PREFIX.length) : pathOnly;

	if (req.method === "GET") {
		serveMedia(req, res, decodeURIComponent(rest.replace(/^\//, "")));
		return;
	}
	if (req.method !== "POST") {
		writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
		return;
	}
	const ext = String(new URLSearchParams(query).get("ext") || "").toLowerCase();
	if (!MEDIA_EXTENSIONS.has(ext)) {
		writeJson(res, 415, { ok: false, error: { code: "unsupported-media-type", message: "unsupported media extension" } });
		return;
	}
	const saved = await saveMedia(req, ext);
	if (saved.tooLarge) {
		writeJson(res, 413, { ok: false, error: { code: "payload-too-large", message: "media file too large" } });
		return;
	}
	// Record the stored clip in the ordered library so the panel can re-apply
	// it later without a re-upload. Bookkeeping never fails the upload.
	addToLibrary(saved.name, saved.size);
	writeJson(res, 200, { ok: true, url: `${MEDIA_PREFIX}/${saved.name}`, size: saved.size });
}

// ── trust fence (mirror of dsh-dream-skin/lib/index.js) ────────────────────

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return undefined;
	}
}

/** Whether a normalized URL hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4
		&& parts[0] === "127"
		&& parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry, entryUrl) {
	const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
	return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

/**
 * Assert one configured `trustedHosts` entry is a bare authority (`host` or
 * `host:port`) in canonical form. Anything WHATWG parsing would silently
 * rewrite (whitespace, dangling colon, zero-padded port, path fragment, bogus
 * host spellings) is refused, so a misconfigured entry cannot quietly broaden
 * the authority grant.
 */
function assertTrustedAuthority(entry) {
	const entryUrl = parseAuthority(entry);
	if (entryUrl !== undefined && canonicalAuthority(entry, entryUrl) === entry.toLowerCase()) return;
	throw new Error(`dsh-skin-keymark: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`);
}

/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		assertTrustedAuthority(entry);
		const entryUrl = parseAuthority(entry);
		if (entryUrl === undefined) return false;
		return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
			? entryUrl.hostname === hostUrl.hostname
			: entryUrl.host === hostUrl.host;
	});
}

/**
 * Decide whether one request may reach the plugin routes.
 * @param req - node HTTP request facts (headers).
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the Host is ours (loopback or trusted) and browser markers are same-origin.
 */
function isTrustedApiRequest(req, trustedHosts) {
	const host = typeof req.headers.host === "string" ? req.headers.host : undefined;
	if (host === undefined) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === undefined) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

/**
 * Non-loopback authorities this deployment serves, for the trust fence above.
 *
 * DSH 0.2.1-rc.2 deleted the `webRuntime` service that used to hand this list
 * over, and `inject: ["webRuntime"]` therefore stopped the whole host half from
 * mounting (no routes, no media, no state file reads). Resolve it softly now:
 * the external runtime when a deployment still provides it, the web server's
 * own copy next, and an empty list otherwise — which is exactly right for a
 * loopback-only install, where every served authority is already loopback.
 *
 * @param ctx - host cordis context.
 * @returns trusted bare authorities, or `[]` when the host publishes none.
 */
function trustedHostsOf(ctx) {
	for (const name of ["webRuntime", "webServer"]) {
		try {
			const service = typeof ctx.get === "function" ? ctx.get(name) : undefined;
			if (service !== null && service !== undefined && Array.isArray(service.trustedHosts)) return service.trustedHosts;
		} catch {
			/* service absent or unavailable — try the next source */
		}
	}
	return [];
}

// ── JSON body / response helpers ───────────────────────────────────────────

/** Sentinel: the request body exceeded MAX_BODY_BYTES (respond 413, not 400). */
const PAYLOAD_TOO_LARGE = Symbol("payload-too-large");

/**
 * Read a JSON request body, capped at MAX_BODY_BYTES.
 * Resolves the parsed body, or `null` when not valid JSON, or
 * `PAYLOAD_TOO_LARGE` when the body exceeded the cap.
 */
function readJsonBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		let aborted = false;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES && !aborted) {
				aborted = true;
				req.destroy();
				resolve(PAYLOAD_TOO_LARGE);
				return;
			}
			if (!aborted) chunks.push(chunk);
		});
		req.on("end", () => {
			if (aborted) return;
			try {
				const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				resolve(parsed);
			} catch {
				resolve(null);
			}
		});
		req.on("error", () => {
			if (!aborted) resolve(null);
		});
	});
}

/** Write a JSON response with the given status code. */
function writeJson(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store"
	});
	res.end(body);
}

/** Handle one fenced API request. */
async function handleApi(req, res) {
	if (req.method !== "POST") {
		writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
		return;
	}
	// Content-type fence: only JSON bodies are meaningful here. Without it a
	// cross-site form POST (which the trust fence already blocks via
	// sec-fetch-site) would otherwise be parsed as `{}` and mis-handled.
	const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"].toLowerCase() : "";
	if (!contentType.startsWith("application/json")) {
		writeJson(res, 415, { ok: false, error: { code: "unsupported-media-type", message: "content-type must be application/json" } });
		return;
	}
	const payload = await readJsonBody(req);
	if (payload === PAYLOAD_TOO_LARGE) {
		writeJson(res, 413, { ok: false, error: { code: "payload-too-large", message: "request body too large" } });
		return;
	}
	if (payload === null || typeof payload !== "object" || typeof payload.method !== "string") {
		writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "bad request" } });
		return;
	}
	if (payload.method === "get") {
		writeJson(res, 200, { ok: true, value: readState() });
		return;
	}
	if (payload.method === "set") {
		const patch = payload.patch;
		if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
			writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "patch must be a plain object" } });
			return;
		}
		// Merge into the current state. Only the keys present in `patch` are
		// touched: a string value sets it, null removes it, and keys not in the
		// patch are left untouched. This makes concurrent writers (e.g. two
		// browser tabs, each with its own in-memory cache) safe. Only string /
		// null values are accepted, so a compromised page cannot smuggle
		// non-JSON types into the file.
		const next = readState();
		for (const [key, value] of Object.entries(patch)) {
			if (typeof key !== "string") continue;
			if (value === null) delete next[key];
			else if (typeof value === "string") next[key] = value;
		}
		writeState(next);
		writeJson(res, 200, { ok: true });
		return;
	}
	if (payload.method === "list-media") {
		writeJson(res, 200, { ok: true, value: readLibrary() });
		return;
	}
	if (payload.method === "delete-media") {
		// Soft delete: rename next to the live file so playback in another tab
		// keeps working, and drop it from the library index right away. The
		// collector removes the tombstone a week later.
		const name = payload.name;
		const file = mediaFilePath(name);
		if (!file) {
			writeJson(res, 400, { ok: false, error: { code: "bad-request", message: "bad media name" } });
			return;
		}
		try { renameSync(file, `${file}.deleted-${Date.now()}`); } catch { /* already gone */ }
		removeFromLibrary(name);
		writeJson(res, 200, { ok: true });
		return;
	}
	writeJson(res, 404, { ok: false, error: { code: "not-found", message: `unknown method "${payload.method}"` } });
}

/**
 * Host loader entry: mount the fenced persistence API.
 * @param ctx - host cordis context (webServer).
 */
export function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: async (req, res) => {
			if (!isTrustedApiRequest(req, trustedHostsOf(ctx))) {
				writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
				return;
			}
			try {
				await handleApi(req, res);
			} catch (error) {
				// Do not echo the internal error back to the browser — the
				// trusted-origin page does not need filesystem paths etc.
				console.error("[dsh-skin-keymark] persistence API error:", error);
				writeJson(res, 500, { ok: false, error: { code: "internal", message: "internal error" } });
			}
		}
	}), "dsh-skin-keymark: persistence API routes");
	ctx.effect(() => {
		gcMedia();
		return ctx.webServer.register({
			kind: "prefix",
			path: MEDIA_PREFIX,
			handler: async (req, res) => {
				if (!isTrustedApiRequest(req, trustedHostsOf(ctx))) {
					writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
					return;
				}
				try {
					await handleMedia(req, res);
				} catch (error) {
					// Never echo internal errors (filesystem paths) to the page.
					console.error("[dsh-skin-keymark] media API error:", error);
					writeJson(res, 500, { ok: false, error: { code: "internal", message: "internal error" } });
				}
			}
		});
	}, "dsh-skin-keymark: local wallpaper media routes");
	// Inline the saved state into every index response, ahead of any module
	// script, so the browser half's first paint is correct even when
	// localStorage is empty (fresh install, cleared storage, changed origin).
	// Re-read per render: the row always carries the latest persisted state.
	ctx.effect(() => ctx.on("webserver/index-inject", (table) => {
		const saved = readState();
		const blob = typeof saved.state === "string" ? saved.state : "";
		if (blob === "" || blob.length > BOOT_SEED_MAX_CHARS) return;
		table.push({ kind: "global", name: BOOT_GLOBAL_NAME, value: { state: blob } });
	}), "dsh-skin-keymark: inlined boot seed");
}
