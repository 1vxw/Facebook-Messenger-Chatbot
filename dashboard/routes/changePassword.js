const bcrypt = require("bcrypt");
const express = require("express");
const router = express.Router();

module.exports = function ({ isAuthenticated, dashBoardData }) {
	router
		.get("/", isAuthenticated, async (req, res) => {
			res.render("change-password");
		})
		.post("/", isAuthenticated, async (req, res) => {
			const { oldassword, password, password_confirmation } = req.body;
			if (!await bcrypt.compare(oldassword, req.user.password))
				return res.status(400).json({
					status: "error",
					error: "OLDASSWORD_IS_NOT_CORRECT",
					message: "Current password is incorrect"
				});
			if (password !== password_confirmation)
				return res.status(400).json({
					status: "error",
					error: "PASSWORD_IS_NOT_MATCH",
					message: "Passwords do not match"
				});
			if (password.length < 6)
				return res.status(400).json({
					status: "error",
					error: "PASSWORD_IS_NOT_ENOUGH",
					message: "Password must be at least 6 characters"
				});

			const hashPassword = bcrypt.hashSync(password, 10);
			await dashBoardData.set(req.user.email, { password: hashPassword });
			req.flash("success", {
				msg: "Password changed successfully"
			});
			res.send();
		});

	return router;
};
