const crypto = require("crypto");

function base64urlEncode(input) {
	return Buffer.from(input)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function base64urlDecode(input) {
	let normalized = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
	while (normalized.length % 4)
		normalized += "=";
	return Buffer.from(normalized, "base64").toString("utf8");
}

function getStateSecret() {
	return String(
		process.env.GCLASS_STATE_SECRET ||
		process.env.SESSION_SECRET ||
		"gclass-dev-secret-change-me"
	).trim();
}

function signData(data) {
	return base64urlEncode(
		crypto
			.createHmac("sha256", getStateSecret())
			.update(String(data))
			.digest()
	);
}

function safeEqual(a, b) {
	const aa = Buffer.from(String(a || ""));
	const bb = Buffer.from(String(b || ""));
	if (aa.length !== bb.length)
		return false;
	return crypto.timingSafeEqual(aa, bb);
}

function createConnectState(senderID, ttlMs = 10 * 60 * 1000) {
	const payload = {
		sid: String(senderID),
		exp: Date.now() + Number(ttlMs || 0),
		nonce: crypto.randomBytes(8).toString("hex")
	};
	const encodedPayload = base64urlEncode(JSON.stringify(payload));
	const sig = signData(encodedPayload);
	return `${encodedPayload}.${sig}`;
}

function verifyConnectState(state) {
	try {
		const raw = String(state || "").trim();
		if (!raw.includes("."))
			return { ok: false, reason: "format" };
		const [encodedPayload, sig] = raw.split(".");
		const expectedSig = signData(encodedPayload);
		if (!safeEqual(sig, expectedSig))
			return { ok: false, reason: "signature" };
		const payload = JSON.parse(base64urlDecode(encodedPayload));
		const sid = String(payload?.sid || "").trim();
		const exp = Number(payload?.exp || 0);
		if (!sid || !Number.isFinite(exp))
			return { ok: false, reason: "payload" };
		if (Date.now() > exp)
			return { ok: false, reason: "expired" };
		return { ok: true, sid, exp };
	}
	catch (_e) {
		return { ok: false, reason: "invalid" };
	}
}

module.exports = {
	createConnectState,
	verifyConnectState
};
