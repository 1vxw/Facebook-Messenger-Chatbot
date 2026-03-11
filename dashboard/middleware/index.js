const { threadsData } = global.db;

function isPostMethod(req) {
	return req.method == "POST";
}

module.exports = function (checkAuthConfigDashboardOfThread) {
	return {
		isAuthenticated(req, res, next) {
			if (req.isAuthenticated())
				return next();

			if (isPostMethod(req))
				return res.status(401).send({
					status: "error",
					error: "PERMISSION_DENIED",
					message: "You are not logged in"
				});

			req.flash("errors", { msg: "You must be logged in" });
			res.redirect(`/login?redirect=${req.originalUrl}`);
		},

		unAuthenticated(req, res, next) {
			if (!req.isAuthenticated())
				return next();

			if (isPostMethod(req))
				return res.status(401).send({
					status: "error",
					error: "PERMISSION_DENIED",
					message: "An error occurred"
				});

			res.redirect("/");
		},

		isVeryfiUserIDFacebook(req, res, next) {
			if (req.user?.email === "admin")
				return next();
			if (req.user.facebookUserID)
				return next();

			if (isPostMethod(req))
				return res.status(401).send({
					status: "error",
					error: "PERMISSION_DENIED",
					message: "Your Facebook ID is not verified"
				});

			req.flash("errors", { msg: "You must verify your Facebook ID before this action" });
			res.redirect(`/verifyfbid?redirect=${req.originalUrl}`);
		},

		isWaitVerifyAccount(req, res, next) {
			if (req.session.waitVerifyAccount)
				return next();

			if (isPostMethod(req))
				return res.status(401).send({
					status: "error",
					error: "PERMISSION_DENIED",
					message: "An error occurred, please try again"
				});

			res.redirect("/register");
		},

		async checkHasAndInThread(req, res, next) {
			const userID = req.user.facebookUserID;
			const threadID = isPostMethod(req) ? req.body.threadID : req.params.threadID;
			const threadData = await threadsData.get(threadID);

			if (!threadData) {
				if (isPostMethod(req))
					return res.status(401).send({
						status: "error",
						error: "PERMISSION_DENIED",
						message: "Thread not found"
					});

				req.flash("errors", { msg: "Thread not found" });
				return res.redirect("/dashboard");
			}

			const findMember = threadData.members.find(m => m.userID == userID && m.inGroup == true);
			if (!findMember) {
				if (isPostMethod(req))
					return res.status(401).send({
						status: "error",
						error: "PERMISSION_DENIED",
						message: "You are not a member of this thread"
					});

				req.flash("errors", { msg: "You are not in this thread" });
				return res.redirect("/dashboard");
			}
			req.threadData = threadData;
			next();
		},

		async middlewareCheckAuthConfigDashboardOfThread(req, res, next) {
			const threadID = isPostMethod(req) ? req.body.threadID : req.params.threadID;
			if (checkAuthConfigDashboardOfThread(threadID, req.user.facebookUserID))
				return next();

			if (isPostMethod(req))
				return res.status(401).send({
					status: "error",
					error: "PERMISSION_DENIED",
					message: "You do not have permission to edit this thread"
				});

			req.flash("errors", {
				msg: "Only thread admins or members with dashboard permission can edit this dashboard"
			});
			return res.redirect("/dashboard");
		},

		async isAdmin(req, res, next) {
			if (req.user?.email === "admin" || req.user?.isAdmin === true)
				return next();
			const userID = req.user.facebookUserID;
			if (!global.GoatBot.config.adminBot.includes(userID)) {
				if (isPostMethod(req))
					return res.status(401).send({
						status: "error",
						error: "PERMISSION_DENIED",
						message: "You are not a bot admin"
					});

				req.flash("errors", { msg: "You are not a bot admin" });
				return res.redirect("/dashboard");
			}
			next();
		}
	};
};
