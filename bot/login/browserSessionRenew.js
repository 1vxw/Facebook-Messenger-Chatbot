const fs = require("fs-extra");
const path = require("path");

function normalizeCookiesForAccount(cookies = []) {
	return cookies
		.filter(cookie => ["c_user", "xs", "datr", "fr", "sb", "i_user"].includes(cookie.name))
		.map(cookie => ({
			key: cookie.name,
			value: cookie.value,
			domain: cookie.domain?.replace(/^\./, "") || "facebook.com",
			path: cookie.path || "/",
			hostOnly: !String(cookie.domain || "").startsWith("."),
			creation: new Date().toISOString(),
			lastAccessed: new Date().toISOString()
		}));
}

function parseExpiresToUnix(expires) {
	if (expires == null || expires === "" || expires === "Infinity")
		return -1;
	const asNumber = Number(expires);
	if (!Number.isNaN(asNumber))
		return asNumber > 10000000000 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
	const asDate = Date.parse(expires);
	if (Number.isNaN(asDate))
		return -1;
	return Math.floor(asDate / 1000);
}

function mapAccountToPlaywrightCookies(accountCookies = []) {
	return accountCookies
		.filter(item => item && item.key && typeof item.value !== "undefined")
		.map(item => {
			const hostOnly = item.hostOnly === true;
			let domain = String(item.domain || "facebook.com").replace(/^\./, "");
			if (!hostOnly)
				domain = `.${domain}`;
			return {
				name: String(item.key),
				value: String(item.value),
				domain,
				path: item.path || "/",
				secure: !!item.secure,
				httpOnly: !!item.httpOnly,
				expires: parseExpiresToUnix(item.expires)
			};
		});
}

async function seedContextFromAccountFile(context, accountFile) {
	try {
		if (!await fs.pathExists(accountFile))
			return false;
		const raw = await fs.readFile(accountFile, "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed) || !parsed.length)
			return false;
		const mapped = mapAccountToPlaywrightCookies(parsed);
		if (!mapped.length)
			return false;
		await context.addCookies(mapped);
		return true;
	}
	catch (_e) {
		return false;
	}
}

async function safeRequirePlaywright() {
	const nodeMajor = Number(process.versions.node.split(".")[0] || 0);
	if (nodeMajor < 18)
		return null;
	try {
		return require("playwright");
	}
	catch (_e) {
		try {
			return require("playwright-core");
		}
		catch (_e2) {
			return null;
		}
	}
}

module.exports = async function renewFromBrowserProfile(options = {}) {
	const {
		profileDir,
		accountFile,
		userAgent,
		headless = true,
		homeUrl = "https://m.facebook.com/",
		navTimeoutMs = 90000
	} = options;

	if (!profileDir || !accountFile)
		throw new Error("Missing profileDir/accountFile for browser renew");

	const playwright = await safeRequirePlaywright();
	if (!playwright)
		throw new Error("Browser renew requires Node.js >= 18 and Playwright (npm i playwright).");

	const chromium = playwright.chromium;
	await fs.ensureDir(profileDir);

	const context = await chromium.launchPersistentContext(path.resolve(profileDir), {
		headless: !!headless,
		viewport: { width: 1280, height: 720 },
		userAgent: userAgent || undefined
	});

	try {
		const seededFromAccount = await seedContextFromAccountFile(context, accountFile);
		const page = context.pages()[0] || await context.newPage();
		const targets = [homeUrl, "https://facebook.com/", "https://www.facebook.com/"];
		const seen = new Set();
		const navErrors = [];

		for (const target of targets) {
			const url = String(target || "").trim();
			if (!url || seen.has(url))
				continue;
			seen.add(url);
			try {
				await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeoutMs });
				await page.waitForTimeout(2000);
				break;
			}
			catch (err) {
				navErrors.push(`${url}: ${err.message || String(err)}`);
			}
		}

		const cookies = await context.cookies("https://www.facebook.com", "https://m.facebook.com");
		const appState = normalizeCookiesForAccount(cookies);

		const hasAuth = appState.some(c => c.key === "c_user") && appState.some(c => c.key === "xs");
		if (!hasAuth) {
			return {
				success: false,
				reason: "Browser profile is not logged in to Facebook (missing c_user/xs).",
				navigationErrors: navErrors
			};
		}

		await fs.writeFile(accountFile, JSON.stringify(appState, null, 2), "utf8");
		return {
			success: true,
			count: appState.length,
			seededFromAccount,
			navigationErrors: navErrors
		};
	}
	finally {
		await context.close();
	}
};
