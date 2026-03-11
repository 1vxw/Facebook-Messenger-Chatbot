const axios = require("axios");
/**
 * 
 * @param {string} cookie Cookie string as `c_user=123;xs=123;datr=123;` format
 * @param {string} userAgent User agent string
 * @returns {Promise<Boolean>} True if cookie is valid, false if not
 */
module.exports = async function (cookie, userAgent) {
	try {
		const response = await axios({
			url: "https://www.facebook.com/",
			method: "GET",
			maxRedirects: 5,
			validateStatus: () => true,
			headers: {
				cookie,
				"user-agent": userAgent || "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
				"accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"accept-language": "en-US,en;q=0.9",
				"upgrade-insecure-requests": "1"
			}
		});

		if (response.status >= 400)
			return false;

		const html = String(response.data || "");
		const isCheckpoint = /checkpoint|review recent login|suspicious login|confirm your identity/i.test(html);
		const isLoginPage = /id="login_form"|name="email"|name="pass"|log in or sign up/i.test(html);
		const hasFacebookShell = /<title[^>]*>\s*Facebook\s*<\/title>/i.test(html);

		return hasFacebookShell && !isCheckpoint && !isLoginPage;
	}
	catch (e) {
		return false;
	}
};
