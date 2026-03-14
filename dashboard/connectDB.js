const path = require("path");
const applyRuntimeSecrets = require("../security/applyRuntimeSecrets.js");

const dirConfig = path.join(`${__dirname}/../${process.env.NODE_ENV === 'development' ? 'config.dev.json' : 'config.json'}`);
const dirConfigCommands = path.join(`${__dirname}/../${process.env.NODE_ENV === 'development' ? 'configCommands.dev.json' : 'configCommands.json'}`);

const previousGoatBot = global.GoatBot || {};
const runtimeConfig = require(dirConfig);
const runtimeConfigCommands = require(dirConfigCommands);
applyRuntimeSecrets(runtimeConfig, runtimeConfigCommands);
global.GoatBot = {
	...previousGoatBot,
	config: runtimeConfig,
	configCommands: runtimeConfigCommands,
	reLoginBot: typeof previousGoatBot.reLoginBot === "function" ? previousGoatBot.reLoginBot : function () { },
	__loginBootstrapReady: previousGoatBot.__loginBootstrapReady === true
};
global.utils = global.utils || require("../utils.js");
global.client = global.client || {
	database: {
		creatingThreadData: [],
		creatingUserData: [],
		creatingDashBoardData: []
	}
};
global.db = global.db || {
	allThreadData: [],
	allUserData: [],
	globalData: []
};

module.exports = async function () {
	const controller = await require(path.join(__dirname, "..", "database/controller/index.js"))(null); // data is loaded here
	const { threadModel, userModel, dashBoardModel, globalModel, threadsData, usersData, dashBoardData, globalData } = controller;
	return {
		threadModel,
		userModel,
		dashBoardModel,
		globalModel,
		threadsData,
		usersData,
		dashBoardData,
		globalData
	};
};
