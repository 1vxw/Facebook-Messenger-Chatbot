

const axios = require("axios");

const maxStorageMessage = 4;
const groqApiBase = "https://api.groq.com/openai/v1";

if (!global.temp)
	global.temp = {};
if (!global.temp.geminiUsing)
	global.temp.geminiUsing = {};
if (!global.temp.geminiHistory)
	global.temp.geminiHistory = {};
if (!global.temp.geminiModelCache)
	global.temp.geminiModelCache = {};
if (!global.temp.vanceSentMessages)
	global.temp.vanceSentMessages = {};

const { geminiUsing, geminiHistory } = global.temp;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function sanitizeOutput(text) {
	if (!text)
		return text;

	return String(text)
		// remove explicit id fields
		.replace(/\(\s*id\s*:\s*[^)]+\)/gi, "")
		.replace(/\b(?:userID|threadID|id)\s*:\s*\d+\b/gi, "")
		// remove markdown asterisks
		.replace(/\*\*/g, "")
		.replace(/\*/g, "")
		// clean spacing artifacts
		.replace(/[ \t]{2,}/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}


async function buildThreadContext(event, threadsData) {
	if (!event?.threadID || !threadsData)
		return "";

	try {
		const threadData = await threadsData.get(event.threadID);
		const members = Array.isArray(threadData?.members) ? threadData.members : [];
		const topMembers = members.slice(0, 50).map((m, idx) => {
			const name = m?.name || "Unknown";
			const userID = m?.userID || "unknown";
			const nickname = m?.nickname ? `, nickname: ${m.nickname}` : "";
			return `${idx + 1}. ${name} (id: ${userID}${nickname})`;
		});

		const mentions = event?.mentions && typeof event.mentions === "object"
			? Object.entries(event.mentions).map(([id, name]) => `${name.replace(/^@/, "")} (id: ${id})`)
			: [];

		let context = `Group thread id: ${event.threadID}\n`;
		if (topMembers.length)
			context += `Known participants (up to 50):\n${topMembers.join("\n")}\n`;
		if (mentions.length)
			context += `Mentioned in this message: ${mentions.join(", ")}\n`;

		return context.trim();
	}
	catch (_e) {
		return "";
	}
}

async function buildUserInfoContext(event, api) {
	if (!api || !event)
		return "";

	const ids = new Set();
	if (event.senderID)
		ids.add(String(event.senderID));
	if (event.mentions && typeof event.mentions === "object")
		for (const id of Object.keys(event.mentions))
			ids.add(String(id));

	if (!ids.size)
		return "";

	const lines = [];
	for (const uid of ids) {
		try {
			const result = await api.getUserInfo(uid);
			const info = result?.[uid] || {};
			const name = info?.name || "Unknown";
			const vanity = info?.vanity ? `, vanity: ${info.vanity}` : "";
			const gender = typeof info?.gender !== "undefined" ? `, gender: ${info.gender}` : "";
			const type = info?.type ? `, type: ${info.type}` : "";
			const isFriend = typeof info?.isFriend !== "undefined" ? `, isFriend: ${info.isFriend}` : "";
			lines.push(`- ${name} (id: ${uid}${vanity}${gender}${type}${isFriend})`);
		}
		catch (_e) {
			lines.push(`- id: ${uid} (public profile info unavailable)`);
		}
	}

	if (!lines.length)
		return "";
	return `User profile info (from Facebook API, fields may be partial):\n${lines.join("\n")}`;
}

async function generateVanceText({ prompt, event, senderID, commandName, envCommands, threadsData, api, getLang }) {
	const apiKey = envCommands?.[commandName]?.apiKey || process.env.GROQ_API_KEY || "";
	const preferredModel = envCommands?.[commandName]?.model || process.env.GROQ_MODEL || "llama-3.1-8b-instant";

	if (!apiKey)
		throw new Error(getLang("apiKeyEmpty"));
	if (!prompt || !String(prompt).trim())
		throw new Error(getLang("invalidContent"));
	if (geminiUsing[senderID])
		throw new Error(getLang("yourAreUsing"));

	geminiUsing[senderID] = true;
	try {
		const normalizedPrompt = String(prompt).trim();
		const history = Array.isArray(geminiHistory[senderID]) ? geminiHistory[senderID] : [];
		const threadContext = await buildThreadContext(event, threadsData);
		const userInfoContext = await buildUserInfoContext(event, api);

		const contextChunks = [threadContext, userInfoContext].filter(Boolean);
		const finalPrompt = contextChunks.length
			? `You are Vance, a general AI assistant in Messenger.\nAnswer any normal question directly.\nWhen the user asks about people/groups, use the context below.\nIf specific profile/group data is missing, say it's unavailable, but still answer the rest of the request.\n\nContext:\n${contextChunks.join("\n\n")}\n\nUser request: ${normalizedPrompt}`
			: `You are Vance, a helpful general AI assistant in Messenger.\nUser request: ${normalizedPrompt}`;

		const messages = [];
		messages.push({
			role: "system",
			content: "You are Vance, a helpful general AI assistant in Messenger."
		});
		for (const item of history) {
			if (!item?.role || !item?.content)
				continue;
			messages.push({
				role: item.role === "assistant" ? "assistant" : "user",
				content: String(item.content)
			});
		}
		messages.push({
			role: "user",
			content: finalPrompt
		});

		const response = await axios.post(`${groqApiBase}/chat/completions`, {
			model: preferredModel,
			messages,
			max_tokens: 500,
			temperature: 0.5
		}, {
			timeout: 60000,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json"
			}
		});

		const rawText = response?.data?.choices?.[0]?.message?.content?.trim() || "";
		const text = sanitizeOutput(rawText);
		if (!text)
			throw new Error("Empty response from Groq API");

		if (!Array.isArray(geminiHistory[senderID]))
			geminiHistory[senderID] = [];

		geminiHistory[senderID].push(
			{ role: "user", content: normalizedPrompt },
			{ role: "assistant", content: text }
		);

		while (geminiHistory[senderID].length > maxStorageMessage * 2)
			geminiHistory[senderID].shift();

		return text;
	}
	finally {
		delete geminiUsing[senderID];
	}
}

async function replyAndRegister({ message, text, event, commandName }) {
	const sent = await message.reply(text);
	if (sent?.messageID) {
		const threadID = String(event.threadID || "");
		if (!global.temp.vanceSentMessages[threadID])
			global.temp.vanceSentMessages[threadID] = [];
		global.temp.vanceSentMessages[threadID].push({
			id: sent.messageID,
			ts: Date.now()
		});
		if (global.temp.vanceSentMessages[threadID].length > 300)
			global.temp.vanceSentMessages[threadID] = global.temp.vanceSentMessages[threadID].slice(-300);

		global.GoatBot.onReply.set(sent.messageID, {
			commandName,
			messageID: sent.messageID,
			author: event.senderID,
			type: "continueVance"
		});
	}
	return sent;
}

async function clearVanceMessages({ api, threadID, maxCount }) {
	const key = String(threadID || "");
	const allRaw = global.temp.vanceSentMessages[key] || [];
	const all = allRaw.map(item => typeof item === "string" ? { id: item, ts: 0 } : item).filter(item => item?.id);
	if (!all.length)
		return 0;

	const now = Date.now();
	const dayScoped = all.filter(item => item.ts && now - item.ts <= ONE_DAY_MS);
	if (!dayScoped.length)
		return 0;

	const take = Math.max(1, Math.min(300, parseInt(maxCount, 10) || dayScoped.length));
	const targets = dayScoped.slice(-take);
	let removed = 0;
	for (let i = targets.length - 1; i >= 0; i--) {
		try {
			await api.unsendMessage(targets[i].id);
			removed++;
		}
		catch (_e) {}
	}
	const targetIds = new Set(targets.map(t => t.id));
	global.temp.vanceSentMessages[key] = all.filter(item => !targetIds.has(item.id));
	return removed;
}

module.exports = {
	config: {
		name: "vance",
		version: "1.3",
		author: "VincePradas",
		countDown: 5,
		role: 0,
		description: {
			vi: "Groq chat",
			en: "Groq chat"
		},
		category: "box chat",
		guide: {
			vi: "   {pn} <noi dung> - chat voi Groq",
			en: "   {pn} <content> - chat with Groq"
		},
		envConfig: {
			apiKey: "",
			model: "llama-3.1-8b-instant"
		}
	},

	langs: {
		vi: {
			apiKeyEmpty: "Vui long them Groq API key trong configCommands.json -> envCommands -> vance -> apiKey",
			yourAreUsing: "Ban dang su dung Groq chat, vui long doi yeu cau truoc ket thuc",
			invalidContent: "Vui long nhap noi dung ban muon chat",
			cleared: "Da xoa %1 tin nhan cua Vance trong doan chat nay",
			noMessagesToClear: "Khong co tin nhan Vance nao trong 24 gio gan day de xoa",
			adminOnlyClear: "Chi admin bot moi co the xoa tin nhan cua Vance",
			replyOwnerOnly: "Chi nguoi bat dau hoi dap moi co the tiep tuc bang reply",
			error: "Da co loi xay ra\n%1"
		},
		en: {
			apiKeyEmpty: "Please set Groq API key in configCommands.json -> envCommands -> vance -> apiKey",
			yourAreUsing: "Pending request for vance, please wait until the previous request ends",
			invalidContent: "Please enter the content you want to chat",
			cleared: "Removed %1 Vance message(s) in this thread",
			noMessagesToClear: "No Vance messages from the last 24 hours to remove in this thread",
			adminOnlyClear: "Only bot admins can clear Vance messages",
			replyOwnerOnly: "Only the original requester can continue this vance thread by reply",
			error: "An error has occurred\n%1"
		}
	},

	onStart: async function ({ message, event, args, getLang, envCommands, commandName, threadsData, api, role }) {
		const first = (args[0] || "").toLowerCase();
		if (first === "clear" || first === "cleanup") {
			if (role < 2)
				return message.reply(getLang("adminOnlyClear"));
			const countArg = args[1];
			const removed = await clearVanceMessages({
				api,
				threadID: event.threadID,
				maxCount: countArg
			});
			return message.reply(removed ? getLang("cleared", removed) : getLang("noMessagesToClear"));
		}

		try {
			const text = await generateVanceText({
				prompt: args.join(" "),
				event,
				senderID: event.senderID,
				commandName,
				envCommands,
				threadsData,
				api,
				getLang
			});
			return await replyAndRegister({ message, text, event, commandName });
		}
		catch (err) {
			const details = err?.response?.data?.error?.message || err.message || "Unknown error";
			return message.reply(getLang("error", details));
		}
	},

	onReply: async function ({ event, Reply, message, getLang, envCommands, commandName, threadsData, api }) {
		if (Reply.type !== "continueVance")
			return;
		if (event.senderID !== Reply.author)
			return message.reply(getLang("replyOwnerOnly"));

		try {
			const text = await generateVanceText({
				prompt: event.body || "",
				event,
				senderID: event.senderID,
				commandName,
				envCommands,
				threadsData,
				api,
				getLang
			});
			return await replyAndRegister({ message, text, event, commandName });
		}
		catch (err) {
			const details = err?.response?.data?.error?.message || err.message || "Unknown error";
			return message.reply(getLang("error", details));
		}
	}
};
