const axios = require("axios");

module.exports = {
	config: {
		name: "trivia",
		version: "1.0",
		author: "VincePradas",
		countDown: 5,
		role: 0,
		description: {
			en: "play a trivia game"
		},
		category: "game",
		guide: {
			en: "{pn}"
		}
	},

	onStart: async function ({ message, event }) {
		const triviaData = (await axios.get("https://opentdb.com/api.php?amount=1&type=multiple")).data.results[0];
		const question = triviaData.question;
		const correctAnswer = triviaData.correct_answer;
		const options = [...triviaData.incorrect_answers, correctAnswer].sort(() => 0.5 - Math.random());

		message.reply({
			body: `🧠 Tivia Time !\n\nQuestion: ${question}\n\nOptions: ${options.join(', ')}\n\n(Reply to this message with the chosen answer)`,
		}, (err, info) => {
			global.GoatBot.onReply.set(info.messageID, {
				commandName: "trivia",	
				messageID: info.messageID,
				author: event.senderID,
				correctAnswer
			});
		});
	},

	onReply: async function ({ message, Reply, event }) {
		const { author, correctAnswer, messageID } = Reply;
		if (event.senderID !== author) return message.reply("You are not the player for this question.");

		if (event.body.toLowerCase() === correctAnswer.toLowerCase()) {
			message.reply("Correct Boss!, Galing mo talaga!");
		} else {
			message.reply("Wrong answer!");
		}
	}
};
