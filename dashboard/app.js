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
	const { config } = global.GoatBot;
	const { expireVerifyCode } = config.dashBoard;
	const { gmailAccount } = config.credentials;

	const getText = global.utils.getText;

	const {
		email,
		clientId,
		clientSecret,
		refreshToken
	} = gmailAccount;

	const OAuth2 = google.auth.OAuth2;
	const OAuth2_client = new OAuth2(clientId, clientSecret);
	OAuth2_client.setCredentials({ refresh_token: refreshToken });
	let accessToken;
	try {
		accessToken = await OAuth2_client.getAccessToken();
	}
	catch (err) {
		throw new Error(getText("Goat", "googleApiRefreshTokenExpired"));
	}

	const transporter = nodemailer.createTransport({
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


	const {
		threadModel,
		userModel,
		dashBoardModel,
		threadsData,
		usersData,
		dashBoardData
	} = global.db;

	// Ensure hardcoded dashboard credentials exist for single-admin operation.
	try {
		const adminUser = await dashBoardData.get("admin");
		if (!adminUser) {
			const bcrypt = require("bcrypt");
			await dashBoardData.create({
				email: "admin",
				name: "Administrator",
				password: bcrypt.hashSync("admin", 10),
				facebookUserID: config.adminBot?.[0] || "",
				isAdmin: true
			});
			utils.log.warn("DASHBOARD", "Created default dashboard credentials: admin/admin");
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
	app.use(session({
		secret: randomStringApikey(10),
		resave: false,
		saveUninitialized: true,
		cookie: {
			secure: false,
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

	function readAppstateStatus() {
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
			fileSizeBytes: 0,
			path: accountFilePath
		};

		try {
			if (!fs.existsSync(accountFilePath))
				return status;

			const raw = fs.readFileSync(accountFilePath, "utf8");
			status.exists = true;
			status.fileSizeBytes = Buffer.byteLength(raw || "", "utf8");
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed))
				return status;

			status.validJson = true;
			status.cookieCount = parsed.length;
			status.hasCUser = parsed.some(item => item?.key === "c_user" && item?.value);
			status.hasXs = parsed.some(item => item?.key === "xs" && item?.value);

			const nowSec = Math.floor(Date.now() / 1000);
			const expList = parsed
				.map(item => Number(item?.expires || 0))
				.filter(exp => Number.isFinite(exp) && exp > 0);

			if (expList.length) {
				const nearestExp = Math.min(...expList);
				status.expiresAt = new Date(nearestExp * 1000).toISOString();
				status.expiresInHours = Number(((nearestExp - nowSec) / 3600).toFixed(2));
				status.expiresSoonCount = expList.filter(exp => exp - nowSec <= 24 * 3600).length;
			}
		}
		catch (e) {
			return status;
		}

		return status;
	}

	async function readGeminiStatus() {
		const key = (config.credentials?.gmailAccount?.apiKey || process.env.GEMINI_API_KEY || "").trim();
		const result = {
			configured: !!key,
			maskedKey: key ? `${key.slice(0, 6)}...${key.slice(-4)}` : "",
			check: "not_checked",
			error: null
		};

		if (!key)
			return result;

		try {
			const resp = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, {
				timeout: 10000
			});
			result.check = Array.isArray(resp.data?.models) ? "ok" : "unexpected_response";
		}
		catch (err) {
			result.check = "error";
			result.error = err?.response?.data?.error?.message || err.message;
		}
		return result;
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
		const appstate = readAppstateStatus();
		const gemini = await readGeminiStatus();

		res.render("stats", {
			fcaVersion,
			totalThread,
			totalUser,
			prefix,
			uptime,
			uptimeSecond: process.uptime(),
			appstate,
			gemini
		});
	});

	app.get("/monitor", isAuthenticated, isAdmin, async (req, res) => {
		res.render("monitor", {
			appstate: readAppstateStatus(),
			gemini: await readGeminiStatus(),
			autoRefreshFbstate: !!config.autoRefreshFbstate,
			botStarted: !!global.GoatBot?.Listening,
			botStartInProgress: !!global.GoatBot?.bootingBotFromTrigger
		});
	});

	app.post("/admin/system/secrets", isAuthenticated, isAdmin, async (req, res) => {
		try {
			const { appstate, geminiKey } = req.body;
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

			if (typeof geminiKey === "string" && geminiKey.trim()) {
				config.credentials.gmailAccount.apiKey = geminiKey.trim();
				updated.push("geminiKey");
			}

			if (updated.length === 0)
				return res.status(400).send({ status: "error", message: "No secret value provided" });

			saveConfigToDisk();
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

	let dashBoardUrl = `https://${process.env.REPL_OWNER
		? `${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`
		: process.env.API_SERVER_EXTERNAL == "https://api.glitch.com"
			? `${process.env.PROJECT_DOMAIN}.glitch.me`
			: `localhost:${runningPort}`}`;
	dashBoardUrl.includes("localhost") && (dashBoardUrl = dashBoardUrl.replace("https", "http"));
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

