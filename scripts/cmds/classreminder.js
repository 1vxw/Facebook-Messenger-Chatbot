const axios = require("axios");
const moment = require("moment-timezone");

const DAY_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const DAY_TO_NUMBER = {
	sun: 0, sunday: 0, su: 0,
	mon: 1, monday: 1, mo: 1, m: 1,
	tue: 2, tues: 2, tuesday: 2, tu: 2, t: 2,
	wed: 3, wednesday: 3, we: 3, w: 3,
	thu: 4, thur: 4, thurs: 4, thursday: 4, th: 4,
	fri: 5, friday: 5, fr: 5, f: 5,
	sat: 6, saturday: 6, sa: 6
};

const CSV_HEADERS = {
	day: ["day", "weekday", "araw"],
	start: ["start", "starttime", "time", "from", "time_start", "givenplannedearlieststart", "plannedstart"],
	end: ["end", "endtime", "to", "time_end", "givenplannedearliestend", "plannedend"],
	subject: ["subject", "course", "class", "title", "coursecode", "course_code", "additionaltitle"],
	instructor: ["instructor", "teacher", "professor", "prof", "lecturer"],
	location: ["location", "room", "venue", "link", "place", "assignedresources"],
	notes: ["notes", "description", "rrule"]
};

function normalizeTime(input) {
	if (!input)
		return null;
	const raw = String(input).trim().toLowerCase();
	const ampmMatch = raw.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
	if (ampmMatch) {
		let hour = Number(ampmMatch[1]);
		const minute = Number(ampmMatch[2]);
		const suffix = ampmMatch[3].toLowerCase();
		if (hour < 1 || hour > 12 || minute > 59)
			return null;
		if (suffix === "pm" && hour !== 12)
			hour += 12;
		if (suffix === "am" && hour === 12)
			hour = 0;
		return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
	}

	if (!/^\d{1,2}:\d{2}$/.test(raw))
		return extractTimeFromDateTime(raw);
	const [h, m] = raw.split(":").map(Number);
	if (h < 0 || h > 23 || m < 0 || m > 59)
		return null;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function extractTimeFromDateTime(input) {
	const value = String(input || "").trim();
	const m = value.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
	if (!m)
		return null;
	let hour = Number(m[1]);
	const minute = Number(m[2]);
	const suffix = (m[3] || "").toLowerCase();
	if (minute < 0 || minute > 59)
		return null;
	if (suffix) {
		if (hour < 1 || hour > 12)
			return null;
		if (suffix === "pm" && hour !== 12)
			hour += 12;
		if (suffix === "am" && hour === 12)
			hour = 0;
	}
	else if (hour < 0 || hour > 23) {
		return null;
	}
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeDayToken(token) {
	if (token == null)
		return null;
	const clean = String(token).trim().toLowerCase();
	if (clean === "")
		return null;
	if (!isNaN(clean)) {
		const dayNumber = Number(clean);
		if (dayNumber >= 0 && dayNumber <= 6)
			return dayNumber;
	}
	if (DAY_TO_NUMBER[clean] !== undefined)
		return DAY_TO_NUMBER[clean];
	return null;
}

function parseDays(input) {
	if (!input)
		return [];
	const raw = String(input).trim().toLowerCase();
	if (raw === "")
		return [];

	const normalized = raw
		.replace(/,/g, "/")
		.replace(/&/g, "/")
		.replace(/\band\b/g, "/")
		.replace(/\s+/g, "/");

	const parts = normalized.split("/").filter(Boolean);
	const days = new Set();

	for (const part of parts) {
		const direct = normalizeDayToken(part);
		if (direct !== null) {
			days.add(direct);
			continue;
		}
		if (/^[mtwfsu]+$/.test(part)) {
			const letters = part.split("");
			for (let i = 0; i < letters.length; i++) {
				const c = letters[i];
				if (c === "t" && letters[i + 1] === "h") {
					days.add(4);
					i++;
					continue;
				}
				if (c === "s" && letters[i + 1] === "u") {
					days.add(0);
					i++;
					continue;
				}
				const parsed = normalizeDayToken(c);
				if (parsed !== null)
					days.add(parsed);
			}
		}
	}
	return [...days].sort((a, b) => a - b);
}

function extractByDayFromNotes(notes) {
	const text = String(notes || "");
	const match = text.match(/BYDAY=([^;]+)/i);
	if (!match)
		return [];
	return parseDays(match[1].replace(/,/g, "/"));
}

function ensureReminderData(input) {
	const data = input && typeof input === "object" ? input : {};
	if (!Array.isArray(data.classes))
		data.classes = [];
	if (!Array.isArray(data.dailyReminderTimes))
		data.dailyReminderTimes = ["20:00"];
	data.dailyReminderTimes = data.dailyReminderTimes.map(normalizeTime).filter(Boolean);
	if (data.dailyReminderTimes.length === 0)
		data.dailyReminderTimes = ["20:00"];
	if (!data.reminderMinutesBeforeClass || isNaN(data.reminderMinutesBeforeClass))
		data.reminderMinutesBeforeClass = 60;
	data.reminderMinutesBeforeClass = Math.max(1, Math.min(1440, Number(data.reminderMinutesBeforeClass)));
	if (typeof data.enabled !== "boolean")
		data.enabled = true;
	if (!data.sentMap || typeof data.sentMap !== "object")
		data.sentMap = {};
	return data;
}

function classLine(c, idx) {
	const end = c.end ? `-${c.end}` : "";
	const location = c.location ? ` | ${c.location}` : "";
	return `${idx + 1}. ${DAY_LABEL[c.day]} ${c.start}${end} - ${c.subject} (Instructor: ${c.instructor || "N/A"})${location}`;
}

function parseCsv(text) {
	const firstLine = String(text || "").split(/\r?\n/)[0] || "";
	const delimiter = firstLine.includes("\t") ? "\t" : ",";
	const rows = [];
	let row = [];
	let cell = "";
	let inQuotes = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];

		if (ch === '"') {
			if (inQuotes && next === '"') {
				cell += '"';
				i++;
			}
			else {
				inQuotes = !inQuotes;
			}
			continue;
		}

		if (ch === delimiter && !inQuotes) {
			row.push(cell);
			cell = "";
			continue;
		}

		if ((ch === "\n" || ch === "\r") && !inQuotes) {
			if (ch === "\r" && next === "\n")
				i++;
			row.push(cell);
			cell = "";
			if (row.some(v => String(v).trim() !== ""))
				rows.push(row);
			row = [];
			continue;
		}

		cell += ch;
	}

	row.push(cell);
	if (row.some(v => String(v).trim() !== ""))
		rows.push(row);
	return rows;
}

function normalizeHeader(h) {
	return String(h || "")
		.replace(/^\uFEFF/, "")
		.replace(/^"+|"+$/g, "")
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/g, "");
}

function getColumnIndex(headers, key) {
	const normalized = headers.map(normalizeHeader);
	const targets = CSV_HEADERS[key].map(normalizeHeader);
	for (const t of targets) {
		const idx = normalized.findIndex(h => h === t);
		if (idx !== -1)
			return idx;
	}
	return -1;
}

function toClassItemsFromRows(rows) {
	if (!rows.length)
		return { classes: [], skipped: 0 };

	const headers = rows[0];
	let hasHeader = false;
	const probe = headers.map(normalizeHeader);
	for (const key of Object.keys(CSV_HEADERS)) {
		if (probe.some(h => CSV_HEADERS[key].map(normalizeHeader).includes(h))) {
			hasHeader = true;
			break;
		}
	}
	if (!hasHeader && probe.length >= 4) {
		const probeJoined = probe.join("|");
		if (probeJoined.includes("title") && probeJoined.includes("givenplannedearlieststart"))
			hasHeader = true;
	}

	const bodyRows = hasHeader ? rows.slice(1) : rows;
	const dayIdx = hasHeader ? getColumnIndex(headers, "day") : 0;
	const startIdx = hasHeader ? getColumnIndex(headers, "start") : 1;
	const endIdx = hasHeader ? getColumnIndex(headers, "end") : 2;
	const subjectIdx = hasHeader ? getColumnIndex(headers, "subject") : 3;
	const instructorIdx = hasHeader ? getColumnIndex(headers, "instructor") : 4;
	const locationIdx = hasHeader ? getColumnIndex(headers, "location") : 5;
	const notesIdx = hasHeader ? getColumnIndex(headers, "notes") : -1;

	const classes = [];
	let skipped = 0;

	for (const r of bodyRows) {
		const dayRaw = dayIdx >= 0 ? r[dayIdx] : "";
		const startRaw = startIdx >= 0 ? r[startIdx] : "";
		const endRaw = endIdx >= 0 ? r[endIdx] : "";
		const subjectRaw = subjectIdx >= 0 ? r[subjectIdx] : "";
		const instructorRaw = instructorIdx >= 0 ? r[instructorIdx] : "";
		const locationRaw = locationIdx >= 0 ? r[locationIdx] : "";
		const notesRaw = notesIdx >= 0 ? r[notesIdx] : "";

		let days = parseDays(dayRaw);
		if (days.length === 0)
			days = extractByDayFromNotes(notesRaw);
		const start = normalizeTime(startRaw);
		const end = normalizeTime(endRaw);
		const subject = String(subjectRaw || "").trim();
		const instructor = String(instructorRaw || "").trim();
		const location = String(locationRaw || "").trim();

		if (days.length === 0 || !start || !subject) {
			skipped++;
			continue;
		}

		for (const day of days) {
			classes.push({
				id: `${Date.now()}_${Math.floor(Math.random() * 100000)}`,
				day,
				start,
				end: end || "",
				subject,
				instructor,
				location
			});
		}
	}
	return { classes, skipped };
}

function findCsvAttachment(event) {
	const attachments = [
		...(event.attachments || []),
		...(event.messageReply?.attachments || [])
	];
	return attachments.find(att => {
		const name = String(att?.name || "").toLowerCase();
		const url = String(att?.url || "").toLowerCase();
		const type = String(att?.type || "").toLowerCase();
		return name.endsWith(".csv") || url.includes(".csv") || type === "file";
	});
}

async function runReminderTick(api, usersData, logger) {
	const timeZone = global.GoatBot.config.timeZone || "Asia/Manila";
	const now = moment.tz(timeZone);
	const nowHm = now.format("HH:mm");
	const nowFull = now.format("YYYY-MM-DD HH:mm");
	const users = global.db.allUserData || [];

	for (const user of users) {
		const userID = user.userID;
		const data = ensureReminderData(user.data?.classReminder);
		if (!data.enabled || data.classes.length === 0)
			continue;

		let changed = false;
		for (const [key, ts] of Object.entries(data.sentMap)) {
			if (!ts || now.valueOf() - ts > 14 * 24 * 60 * 60 * 1000) {
				delete data.sentMap[key];
				changed = true;
			}
		}

		for (const remindTime of data.dailyReminderTimes) {
			if (remindTime !== nowHm)
				continue;
			const sentKey = `daily_${now.format("YYYY-MM-DD")}_${remindTime}`;
			if (data.sentMap[sentKey])
				continue;

			const tomorrow = now.clone().add(1, "day");
			const tomorrowDay = tomorrow.day();
			const tomorrowClasses = data.classes
				.filter(c => c.day === tomorrowDay)
				.sort((a, b) => a.start.localeCompare(b.start));

			const headerDate = tomorrow.format("dddd, YYYY-MM-DD");
			let body = `Tomorrow's classes (${headerDate}):`;
			if (tomorrowClasses.length === 0)
				body += "\nNo classes scheduled.";
			else
				body += `\n${tomorrowClasses.map((c, i) => `${i + 1}. ${c.start}${c.end ? `-${c.end}` : ""} ${c.subject} | ${c.instructor || "N/A"}`).join("\n")}`;

			try {
				await api.sendMessage(body, userID);
				data.sentMap[sentKey] = Date.now();
				changed = true;
			}
			catch (err) {
				logger.err("CLASS_REMINDER", `Tomorrow reminder failed for ${userID}: ${err?.message || err}`);
			}
		}

		for (const c of data.classes) {
			if (c.day !== now.day() || !c.start)
				continue;
			const classMoment = moment.tz(`${now.format("YYYY-MM-DD")} ${c.start}`, "YYYY-MM-DD HH:mm", timeZone);
			if (!classMoment.isValid())
				continue;
			const triggerMoment = classMoment.clone().subtract(data.reminderMinutesBeforeClass, "minutes");
			if (triggerMoment.format("YYYY-MM-DD HH:mm") !== nowFull)
				continue;

			const sentKey = `before_${c.id}_${triggerMoment.format("YYYY-MM-DD HH:mm")}`;
			if (data.sentMap[sentKey])
				continue;

			const txt = `Class starts in ${data.reminderMinutesBeforeClass} minutes.\n${c.subject}\nTime: ${c.start}${c.end ? `-${c.end}` : ""}\nInstructor: ${c.instructor || "N/A"}${c.location ? `\nLocation: ${c.location}` : ""}`;
			try {
				await api.sendMessage(txt, userID);
				data.sentMap[sentKey] = Date.now();
				changed = true;
			}
			catch (err) {
				logger.err("CLASS_REMINDER", `Before-class reminder failed for ${userID}: ${err?.message || err}`);
			}
		}

		if (changed)
			await usersData.set(userID, data, "data.classReminder");
	}
}

module.exports = {
	config: {
		name: "classrem",
		aliases: ["classreminder", "schedule", "sched", "setclassrem"],
		version: "2.0",
		author: "VincePradas + Codex",
		countDown: 3,
		role: 0,
		description: {
			en: "Import class schedule from CSV and run automatic reminders"
		},
		category: "utility",
		guide: {
			en: "{pn} set (reply to a .csv file)\n"
				+ "{pn} list\n"
				+ "{pn} today\n"
				+ "{pn} tomorrow\n"
				+ "{pn} add <day> <HH:mm> <subject> | <instructor> | <end> | <location>\n"
				+ "{pn} edit <index> <day> <HH:mm> <subject> | <instructor> | <end> | <location>\n"
				+ "{pn} delete <index>\n"
				+ "{pn} times list|add <HH:mm>|remove <HH:mm>\n"
				+ "{pn} before <minutes>\n"
				+ "{pn} [on|off]"
		}
	},

	langs: {
		en: {
			usage: "Usage:\n%1",
			noCsv: "Reply to your schedule .csv file, then run: %1 set",
			importFail: "Could not parse CSV. Required columns: day, start/time, subject/course.",
			importDone: "Imported %1 classes from CSV (%2 skipped).",
			empty: "No classes saved yet.",
			listHeader: "Reminder Manager\nStatus: %1\nBefore-class: %2 minute(s)\nTomorrow reminders at: %3\n\nClasses:",
			todayEmpty: "No classes today.",
			tomorrowEmpty: "No classes tomorrow.",
			addMissing: "Use: %1 add <day> <HH:mm> <subject> | <instructor> | <end> | <location>",
			editMissing: "Use: %1 edit <index> <day> <HH:mm> <subject> | <instructor> | <end> | <location>",
			invalidDay: "Invalid day. Example: mon, tue, wed, thu, fri, sat, sun",
			invalidTime: "Invalid time. Use HH:mm (24h) or h:mm am/pm.",
			invalidIndex: "Invalid class index.",
			added: "Added:\n%1",
			edited: "Updated:\n%1",
			deleted: "Deleted: %1",
			minutesInvalid: "Minutes must be 1-1440.",
			minutesSet: "Before-class reminder is now %1 minute(s).",
			timeMissing: "Use: %1 times add <HH:mm> or %1 times remove <HH:mm>",
			timeAdded: "Added tomorrow reminder time: %1",
			timeExists: "That reminder time already exists.",
			timeRemoved: "Removed tomorrow reminder time: %1",
			timeNotFound: "That reminder time was not found.",
			timeList: "Tomorrow reminder times:\n%1",
			enabled: "Class reminders are now ON.",
			disabled: "Class reminders are now OFF."
		}
	},

	onLoad: async function ({ api, usersData }) {
		if (global.temp.classReminderWorkerStarted)
			return;
		global.temp.classReminderWorkerStarted = true;
		const logger = global.utils.log;
		logger.info("CLASS_REMINDER", "Worker started (checks every 30 seconds).");
		setInterval(async () => {
			try {
				await runReminderTick(api, usersData, logger);
			}
			catch (err) {
				logger.err("CLASS_REMINDER", err?.stack || err?.message || String(err));
			}
		}, 30000);
	},

	onStart: async function ({ message, event, args, usersData, getLang }) {
		const senderID = event.senderID;
		const prefix = global.utils.getPrefix(event.threadID);
		const pn = `${prefix}classrem`;
		const usage = module.exports.config.guide.en.replaceAll("{pn}", pn);

		const data = ensureReminderData(await usersData.get(senderID, "data.classReminder", {}));
		const action = (args[0] || "").toLowerCase();

		if (!action)
			return message.reply(getLang("usage", usage));

		if (action === "set") {
			const csvAttachment = findCsvAttachment(event);
			if (!csvAttachment?.url)
				return message.reply(getLang("noCsv", pn));
			let csvText;
			try {
				const response = await axios.get(csvAttachment.url, { responseType: "text" });
				csvText = String(response.data || "");
			}
			catch (err) {
				return message.reply(`Failed to download CSV: ${err?.message || err}`);
			}
			const rows = parseCsv(csvText);
			const { classes, skipped } = toClassItemsFromRows(rows);
			if (!classes.length)
				return message.reply(getLang("importFail"));
			data.classes = classes;
			data.sentMap = {};
			await usersData.set(senderID, data, "data.classReminder");
			return message.reply(getLang("importDone", classes.length, skipped));
		}

		if (action === "list") {
			if (!data.classes.length)
				return message.reply(getLang("empty"));
			const classes = [...data.classes].sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
			const lines = classes.map((c, i) => classLine(c, i)).join("\n");
			return message.reply(
				`${getLang("listHeader", data.enabled ? "ON" : "OFF", data.reminderMinutesBeforeClass, data.dailyReminderTimes.join(", "))}\n${lines}`
			);
		}

		if (action === "today" || action === "tomorrow") {
			const tz = global.GoatBot.config.timeZone || "Asia/Manila";
			const now = moment.tz(tz);
			const targetDay = action === "today" ? now.day() : now.clone().add(1, "day").day();
			const classes = data.classes.filter(c => c.day === targetDay).sort((a, b) => a.start.localeCompare(b.start));
			if (!classes.length)
				return message.reply(getLang(action === "today" ? "todayEmpty" : "tomorrowEmpty"));
			return message.reply(classes.map((c, i) => classLine(c, i)).join("\n"));
		}

		if (action === "add" || action === "edit") {
			let payloadArgs = args.slice(1);
			let targetIndex = null;

			if (action === "edit") {
				targetIndex = Number(payloadArgs[0]) - 1;
				if (isNaN(targetIndex) || targetIndex < 0 || targetIndex >= data.classes.length)
					return message.reply(getLang("invalidIndex"));
				payloadArgs = payloadArgs.slice(1);
			}

			const raw = payloadArgs.join(" ");
			const segments = raw.split("|").map(s => s.trim());
			const head = segments[0] || "";
			const pieces = head.split(/\s+/).filter(Boolean);
			const dayToken = pieces.shift();
			const startToken = pieces.shift();
			const subject = pieces.join(" ").trim();
			const instructor = segments[1] || "";
			const end = normalizeTime(segments[2] || "");
			const location = segments[3] || "";

			if (!dayToken || !startToken || !subject)
				return message.reply(getLang(action === "add" ? "addMissing" : "editMissing", pn));

			const day = normalizeDayToken(dayToken);
			if (day === null)
				return message.reply(getLang("invalidDay"));
			const start = normalizeTime(startToken);
			if (!start)
				return message.reply(getLang("invalidTime"));

			const next = {
				id: action === "edit" ? data.classes[targetIndex].id : `${Date.now()}_${Math.floor(Math.random() * 100000)}`,
				day,
				start,
				end: end || "",
				subject,
				instructor,
				location
			};

			if (action === "add") {
				data.classes.push(next);
				await usersData.set(senderID, data, "data.classReminder");
				return message.reply(getLang("added", classLine(next, data.classes.length - 1)));
			}

			data.classes[targetIndex] = next;
			await usersData.set(senderID, data, "data.classReminder");
			return message.reply(getLang("edited", classLine(next, targetIndex)));
		}

		if (action === "delete" || action === "remove") {
			const idx = Number(args[1]) - 1;
			if (isNaN(idx) || idx < 0 || idx >= data.classes.length)
				return message.reply(getLang("invalidIndex"));
			const removed = data.classes.splice(idx, 1)[0];
			await usersData.set(senderID, data, "data.classReminder");
			return message.reply(getLang("deleted", `${DAY_LABEL[removed.day]} ${removed.start} - ${removed.subject}`));
		}

		if (action === "before") {
			const minutes = Number(args[1]);
			if (isNaN(minutes) || minutes < 1 || minutes > 1440)
				return message.reply(getLang("minutesInvalid"));
			data.reminderMinutesBeforeClass = Math.floor(minutes);
			await usersData.set(senderID, data, "data.classReminder");
			return message.reply(getLang("minutesSet", data.reminderMinutesBeforeClass));
		}

		if (action === "times") {
			const sub = (args[1] || "list").toLowerCase();
			if (sub === "list")
				return message.reply(getLang("timeList", data.dailyReminderTimes.join("\n")));

			const t = normalizeTime(args[2]);
			if (!t)
				return message.reply(getLang("timeMissing", pn));

			if (sub === "add") {
				if (data.dailyReminderTimes.includes(t))
					return message.reply(getLang("timeExists"));
				data.dailyReminderTimes.push(t);
				data.dailyReminderTimes.sort();
				await usersData.set(senderID, data, "data.classReminder");
				return message.reply(getLang("timeAdded", t));
			}

			if (sub === "remove") {
				if (!data.dailyReminderTimes.includes(t))
					return message.reply(getLang("timeNotFound"));
				data.dailyReminderTimes = data.dailyReminderTimes.filter(x => x !== t);
				if (!data.dailyReminderTimes.length)
					data.dailyReminderTimes = ["20:00"];
				await usersData.set(senderID, data, "data.classReminder");
				return message.reply(getLang("timeRemoved", t));
			}
			return message.reply(getLang("timeMissing", pn));
		}

		if (action === "on" || action === "off") {
			data.enabled = action === "on";
			await usersData.set(senderID, data, "data.classReminder");
			return message.reply(getLang(data.enabled ? "enabled" : "disabled"));
		}

		return message.reply(getLang("usage", usage));
	}
};
