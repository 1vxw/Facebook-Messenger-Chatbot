function parseWindowMs(text) {
	if (!text)
		return 24 * 60 * 60 * 1000; // 1d default
	const normalized = String(text).trim().toLowerCase();
	const match = normalized.match(/^(\d+)(m|h|d)$/);
	if (!match)
		return null;
	const amount = Number(match[1]);
	const unit = match[2];
	if (!amount || amount < 1)
		return null;
	if (unit === "m")
		return amount * 60 * 1000;
	if (unit === "h")
		return amount * 60 * 60 * 1000;
	return amount * 24 * 60 * 60 * 1000;
}

module.exports = {
	config: {
		name: "clear",
		version: "1.0",
		author: "Vince Pradas",
		countDown: 10,
		role: 0,
		description: {
			vi: "Quet lich su va go tin nhan bot da gui theo khoang thoi gian",
			en: "Scan thread history and unsend bot messages by time frame"
		},
		category: "utility",
		guide: {
			vi: "   {pn}\n   {pn} 1d\n   {pn} 7d 1500",
			en: "   {pn}\n   {pn} 1d\n   {pn} 7d 1500"
		}
	},

	langs: {
		vi: {
			invalidRange: "Khoang thoi gian khong hop le. Dung: 30m, 12h, 1d",
			noHistory: "Khong doc duoc lich su doan chat.",
			none: "Khong tim thay tin nhan bot de go trong khoang thoi gian nay.",
			result: "Da go %1/%2 tin nhan bot (quet %3 tin nhan gan nhat, %4)."
		},
		en: {
			invalidRange: "Invalid time range. Use: 30m, 12h, 1d",
			noHistory: "Could not read thread history.",
			none: "No bot messages found to unsend in this time frame.",
			result: "Unsent %1/%2 bot message(s) (scanned last %3 messages, %4)."
		}
	},

	onStart: async function ({ api, event, args, message, getLang }) {
		const timeframe = args[0] || "1d";
		const windowMs = parseWindowMs(timeframe);
		if (windowMs === null)
			return message.reply(getLang("invalidRange"));

		const scanLimitRaw = parseInt(args[1], 10);
		const scanLimit = Math.max(50, Math.min(5000, isNaN(scanLimitRaw) ? 1000 : scanLimitRaw));

		const threadID = event.threadID;
		const myID = String(api.getCurrentUserID());
		const cutoff = Date.now() - windowMs;

		let scanned = 0;
		let before = null;
		let pages = 0;
		const toUnsend = [];
		const seen = new Set();

		while (scanned < scanLimit && pages < 50) {
			const batchSize = Math.min(100, scanLimit - scanned);
			let history = [];
			try {
				history = await api.getThreadHistory(threadID, batchSize, before);
			}
			catch (_e) {
				if (scanned === 0)
					return message.reply(getLang("noHistory"));
				break;
			}

			if (!Array.isArray(history) || history.length === 0)
				break;

			scanned += history.length;
			pages++;

			for (const item of history) {
				const messageID = item?.messageID;
				const senderID = String(item?.senderID || "");
				const ts = Number(item?.timestamp || 0);
				if (!messageID || !ts || seen.has(messageID))
					continue;
				seen.add(messageID);
				if (senderID !== myID)
					continue;
				if (ts < cutoff)
					continue;
				toUnsend.push({ id: messageID, ts });
			}

			const oldest = history[history.length - 1];
			const oldestTs = Number(oldest?.timestamp || 0);
			if (!oldestTs || oldestTs < cutoff)
				break;
			before = oldestTs;
		}

		if (!toUnsend.length)
			return message.reply(getLang("none"));

		toUnsend.sort((a, b) => b.ts - a.ts);

		let removed = 0;
		for (const item of toUnsend) {
			try {
				await api.unsendMessage(item.id);
				removed++;
			}
			catch (_e) {}
		}

		return message.reply(getLang("result", removed, toUnsend.length, scanned, timeframe));
	}
};
