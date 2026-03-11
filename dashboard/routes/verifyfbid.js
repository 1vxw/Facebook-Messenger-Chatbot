const express = require("express");
const router = express.Router();
const { findUid, getText } = global.utils;

module.exports = function ({ isAuthenticated, randomNumberApikey, expireVerifyCode, dashBoardData, api, createLimiter, config, transporter }) {
	router
		.get("/", isAuthenticated, (req, res) => {
			req.session.redirectTo = req.query.redirect;
			res.render("verifyfbid");
		})
		.get("/submit-code", [isAuthenticated, function (req, res, next) {
			if (!req.session.waitVerify)
				return res.redirect("/verifyfbid");
			next();
		}], (req, res) => {
			res.render("verifyfbid-submit-code");
		})

		.post("/", isAuthenticated, async (req, res) => {
			if (!api)
				return res.status(400).send({ errors: [{ msg: "The bot is currently offline. Please try again later." }] });
			let { fbid } = req.body;
			const code = randomNumberApikey(6);
			if (!fbid)
				return res.status(400).send({ errors: [{ msg: "Please enter a Facebook ID or profile URL" }] });
			try {
				if (isNaN(fbid))
					fbid = await findUid(fbid);
			}
			catch (e) {
				return res.status(400).send({ errors: [{ msg: "Facebook ID or profile URL does not exist" }] });
			}
			req.session.waitVerify = {
				fbid,
				code,
				email: req.user.email
			};

			setTimeout(() => {
				delete req.session.waitVerify;
			}, expireVerifyCode);

			let sentVia = "facebook";
			try {
				await api.sendMessage(getText("verifyfbid", "sendCode", code, config.dashBoard.expireVerifyCode / 60000, global.GoatBot.config.language), fbid);
			}
			catch (e) {
				try {
					await transporter.sendMail({
						from: "VXW",
						to: req.user.email,
						subject: "VXW Facebook ID verification code",
						html: `<p>Your verification code is: <b>${code}</b></p><p>This code expires in ${Math.floor(config.dashBoard.expireVerifyCode / 60000)} minutes.</p>`
					});
					sentVia = "email";
				}
				catch (mailErr) {
					const errors = [];
					if (e.blockedAction)
						errors.push({ msg: "The bot is temporarily blocked from sending messages, and email fallback also failed." });
					else
						errors.push({ msg: `Cannot send verification code to Facebook ID \"${fbid}\" and email fallback failed.` });

					req.flash("errors", errors);
					return res.status(400).send({
						status: "error",
						errors,
						message: errors[0].msg
					});
				}
			}
			req.flash("success", { msg: sentVia === "facebook" ? "Verification code sent to your Facebook account." : "Facebook delivery failed. Verification code sent to your dashboard email." });
			res.send({
				status: "success",
				message: sentVia === "facebook" ? "Verification code sent to your Facebook account." : "Facebook delivery failed. Verification code sent to your dashboard email."
			});
		})
		.post("/submit-code", [isAuthenticated, function (req, res, next) {
			if (!req.session.waitVerify)
				return res.redirect("/verifyfbid");
			next();
		}, createLimiter(1000 * 60 * 5, 20)], async (req, res) => {
			const { code } = req.body;
			const user = await dashBoardData.get(req.user.email);
			if (code == req.session.waitVerify.code) {
				const fbid = req.session.waitVerify.fbid;
				console.log(`User ${user.email} verify fbid ${fbid}`);
				delete req.session.waitVerify;
				await dashBoardData.set(user.email, { facebookUserID: fbid });
				req.flash("success", { msg: "Facebook ID verified successfully" });
				res.send({
					status: "success",
					message: "Facebook ID verified successfully",
					redirectLink: req.session.redirectTo || "/dashboard"
				});
			}
			else {
				return res.status(400).send({ msg: "Verification code is incorrect" });
			}
		});

	return router;
};
