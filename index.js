/**
 * @author Vince Pradas
 * Official source code: https://github.com/1vxw
 */

const { spawn } = require("child_process");
const log = require("./logger/log.js");

function startProject() {
	const child = spawn("node", ["Goat.js"], {
		cwd: __dirname,
		stdio: "inherit",
		shell: true,
		env: {
			...process.env,
			// Default to dashboard-first boot so secrets can be injected before bot login starts.
			DASHBOARD_FIRST_BOOT: process.env.DASHBOARD_FIRST_BOOT || "1"
		}
	});

	child.on("close", (code) => {
		if (code == 2) {
			log.info("Restarting Project...");
			startProject();
		}
	});
}

startProject();
