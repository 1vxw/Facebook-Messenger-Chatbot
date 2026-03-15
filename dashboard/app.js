const express = require("express");
const app = express();
const fileUpload = require("express-fileupload");
const rateLimit = require("express-rate-limit");
const fs = require("fs-extra");
const session = require("express-session");
const eta = require("eta");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const nodemailer = require("nodemailer");
const cookieParser = require("cookie-parser");
const flash = require("connect-flash");
const Passport = require("passport");
const bcrypt = require("bcrypt");
const axios = require("axios");
const mimeDB = require("mime-db");
const http = require("http");
const checkLiveCookie = require("../bot/login/checkLiveCookie.js");
const {
	OAUTH_SCOPES,
	createOAuthClient,
	getUserToken: getGclassUserToken,
	setUserToken: setGclassUserToken
} = require("../scripts/cmds/helpers/gclassAuth.js");
const { verifyConnectState } = require("../scripts/cmds/helpers/gclassConnectState.js");
const server = http.createServer(app);

const imageExt = ["png", "gif", "webp", "jpeg", "jpg"];
const videoExt = ["webm", "mkv", "flv", "vob", "ogv", "ogg", "rrc", "gifv",
	"mng", "mov", "avi", "qt", "wmv", "yuv", "rm", "asf", "amv", "mp4",
	"m4p", "m4v", "mpg", "mp2", "mpeg", "mpe", "mpv", "m4v", "svi", "3gp",
	"3g2", "mxf", "roq", "nsv", "flv", "f4v", "f4p", "f4a", "f4b", "mod"
];
const audioExt = ["3gp", "aa", "aac", "aax", "act", "aiff", "alac", "amr",
	"ape", "au", "awb", "dss", "dvf", "flac", "gsm", "iklax", "ivs",
	"m4a", "m4b", "m4p", "mmf", "mp3", "mpc", "msv", "nmf",
	"ogg", "oga", "mogg", "opus", "ra", "rm", "raw", "rf64", "sln", "tta",
	"voc", "vox", "wav", "wma", "wv", "webm", "8svx", "cd"
];


module.exports = async (api) => {
	if (!api)
		await require("./connectDB.js")();

	const { utils, utils: { drive } } = global;
	const { config, configCommands } = global.GoatBot;
	const { expireVerifyCode } = config.dashBoard;
	const { gmailAccount } = config.credentials;

	const getText = global.utils.getText;
	const stripAnsi = (value) => String(value ?? "").replace(/\u001b\[[0-9;]*m/g, "");

	const runtimeLogState = global.GoatBot.dashboardRuntimeLogs || {
		lines: [],
		clients: new Set(),
		maxLines: 15,
		maxLineLength: 350,
		maxClients: 5,
		maxEventsPerSecond: 3,
		eventsInCurrentSecond: 0,
		currentSecond: 0
	};
	global.GoatBot.dashboardRuntimeLogs = runtimeLogState;

	const pushRuntimeLog = (entry) => {
		const text = stripAnsi(entry?.text || "").replace(/\s+/g, " ").trim();
		if (!text)
			return;
		if (process.env.NODE_ENV === "production" && entry?.level === "debug")
			return;

		const nowSec = Math.floor(Date.now() / 1000);
		if (runtimeLogState.currentSecond !== nowSec) {
			runtimeLogState.currentSecond = nowSec;
			runtimeLogState.eventsInCurrentSecond = 0;
		}
		runtimeLogState.eventsInCurrentSecond += 1;
		if (runtimeLogState.eventsInCurrentSecond > runtimeLogState.maxEventsPerSecond)
			return;

		const line = {
			ts: new Date().toISOString(),
			level: entry?.level || "info",
			text: text.length > runtimeLogState.maxLineLength ? `${text.slice(0, runtimeLogState.maxLineLength)}...` : text
		};

		runtimeLogState.lines.push(line);
		while (runtimeLogState.lines.length > runtimeLogState.maxLines)
			runtimeLogState.lines.shift();

		for (const client of runtimeLogState.clients) {
			try {
				client.write(`data: ${JSON.stringify(line)}\n\n`);
			}
			catch (_e) {
				runtimeLogState.clients.delete(client);
			}
		}
	};

	if (utils?.log && !utils.log.__dashboardWrapped) {
		const methodToLevel = {
			err: "error",
			error: "error",
			warn: "warn",
			info: "info",
			success: "success",
			succes: "success",
			master: "info",
			dev: "debug"
		};
		for (const [method, level] of Object.entries(methodToLevel)) {
			if (typeof utils.log[method] !== "function")
				continue;
			const original = utils.log[method].bind(utils.log);
			utils.log[method] = function (...args) {
				const rendered = args.map(arg => {
					if (arg instanceof Error)
						return arg.stack || arg.message;
					if (typeof arg === "object") {
						try {
							return JSON.stringify(arg);
						}
						catch (_e) {
							return String(arg);
						}
					}
					return String(arg);
				}).join(" ");
				pushRuntimeLog({ level, text: rendered });
				return original(...args);
			};
		}
		utils.log.__dashboardWrapped = true;
	}

	const {
		email,
		clientId,
		clientSecret,
		refreshToken
	} = gmailAccount;

	const hasMailCredentials = !!(email && clientId && clientSecret && refreshToken);
	let transporter = {
		sendMail: async () => {
			throw new Error("Email is not configured. Set GMAIL_EMAIL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.");
		}
	};
	if (hasMailCredentials) {
		const OAuth2 = google.auth.OAuth2;
		const OAuth2_client = new OAuth2(clientId, clientSecret);
		OAuth2_client.setCredentials({ refresh_token: refreshToken });
		let accessToken;
		try {
			accessToken = await OAuth2_client.getAccessToken();
			transporter = nodemailer.createTransport({
				host: "smtp.gmail.com",
				service: "Gmail",
				auth: {
					type: "OAuth2",
					user: email,
					clientId,
					clientSecret,
					refreshToken,
					accessToken
				}
			});
		}
		catch (_err) {
			const tokenErr = getText("Goat", "googleApiTokenExpired");
			utils.log.warn("DASHBOARD", tokenErr.includes("Can't find text") ? "Google API refresh token is invalid/expired. Dashboard email features are disabled until credentials are fixed." : tokenErr);
		}
	}
	else {
		utils.log.warn("DASHBOARD", "Gmail OAuth credentials are missing. Dashboard email features are disabled.");
	}


	const {
		threadModel,
		userModel,
		dashBoardModel,
		threadsData,
		usersData,
		dashBoardData
	} = global.db;

	// Bootstrap the first admin only from environment variables.
	try {
		const adminUser = await dashBoardData.get("admin");
		if (!adminUser) {
			const bootstrapEmail = String(process.env.DASHBOARD_ADMIN_USER || "").trim();
			const bootstrapPassword = String(process.env.DASHBOARD_ADMIN_PASSWORD || "").trim();
			if (bootstrapEmail && bootstrapPassword) {
				await dashBoardData.create({
					email: bootstrapEmail,
					name: "Administrator",
					password: bcrypt.hashSync(bootstrapPassword, 10),
					facebookUserID: config.adminBot?.[0] || "",
					isAdmin: true
				});
				utils.log.warn("DASHBOARD", `Created bootstrap dashboard admin from environment user "${bootstrapEmail}"`);
			}
			else {
				utils.log.warn("DASHBOARD", "No admin account found. Set DASHBOARD_ADMIN_USER and DASHBOARD_ADMIN_PASSWORD, then restart.");
			}
		}
	}
	catch (e) {
		utils.log.err("DASHBOARD", `Cannot seed default admin user: ${e.message}`);
	}


	// const verifyCodes = {
	//     fbid: [],
	//     register: [],
	//     forgetPass: []
	// };

	eta.configure({
		useWith: true
	});

	app.set("views", `${__dirname}/views`);
	app.engine("eta", eta.renderFile);
	app.set("view engine", "eta");

	app.use(bodyParser.json());
	app.use(bodyParser.urlencoded({ extended: true }));
	app.use(cookieParser());
	app.set("trust proxy", 1);
	const secureSessionCookie = process.env.NODE_ENV === "production" || String(process.env.SESSION_COOKIE_SECURE || "").toLowerCase() === "true";
	app.use(session({
		secret: process.env.SESSION_SECRET || randomStringApikey(32),
		resave: false,
		saveUninitialized: true,
		cookie: {
			secure: secureSessionCookie,
			sameSite: "lax",
			httpOnly: true,
			maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
		}
	}));


	// public folder 
	app.use("/css", express.static(`${__dirname}/css`));
	app.use("/js", express.static(`${__dirname}/js`));
	app.use("/images", express.static(`${__dirname}/images`));

	require("./passport-config.js")(Passport, dashBoardData, bcrypt);
	app.use(Passport.initialize());
	app.use(Passport.session());
	app.use(fileUpload());

	app.use(flash());
	app.use(function (req, res, next) {
		res.locals.__dirname = __dirname;
		res.locals.success = req.flash("success") || [];
		res.locals.errors = req.flash("errors") || [];
		res.locals.warnings = req.flash("warnings") || [];
		res.locals.user = req.user || null;
		res.locals.brandName = "VXW";
		res.locals.brandOwner = "Vince Pradas";
		next();
	});

	const generateEmailVerificationCode = require("./scripts/generate-Email-Verification.js");

	// ————————————————— MIDDLEWARE ————————————————— //
	const createLimiter = (ms, max) => rateLimit({
		windowMs: ms, // 5 minutes
		max,
		handler: (req, res) => {
			res.status(429).send({
				status: "error",
				message: getText("app", "tooManyRequests")
			});
		}
	});

	const middleWare = require("./middleware/index.js")(checkAuthConfigDashboardOfThread);

	// ————————————————————————————————————————————— //

	async function checkAuthConfigDashboardOfThread(threadData, userID) {
		if (!isNaN(threadData))
			threadData = await threadsData.get(threadData);
		return threadData.adminIDs?.includes(userID) || threadData.members?.some(m => m.userID == userID && m.permissionConfigDashboard == true) || false;
	}

	const isVideoFile = (mimeType) => videoExt.includes(mimeDB[mimeType]?.extensions?.[0]);

	async function isVerifyRecaptcha() {
		return true;
	}

	function getAccountFilePath() {
		return process.cwd() + (process.env.NODE_ENV == "production" || process.env.NODE_ENV == "development" ? "/account.dev.txt" : "/account.txt");
	}

	function saveConfigToDisk() {
		const configPath = process.cwd() + (process.env.NODE_ENV == "development" ? "/config.dev.json" : "/config.json");
		fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
	}

	function saveConfigCommandsToDisk() {
		const configCommandsPath = process.cwd() + (process.env.NODE_ENV == "development" ? "/configCommands.dev.json" : "/configCommands.json");
		fs.writeFileSync(configCommandsPath, JSON.stringify(configCommands, null, 2));
	}

	function getGclassConnectSessions() {
		if (!global.temp)
			global.temp = {};
		if (!global.temp.gclassConnectSessions)
			global.temp.gclassConnectSessions = {};
		return global.temp.gclassConnectSessions;
	}

	function getPublicBaseUrlFromReq(req) {
		const explicit = String(process.env.PUBLIC_URL || global?.GoatBot?.dashboardPublicBaseUrl || "").trim();
		if (explicit)
			return explicit.replace(/\/+$/, "");
		return `${req.protocol}://${req.get("host")}`;
	}

	function getGclassRedirectUri(req) {
		const explicit = String(process.env.GCLASS_REDIRECT_URI || "").trim();
		if (explicit)
			return explicit;
		return `${getPublicBaseUrlFromReq(req)}/gclass/callback`;
	}

	const appstateLiveCheckCache = global.GoatBot.appstateLiveCheckCache || {
		fingerprint: "",
		checkedAt: 0,
		result: "not_checked"
	};
	global.GoatBot.appstateLiveCheckCache = appstateLiveCheckCache;

	function normalizeCookie(item) {
		const key = String(item?.key || item?.name || "").trim();
		const value = String(item?.value || "").trim();
		const expiresRaw = item?.expires;
		let expiresAtSec = null;

		if (Number.isFinite(Number(expiresRaw))) {
			let n = Number(expiresRaw);
			if (n > 0) {
				if (n > 1e12)
					n = Math.floor(n / 1000);
				expiresAtSec = Math.floor(n);
			}
		}
		else if (typeof expiresRaw === "string" && expiresRaw.trim()) {
			const parsedTime = Date.parse(expiresRaw);
			if (!Number.isNaN(parsedTime))
				expiresAtSec = Math.floor(parsedTime / 1000);
		}

		return { key, value, expiresAtSec };
	}

	async function readAppstateStatus({ liveCheck = false } = {}) {
		const accountFilePath = getAccountFilePath();
		const status = {
			exists: false,
			validJson: false,
			cookieCount: 0,
			hasCUser: false,
			hasXs: false,
			expiresSoonCount: 0,
			expiresAt: null,
			expiresInHours: null,
			expiredCookieCount: 0,
			missingRequiredCookies: [],
			liveCheck: "not_checked",
			usability: "unknown",
			isUsable: false,
			fileSizeBytes: 0,
			path: accountFilePath
		};

		try {
			if (!fs.existsSync(accountFilePath)) {
				status.usability = "missing";
				return status;
			}

			const raw = fs.readFileSync(accountFilePath, "utf8");
			status.exists = true;
			status.fileSizeBytes = Buffer.byteLength(raw || "", "utf8");
			const stat = fs.statSync(accountFilePath);
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				status.usability = "invalid_json";
				return status;
			}

			status.validJson = true;
			status.cookieCount = parsed.length;
			const cookies = parsed.map(normalizeCookie).filter(item => item.key && item.value);
			status.hasCUser = cookies.some(item => item.key === "c_user");
			status.hasXs = cookies.some(item => item.key === "xs");
			status.missingRequiredCookies = ["c_user", "xs"].filter(k => !cookies.some(item => item.key === k));

			const nowSec = Math.floor(Date.now() / 1000);
			const expList = cookies
				.map(item => Number(item.expiresAtSec || 0))
				.filter(exp => Number.isFinite(exp) && exp > 0);

			if (expList.length) {
				const nearestExp = Math.min(...expList);
				status.expiresAt = new Date(nearestExp * 1000).toISOString();
				status.expiresInHours = Number(((nearestExp - nowSec) / 3600).toFixed(2));
				status.expiresSoonCount = expList.filter(exp => exp - nowSec <= 24 * 3600).length;
				status.expiredCookieCount = expList.filter(exp => exp <= nowSec).length;
			}

			const requiredCookies = cookies.filter(item => item.key === "c_user" || item.key === "xs");
			const hasExpiredRequiredCookie = requiredCookies.some(item => Number.isFinite(item.expiresAtSec) && item.expiresAtSec <= nowSec);

			if (status.missingRequiredCookies.length) {
				status.usability = "missing_required_cookie";
				status.liveCheck = "skipped";
			}
			else if (hasExpiredRequiredCookie) {
				status.usability = "expired_required_cookie";
				status.liveCheck = "skipped";
			}
			else if (liveCheck) {
				const cookieString = cookies.map(item => `${item.key}=${item.value}`).join("; ");
				const fingerprint = `${stat.mtimeMs}:${status.fileSizeBytes}:${status.cookieCount}`;
				if (appstateLiveCheckCache.fingerprint === fingerprint && Date.now() - appstateLiveCheckCache.checkedAt < 60 * 1000) {
					status.liveCheck = appstateLiveCheckCache.result;
				}
				else {
					const cookieIsUsable = await checkLiveCookie(cookieString, config.facebookAccount?.userAgent);
					status.liveCheck = cookieIsUsable ? "usable" : "expired_or_invalid";
					appstateLiveCheckCache.fingerprint = fingerprint;
					appstateLiveCheckCache.checkedAt = Date.now();
					appstateLiveCheckCache.result = status.liveCheck;
				}
				status.usability = status.liveCheck === "usable" ? "usable" : "expired_or_invalid";
			}
			else {
				status.liveCheck = "skipped";
				status.usability = "unknown";
			}
			status.isUsable = status.usability === "usable";
		}
		catch (e) {
			return status;
		}

		return status;
	}

	async function readAiStatus() {
		const key = (configCommands?.envCommands?.vance?.apiKey || process.env.GROQ_API_KEY || "").trim();
		const model = (configCommands?.envCommands?.vance?.model || process.env.GROQ_MODEL || "llama-3.1-8b-instant").trim();
		const result = {
			configured: !!key,
			maskedKey: key ? `${key.slice(0, 6)}...${key.slice(-4)}` : "",
			model,
			provider: "groq",
			check: "not_checked",
			error: null
		};

		if (!key)
			return result;

		try {
			const resp = await axios.get("https://api.groq.com/openai/v1/models", {
				timeout: 10000,
				headers: {
					Authorization: `Bearer ${key}`
				}
			});
			const models = Array.isArray(resp.data?.data) ? resp.data.data : [];
			result.check = models.some(item => item?.id === model) ? "ok" : "model_not_found";
		}
		catch (err) {
			result.check = "error";
			result.error = err?.response?.data?.error?.message || err?.response?.data?.error || err.message;
		}
		return result;
	}

	async function stopBotOnly() {
		if (!global.GoatBot?.Listening)
			return { stopped: false, message: "Bot is already stopped" };

		const stopFn = global.GoatBot?.fcaApi?.stopListening;
		if (typeof stopFn === "function") {
			await new Promise((resolve) => {
				try {
					stopFn(() => resolve());
				}
				catch (_e) {
					resolve();
				}
			});
		}

		global.GoatBot.Listening = null;
		return { stopped: true, message: "Bot listener stopped" };
	}


	// ROUTES & MIDDLWARE
	const {
		unAuthenticated,
		isWaitVerifyAccount,
		isAuthenticated,
		isAdmin,
		isVeryfiUserIDFacebook,
		checkHasAndInThread,
		middlewareCheckAuthConfigDashboardOfThread
	} = middleWare;

	const paramsForRoutes = {
		unAuthenticated, isWaitVerifyAccount, isAdmin, isAuthenticated,
		isVeryfiUserIDFacebook, checkHasAndInThread, middlewareCheckAuthConfigDashboardOfThread,

		isVerifyRecaptcha, validateEmail, randomNumberApikey, transporter,
		generateEmailVerificationCode, dashBoardData, expireVerifyCode, Passport, isVideoFile,

		threadsData, api, createLimiter, config, checkAuthConfigDashboardOfThread,
		imageExt, videoExt, audioExt, convertSize, drive, usersData
	};

	const registerRoute = require("./routes/register.js")(paramsForRoutes);
	const loginRoute = require("./routes/login.js")(paramsForRoutes);
	const forgotPasswordRoute = require("./routes/forgotPassword.js")(paramsForRoutes);
	const changePasswordRoute = require("./routes/changePassword.js")(paramsForRoutes);
	const dashBoardRoute = require("./routes/dashBoard.js")(paramsForRoutes);
	const verifyFbidRoute = require("./routes/verifyfbid.js")(paramsForRoutes);
	const apiRouter = require("./routes/api.js")(paramsForRoutes);

	app.get(["/", "/home"], (req, res) => {
		res.render("home");
	});

	app.get(["/health", "/healthz"], (req, res) => {
		res.status(200).send({
			status: "ok",
			timestamp: new Date().toISOString(),
			uptimeSec: Math.floor(process.uptime()),
			botStarted: !!global.GoatBot?.Listening,
			botStartInProgress: !!global.GoatBot?.bootingBotFromTrigger
		});
	});

	app.get("/gclass/connect", async (req, res) => {
		try {
			const state = String(req.query.state || "").trim();
			let senderID = "";
			let finalState = state;

			if (state) {
				const parsed = verifyConnectState(state);
				if (!parsed.ok)
					return res.status(400).send("Connect link expired or invalid. Please run gclass connect again.");
				senderID = String(parsed.sid);
			}
			else {
				// Backward compatibility for old sid/token links.
				const token = String(req.query.token || "").trim();
				const sid = String(req.query.sid || "").trim();
				if (!token || !sid)
					return res.status(400).send("Invalid connect link");

				const sessions = getGclassConnectSessions();
				const pending = sessions[token];
				if (!pending || String(pending.senderID) !== sid)
					return res.status(400).send("Connect link is invalid");
				if (Number(pending.expiresAt || 0) <= Date.now()) {
					delete sessions[token];
					return res.status(400).send("Connect link expired. Please run gclass connect again.");
				}
				senderID = sid;
				finalState = token;
			}

			const redirectUri = getGclassRedirectUri(req);
			const oauth2 = createOAuthClient(redirectUri);
			const authUrl = oauth2.generateAuthUrl({
				access_type: "offline",
				prompt: "consent",
				scope: OAUTH_SCOPES,
				state: finalState
			});
			return res.redirect(authUrl);
		}
		catch (e) {
			const redirectUri = getGclassRedirectUri(req);
			return res.status(500).send(`Cannot start Google connect flow. Configure this redirect URI in Google Cloud OAuth client:\n${redirectUri}\n\n${e.message || ""}`);
		}
	});

	app.get("/gclass/callback", async (req, res) => {
		const baseUrl = getPublicBaseUrlFromReq(req);
		const html = (title, body) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:Arial,sans-serif;padding:24px;max-width:680px;margin:0 auto;"><h2>${title}</h2><p>${body}</p><p>You can close this page and return to Messenger.</p></body></html>`;
		try {
			const oauthError = String(req.query.error || "").trim();
			const code = String(req.query.code || "").trim();
				const stateToken = String(req.query.state || "").trim();
				if (oauthError)
					return res.status(400).send(html("Google connect failed", `Error: ${oauthError}`));
				if (!code || !stateToken)
					return res.status(400).send(html("Google connect failed", "Missing callback parameters."));

				let senderID = "";
				const parsed = verifyConnectState(stateToken);
				if (parsed.ok) {
					senderID = String(parsed.sid);
				}
				else {
					// Backward compatibility for old memory-session state tokens.
					const sessions = getGclassConnectSessions();
					const pending = sessions[stateToken];
					if (!pending)
						return res.status(400).send(html("Google connect failed", "Session not found or expired."));
					if (Number(pending.expiresAt || 0) <= Date.now()) {
						delete sessions[stateToken];
						return res.status(400).send(html("Google connect failed", "Session expired. Run gclass connect again."));
					}
					senderID = String(pending.senderID);
					delete sessions[stateToken];
				}

				const redirectUri = getGclassRedirectUri(req);
				const oauth2 = createOAuthClient(redirectUri);
				const { tokens } = await oauth2.getToken(code);
			if (!tokens?.refresh_token) {
				const old = await getGclassUserToken(senderID);
				if (old?.refresh_token)
					tokens.refresh_token = old.refresh_token;
			}
				await setGclassUserToken(senderID, tokens);

			const botApi = api || global.GoatBot?.fcaApi;
			if (botApi?.sendMessage) {
				botApi.sendMessage(
					"Google Classroom connected successfully. You can now use: gclass tasks",
					senderID,
					() => {},
					true
				);
			}

			return res.status(200).send(html("Google connected", "Your Google Classroom account is now connected to this Messenger account."));
		}
		catch (e) {
			return res.status(500).send(html("Google connect failed", `${e.message || "Unexpected error"}\nRequired redirect URI: ${getGclassRedirectUri(req)}`));
		}
	});

	app.get("/stats", async (req, res) => {
		let fcaVersion;
		try {
			fcaVersion = require("fb-chat-api/package.json").version;
		}
		catch (e) {
			fcaVersion = "unknown";
		}

		const totalThread = (await threadsData.getAll()).filter(t => t.threadID.toString().length > 15).length;
		const totalUser = (await usersData.getAll()).length;
		const prefix = config.prefix;
		const uptime = utils.convertTime(process.uptime() * 1000);
		const appstate = await readAppstateStatus();
		const ai = await readAiStatus();

		res.render("stats", {
			fcaVersion,
			totalThread,
			totalUser,
			prefix,
			uptime,
			uptimeSecond: process.uptime(),
			appstate,
			ai
		});
	});

	app.get("/monitor", isAuthenticated, isAdmin, async (req, res) => {
		res.render("monitor", {
			appstate: await readAppstateStatus({ liveCheck: true }),
			ai: await readAiStatus(),
			runtimeLogs: runtimeLogState.lines,
			autoRefreshFbstate: !!config.autoRefreshFbstate,
			botStarted: !!global.GoatBot?.Listening,
			botStartInProgress: !!global.GoatBot?.bootingBotFromTrigger
		});
	});

	app.get("/admin/system/logs", isAuthenticated, isAdmin, (req, res) => {
		res.send({
			status: "success",
			lines: runtimeLogState.lines
		});
	});

	app.get("/admin/system/logs/stream", isAuthenticated, isAdmin, (req, res) => {
		if (runtimeLogState.clients.size >= runtimeLogState.maxClients)
			return res.status(429).send("Too many realtime log viewers");

		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache, no-transform");
		res.setHeader("Connection", "keep-alive");
		res.flushHeaders?.();
		res.write(":ok\n\n");

		runtimeLogState.clients.add(res);
		const heartbeat = setInterval(() => {
			try {
				res.write(":ping\n\n");
			}
			catch (_e) {
				clearInterval(heartbeat);
				runtimeLogState.clients.delete(res);
			}
		}, 25000);

		req.on("close", () => {
			clearInterval(heartbeat);
			runtimeLogState.clients.delete(res);
		});
	});

	app.post("/admin/system/secrets", isAuthenticated, isAdmin, async (req, res) => {
		try {
			const { appstate, geminiKey, aiApiKey } = req.body;
			let updated = [];

			if (typeof appstate === "string" && appstate.trim()) {
				let parsed;
				try {
					parsed = JSON.parse(appstate);
				}
				catch {
					return res.status(400).send({ status: "error", message: "AppState must be valid JSON" });
				}
				if (!Array.isArray(parsed))
					return res.status(400).send({ status: "error", message: "AppState JSON must be an array of cookies" });

				fs.writeFileSync(getAccountFilePath(), JSON.stringify(parsed, null, 2));
				updated.push("appstate");
			}

			const finalAiKey = typeof aiApiKey === "string" && aiApiKey.trim()
				? aiApiKey.trim()
				: typeof geminiKey === "string" && geminiKey.trim()
					? geminiKey.trim()
					: "";

			if (finalAiKey) {
				configCommands.envCommands = configCommands.envCommands || {};
				for (const commandName of ["vance", "vancetest", "cm", "croom", "gclass"]) {
					configCommands.envCommands[commandName] = configCommands.envCommands[commandName] || {};
					configCommands.envCommands[commandName].apiKey = finalAiKey;
					configCommands.envCommands[commandName].model = "llama-3.1-8b-instant";
					// keep compatibility for legacy configs that still read gemini* keys
					configCommands.envCommands[commandName].geminiApiKey = finalAiKey;
					configCommands.envCommands[commandName].geminiModel = "llama-3.1-8b-instant";
				}
				updated.push("aiApiKey");
			}

			if (updated.length === 0)
				return res.status(400).send({ status: "error", message: "No secret value provided" });

			saveConfigToDisk();
			saveConfigCommandsToDisk();
			return res.send({
				status: "success",
				message: `Updated: ${updated.join(", ")}`
			});
		}
		catch (e) {
			return res.status(500).send({ status: "error", message: e.message });
		}
	});

	app.post("/admin/system/restart", isAuthenticated, isAdmin, (req, res) => {
		res.send({ status: "success", message: "Restart signal sent" });
		res.on("finish", () => process.exit(2));
	});

	app.post("/admin/system/start", isAuthenticated, isAdmin, async (req, res) => {
		try {
			const action = String(req.body?.action || "").trim().toLowerCase();
			if (action === "stop_bot" || action === "stop") {
				const result = await stopBotOnly();
				return res.send({ status: "success", message: result.message });
			}

			if (action === "restart_bot" || action === "restart") {
				await stopBotOnly();

				if (global.GoatBot?.__loginBootstrapReady !== true) {
					for (let i = 0; i < 20 && global.GoatBot?.__loginBootstrapReady !== true; i++)
						await new Promise(resolve => setTimeout(resolve, 200));
				}

				if (typeof global.GoatBot?.reLoginBot !== "function" || global.GoatBot?.__loginBootstrapReady !== true)
					return res.status(500).send({ status: "error", message: "Bot restart handler is not available yet, please retry in 2-3 seconds." });

				await global.GoatBot.reLoginBot();
				return res.send({ status: "success", message: "Bot restarted" });
			}

			if (global.GoatBot?.Listening)
				return res.send({ status: "success", message: "Bot is already running" });

			// Wait briefly in case login bootstrap is still wiring runtime handlers.
			if (global.GoatBot?.__loginBootstrapReady !== true) {
				for (let i = 0; i < 20 && global.GoatBot?.__loginBootstrapReady !== true; i++)
					await new Promise(resolve => setTimeout(resolve, 200));
			}

			if (typeof global.GoatBot?.reLoginBot !== "function" || global.GoatBot?.__loginBootstrapReady !== true)
				return res.status(500).send({ status: "error", message: "Start handler is not available yet, please retry in 2-3 seconds." });

			await global.GoatBot.reLoginBot();
			return res.send({ status: "success", message: "Bot start triggered" });
		}
		catch (e) {
			return res.status(500).send({ status: "error", message: e.message });
		}
	});

	app.post("/admin/system/bot/stop", isAuthenticated, isAdmin, async (req, res) => {
		try {
			const result = await stopBotOnly();
			return res.send({ status: "success", message: result.message });
		}
		catch (e) {
			return res.status(500).send({ status: "error", message: e.message });
		}
	});

	const botStopAliasHandler = async (req, res) => {
		try {
			const result = await stopBotOnly();
			return res.send({ status: "success", message: result.message });
		}
		catch (e) {
			return res.status(500).send({ status: "error", message: e.message });
		}
	};
	app.post("/admin/system/stop-bot", isAuthenticated, isAdmin, botStopAliasHandler);
	app.post("/admin/bot/stop", isAuthenticated, isAdmin, botStopAliasHandler);

	app.post("/admin/system/bot/restart", isAuthenticated, isAdmin, async (req, res) => {
		try {
			await stopBotOnly();

			// Wait briefly in case login bootstrap is still wiring runtime handlers.
			if (global.GoatBot?.__loginBootstrapReady !== true) {
				for (let i = 0; i < 20 && global.GoatBot?.__loginBootstrapReady !== true; i++)
					await new Promise(resolve => setTimeout(resolve, 200));
			}

			if (typeof global.GoatBot?.reLoginBot !== "function" || global.GoatBot?.__loginBootstrapReady !== true)
				return res.status(500).send({ status: "error", message: "Bot restart handler is not available yet, please retry in 2-3 seconds." });

			await global.GoatBot.reLoginBot();
			return res.send({ status: "success", message: "Bot restarted" });
		}
		catch (e) {
			return res.status(500).send({ status: "error", message: e.message });
		}
	});

	const botRestartAliasHandler = async (req, res) => {
		try {
			await stopBotOnly();
			if (global.GoatBot?.__loginBootstrapReady !== true) {
				for (let i = 0; i < 20 && global.GoatBot?.__loginBootstrapReady !== true; i++)
					await new Promise(resolve => setTimeout(resolve, 200));
			}
			if (typeof global.GoatBot?.reLoginBot !== "function" || global.GoatBot?.__loginBootstrapReady !== true)
				return res.status(500).send({ status: "error", message: "Bot restart handler is not available yet, please retry in 2-3 seconds." });
			await global.GoatBot.reLoginBot();
			return res.send({ status: "success", message: "Bot restarted" });
		}
		catch (e) {
			return res.status(500).send({ status: "error", message: e.message });
		}
	};
	app.post("/admin/system/restart-bot", isAuthenticated, isAdmin, botRestartAliasHandler);
	app.post("/admin/bot/restart", isAuthenticated, isAdmin, botRestartAliasHandler);

	app.post("/admin/system/stop", isAuthenticated, isAdmin, (req, res) => {
		res.send({ status: "success", message: "Stop signal sent" });
		res.on("finish", () => process.exit(0));
	});

	app.get("/profile", isAuthenticated, async (req, res) => {
		res.render("profile", {
			userData: await usersData.get(req.user.facebookUserID) || {}
		});
	});

	app.get("/donate", (req, res) => res.render("donate"));

	app.get("/logout", (req, res, next) => {
		req.logout(function (err) {
			if (err)
				return next(err);
			res.redirect("/");
		});
	});

	app.post("/changefbstate", isAuthenticated, isVeryfiUserIDFacebook, (req, res) => {
		if (!global.GoatBot.config.adminBot.includes(req.user.facebookUserID))
			return res.send({
				status: "error",
				message: getText("app", "notPermissionChangeFbstate")
			});
		const { fbstate } = req.body;
		if (!fbstate)
			return res.send({
				status: "error",
				message: getText("app", "notFoundFbstate")
			});

		fs.writeFileSync(getAccountFilePath(), fbstate);
		res.send({
			status: "success",
			message: getText("app", "changedFbstateSuccess")
		});

		res.on("finish", () => {
			process.exit(2);
		});
	});
	app.get("/uptime", global.responseUptimeCurrent);

	app.get("/changefbstate", isAuthenticated, isVeryfiUserIDFacebook, isAdmin, (req, res) => {
		res.render("changeFbstate", {
			currentFbstate: fs.readFileSync(getAccountFilePath(), "utf8")
		});
	});

	app.use("/register", registerRoute);
	app.use("/login", loginRoute);
	app.use("/forgot-password", forgotPasswordRoute);
	app.use("/change-password", changePasswordRoute);
	app.use("/dashboard", dashBoardRoute);
	app.use("/verifyfbid", verifyFbidRoute);
	app.use("/api", apiRouter);

	app.get("*", (req, res) => {
		res.status(404).render("404");
	});

	// catch global error	
	app.use((err, req, res, next) => {
		if (err.message == "Login sessions require session support. Did you forget to use `express-session` middleware?")
			return res.status(500).send(getText("app", "serverError"));
	});

	const PORT = Number(process.env.PORT) || config.dashBoard.port || config.serverUptime.port || 3001;
	let runningPort = PORT;
	const listenServer = (port) => new Promise((resolve, reject) => {
		const onError = (err) => {
			server.off("listening", onListening);
			reject(err);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port);
	});

	try {
		await listenServer(runningPort);
	}
	catch (err) {
		if (err?.code !== "EADDRINUSE")
			throw err;

		let isListening = false;
		for (let i = 1; i <= 20; i++) {
			const fallbackPort = PORT + i;
			try {
				await listenServer(fallbackPort);
				runningPort = fallbackPort;
				isListening = true;
				utils.log.warn("DASHBOARD", `Port ${PORT} is busy, switched dashboard to port ${fallbackPort}`);
				break;
			}
			catch (fallbackErr) {
				if (fallbackErr?.code !== "EADDRINUSE")
					throw fallbackErr;
			}
		}

		if (!isListening) {
			utils.log.err("DASHBOARD", `Cannot start dashboard: ports ${PORT}-${PORT + 20} are all busy`);
			return;
		}
	}

	let dashBoardUrl = String(process.env.PUBLIC_URL || "").trim();
	if (!dashBoardUrl) {
		if (process.env.WEBSITE_HOSTNAME)
			dashBoardUrl = `https://${process.env.WEBSITE_HOSTNAME}`;
		else if (process.env.WEBSITE_SITE_NAME)
			dashBoardUrl = `https://${process.env.WEBSITE_SITE_NAME}.azurewebsites.net`;
		else if (process.env.REPL_OWNER)
			dashBoardUrl = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
		else if (process.env.API_SERVER_EXTERNAL == "https://api.glitch.com")
			dashBoardUrl = `https://${process.env.PROJECT_DOMAIN}.glitch.me`;
		else
			dashBoardUrl = `http://localhost:${runningPort}`;
	}
	dashBoardUrl = dashBoardUrl.replace(/\/+$/, "");
	global.GoatBot.dashboardPublicBaseUrl = dashBoardUrl;
	utils.log.info("DASHBOARD", `Dashboard is running: ${dashBoardUrl}`);
	if (config.serverUptime.socket.enable == true)
		require("../bot/login/socketIO.js")(server);
};

function randomStringApikey(max) {
	let text = "";
	const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let i = 0; i < max; i++)
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	return text;
}

function randomNumberApikey(maxLength) {
	let text = "";
	const possible = "0123456789";
	for (let i = 0; i < maxLength; i++)
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	return text;
}

function validateEmail(email) {
	const re = /^(([^<>()\[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
	return re.test(email);
}

function convertSize(byte) {
	return byte > 1024 ? byte > 1024 * 1024 ? (byte / 1024 / 1024).toFixed(2) + " MB" : (byte / 1024).toFixed(2) + " KB" : byte + " Byte";
}

