const axios = require("axios");
const ytdl = require("@distube/ytdl-core");
const fs = require("fs-extra");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");
const youtubedl = require("youtube-dl-exec");
const { getStreamFromURL, downloadFile, formatNumber } = global.utils;
async function getStreamAndSize(url, path = "") {
	if (!url || typeof url !== "string") {
		const error = new Error("Invalid media URL");
		error.code = "INVALID_MEDIA_URL";
		throw error;
	}
	const response = await axios({
		method: "GET",
		url,
		responseType: "stream",
		headers: {
			'Range': 'bytes=0-'
		}
	});
	if (path)
		response.data.path = path;
	const totalLength = response.headers["content-length"];
	return {
		stream: response.data,
		size: totalLength
	};
}

module.exports = {
	config: {
		name: "ytb",
		version: "1.16",
		author: "VincePradas",
		countDown: 5,
		role: 0,
		description: {
			vi: "Tải video, audio hoặc xem thông tin video trên YouTube",
			en: "Download video, audio or view video information on YouTube"
		},
		category: "media",
		guide: {
			vi: "   {pn} [video|-v] [<tên video>|<link video>]: dùng để tải video từ youtube."
				+ "\n   {pn} [audio|-a] [<tên video>|<link video>]: dùng để tải audio từ youtube"
				+ "\n   {pn} [info|-i] [<tên video>|<link video>]: dùng để xem thông tin video từ youtube"
				+ "\n   Ví dụ:"
				+ "\n    {pn} -v Fallen Kingdom"
				+ "\n    {pn} -a Fallen Kingdom"
				+ "\n    {pn} -i Fallen Kingdom",
			en: "   {pn} [video|-v] [<video name>|<video link>]: use to download video from youtube."
				+ "\n   {pn} [audio|-a] [<video name>|<video link>]: use to download audio from youtube"
				+ "\n   {pn} [info|-i] [<video name>|<video link>]: use to view video information from youtube"
				+ "\n   Example:"
				+ "\n    {pn} -v Fallen Kingdom"
				+ "\n    {pn} -a Fallen Kingdom"
				+ "\n    {pn} -i Fallen Kingdom"
		}
	},

	langs: {
		vi: {
			error: "Đã xảy ra lỗi: %1",
			noResult: "⭕ Không có kết quả tìm kiếm nào phù hợp với từ khóa %1",
			choose: "%1Reply tin nhắn với số để chọn hoặc nội dung bất kì để gỡ",
			video: "video",
			audio: "âm thanh",
			downloading: "Đang tải xuống %1 \"%2\"",
			downloading2: "Đang tải xuống %1 \"%2\"\n🔃 Tốc độ: %3MB/s\n⏸️ Đã tải: %4/%5MB (%6%)\n⏳ Ước tính thời gian còn lại: %7 giây",
			noVideo: "⭕ Rất tiếc, không tìm thấy video nào có dung lượng nhỏ hơn 83MB",
			noAudio: "⭕ Rất tiếc, không tìm thấy audio nào có dung lượng nhỏ hơn 26MB",
			info: "💠 Tiêu đề: %1\n🏪 Channel: %2\n👨‍👩‍👧‍👦 Subscriber: %3\n⏱ Thời gian video: %4\n👀 Lượt xem: %5\n👍 Lượt thích: %6\n🆙 Ngày tải lên: %7\n🔠 ID: %8\n🔗 Link: %9",
			listChapter: "\n📖 Danh sách phân đoạn: %1\n"
		},
		en: {
			error: "An error occurred: %1",
			noResult: "⭕ No search results match the keyword %1",
			choose: "%1Reply to the message with a number to choose or any content to cancel",
			video: "video",
			audio: "audio",
			downloading: "Downloading %1 \"%2\"",
			downloading2: "Downloading %1 \"%2\"\n🔃 Speed: %3MB/s\n⏸️ Downloaded: %4/%5MB (%6%)\n⏳ Estimated time remaining: %7 seconds",
			noVideo: "⭕ Sorry, no video was found with a size less than 83MB",
			noAudio: "⭕ Sorry, no audio was found with a size less than 26MB",
			info: "💠 Title: %1\n🏪 Channel: %2\n👨‍👩‍👧‍👦 Subscriber: %3\n⏱ Video duration: %4\n👀 View count: %5\n👍 Like count: %6\n🆙 Upload date: %7\n🔠 ID: %8\n🔗 Link: %9",
			listChapter: "\n📖 List chapter: %1\n"
		}
	},

	onStart: async function ({ args, message, event, commandName, getLang }) {
		let type;
		switch (args[0]) {
			case "-v":
			case "0v":
			case "video":
				type = "video";
				break;
			case "-a":
			case "-s":
			case "audio":
			case "sing":
				type = "audio";
				break;
			case "-i":
			case "info":
				type = "info";
				break;
			default:
				return message.SyntaxError();
		}

		const checkurl = /^(?:https?:\/\/)?(?:m\.|www\.)?(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))((\w|-){11})(?:\S+)?$/;
		const urlYtb = checkurl.test(args[1]);

		if (urlYtb) {
			const infoVideo = await getVideoInfo(args[1]);
			handle({ type, infoVideo, message, downloadFile, getLang });
			return;
		}

		let keyWord = args.slice(1).join(" ");
		keyWord = keyWord.includes("?feature=share") ? keyWord.replace("?feature=share", "") : keyWord;
		const maxResults = 6;

		let result;
		try {
			result = (await search(keyWord)).slice(0, maxResults);
		}
		catch (err) {
			return message.reply(getLang("error", err.message));
		}
		if (result.length == 0)
			return message.reply(getLang("noResult", keyWord));
		let msg = "";
		let i = 1;
		const thumbnails = [];
		const arrayID = [];

		for (const info of result) {
			thumbnails.push(getStreamFromURL(info.thumbnail));
			msg += `${i++}. ${info.title}\nTime: ${info.time}\nChannel: ${info.channel.name}\n\n`;
		}

		message.reply({
			body: getLang("choose", msg),
			attachment: await Promise.all(thumbnails)
		}, (err, info) => {
			global.GoatBot.onReply.set(info.messageID, {
				commandName,
				messageID: info.messageID,
				author: event.senderID,
				arrayID,
				result,
				type
			});
		});
	},

	onReply: async ({ event, api, Reply, message, getLang }) => {
		const { result, type } = Reply;
		const choice = event.body;
		if (!isNaN(choice) && choice <= 6) {
			const infoChoice = result[choice - 1];
			const idvideo = infoChoice.id;
			const infoVideo = await getVideoInfo(idvideo);
			api.unsendMessage(Reply.messageID);
			await handle({ type, infoVideo, message, getLang });
		}
		else
			api.unsendMessage(Reply.messageID);
	}
};

async function handle({ type, infoVideo, message, getLang }) {
	const { title, videoId } = infoVideo;

	if (type == "video") {
		const MAX_SIZE = 83 * 1024 * 1024; // 83MB (max size of video that can be sent on fb)
		const msgSend = message.reply(getLang("downloading", getLang("video"), title));
		let videoPath;
		try {
			videoPath = await downloadVideoWithYtDlp(videoId, MAX_SIZE);
		}
		catch (err) {
			return message.reply(getLang("error", "Failed to convert video from YouTube right now. Please try again later."));
		}
		if (!videoPath)
			return message.reply(getLang("noVideo"));

		message.reply({
			body: title,
			attachment: fs.createReadStream(videoPath)
		}, async (err) => {
			if (err)
				return message.reply(getLang("error", err.message));
			if (videoPath && fs.existsSync(videoPath))
				fs.unlinkSync(videoPath);
			message.unsend((await msgSend).messageID);
		});
	}
	else if (type == "audio") {
		const MAX_SIZE = 27262976; // 26MB (max size of audio that can be sent on fb)
		const msgSend = message.reply(getLang("downloading", getLang("audio"), title));
		let audioPath;
		try {
			audioPath = await downloadAudioWithYtDlp(videoId, MAX_SIZE);
		}
		catch (err) {
			return message.reply(getLang("error", "Failed to convert audio from YouTube right now. Please try again later."));
		}
		if (!audioPath)
			return message.reply(getLang("noAudio"));

		message.reply({
			body: title,
			attachment: fs.createReadStream(audioPath)
		}, async (err) => {
			if (err)
				return message.reply(getLang("error", err.message));
			if (audioPath && fs.existsSync(audioPath))
				fs.unlinkSync(audioPath);
			message.unsend((await msgSend).messageID);
		});
	}
	else if (type == "info") {
		const { title, lengthSeconds, viewCount, videoId, uploadDate, likes, channel, chapters } = infoVideo;

		const hours = Math.floor(lengthSeconds / 3600);
		const minutes = Math.floor(lengthSeconds % 3600 / 60);
		const seconds = Math.floor(lengthSeconds % 3600 % 60);
		const time = `${hours ? hours + ":" : ""}${minutes < 10 ? "0" + minutes : minutes}:${seconds < 10 ? "0" + seconds : seconds}`;
		let msg = getLang("info", title, channel.name, formatNumber(channel.subscriberCount || 0), time, formatNumber(viewCount), formatNumber(likes), uploadDate, videoId, `https://youtu.be/${videoId}`);
		// if (chapters.length > 0) {
		// 	msg += getLang("listChapter")
		// 		+ chapters.reduce((acc, cur) => {
		// 			const time = convertTime(cur.start_time * 1000, ':', ':', ':').slice(0, -1);
		// 			return acc + ` ${time} => ${cur.title}\n`;
		// 		}, '');
		// }

		message.reply({
			body: msg,
			attachment: await Promise.all([
				getStreamFromURL(infoVideo.thumbnails[infoVideo.thumbnails.length - 1].url),
				getStreamFromURL(infoVideo.channel.thumbnails[infoVideo.channel.thumbnails.length - 1].url)
			])
		});
	}
}

async function downloadAudioWithYtDlp(videoId, maxSize) {
	const tmpDir = path.join(__dirname, "tmp");
	const stamp = Date.now();
	const baseName = `${videoId}_${stamp}_ytdlp`;
	const outputTemplate = path.join(tmpDir, `${baseName}.%(ext)s`);
	let audioPath = null;

	try {
		await fs.ensureDir(tmpDir);
		await youtubedl(`https://youtu.be/${videoId}`, {
			noPlaylist: true,
			noWarnings: true,
			preferFreeFormats: true,
			format: "bestaudio/best",
			extractAudio: true,
			audioFormat: "mp3",
			audioQuality: "5",
			ffmpegLocation: ffmpegPath ? path.dirname(ffmpegPath) : undefined,
			output: outputTemplate
		});

		const fileName = fs.readdirSync(tmpDir).find(name => name.startsWith(`${baseName}.`) && name.endsWith(".mp3"));
		if (!fileName)
			throw new Error("YTDLP_AUDIO_NOT_FOUND");
		audioPath = path.join(tmpDir, fileName);

		const stat = fs.statSync(audioPath);
		if (stat.size > maxSize) {
			fs.unlinkSync(audioPath);
			return null;
		}
		return audioPath;
	}
	catch (err) {
		if (audioPath && fs.existsSync(audioPath))
			fs.unlinkSync(audioPath);
		throw err;
	}
}

async function downloadVideoWithYtDlp(videoId, maxSize) {
	const tmpDir = path.join(__dirname, "tmp");
	const stamp = Date.now();
	const baseName = `${videoId}_${stamp}_ytdlp_video`;
	const outputTemplate = path.join(tmpDir, `${baseName}.%(ext)s`);
	let videoPath = null;

	try {
		await fs.ensureDir(tmpDir);
		await youtubedl(`https://youtu.be/${videoId}`, {
			noPlaylist: true,
			noWarnings: true,
			preferFreeFormats: true,
			format: "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
			mergeOutputFormat: "mp4",
			recodeVideo: "mp4",
			ffmpegLocation: ffmpegPath ? path.dirname(ffmpegPath) : undefined,
			output: outputTemplate
		});

		const fileName =
			fs.readdirSync(tmpDir).find(name => name.startsWith(`${baseName}.`) && name.endsWith(".mp4")) ||
			fs.readdirSync(tmpDir).find(name => name.startsWith(`${baseName}.`));
		if (!fileName)
			throw new Error("YTDLP_VIDEO_NOT_FOUND");
		videoPath = path.join(tmpDir, fileName);

		const stat = fs.statSync(videoPath);
		if (stat.size > maxSize) {
			fs.unlinkSync(videoPath);
			return null;
		}
		return videoPath;
	}
	catch (err) {
		if (videoPath && fs.existsSync(videoPath))
			fs.unlinkSync(videoPath);
		throw err;
	}
}

async function search(keyWord) {
	try {
		const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(keyWord)}`;
		const res = await axios.get(url);
		const getJson = JSON.parse(res.data.split("ytInitialData = ")[1].split(";</script>")[0]);
		const videos = getJson.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents;
		const results = [];
		for (const video of videos)
			if (video.videoRenderer?.lengthText?.simpleText) // check is video, not playlist or channel or live
				results.push({
					id: video.videoRenderer.videoId,
					title: video.videoRenderer.title.runs[0].text,
					thumbnail: video.videoRenderer.thumbnail.thumbnails.pop().url,
					time: video.videoRenderer.lengthText.simpleText,
					channel: {
						id: video.videoRenderer.ownerText.runs[0].navigationEndpoint.browseEndpoint.browseId,
						name: video.videoRenderer.ownerText.runs[0].text,
						thumbnail: video.videoRenderer.channelThumbnailSupportedRenderers.channelThumbnailWithLinkRenderer.thumbnail.thumbnails.pop().url.replace(/s[0-9]+\-c/g, '-c')
					}
				});
		return results;
	}
	catch (e) {
		const error = new Error("Cannot search video");
		error.code = "SEARCH_VIDEO_ERROR";
		throw error;
	}
}

async function getVideoInfo(id) {
	// get id from url if url
	id = id.replace(/(>|<)/gi, '').split(/(vi\/|v=|\/v\/|youtu\.be\/|\/embed\/|\/shorts\/)/);
	id = id[2] !== undefined ? id[2].split(/[^0-9a-z_\-]/i)[0] : id[0];

	let html;
	try {
		({ data: html } = await axios.get(`https://youtu.be/${id}?hl=en`, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.101 Safari/537.36'
			}
		}));
	}
	catch (e) {
		html = "";
	}

	let json;
	let json2;
	try {
		const playerResponseMatch = html.match(/var ytInitialPlayerResponse = (.*?});/);
		const initialDataMatch = html.match(/var ytInitialData = (.*?});/);
		if (playerResponseMatch?.[1])
			json = JSON.parse(playerResponseMatch[1]);
		if (initialDataMatch?.[1])
			json2 = JSON.parse(initialDataMatch[1]);
	}
	catch (e) {
		json = null;
		json2 = null;
	}

	if (json?.videoDetails) {
		const { title, lengthSeconds, viewCount, videoId, thumbnail, author } = json.videoDetails;
		let getChapters;
		try {
			getChapters = json2.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer.playerBar.multiMarkersPlayerBarRenderer.markersMap.find(x => x.key == "DESCRIPTION_CHAPTERS" && x.value.chapters).value.chapters;
		}
		catch (e) {
			getChapters = [];
		}
		const owner = json2?.contents?.twoColumnWatchNextResults?.results?.results?.contents?.find(x => x.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer?.owner;

		return {
			videoId,
			title,
			video_url: `https://youtu.be/${videoId}`,
			lengthSeconds: String(lengthSeconds || 0).match(/\d+/)?.[0] || 0,
			viewCount: String(viewCount || 0).match(/\d+/)?.[0] || 0,
			uploadDate: json?.microformat?.playerMicroformatRenderer?.uploadDate || "",
			// contents.twoColumnWatchNextResults.results.results.contents[0].videoPrimaryInfoRenderer.videoActions.menuRenderer.topLevelButtons[0].segmentedLikeDislikeButtonViewModel.likeButtonViewModel.likeButtonViewModel.toggleButtonViewModel.toggleButtonViewModel.defaultButtonViewModel.buttonViewModel.accessibilityText
			likes: json2?.contents?.twoColumnWatchNextResults?.results?.results?.contents?.find(x => x.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer?.videoActions?.menuRenderer?.topLevelButtons?.find(x => x.segmentedLikeDislikeButtonViewModel)?.segmentedLikeDislikeButtonViewModel?.likeButtonViewModel?.likeButtonViewModel?.toggleButtonViewModel?.toggleButtonViewModel?.defaultButtonViewModel?.buttonViewModel?.accessibilityText?.replace(/\.|,/g, '')?.match(/\d+/)?.[0] || 0,
			chapters: getChapters.map((x, i) => {
				const start_time = x.chapterRenderer.timeRangeStartMillis;
				const end_time = getChapters[i + 1]?.chapterRenderer?.timeRangeStartMillis || (String(lengthSeconds || 0).match(/\d+/)?.[0] || 0) * 1000;

				return {
					title: x.chapterRenderer.title.simpleText,
					start_time_ms: start_time,
					start_time: start_time / 1000,
					end_time_ms: end_time - start_time + start_time,
					end_time: (end_time - start_time + start_time) / 1000
				};
			}),
			thumbnails: thumbnail?.thumbnails || [],
			author: author,
			channel: {
				id: owner?.videoOwnerRenderer?.navigationEndpoint?.browseEndpoint?.browseId || "",
				username: owner?.videoOwnerRenderer?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || "",
				name: owner?.videoOwnerRenderer?.title?.runs?.[0]?.text || author || "Unknown",
				thumbnails: owner?.videoOwnerRenderer?.thumbnail?.thumbnails || [],
				subscriberCount: parseAbbreviatedNumber(owner?.videoOwnerRenderer?.subscriberCountText?.simpleText) || 0
			}
		};
	}

	// fallback: ytdl data is usually more stable than manual HTML scraping
	const info = await ytdl.getBasicInfo(id);
	const videoDetails = info?.videoDetails || {};
	const thumbnails = videoDetails?.thumbnails || [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }];
	const author = videoDetails?.author || {};
	const uploadDate = info?.player_response?.microformat?.playerMicroformatRenderer?.uploadDate || "";

	return {
		videoId: videoDetails?.videoId || id,
		title: videoDetails?.title || "Unknown title",
		video_url: `https://youtu.be/${videoDetails?.videoId || id}`,
		lengthSeconds: String(videoDetails?.lengthSeconds || 0),
		viewCount: String(videoDetails?.viewCount || 0),
		uploadDate,
		likes: 0,
		chapters: [],
		thumbnails,
		author: author?.name || author || "Unknown",
		channel: {
			id: author?.id || "",
			username: author?.channel_url || "",
			name: author?.name || "Unknown",
			thumbnails: author?.thumbnails || thumbnails,
			subscriberCount: Number(author?.subscriber_count || 0)
		}
	};
}

function parseAbbreviatedNumber(string) {
	if (typeof string !== "string")
		return null;
	const match = string
		.replace(',', '.')
		.replace(' ', '')
		.match(/([\d,.]+)([MK]?)/);
	if (match) {
		let [, num, multi] = match;
		num = parseFloat(num);
		return Math.round(multi === 'M' ? num * 1000000 :
			multi === 'K' ? num * 1000 : num);
	}
	return null;
}
