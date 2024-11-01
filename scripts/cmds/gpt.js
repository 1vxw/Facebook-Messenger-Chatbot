    // Make sure to include this import
    const { GoogleGenerativeAI } = require('@google/generative-ai');


    const apiKey = "AIzaSyC9nZPUpiHHGz5kfhYEvPBa1UYCMKw5tt4";
    // Initialize the GoogleGenerativeAI instance with your API key
    const genAI = new GoogleGenerativeAI(apiKey);

    // Model configuration
    const maxTokens = 500;
    const maxStorageMessage = 4;

    if (!global.temp.geminiUsing)
        global.temp.geminiUsing = {};
    if (!global.temp.geminiHistory)
        global.temp.geminiHistory = {};

    const { geminiUsing, geminiHistory } = global.temp;

    module.exports = {
        config: {
            name: "vance",
            version: "1.0",
            author: "VincePradas",
            countDown: 5,
            role: 0,
            description: {
                vi: "Gemini chat",
                en: "Gemini chat"
            },
            category: "box chat",
            guide: {
                vi: "   {pn} <nội dung> - chat với Gemini",
                en: "   {pn} <content> - chat with Gemini"
            }
        },

        langs: {
            vi: {
                apiKeyEmpty: "Vui lòng cung cấp API key cho Gemini tại file scripts/cmds/gemini.js",
                yourAreUsing: "Bạn đang sử dụng Gemini chat, vui lòng chờ quay lại sau khi yêu cầu trước kết thúc",
                processingRequest: "Đang xử lý yêu cầu của bạn, quá trình này có thể mất vài phút, vui lòng chờ",
                invalidContent: "Vui lòng nhập nội dung bạn muốn chat",
                error: "Đã có lỗi xảy ra\n%1",
                clearHistory: "Đã xóa lịch sử chat của bạn với Gemini"
            },
            en: {
                apiKeyEmpty: "Please provide API key for Gemini at file scripts/cmds/gemini.js",
                yourAreUsing: "You are using Gemini chat, please wait until the previous request ends",
                processingRequest: "Processing your request, this process may take a few minutes, please wait",
                invalidContent: "Please enter the content you want to chat",
                error: "An error has occurred\n%1",
                clearHistory: "Your chat history with Gemini has been deleted"
            }
        },

        onStart: async function ({ message, event, args, getLang, commandName }) {
            if (!apiKey)
                return message.reply(getLang('apiKeyEmpty'));

            if (!args[0])
                return message.reply(getLang('invalidContent'));

            if (geminiUsing[event.senderID])
                return message.reply(getLang("yourAreUsing"));

            geminiUsing[event.senderID] = true;

            let sending;
            try {
                sending = message.reply(getLang('processingRequest'));

                // Create the prompt from user input
                const prompt = args.join(' ');

                // Get the model
                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

                // Generate content
                const result = await model.generateContent(prompt);

                // Get the generated text
                const text = result.response.text();

                // Store conversation history
                if (!geminiHistory[event.senderID] || !Array.isArray(geminiHistory[event.senderID]))
                    geminiHistory[event.senderID] = [];

                if (geminiHistory[event.senderID].length >= maxStorageMessage)
                    geminiHistory[event.senderID].shift();

                geminiHistory[event.senderID].push({
                    role: 'user',
                    content: prompt
                });

                geminiHistory[event.senderID].push({
                    role: 'assistant',
                    content: text
                });

                // Reply with the generated content
                return message.reply(text);
            }
            catch (err) {
                const errorMessage = err.message || "An unknown error occurred";
                return message.reply(getLang('error', errorMessage));
            }
            finally {
                delete geminiUsing[event.senderID];
                message.unsend((await sending).messageID);
            }
        }
    };
