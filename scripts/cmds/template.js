module.exports = {
	config: {
		name: "template",
		version: "1.0",
		author: "Vince Pradas",
		countDown: 5,
		role: 0,
		shortDescription: {
			en: "Send basic Messenger template",
			vi: "Gui mau template Messenger co ban"
		},
		description: {
			en: "Send a button template with a webview URL",
			vi: "Gui button template kem URL webview"
		},
		category: "utility",
		guide: {
			en: "{pn} [url]",
			vi: "{pn} [url]"
		}
	},

	langs: {
		en: {
			sent: "Basic button template sent.",
			failed: "Failed to send template: %1"
		},
		vi: {
			sent: "Da gui button template co ban.",
			failed: "Khong the gui template: %1"
		}
	},

	onStart: async function ({ api, args, event, message, getLang }) {
		const url = String(args[0] || "https://example.com").trim();

		const templateMessage = {
			attachment: {
				type: "template",
				payload: {
					template_type: "button",
					text: "Hello from Vance Bot. Tap a button below:",
					buttons: [
						{
							type: "web_url",
							url,
							title: "Open Webview",
							webview_height_ratio: "full"
						},
						{
							type: "postback",
							title: "Ping Bot",
							payload: "PING_PAYLOAD"
						}
					]
				}
			}
		};

		try {
			await api.sendMessage(templateMessage, event.threadID, event.messageID);
			return message.reply(getLang("sent"));
		}
		catch (err) {
			return message.reply(getLang("failed", err?.message || "unknown error"));
		}
	}
};
