function toArray(input) {
	return String(input || "")
		.split(/[,\s]+/)
		.map(item => item.trim())
		.filter(Boolean);
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

	if (process.env.GMAIL_EMAIL)
		nextConfig.credentials.gmailAccount.email = process.env.GMAIL_EMAIL;
	if (process.env.GOOGLE_CLIENT_ID)
		nextConfig.credentials.gmailAccount.clientId = process.env.GOOGLE_CLIENT_ID;
	if (process.env.GOOGLE_CLIENT_SECRET)
		nextConfig.credentials.gmailAccount.clientSecret = process.env.GOOGLE_CLIENT_SECRET;
	if (process.env.GOOGLE_REFRESH_TOKEN)
		nextConfig.credentials.gmailAccount.refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
	if (process.env.GOOGLE_API_KEY)
		nextConfig.credentials.gmailAccount.apiKey = process.env.GOOGLE_API_KEY;

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

	return {
		config: nextConfig,
		configCommands: nextConfigCommands
	};
}

module.exports = applyRuntimeSecrets;
