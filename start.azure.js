const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function readConfig() {
	try {
		const raw = fs.readFileSync(path.join(process.cwd(), "config.json"), "utf8");
		return JSON.parse(raw);
	}
	catch (_e) {
		return {};
	}
}

function installPlaywrightChromium() {
	const cliPath = path.join(process.cwd(), "node_modules", "playwright", "cli.js");
	if (!fs.existsSync(cliPath)) {
		console.log("[AZURE_START] Playwright CLI not found, skipping browser install.");
		return;
	}

	console.log("[AZURE_START] Installing Playwright chromium...");
	const res = spawnSync(process.execPath, [cliPath, "install", "chromium"], {
		stdio: "inherit",
		env: process.env
	});

	if (res.status !== 0)
		console.log(`[AZURE_START] Playwright install returned code ${res.status}, continuing startup.`);
}

function startBot() {
	const entry = path.join(process.cwd(), "index.js");
	const child = spawnSync(process.execPath, [entry], {
		stdio: "inherit",
		env: process.env
	});
	process.exit(child.status || 0);
}

const config = readConfig();
const browserRenewEnabled = config?.facebookAccount?.browserRenew?.enable === true;
if (browserRenewEnabled)
	installPlaywrightChromium();
else
	console.log("[AZURE_START] browserRenew disabled, skipping Playwright install.");

startBot();

