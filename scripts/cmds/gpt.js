const axios = require("axios");
const { Readable } = require("stream");

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

function getConversationKey(senderID, threadID) {
	return `${String(threadID || "unknown_thread")}::${String(senderID || "unknown_user")}`;
}

function parseAudioMode(input = "") {
	const raw = String(input || "");
	const hasAudioFlag = /(^|\s)-a(?=\s|$)/i.test(raw);
	const cleanedPrompt = raw
		.replace(/(^|\s)-a(?=\s|$)/ig, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	return { hasAudioFlag, cleanedPrompt };
}

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

function collectImageAttachments(event) {
	const buckets = [];
	if (Array.isArray(event?.attachments))
		buckets.push(...event.attachments);
	if (Array.isArray(event?.messageReply?.attachments))
		buckets.push(...event.messageReply.attachments);

	const images = [];
	for (const item of buckets) {
		if (!item || typeof item !== "object")
			continue;
		const type = String(item.type || item.mimeType || "").toLowerCase();
		const candidates = [
			item.url,
			item.previewUrl,
			item.largePreviewUrl,
			item.thumbnailUrl,
			item?.imageMetadata?.url,
			item?.imageData?.url
		].filter(Boolean);
		if (!candidates.length)
			continue;
		const url = String(candidates[0]);
		const looksLikeImage = type.includes("photo")
			|| type.includes("image")
			|| /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url);
		if (!looksLikeImage)
			continue;
		images.push({
			url,
			name: item.filename || item.name || ""
		});
	}
	return images;
}

async function toInlineImageDataUrl(url) {
	if (!url || typeof url !== "string")
		return null;
	try {
		const res = await axios.get(url, {
			responseType: "arraybuffer",
			timeout: 15000,
			maxContentLength: 6 * 1024 * 1024
		});
		const mime = String(res?.headers?.["content-type"] || "").toLowerCase();
		const safeMime = mime.startsWith("image/") ? mime : "image/jpeg";
		const b64 = Buffer.from(res.data).toString("base64");
		if (!b64)
			return null;
		return `data:${safeMime};base64,${b64}`;
	}
	catch (_e) {
		return null;
	}
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
			? Object.entries(event.mentions).map(([id, name]) => `${String(name).replace(/^@/, "")} (id: ${id})`)
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

async function generateVanceText({ prompt, event, senderID, commandName, envCommands, threadsData, api, getLang, audioMode = false }) {
	const apiKey = envCommands?.[commandName]?.apiKey || process.env.GROQ_API_KEY || "";
	const preferredModel = envCommands?.[commandName]?.model || process.env.GROQ_MODEL || "";
	const imageAttachments = collectImageAttachments(event);
	const hasImageContext = imageAttachments.length > 0;
	const canUseVision = hasImageContext;
	const conversationKey = getConversationKey(senderID, event?.threadID);

	if (!apiKey)
		throw new Error(getLang("apiKeyEmpty"));
	if (!preferredModel)
		throw new Error(getLang("modelEmpty"));
	if ((!prompt || !String(prompt).trim()) && !hasImageContext)
		throw new Error(getLang("invalidContent"));
	if (geminiUsing[conversationKey])
		throw new Error(getLang("yourAreUsing"));

	geminiUsing[conversationKey] = true;
	try {
		const normalizedPrompt = String(prompt || "").trim() || "Please analyze the replied image and explain what you can see.";
		const history = Array.isArray(geminiHistory[conversationKey]) ? geminiHistory[conversationKey] : [];
		const threadContext = await buildThreadContext(event, threadsData);
		const userInfoContext = await buildUserInfoContext(event, api);
		const imageContext = hasImageContext
			? `Image context (${imageAttachments.length}):\n${imageAttachments.map((img, i) => `${i + 1}. ${img.url}${img.name ? ` (name: ${img.name})` : ""}`).join("\n")}`
			: "";

		const contextChunks = [threadContext, userInfoContext, imageContext].filter(Boolean);
		const responseStyleInstruction = audioMode
			? "Audio mode is enabled. Reply briefly in 1-3 short sentences, prioritize direct answer first, avoid long lists, and keep it natural for speech."
			: "";
		const finalPrompt = contextChunks.length
			? `You are Vance, a general AI assistant in Messenger.\nAnswer any normal question directly.\nWhen the user asks about people/groups, use the context below.\nIf specific profile/group data is missing, say it's unavailable, but still answer the rest of the request.\n${responseStyleInstruction}\n\nContext:\n${contextChunks.join("\n\n")}\n\nUser request: ${normalizedPrompt}`
			: `You are Vance, a helpful general AI assistant in Messenger.\n${responseStyleInstruction}\nUser request: ${normalizedPrompt}`;

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
		if (canUseVision) {
			const userContent = [{ type: "text", text: finalPrompt }];
			for (const image of imageAttachments.slice(0, 4)) {
				const inlineUrl = await toInlineImageDataUrl(image.url);
				userContent.push({
					type: "image_url",
					image_url: { url: inlineUrl || image.url }
				});
			}
			messages.push({
				role: "user",
				content: userContent
			});
		}
		else {
			messages.push({
				role: "user",
				content: finalPrompt
			});
		}

		const response = await axios.post(`${groqApiBase}/chat/completions`, {
			model: preferredModel,
			messages,
			max_tokens: audioMode ? 180 : 500,
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

		if (!Array.isArray(geminiHistory[conversationKey]))
			geminiHistory[conversationKey] = [];

		geminiHistory[conversationKey].push(
			{ role: "user", content: normalizedPrompt },
			{ role: "assistant", content: text }
		);

		while (geminiHistory[conversationKey].length > maxStorageMessage * 2)
			geminiHistory[conversationKey].shift();

		return text;
	}
	finally {
		delete geminiUsing[conversationKey];
	}
}

async function sendReplyWithInfo(message, form) {
	return await new Promise(async (resolve, reject) => {
		let settled = false;
		const finish = (err, info) => {
			if (settled)
				return;
			settled = true;
			if (err)
				reject(err);
			else
				resolve(info || null);
		};
		try {
			const maybe = await message.reply(form, finish);
			if (maybe?.messageID)
				finish(null, maybe);
		}
		catch (err) {
			finish(err);
		}
		setTimeout(() => {
			if (!settled)
				resolve(null);
		}, 5000);
	});
}

function escapeXml(value = "") {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function normalizeAzureRate(rawRate) {
	const val = String(rawRate || "").trim();
	if (!val)
		return "0%";
	if (/^[+-]?\d+%$/.test(val))
		return val;
	const n = Number(val);
	if (!Number.isFinite(n))
		return "0%";
	if (n > 0 && n < 3) {
		const pct = Math.round((n - 1) * 100);
		return `${pct >= 0 ? "+" : ""}${pct}%`;
	}
	const pct = Math.round(n);
	return `${pct >= 0 ? "+" : ""}${pct}%`;
}

function normalizeAzureVoice(rawVoice) {
	const val = String(rawVoice || "").trim();
	if (!val)
		return "en-US-GuyNeural";
	if (/^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(val))
		return val;
	// Accept legacy or invalid values and force a stable male neural voice.
	return "en-US-GuyNeural";
}

function parseAzureError(err) {
	const status = err?.response?.status;
	const body = err?.response?.data;
	let detail = "";
	if (Buffer.isBuffer(body))
		detail = body.toString("utf8");
	else if (typeof body === "string")
		detail = body;
	else if (body && typeof body === "object")
		detail = body?.error?.message || body?.message || JSON.stringify(body);
	else
		detail = err?.message || "Unknown Azure TTS error";
	detail = String(detail).replace(/\s+/g, " ").trim();
	return status ? `HTTP ${status}: ${detail}` : detail;
}

async function getAzureTTSStream({ text }) {
	const subscriptionKey = String(process.env.AZURE_SPEECH_KEY || "").trim();
	const region = String(process.env.AZURE_SPEECH_REGION || "").trim();
	const endpointFromEnv = String(process.env.AZURE_SPEECH_ENDPOINT || "").trim().replace(/\/+$/, "");
	if (!subscriptionKey)
		throw new Error("Missing AZURE_SPEECH_KEY");
	if (!region && !endpointFromEnv)
		throw new Error("Missing AZURE_SPEECH_REGION (or AZURE_SPEECH_ENDPOINT)");

	const endpoint = endpointFromEnv || `https://${region}.tts.speech.microsoft.com`;
	const voice = normalizeAzureVoice(process.env.VANCE_TTS_VOICE);
	const rate = normalizeAzureRate(process.env.VANCE_TTS_RATE || process.env.VANCE_TTS_SPEED || "1.15");
	const outputFormat = String(process.env.VANCE_TTS_AUDIO_FORMAT || "audio-24khz-48kbitrate-mono-mp3").trim();
	const language = String(process.env.VANCE_TTS_LOCALE || "en-US").trim();
	const ssml = [
		`<speak version='1.0' xml:lang='${escapeXml(language)}'>`,
		`<voice name='${escapeXml(voice)}'>`,
		`<prosody rate='${escapeXml(rate)}'>${escapeXml(text)}</prosody>`,
		"</voice>",
		"</speak>"
	].join("");

	let response;
	try {
		response = await axios.post(`${endpoint}/cognitiveservices/v1`, ssml, {
			timeout: 30000,
			responseType: "arraybuffer",
			headers: {
				"Ocp-Apim-Subscription-Key": subscriptionKey,
				"Content-Type": "application/ssml+xml",
				"X-Microsoft-OutputFormat": outputFormat,
				"User-Agent": "vance-bot"
			}
		});
	}
	catch (err) {
		throw new Error(parseAzureError(err));
	}

	const data = Buffer.from(response.data || []);
	if (!data.length)
		throw new Error("Azure TTS returned empty audio");

	const stream = Readable.from(data);
	stream.path = "vance.mp3";
	return stream;
}

async function sendAudioReplyWithInfo({ message, text }) {
	const compact = String(text || "")
		.replace(/\n+/g, ". ")
		.replace(/\s{2,}/g, " ")
		.trim();
	const maxSpeechChars = Math.max(80, Math.min(400, parseInt(process.env.VANCE_TTS_MAX_CHARS || "180", 10) || 180));
	const speechText = compact.slice(0, maxSpeechChars) || "No response.";
	const azureAudio = await getAzureTTSStream({ text: speechText });
	return await sendReplyWithInfo(message, {
		body: text,
		attachment: azureAudio
	});
}

function startTypingIndicator(api, threadID) {
	if (!api || typeof api.sendTypingIndicator !== "function" || !threadID)
		return () => {};
	let stopper = null;
	try {
		const ret = api.sendTypingIndicator(threadID, true);
		if (typeof ret === "function")
			stopper = ret;
	}
	catch (_e) {
		try {
			const ret = api.sendTypingIndicator(threadID);
			if (typeof ret === "function")
				stopper = ret;
		}
		catch (_err) {}
	}
	return () => {
		try {
			if (typeof stopper === "function")
				stopper();
		}
		catch (_e) {}
	};
}

function registerVanceReply(sent, event, commandName) {
	if (!sent?.messageID)
		return;
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
		threadID: event.threadID,
		type: "continueVance"
	});
}

async function replyAndRegister({ message, text, event, commandName }) {
	const sent = await sendReplyWithInfo(message, text);
	registerVanceReply(sent, event, commandName);
	return sent;
}

async function replyAudioAndRegister({ message, text, event, commandName }) {
	const sent = await sendAudioReplyWithInfo({ message, text });
	registerVanceReply(sent, event, commandName);
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
		version: "1.6",
		author: "VincePradas",
		countDown: 5,
		role: 0,
		description: {
			en: "Groq chat"
		},
		category: "box chat",
		guide: {
			en: "   {pn} <content> - chat with Groq"
		},
		envConfig: {
			apiKey: "",
			model: ""
		}
	},

	langs: {
		en: {
			apiKeyEmpty: "Please set Groq API key in configCommands.json -> envCommands -> vance -> apiKey",
			modelEmpty: "Please set Groq model in configCommands.json -> envCommands -> vance -> model (or environment variable GROQ_MODEL)",
			yourAreUsing: "Pending request for vance, please wait until the previous request ends",
			invalidContent: "Please enter the content you want to chat",
			cleared: "Removed %1 Vance message(s) in this thread",
			noMessagesToClear: "No Vance messages from the last 24 hours to remove in this thread",
			adminOnlyClear: "Only bot admins can clear Vance messages",
			replyOwnerOnly: "Only the original requester can continue this vance thread by reply",
			audioFailed: "Could not create voice message, sent text response instead.",
			audioFailedWithReason: "Could not create voice message, sent text response instead.\nReason: %1",
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
			const { hasAudioFlag, cleanedPrompt } = parseAudioMode(args.join(" "));
			const stopTyping = startTypingIndicator(api, event.threadID);
			let text = "";
			try {
				text = await generateVanceText({
					prompt: cleanedPrompt,
					event,
					senderID: event.senderID,
					commandName,
					envCommands,
					threadsData,
					api,
					getLang,
					audioMode: hasAudioFlag
				});
			}
			finally {
				stopTyping();
			}
			if (hasAudioFlag) {
				try {
					return await replyAudioAndRegister({ message, text, event, commandName });
				}
				catch (e) {
					const reason = e?.message || "Unknown TTS error";
					return await replyAndRegister({
						message,
						text: `${text}\n\n(${getLang("audioFailedWithReason", reason)})`,
						event,
						commandName
					});
				}
			}
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
		if (String(event.threadID) !== String(Reply.threadID))
			return;

		try {
			const { hasAudioFlag, cleanedPrompt } = parseAudioMode(event.body || "");
			const stopTyping = startTypingIndicator(api, event.threadID);
			let text = "";
			try {
				text = await generateVanceText({
					prompt: cleanedPrompt,
					event,
					senderID: event.senderID,
					commandName,
					envCommands,
					threadsData,
					api,
					getLang,
					audioMode: hasAudioFlag
				});
			}
			finally {
				stopTyping();
			}
			if (hasAudioFlag) {
				try {
					return await replyAudioAndRegister({ message, text, event, commandName });
				}
				catch (e) {
					const reason = e?.message || "Unknown TTS error";
					return await replyAndRegister({
						message,
						text: `${text}\n\n(${getLang("audioFailedWithReason", reason)})`,
						event,
						commandName
					});
				}
			}
			return await replyAndRegister({ message, text, event, commandName });
		}
		catch (err) {
			const details = err?.response?.data?.error?.message || err.message || "Unknown error";
			return message.reply(getLang("error", details));
		}
	}
};