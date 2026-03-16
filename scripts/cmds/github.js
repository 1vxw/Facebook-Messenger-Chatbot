const axios = require("axios");

const BASE_URL = "https://api.github.com";

function toInt(value, fallback) {
	const parsed = parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function clip(text, max = 600) {
	const value = String(text || "");
	if (value.length <= max)
		return value;
	return `${value.slice(0, max - 3)}...`;
}

function parseRepo(fullName) {
	const [owner, repo] = String(fullName || "").trim().split("/");
	if (!owner || !repo)
		return null;
	return { owner, repo };
}

function parsePipePayload(rawArgs) {
	const raw = rawArgs.join(" ").trim();
	if (!raw)
		return [];
	return raw.split("|").map(part => part.trim());
}

async function githubRequest({ token, method = "GET", endpoint, data, params }) {
	const headers = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "GoatBot-GitHub-Command"
	};

	if (token)
		headers.Authorization = `Bearer ${token}`;

	return axios({
		method,
		url: `${BASE_URL}${endpoint}`,
		headers,
		data,
		params,
		timeout: 20000
	});
}

function getToken(envCommands, commandName) {
	return (
		envCommands?.[commandName]?.token ||
		process.env.GITHUB_TOKEN ||
		""
	).trim();
}

module.exports = {
	config: {
		name: "github",
		version: "1.0",
		author: "Codex",
		countDown: 5,
		role: 0,
		description: {
			en: "GitHub API command with multiple actions"
		},
		category: "utility",
		guide: {
			en: "{pn} help\n"
				+ "{pn} user <username>\n"
				+ "{pn} repos <username> [page] [perPage]\n"
				+ "{pn} repo <owner/repo>\n"
				+ "{pn} issues <owner/repo> [open|closed|all] [limit]\n"
				+ "{pn} pulls <owner/repo> [open|closed|all] [limit]\n"
				+ "{pn} create-issue <owner/repo> | <title> | <body>\n"
				+ "{pn} close-issue <owner/repo> <issueNumber>\n"
				+ "{pn} comment <owner/repo> <issueNumber> | <comment>\n"
				+ "{pn} star <owner/repo>\n"
				+ "{pn} unstar <owner/repo>"
		},
		envConfig: {
			token: ""
		}
	},

	langs: {
		en: {
			help: "GitHub command actions:\n"
				+ "- user <username>\n"
				+ "- repos <username> [page] [perPage]\n"
				+ "- repo <owner/repo>\n"
				+ "- issues <owner/repo> [open|closed|all] [limit]\n"
				+ "- pulls <owner/repo> [open|closed|all] [limit]\n"
				+ "- create-issue <owner/repo> | <title> | <body>\n"
				+ "- close-issue <owner/repo> <issueNumber>\n"
				+ "- comment <owner/repo> <issueNumber> | <comment>\n"
				+ "- star <owner/repo>\n"
				+ "- unstar <owner/repo>\n\n"
				+ "Set token in configCommands.json -> envCommands -> github -> token\n"
				+ "or use env var GITHUB_TOKEN.",
			invalidAction: "Unknown action. Use: {pn}github help",
			missingArgs: "Missing arguments. Use: {pn}github help",
			tokenRequired: "This action needs a GitHub token (repo scope for private repos and write actions).",
			notFound: "Not found or no access.",
			noData: "No data found.",
			done: "Done.",
			error: "GitHub API error: %1"
		}
	},

	onStart: async function ({ message, args, getLang, commandName, envCommands, event }) {
		const action = (args[0] || "help").toLowerCase();
		const token = getToken(envCommands, commandName);
		const prefix = global.utils.getPrefix(event.threadID);

		try {
			if (action === "help")
				return message.reply(getLang("help"));

			if (action === "user") {
				const username = args[1];
				if (!username)
					return message.reply(getLang("missingArgs").replace("{pn}", prefix));
				const res = await githubRequest({ token, endpoint: `/users/${encodeURIComponent(username)}` });
				const u = res.data;
				return message.reply(
					`User: ${u.login}\n`
					+ `Name: ${u.name || "N/A"}\n`
					+ `Bio: ${clip(u.bio || "N/A", 220)}\n`
					+ `Public repos: ${u.public_repos}\n`
					+ `Followers: ${u.followers}\n`
					+ `Following: ${u.following}\n`
					+ `Profile: ${u.html_url}`
				);
			}

			if (action === "repos") {
				const username = args[1];
				if (!username)
					return message.reply(getLang("missingArgs").replace("{pn}", prefix));
				const page = Math.max(1, toInt(args[2], 1));
				const perPage = Math.min(20, Math.max(1, toInt(args[3], 5)));
				const res = await githubRequest({
					token,
					endpoint: `/users/${encodeURIComponent(username)}/repos`,
					params: { sort: "updated", direction: "desc", page, per_page: perPage }
				});
				const repos = Array.isArray(res.data) ? res.data : [];
				if (!repos.length)
					return message.reply(getLang("noData"));
				const lines = repos.map((r, i) =>
					`${i + 1}. ${r.full_name} | ${r.stargazers_count} stars | ${r.forks_count} forks`
				);
				return message.reply(`Repos of ${username} (page ${page}):\n${lines.join("\n")}`);
			}

			if (action === "repo") {
				const parsed = parseRepo(args[1]);
				if (!parsed)
					return message.reply(getLang("missingArgs").replace("{pn}", prefix));
				const res = await githubRequest({ token, endpoint: `/repos/${parsed.owner}/${parsed.repo}` });
				const r = res.data;
				return message.reply(
					`Repo: ${r.full_name}\n`
					+ `Visibility: ${r.private ? "private" : "public"}\n`
					+ `Default branch: ${r.default_branch}\n`
					+ `Language: ${r.language || "N/A"}\n`
					+ `Stars: ${r.stargazers_count} | Forks: ${r.forks_count} | Open issues: ${r.open_issues_count}\n`
					+ `Description: ${clip(r.description || "N/A", 240)}\n`
					+ `URL: ${r.html_url}`
				);
			}

			if (action === "issues" || action === "pulls") {
				const parsed = parseRepo(args[1]);
				if (!parsed)
					return message.reply(getLang("missingArgs").replace("{pn}", prefix));
				const state = ["open", "closed", "all"].includes((args[2] || "").toLowerCase()) ? args[2].toLowerCase() : "open";
				const limit = Math.min(15, Math.max(1, toInt(args[3], 5)));
				const endpoint = action === "issues" ? `/repos/${parsed.owner}/${parsed.repo}/issues` : `/repos/${parsed.owner}/${parsed.repo}/pulls`;
				const res = await githubRequest({
					token,
					endpoint,
					params: { state, per_page: limit }
				});
				const list = Array.isArray(res.data) ? res.data : [];
				const filtered = action === "issues" ? list.filter(item => !item.pull_request) : list;
				if (!filtered.length)
					return message.reply(getLang("noData"));
				const lines = filtered.map(item =>
					`#${item.number} [${item.state}] ${clip(item.title, 100)}`
				);
				return message.reply(`${action === "issues" ? "Issues" : "Pull Requests"} (${parsed.owner}/${parsed.repo}, ${state}):\n${lines.join("\n")}`);
			}

			if (action === "create-issue") {
				if (!token)
					return message.reply(getLang("tokenRequired"));
				const payload = parsePipePayload(args.slice(1));
				const parsed = parseRepo(payload[0]);
				const title = payload[1];
				const body = payload[2] || "";
				if (!parsed || !title)
					return message.reply(getLang("missingArgs").replace("{pn}", prefix));
				const res = await githubRequest({
					token,
					method: "POST",
					endpoint: `/repos/${parsed.owner}/${parsed.repo}/issues`,
					data: { title, body }
				});
				return message.reply(`Created issue #${res.data.number}: ${res.data.html_url}`);
			}

			if (action === "close-issue") {
				if (!token)
					return message.reply(getLang("tokenRequired"));
				const parsed = parseRepo(args[1]);
				const issueNumber = toInt(args[2], 0);
				if (!parsed || !issueNumber)
					return message.reply(getLang("missingArgs").replace("{pn}", prefix));
				const res = await githubRequest({
					token,
					method: "PATCH",
					endpoint: `/repos/${parsed.owner}/${parsed.repo}/issues/${issueNumber}`,
					data: { state: "closed" }
				});
				return message.reply(`Closed issue #${res.data.number}: ${res.data.html_url}`);
			}

			if (action === "comment") {
				if (!token)
					return message.reply(getLang("tokenRequired"));
				const payload = parsePipePayload(args.slice(1));
				const first = (payload[0] || "").split(" ");
				const parsed = parseRepo(first[0]);
				const issueNumber = toInt(first[1], 0);
				const body = payload[1];
				if (!parsed || !issueNumber || !body)
					return message.reply(getLang("missingArgs").replace("{pn}", prefix));
				const res = await githubRequest({
					token,
					method: "POST",
					endpoint: `/repos/${parsed.owner}/${parsed.repo}/issues/${issueNumber}/comments`,
					data: { body }
				});
				return message.reply(`Comment added: ${res.data.html_url}`);
			}

			if (action === "star" || action === "unstar") {
				if (!token)
					return message.reply(getLang("tokenRequired"));
				const parsed = parseRepo(args[1]);
				if (!parsed)
					return message.reply(getLang("missingArgs").replace("{pn}", prefix));
				await githubRequest({
					token,
					method: action === "star" ? "PUT" : "DELETE",
					endpoint: `/user/starred/${parsed.owner}/${parsed.repo}`
				});
				return message.reply(getLang("done"));
			}

			return message.reply(getLang("invalidAction").replace("{pn}", prefix));
		}
		catch (error) {
			const status = error?.response?.status;
			const details = error?.response?.data?.message || error.message || "Unknown error";
			if (status === 404)
				return message.reply(getLang("notFound"));
			return message.reply(getLang("error", details));
		}
	}
};
