const createFuncMessage = global.utils.message;
const handlerCheckDB = require("./handlerCheckData.js");
const { getPrefix, log } = global.utils;

module.exports = (api, threadModel, userModel, dashBoardModel, globalModel, usersData, threadsData, dashBoardData, globalData) => {
	const handlerEvents = require(process.env.NODE_ENV == 'development' ? "./handlerEvents.dev.js" : "./handlerEvents.js")(api, threadModel, userModel, dashBoardModel, globalModel, usersData, threadsData, dashBoardData, globalData);

	return async function (event) {
		const senderID = event.senderID || event.userID || event.author;
		const isAdminBot = global.GoatBot.config.adminBot?.includes(senderID);
		const isInboxMessage = event.isGroup === false || (event.senderID && event.senderID == event.threadID);
		const rawBody = typeof event.body == "string" ? event.body.trim() : "";
		const prefix = event.threadID ? getPrefix(event.threadID) : global.GoatBot.config.prefix;
		const isExplicitBotCall = !!rawBody && (
			rawBody.startsWith(prefix) ||
			/\bvance\b/i.test(rawBody)
		);

		// antiInbox keeps random DMs muted but still allows explicit bot calls.
		if (
			global.GoatBot.config.antiInbox == true &&
			isInboxMessage &&
			!isExplicitBotCall &&
			!isAdminBot
		) {
			log.info("ANTI_INBOX", `Ignored inbox message from ${senderID} in ${event.threadID}`);
			return;
		}

		const message = createFuncMessage(api, event);

		await handlerCheckDB(usersData, threadsData, event);
		const handlerChat = await handlerEvents(event, message);
		if (!handlerChat)
			return;

		const {
			onAnyEvent, onFirstChat, onStart, onChat,
			onReply, onEvent, handlerEvent, onReaction,
			typ, presence, read_receipt
		} = handlerChat;

		if (event.isGroup === false && typeof event.body === "string" && event.body.trim()) {
			log.info("DM_DISPATCH", `type=${event.type || "unknown"} thread=${event.threadID} sender=${senderID} body=${event.body.slice(0, 80)}`);
		}

		onAnyEvent();
		switch (event.type) {
			case "message":
			case "message_reply":
			case "message_unsend":
				onFirstChat();
				onChat();
				onStart();
				onReply();
				break;
			case "event":
				handlerEvent();
				onEvent();
				break;
			case "message_reaction":
				onReaction();
				break;
			case "typ":
				typ();
				break;
			case "presence":
				presence();
				break;
			case "read_receipt":
				read_receipt();
				break;
			// case "friend_request_received":
			// { /* code block */ }
			// break;

			// case "friend_request_cancel"
			// { /* code block */ }
			// break;
			default:
				// Some Facebook clients may emit different message-like event types in 1:1 chats.
				// If we still have text + thread, run command/chat handlers as a safe fallback.
				if (typeof event.body === "string" && event.threadID) {
					onFirstChat();
					onChat();
					onStart();
					onReply();
				}
				break;
		}
	};
};
