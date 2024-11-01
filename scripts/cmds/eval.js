const { removeHomeDir, log } = global.utils;

module.exports = {
  config: {
    name: "eval",
    version: "1.6",
    author: "VincePradas",
    countDown: 5,
    role: 2,
    description: {
      vi: "Test code nhanh",
      en: "Test code quickly"
    },
    category: "owner",
    guide: {
      vi: "{pn} <đoạn code cần test>",
      en: "{pn} <code to test>"
    }
  },

  langs: {
    vi: {
      error: "❌ Đã có lỗi xảy ra:"
    },
    en: {
      error: "❌ An error occurred:"
    }
  },

  onStart: async function ({ api, args, message, event, getLang }) {
    try {
      // Join the arguments (the code to evaluate) into a single string
      const codeToEval = args.join(" ");
      
      // Use eval and capture the result
      let result = await eval(`(async () => { return ${codeToEval}; })()`);
      
      // Send the result to Messenger
      message.reply(result?.toString() || "undefined");
      
    } catch (err) {
      log.err("eval command", err);

      // If there's an error, send an error message
      message.reply(
        `${getLang("error")}\n` +
        (err.stack ?
          removeHomeDir(err.stack) :
          removeHomeDir(JSON.stringify(err, null, 2) || "")
        )
      );
    }
  }
};
