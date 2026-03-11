const fs = require("fs-extra");
const path = require("path");
const { google } = require("googleapis");

const TOKENS_FILE = path.join(process.cwd(), "database", "data", "classroomUserTokens.json");
const DEFAULT_OAUTH_REDIRECT_URI = "https://developers.google.com/oauthplayground";
const OAUTH_SCOPES = [
	"https://www.googleapis.com/auth/drive.file",
	"https://www.googleapis.com/auth/drive.readonly",
	"https://www.googleapis.com/auth/classroom.courses.readonly",
	"https://www.googleapis.com/auth/classroom.coursework.me.readonly",
	"https://www.googleapis.com/auth/classroom.coursework.me",
	"https://www.googleapis.com/auth/classroom.student-submissions.me.readonly"
];

function getOAuthBaseConfig() {
	const gmailCfg = global?.GoatBot?.config?.credentials?.gmailAccount || {};
	return {
		clientId: gmailCfg.clientId || "",
		clientSecret: gmailCfg.clientSecret || ""
	};
}

function createOAuthClient(redirectUri = DEFAULT_OAUTH_REDIRECT_URI) {
	const { clientId, clientSecret } = getOAuthBaseConfig();
	return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function loadTokenStore() {
	await fs.ensureFile(TOKENS_FILE);
	let raw = await fs.readFile(TOKENS_FILE, "utf8");
	if (!raw.trim()) {
		await fs.writeFile(TOKENS_FILE, "{}", "utf8");
		raw = "{}";
	}
	try {
		const data = JSON.parse(raw);
		return data && typeof data === "object" ? data : {};
	}
	catch (_e) {
		return {};
	}
}

async function saveTokenStore(data) {
	await fs.ensureDir(path.dirname(TOKENS_FILE));
	await fs.writeFile(TOKENS_FILE, JSON.stringify(data, null, 2), "utf8");
}

async function getUserToken(senderID) {
	const store = await loadTokenStore();
	return store[String(senderID)] || null;
}

async function setUserToken(senderID, token) {
	const store = await loadTokenStore();
	store[String(senderID)] = token;
	await saveTokenStore(store);
}

async function removeUserToken(senderID) {
	const store = await loadTokenStore();
	delete store[String(senderID)];
	await saveTokenStore(store);
}

async function exchangeAuthCodeForUser({ senderID, code, redirectUri = DEFAULT_OAUTH_REDIRECT_URI }) {
	const oauth2 = createOAuthClient(redirectUri);
	const { tokens } = await oauth2.getToken(code);
	if (!tokens?.refresh_token) {
		const old = await getUserToken(senderID);
		if (old?.refresh_token)
			tokens.refresh_token = old.refresh_token;
	}
	await setUserToken(senderID, tokens);
	return tokens;
}

async function getClientsForUser(senderID) {
	const token = await getUserToken(senderID);
	if (!token)
		return null;

	const auth = createOAuthClient();
	auth.setCredentials(token);
	return {
		classroom: google.classroom({ version: "v1", auth }),
		drive: google.drive({ version: "v3", auth }),
		auth
	};
}

module.exports = {
	OAUTH_SCOPES,
	DEFAULT_OAUTH_REDIRECT_URI,
	createOAuthClient,
	getUserToken,
	setUserToken,
	removeUserToken,
	getClientsForUser,
	exchangeAuthCodeForUser
};
