const { findUid } = global.utils;
const regExCheckURL = /^(http|https):\/\/[^ "]+$/;

module.exports = {
	config: {
		name: "getid",
		version: "1.0",
		author: "VincePradas",
		countDown: 5,
		role: 0,
		description: {
			vi: "Lay Facebook UID bang mention, reply hoac link profile",
			en: "Get Facebook UID by mention, reply, or profile link"
		},
		category: "info",
		guide: {
			vi: "   {pn}: lay UID cua ban"
				+ "\n   {pn} @tag: lay UID cua nguoi duoc tag"
				+ "\n   {pn} <link profile>: lay UID tu link profile"
				+ "\n   Reply tin nhan cua ai do + {pn}: lay UID cua nguoi do",
			en: "   {pn}: get your UID"
				+ "\n   {pn} @tag: get UID of tagged users"
				+ "\n   {pn} <profile link>: get UID from profile link"
				+ "\n   Reply to a user's message + {pn}: get that user's UID"
		}
	},

	langs: {
		vi: {
			syntaxError: "Hay tag/reply/gui link profile, hoac de trong de lay UID cua ban"
		},
		en: {
			syntaxError: "Tag/reply/send profile link, or leave blank to get your own UID"
		}
	},

	onStart: async function ({ message, event, args, getLang }) {
		if (event.messageReply)
			return message.reply(event.messageReply.senderID);

		if (!args[0])
			return message.reply(event.senderID);

		if (args[0].match(regExCheckURL)) {
			let msg = "";
			for (const link of args) {
				try {
					const uid = await findUid(link);
					msg += `${link} => ${uid}\n`;
				}
				catch (e) {
					msg += `${link} (ERROR) => ${e.message}\n`;
				}
			}
			return message.reply(msg.trim());
		}

		const { mentions } = event;
		let msg = "";
		for (const id in mentions)
			msg += `${mentions[id].replace("@", "")}: ${id}\n`;

		return message.reply(msg || getLang("syntaxError"));
	}
};
