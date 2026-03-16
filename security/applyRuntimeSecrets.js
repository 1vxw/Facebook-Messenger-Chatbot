function toArray(input) {
	return String(input || "")
		.split(/[,\s]+/)
		.map(item => item.trim())
		.filter(Boolean);
}

function normalizeSecret(value) {
	const text = String(value || "").trim();
	if (!text)
		return "";
	if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'")))
		return text.slice(1, -1).trim();
	return text;
}

function firstEnv(keys = []) {
	for (const key of keys) {
		const value = normalizeSecret(process.env[key]);
		if (value)
			return value;
	}
	return "";
}

function applyRuntimeSecrets(config = {}, configCommands = {}) {
	const nextConfig = config;
	const nextConfigCommands = configCommands;

	nextConfig.facebookAccount = nextConfig.facebookAccount || {};
	nextConfig.credentials = nextConfig.credentials || {};
	nextConfig.credentials.gmailAccount = nextConfig.credentials.gmailAccount || {};
	nextConfig.credentials.gRecaptcha = nextConfig.credentials.gRecaptcha || {};

	nextConfigCommands.envGlobal = nextConfigCommands.envGlobal || {};
	nextConfigCommands.envCommands = nextConfigCommands.envCommands || {};

	if (process.env.FB_EMAIL)
		nextConfig.facebookAccount.email = process.env.FB_EMAIL;
	if (process.env.FB_PASSWORD)
		nextConfig.facebookAccount.password = process.env.FB_PASSWORD;
	if (process.env.FB_2FA_SECRET)
		nextConfig.facebookAccount["2FASecret"] = process.env.FB_2FA_SECRET;
	if (process.env.FB_C_USER)
		nextConfig.facebookAccount.c_user = process.env.FB_C_USER;
	if (process.env.ADMIN_BOT_IDS)
		nextConfig.adminBot = toArray(process.env.ADMIN_BOT_IDS);

	const gmailEmail = firstEnv(["GMAIL_EMAIL", "GOOGLE_GMAIL_EMAIL", "GMAIL_ADDRESS"]);
	const googleClientId = firstEnv(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENTID", "GMAIL_CLIENT_ID"]);
	const googleClientSecret = firstEnv(["GOOGLE_CLIENT_SECRET", "GOOGLE_CLIENTSECRET", "GMAIL_CLIENT_SECRET"]);
	const googleRefreshToken = firstEnv(["GOOGLE_REFRESH_TOKEN", "GOOGLE_REFRESHTOKEN", "GMAIL_REFRESH_TOKEN"]);
	const googleApiKey = firstEnv(["GOOGLE_API_KEY", "GOOGLE_APIKEY", "GEMINI_API_KEY"]);

	if (gmailEmail)
		nextConfig.credentials.gmailAccount.email = gmailEmail;
	if (googleClientId)
		nextConfig.credentials.gmailAccount.clientId = googleClientId;
	if (googleClientSecret)
		nextConfig.credentials.gmailAccount.clientSecret = googleClientSecret;
	if (googleRefreshToken)
		nextConfig.credentials.gmailAccount.refreshToken = googleRefreshToken;
	if (googleApiKey)
		nextConfig.credentials.gmailAccount.apiKey = googleApiKey;

	if (process.env.RECAPTCHA_SITE_KEY)
		nextConfig.credentials.gRecaptcha.siteKey = process.env.RECAPTCHA_SITE_KEY;
	if (process.env.RECAPTCHA_SECRET_KEY)
		nextConfig.credentials.gRecaptcha.secretKey = process.env.RECAPTCHA_SECRET_KEY;

	if (process.env.WEATHER_API_KEY)
		nextConfigCommands.envGlobal.weatherApiKey = process.env.WEATHER_API_KEY;

	if (process.env.GROQ_API_KEY || process.env.GROQ_MODEL) {
		for (const commandName of ["vance", "vancetest", "cm", "croom", "gclass"]) {
			nextConfigCommands.envCommands[commandName] = nextConfigCommands.envCommands[commandName] || {};
			if (process.env.GROQ_API_KEY) {
				nextConfigCommands.envCommands[commandName].apiKey = process.env.GROQ_API_KEY;
				nextConfigCommands.envCommands[commandName].geminiApiKey = process.env.GROQ_API_KEY;
			}
			if (process.env.GROQ_MODEL) {
				nextConfigCommands.envCommands[commandName].model = process.env.GROQ_MODEL;
				nextConfigCommands.envCommands[commandName].geminiModel = process.env.GROQ_MODEL;
			}
		}
	}

	const githubToken = firstEnv(["GITHUB_TOKEN", "GH_TOKEN"]);
	if (githubToken) {
		nextConfigCommands.envCommands.github = nextConfigCommands.envCommands.github || {};
		nextConfigCommands.envCommands.github.token = githubToken;
	}

	return {
		config: nextConfig,
		configCommands: nextConfigCommands
	};
}

module.exports = applyRuntimeSecrets;
