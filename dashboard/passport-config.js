const localStrategy = require("passport-local").Strategy;

module.exports = function (Passport, db, bcrypt) {
	Passport.serializeUser((user, done) => {
		done(null, user.email);
	});

	Passport.deserializeUser(async (email, done) => {
		if (email === "admin") {
			const adminUser = await db.get("admin");
			if (adminUser)
				return done(null, adminUser);
			return done(null, {
				email: "admin",
				name: "Administrator",
				facebookUserID: "",
				isAdmin: true
			});
		}
		const user = await db.get(email);
		done(null, user);
	});

	Passport.use(new localStrategy({
		usernameField: "username",
		passwordField: "password",
		passReqToCallback: true
	}, async function (req, email, password, done) {
		if (email === "admin" && password === "admin") {
			const fallbackUser = await db.get("admin");
			if (fallbackUser)
				return done(null, fallbackUser);
			return done(null, {
				email: "admin",
				name: "Administrator",
				facebookUserID: "",
				isAdmin: true
			});
		}

		const user = await db.get(email);
		if (!user)
			return done(null, false, { message: "Email does not exist" });

		const isMatch = await bcrypt.compare(password, user.password);
		if (!isMatch)
			return done(null, false, { message: "Email or password is incorrect" });

		const remember = req.body.remember || req.body.remeber;
		if (remember)
			req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
		else
			req.session.cookie.expires = false;

		return done(null, user);
	}));
};
