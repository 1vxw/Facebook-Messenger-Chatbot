module.exports = {
	config: {
		name: "clr",
		version: "1.1",
		author: "Vince Pradas",
		countDown: 5,
		role: 0,
		description: {
			vi: "Xoa tin nhan bot da gui trong doan chat hien tai theo khoang thoi gian",
			en: "Clear bot-sent messages in current conversation by time frame"
		},
		category: "utility",
		guide: {
			vi: "   {pn}\n   {pn} all\n   {pn} all 1d\n   {pn} 100 12h",
			en: "   {pn}\n   {pn} all\n   {pn} all 1d\n   {pn} 100 12h"
		}
	},

	langs: {
		vi: {
			cleared: "Da xoa %1 tin nhan bot",
			result: "Da xoa %1/%2 tin nhan bot trong %3%4",
			none: "Khong co tin nhan bot nao de xoa trong khoang thoi gian nay.",
			invalidRange: "Khoang thoi gian khong hop le. Dung: 30m, 12h, 1d"
		},
		en: {
			cleared: "Cleared %1 bot message(s).",
			result: "Cleared %1/%2 bot message(s) in %3%4.",
			none: "No tracked bot messages to remove in this time frame.",
			invalidRange: "Invalid time range. Use: 30m, 12h, 1d"
		}
	},

	onStart: async function ({ message, event, args, getLang, api }) {
		function parseWindowMs(text) {
			if (!text)
				return 24 * 60 * 60 * 1000;
			const normalized = String(text).trim().toLowerCase();
			const match = normalized.match(/^(\d+)(m|h|d)$/);
			if (!match)
				return null;
			const amount = Number(match[1]);
			const unit = match[2];
			if (unit === "m")
				return amount * 60 * 1000;
			if (unit === "h")
				return amount * 60 * 60 * 1000;
			return amount * 24 * 60 * 60 * 1000;
		}

		const threadID = String(event.threadID || "");
		const store = global.temp.botSentMessages || {};
		const raw = store[threadID] || [];
		const items = raw
			.map(item => typeof item === "string" ? { id: item, ts: 0 } : item)
			.filter(item => item?.id);

		if (!items.length)
			return message.reply(getLang("none"));

		const first = String(args[0] || "").toLowerCase();
		const second = String(args[1] || "").toLowerCase();
		const isAll = first === "all";
		const requested = !isAll ? parseInt(first, 10) : NaN;
		const windowToken = isAll ? second : (isNaN(requested) ? first : second);
		const windowMs = parseWindowMs(windowToken);
		if (windowMs === null)
			return message.reply(getLang("invalidRange"));

		const now = Date.now();
		const cutoff = now - windowMs;
		const inRange = items.filter(item => Number(item.ts || 0) >= cutoff);

		if (!inRange.length)
			return message.reply(getLang("none"));

		const take = isAll || isNaN(requested) ? inRange.length : Math.max(1, Math.min(5000, requested));
		const targets = inRange.slice(-take);

		let removed = 0;
		const removedIDs = new Set();
		for (let i = targets.length - 1; i >= 0; i--) {
			try {
				await api.unsendMessage(targets[i].id);
				removed++;
				removedIDs.add(targets[i].id);
			}
			catch (_e) {}
		}

		store[threadID] = items.filter(item => !removedIDs.has(item.id));
		global.temp.botSentMessages = store;

		if (!removed)
			return message.reply(getLang("none"));

		const failed = targets.length - removed;
		return message.reply(getLang("result", removed, targets.length, windowToken || "1d", failed > 0 ? ` (${failed} failed)` : ""));
	}
};
