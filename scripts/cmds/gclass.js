const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");
const { google } = require("googleapis");
const { Readable } = require("stream");
const { Document, Packer, Paragraph } = require("docx");
const PDFDocument = require("pdfkit");

const DOWNLOAD_DIR = path.join(__dirname, "tmp", "classroom");
const TOKENS_FILE = path.join(process.cwd(), "database", "data", "classroomUserTokens.json");
const OAUTH_REDIRECT_URI = "https://developers.google.com/oauthplayground";
const OAUTH_SCOPES = [
	"https://www.googleapis.com/auth/drive.file",
	"https://www.googleapis.com/auth/drive.readonly",
	"https://www.googleapis.com/auth/classroom.courses.readonly",
	"https://www.googleapis.com/auth/classroom.coursework.me.readonly",
	"https://www.googleapis.com/auth/classroom.coursework.me",
	"https://www.googleapis.com/auth/classroom.student-submissions.me.readonly"
];

if (!global.temp)
	global.temp = {};
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

function getOAuthBaseConfig() {
	const gmailCfg = global?.GoatBot?.config?.credentials?.gmailAccount || {};
	return {
		clientId: gmailCfg.clientId || "",
		clientSecret: gmailCfg.clientSecret || ""
	};
}

function createOAuthClient() {
	const { clientId, clientSecret } = getOAuthBaseConfig();
	return new google.auth.OAuth2(clientId, clientSecret, OAUTH_REDIRECT_URI);
}

async function loadTokenStore() {
	await fs.ensureFile(TOKENS_FILE);
	let raw = await fs.readFile(TOKENS_FILE, "utf8");
	if (!raw.trim()) {
		await fs.writeFile(TOKENS_FILE, "{}", "utf8");
		raw = "{}";
	}
	try {
		const data = JSON.parse(raw);
		return data && typeof data === "object" ? data : {};
	}
	catch (_e) {
		return {};
	}
}

async function saveTokenStore(data) {
	await fs.ensureDir(path.dirname(TOKENS_FILE));
	await fs.writeFile(TOKENS_FILE, JSON.stringify(data, null, 2), "utf8");
}

async function getUserToken(senderID) {
	const store = await loadTokenStore();
	return store[String(senderID)] || null;
}

async function setUserToken(senderID, token) {
	const store = await loadTokenStore();
	store[String(senderID)] = token;
	await saveTokenStore(store);
}

async function removeUserToken(senderID) {
	const store = await loadTokenStore();
	delete store[String(senderID)];
	await saveTokenStore(store);
}

async function getClientsForUser(senderID) {
	const token = await getUserToken(senderID);
	if (!token)
		return null;

	const auth = createOAuthClient();
	auth.setCredentials(token);
	return {
		classroom: google.classroom({ version: "v1", auth }),
		drive: google.drive({ version: "v3", auth }),
		auth
	};
}

function isInvalidGrantError(err) {
	const msg = String(
		err?.response?.data?.error_description ||
		err?.response?.data?.error ||
		err?.response?.data?.error?.message ||
		err?.message ||
		""
	).toLowerCase();
	return msg.includes("invalid_grant");
}

function ensureState() {
	if (!global.temp.classroomState)
		global.temp.classroomState = {};
	return global.temp.classroomState;
}

function getStateKey(senderID, threadID) {
	return `${String(senderID)}:${String(threadID || "")}`;
}

function getStateBucket(senderID, threadID) {
	const state = ensureState();
	const key = getStateKey(senderID, threadID);
	if (!state[key])
		state[key] = {};
	return state[key];
}

function safeName(name) {
	return String(name || "file").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
}

function toDateString(item) {
	const dueDate = item.courseWork?.dueDate;
	const dueTime = item.courseWork?.dueTime || {};
	if (!dueDate)
		return "No due date";
	const y = dueDate.year || 1970;
	const m = dueDate.month || 1;
	const d = dueDate.day || 1;
	const hh = dueTime.hours || 0;
	const mm = dueTime.minutes || 0;
	return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function summarizeTask(task, index) {
	return `${index + 1}. [${task.courseName}] ${task.courseWork.title || "(Untitled)"} | state: ${task.submission.state || "UNKNOWN"} | due: ${toDateString(task)}`;
}

function summarizeCourse(course, index) {
	return `${index + 1}. ${course.name || course.section || "Unknown Course"} (courseId: ${course.id})`;
}

function renderTaskText(task, index) {
	const cw = task?.courseWork || {};
	const title = cw.title || "(Untitled)";
	const desc = cw.description || "No description provided.";
	const due = toDateString(task);
	const state = task?.submission?.state || "UNKNOWN";
	const maxPoints = typeof cw.maxPoints === "number" ? cw.maxPoints : null;
	const workType = cw.workType || "UNKNOWN";

	const lines = [
		`Task #${index + 1}`,
		`Course: ${task.courseName}`,
		`Title: ${title}`,
		`Type: ${workType}`,
		`State: ${state}`,
		`Due: ${due}`
	];
	if (maxPoints !== null)
		lines.push(`Points: ${maxPoints}`);

	lines.push("", "Task Text:", desc);
	return lines.join("\n");
}

function summarizeTaskAboutFallback(task, index) {
	const title = task?.courseWork?.title || `(Task #${index + 1})`;
	const raw = String(task?.courseWork?.description || "").replace(/\s+/g, " ").trim();
	if (!raw)
		return `${title}: complete the assigned activity and submit based on the course requirements.`;
	const firstSentence = raw.split(/(?<=[.!?])\s+/)[0] || raw.slice(0, 220);
	const actionMatch = raw.match(/\b(submit|create|build|design|write|solve|complete|develop|analyze|prepare|implement|record|upload)\b/i);
	if (actionMatch)
		return `${title}: ${actionMatch[1]} the required output and submit it following the task constraints and deadline.`;
	return `${title}: ${firstSentence}`;
}

function normalizeLoose(text) {
	return String(text || "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function isWeakTaskSummary(summary, task) {
	const s = normalizeLoose(summary);
	const title = normalizeLoose(task?.courseWork?.title || "");
	const desc = normalizeLoose(task?.courseWork?.description || "");
	if (!s || s.length < 35)
		return true;
	// mostly title echo
	if (title && (s === title || s.startsWith(title)))
		return true;
	// generic greeting/announcement noise
	if (/^(hello|hi|good morning|good afternoon|dear class|announcement)\b/.test(s))
		return true;
	// no action verb cue
	if (!/(submit|create|build|write|answer|upload|complete|design|develop|prepare|turn in)/.test(s))
		return true;
	// near direct copy of first desc chunk
	if (desc && desc.startsWith(s))
		return true;
	return false;
}

async function summarizeTaskAboutWithGemini({ apiKey, model, task, index }) {
	const resolvedModel = await resolveClassroomModel(apiKey, model);
	const prompt = [
		"Summarize what this assignment is about in one short direct text.",
		"Rules:",
		"- Maximum 1 sentence.",
		"- Keep it concise and practical.",
		"- Start with the required action (e.g., submit/create/write/build/upload).",
		"- Do not echo the title, greeting lines, emojis, or announcements.",
		"- Focus on the actual required deliverable and deadline intent.",
		"- Do not repeat full instructions.",
		"- Plain text only.",
		"",
		`Task #${index + 1}`,
		`Course: ${task?.courseName || "Unknown Course"}`,
		`Title: ${task?.courseWork?.title || "(Untitled)"}`,
		"Description:",
		String(task?.courseWork?.description || "No description provided.")
	].join("\n");

	const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(resolvedModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
	const { data } = await axios.post(url, {
		contents: [{ role: "user", parts: [{ text: prompt }] }],
		generationConfig: {
			temperature: 0.1,
			topP: 0.95,
			maxOutputTokens: 120
		}
	}, { timeout: 25000 });

	const text = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("").replace(/\s+/g, " ").trim();
	if (!text)
		throw new Error("Gemini returned empty summary");
	return text;
}

function normalizeModelName(modelName) {
	return String(modelName || "").replace(/^models\//, "").trim();
}

async function resolveClassroomModel(apiKey, preferredModel) {
	if (!global.temp.classroomModelCache)
		global.temp.classroomModelCache = {};
	const preferred = normalizeModelName(preferredModel) || "gemini-1.5-flash";
	const cacheKey = `${apiKey}:${preferred}`;
	if (global.temp.classroomModelCache[cacheKey])
		return global.temp.classroomModelCache[cacheKey];

	const fallbackList = [preferred, "gemini-1.5-flash", "gemini-1.5-pro"].filter(Boolean);
	try {
		const { data } = await axios.get(`${GEMINI_API_BASE}/models?key=${encodeURIComponent(apiKey)}`, { timeout: 15000 });
		const models = Array.isArray(data?.models) ? data.models : [];
		const available = new Set(models.map(m => normalizeModelName(m?.name)).filter(Boolean));
		for (const m of fallbackList) {
			if (available.has(m)) {
				global.temp.classroomModelCache[cacheKey] = m;
				return m;
			}
		}
		const firstGenerateCapable = models.find(m =>
			Array.isArray(m?.supportedGenerationMethods) &&
			m.supportedGenerationMethods.includes("generateContent")
		);
		const chosen = normalizeModelName(firstGenerateCapable?.name) || preferred;
		global.temp.classroomModelCache[cacheKey] = chosen;
		return chosen;
	}
	catch (_e) {
		return preferred;
	}
}

async function generateDraftTextWithGemini({ apiKey, model, task }) {
	const resolvedModel = await resolveClassroomModel(apiKey, model);
	const title = task?.courseWork?.title || "Untitled";
	const description = task?.courseWork?.description || "No task description provided.";
	const due = toDateString(task);
	const prompt = [
		"You are an academic assistant. Write a clear, student-style draft answer.",
		"Output plain text (no markdown, no code fences).",
		"If data is missing, make reasonable assumptions and continue.",
		"",
		`Course: ${task.courseName}`,
		`Task title: ${title}`,
		`Due: ${due}`,
		"",
		"Task description:",
		description,
		"",
		"Write the full draft answer now."
	].join("\n");

	const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(resolvedModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
	const { data } = await axios.post(url, {
		contents: [{ role: "user", parts: [{ text: prompt }] }],
		generationConfig: {
			temperature: 0.4,
			topP: 0.95,
			maxOutputTokens: 1800
		}
	}, { timeout: 45000 });

	const text = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("").trim();
	if (!text)
		throw new Error("Gemini returned empty content");
	return text;
}

function safeJsonParse(text) {
	try {
		return JSON.parse(text);
	}
	catch (_e) {
		const match = String(text || "").match(/\{[\s\S]*\}/);
		if (!match)
			return null;
		try {
			return JSON.parse(match[0]);
		}
		catch (_e2) {
			return null;
		}
	}
}

function heuristicCapabilityCheck(task) {
	const text = `${task?.courseWork?.title || ""}\n${task?.courseWork?.description || ""}`.toLowerCase();
	const externalActionPatterns = [
		/\b(take|record|capture)\b.{0,30}\b(photo|picture|video|audio|voice)\b/i,
		/\b(upload|submit)\b.{0,30}\b(photo|picture|video|audio|recording|selfie)\b/i,
		/\b(handwritten|hand writing|on paper|paper-based)\b/i,
		/\b(physical|in-person|face to face|field work|lab experiment|presentation in class)\b/i,
		/\b(real[- ]?time|live demo|live presentation)\b/i
	];
	if (externalActionPatterns.some(rx => rx.test(text))) {
		return {
			capable: false,
			reason: "Task requires external real-world media/action that AI cannot physically perform.",
			responseText: "I cannot perform the physical/media capture itself, but I can produce a complete submission template, checklist, and final text/caption."
		};
	}

	const nonTextOnlyPatterns = [
		/\b(build|create|design|implement|develop|write|analyze|solve|compute)\b/i,
		/\b(database|sql|excel|spreadsheet|access|document|report|code|program|algorithm|essay|reflection|summary)\b/i,
		/\b(table|form|query|report)\b/i
	];
	if (nonTextOnlyPatterns.some(rx => rx.test(text))) {
		return {
			capable: true,
			reason: "Task is digital/text-constructive and can be completed with AI-generated content.",
			responseText: ""
		};
	}
	return {
		capable: true,
		reason: "Task appears solvable through generated digital content.",
		responseText: ""
	};
}

function buildDetailedHowToGuide(task) {
	const title = task?.courseWork?.title || "Assignment";
	const due = toDateString(task);
	const course = task?.courseName || "Unknown Course";
	const mode = heuristicCapabilityCheck(task).capable ? "digital" : "external";

	const modeSpecific = mode === "external"
		? [
			"Mode-specific notes (external deliverable):",
			"- You must create/capture the required media or real-world output yourself.",
			"- Keep proof/evidence of originality and submission."
		]
		: [
			"Mode-specific notes (digital deliverable):",
			"- Produce the artifact in the required format.",
			"- Validate against rubric/requirements before submission."
		];

	return [
		`Detailed execution guide for: ${title}`,
		`Course: ${course}`,
		`Due: ${due}`,
		"",
		"Execution strategy:",
		"- Identify required deliverable type, constraints, and grading criteria.",
		"- Build the output in the requested format and quality.",
		"- Verify deadline and submission channel before turn-in.",
		"",
		"Step-by-step plan:",
		"1) Extract constraints: format, scope, required sections, deadline, originality rules.",
		"2) Draft the output content and structure.",
		"3) Validate quality before upload:",
		"   - requirement coverage",
		"   - clear and readable",
		"   - follows format/rubric",
		"4) Prepare submission message/metadata:",
		"   - concise title",
		"   - short explanation/context",
		"5) Upload to Classroom and verify the correct file is attached and readable.",
		"6) Re-check deadline/timezone, then submit.",
		"7) Keep evidence (screenshot of submitted state).",
		"",
		...modeSpecific,
		"",
		"Submission checklist:",
		"- Requirement matched",
		"- Correct file attached",
		"- Proper caption/comment added",
		"- Submitted before due time",
		"",
		"Deliverable template you can submit:",
		"Title:",
		"Caption / Explanation:",
		"Evidence attached:",
		"Reflection (2-3 sentences):"
	].join("\n");
}

function mimeForExt(ext) {
	const e = String(ext || "").toLowerCase();
	switch (e) {
		case "pdf":
			return "application/pdf";
		case "docx":
		default:
			return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
	}
}

function shortActivityNameFromTask(task) {
	const raw = String(task?.courseWork?.title || "activity");
	const cleaned = raw.replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();
	const words = cleaned.split(" ").filter(Boolean).slice(0, 4);
	const short = words.join(" ").trim();
	return short || "activity";
}

function surnameOrFullName(fullName) {
	const name = String(fullName || "").trim();
	if (!name)
		return "Student";
	const parts = name.split(/\s+/).filter(Boolean);
	return parts.length > 1 ? parts[parts.length - 1] : name;
}

async function decideDraftFileTypeWithGemini({ apiKey, model, task, aiCapable, aiReason, aiDraft }) {
	const resolvedModel = await resolveClassroomModel(apiKey, model);
	const prompt = [
		"You choose the best file type for a generated assignment draft.",
		"Return ONLY valid JSON: {\"ext\":\"docx|pdf\",\"reason\":\"string\"}",
		"Choose between Word (.docx) or PDF only.",
		"If uncertain, choose docx.",
		"",
		`Course: ${task.courseName}`,
		`Title: ${task?.courseWork?.title || "Untitled"}`,
		`Capable: ${aiCapable ? "YES" : "NO"}`,
		`Reason: ${aiReason || "N/A"}`,
		"",
		"Draft preview:",
		String(aiDraft || "").slice(0, 1200)
	].join("\n");

	const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(resolvedModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
	const { data } = await axios.post(url, {
		contents: [{ role: "user", parts: [{ text: prompt }] }],
		generationConfig: {
			temperature: 0.1,
			topP: 0.95,
			maxOutputTokens: 300
		}
	}, { timeout: 30000 });

	const raw = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("").trim();
	const parsed = safeJsonParse(raw);
	const ext = String(parsed?.ext || "docx").toLowerCase();
	const allow = new Set(["docx", "pdf"]);
	return {
		ext: allow.has(ext) ? ext : "docx",
		reason: String(parsed?.reason || "Defaulted to docx")
	};
}

async function writeDraftFile(localPath, ext, content) {
	if (ext === "pdf") {
		await new Promise((resolve, reject) => {
			const pdf = new PDFDocument({ margin: 48, size: "A4" });
			const ws = fs.createWriteStream(localPath);
			pdf.pipe(ws);
			for (const line of String(content || "").split("\n")) {
				pdf.text(line, { lineGap: 2 });
			}
			pdf.end();
			ws.on("finish", resolve);
			ws.on("error", reject);
		});
		return;
	}

	const doc = new Document({
		sections: [{
			properties: {},
			children: String(content || "")
				.split("\n")
				.map(line => new Paragraph(line))
		}]
	});
	const buffer = await Packer.toBuffer(doc);
	await fs.writeFile(localPath, buffer);
}

async function evaluateAndGenerateWithGemini({ apiKey, model, task }) {
	const resolvedModel = await resolveClassroomModel(apiKey, model);
	const title = task?.courseWork?.title || "Untitled";
	const description = task?.courseWork?.description || "No task description provided.";
	const due = toDateString(task);

	const prompt = [
		"You are a strict assignment analyzer.",
		"Determine whether an AI text assistant can directly complete this task.",
		"Return ONLY valid JSON with this schema:",
		"{\"capable\":boolean,\"reason\":\"string\",\"responseText\":\"string\"}",
		"Rules:",
		"- capable=false if task needs real-world action/media (selfie, actual photo upload, physical/lab work, live attendance, etc.).",
		"- capable=true for digital/text tasks (coding, database design docs, written outputs, structured plans, reports, worksheets, etc.) even if software-specific.",
		"- responseText must still be useful: if capable=true provide the full draft answer/work product.",
		"- if capable=false provide a detailed, actionable guide with steps, checklist, and a ready-to-use caption/template without pretending completion.",
		"- Do NOT copy/paste the assignment instructions verbatim.",
		"- Do NOT include headers like 'Task description' or reprint the prompt.",
		"- Focus on final output content that the student can directly use/submit.",
		"- If software output is requested (e.g., Access/Excel/SQL), provide a complete artifact description including exact object names, fields, sample data, and expected output view.",
		"- Plain text only in responseText.",
		"",
		`Course: ${task.courseName}`,
		`Task title: ${title}`,
		`Due: ${due}`,
		"",
		"Task description:",
		description
	].join("\n");

	const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(resolvedModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
	const { data } = await axios.post(url, {
		contents: [{ role: "user", parts: [{ text: prompt }] }],
		generationConfig: {
			temperature: 0.2,
			topP: 0.95,
			maxOutputTokens: 1800
		}
	}, { timeout: 45000 });

	const raw = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("").trim();
	if (!raw)
		throw new Error("Gemini returned empty analysis");

	const parsed = safeJsonParse(raw);
	if (!parsed || typeof parsed.capable !== "boolean")
		throw new Error("Gemini returned invalid analysis format");

	return {
		capable: parsed.capable,
		reason: String(parsed.reason || "").trim() || "No reason provided",
		responseText: String(parsed.responseText || "").trim(),
		model: resolvedModel
	};
}

function filterCourses(courses, selector) {
	if (!selector)
		return courses;
	const normalized = String(selector).trim().toLowerCase();
	if (!normalized)
		return courses;

	const idx = parseInt(normalized, 10);
	if (!isNaN(idx) && idx > 0 && idx <= courses.length)
		return [courses[idx - 1]];

	const byId = courses.find(c => String(c.id) === normalized);
	if (byId)
		return [byId];

	return courses.filter(c => String(c.name || c.section || "").toLowerCase().includes(normalized));
}

async function fetchActiveCourses(senderID) {
	const clients = await getClientsForUser(senderID);
	if (!clients)
		throw new Error("NOT_LOGGED_IN");
	const { classroom } = clients;

	const teacherRes = await classroom.courses.list({
		teacherId: "me",
		courseStates: ["ACTIVE"],
		pageSize: 100
	}).catch(() => ({ data: { courses: [] } }));

	const studentRes = await classroom.courses.list({
		studentId: "me",
		courseStates: ["ACTIVE"],
		pageSize: 100
	}).catch(() => ({ data: { courses: [] } }));

	const map = new Map();
	for (const c of [...(teacherRes?.data?.courses || []), ...(studentRes?.data?.courses || [])]) {
		if (c?.id)
			map.set(c.id, c);
	}
	return [...map.values()];
}

async function fetchTodoTasks(senderID, courseSelector) {
	const clients = await getClientsForUser(senderID);
	if (!clients)
		throw new Error("NOT_LOGGED_IN");
	const { classroom } = clients;
	const courses = await fetchActiveCourses(senderID);
	const selectedCourses = filterCourses(courses, courseSelector);
	const tasks = [];

	for (const course of selectedCourses) {
		const worksRes = await classroom.courses.courseWork.list({
			courseId: course.id,
			pageSize: 100,
			orderBy: "dueDate desc"
		}).catch(() => ({ data: { courseWork: [] } }));

		for (const cw of (worksRes?.data?.courseWork || [])) {
			const subRes = await classroom.courses.courseWork.studentSubmissions.list({
				courseId: course.id,
				courseWorkId: cw.id,
				userId: "me",
				pageSize: 1
			}).catch(() => ({ data: { studentSubmissions: [] } }));
			const sub = (subRes?.data?.studentSubmissions || [])[0];
			if (!sub)
				continue;
			const state = sub.state || "";
			if (state === "TURNED_IN" || state === "RETURNED")
				continue;
			tasks.push({
				courseId: course.id,
				courseName: course.name || course.section || "Unknown Course",
				courseSection: course.section || "",
				courseCode: course.courseCode || "",
				courseWork: cw,
				submission: sub
			});
		}
	}
	return tasks;
}

function formatCourseAndSection(task) {
	const code = String(task?.courseCode || "").trim();
	const name = String(task?.courseName || "").trim();
	const section = String(task?.courseSection || "").trim();
	const left = code || name || "Unknown Course";
	if (section)
		return `${left} ${section}`.trim();
	return left;
}

async function turnInTask(senderID, task) {
	const clients = await getClientsForUser(senderID);
	if (!clients)
		throw new Error("NOT_LOGGED_IN");
	const { classroom } = clients;
	try {
		await classroom.courses.courseWork.studentSubmissions.turnIn({
			courseId: task.courseId,
			courseWorkId: task.courseWork.id,
			id: task.submission.id
		});
		return { ok: true, message: "Turned in successfully" };
	}
	catch (err) {
		return { ok: false, message: err?.errors?.[0]?.message || err?.message || "Unknown error" };
	}
}

async function reclaimTask(senderID, task) {
	const clients = await getClientsForUser(senderID);
	if (!clients)
		throw new Error("NOT_LOGGED_IN");
	const { classroom } = clients;
	try {
		await classroom.courses.courseWork.studentSubmissions.reclaim({
			courseId: task.courseId,
			courseWorkId: task.courseWork.id,
			id: task.submission.id
		});
		return { ok: true, message: "Unsubmitted successfully" };
	}
	catch (err) {
		return { ok: false, message: err?.errors?.[0]?.message || err?.message || "Unknown error" };
	}
}

function googleExportMime(googleMime) {
	switch (googleMime) {
		case "application/vnd.google-apps.document":
			return { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" };
		case "application/vnd.google-apps.spreadsheet":
			return { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" };
		case "application/vnd.google-apps.presentation":
			return { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" };
		case "application/vnd.google-apps.drawing":
			return { mimeType: "image/png", ext: "png" };
		default:
			return { mimeType: "application/pdf", ext: "pdf" };
	}
}

async function downloadDriveFile(drive, fileId, originalName, mimeType) {
	await fs.ensureDir(DOWNLOAD_DIR);
	const base = safeName(originalName || fileId);
	const isGoogleDoc = String(mimeType || "").startsWith("application/vnd.google-apps.");
	let outPath;
	let res;

	if (isGoogleDoc) {
		const exportCfg = googleExportMime(mimeType);
		outPath = path.join(DOWNLOAD_DIR, `${base}.${exportCfg.ext}`);
		res = await drive.files.export({ fileId, mimeType: exportCfg.mimeType }, { responseType: "stream" });
	}
	else {
		const ext = path.extname(base) || "";
		outPath = path.join(DOWNLOAD_DIR, ext ? base : `${base}.bin`);
		res = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
	}

	await new Promise((resolve, reject) => {
		const ws = fs.createWriteStream(outPath);
		res.data.pipe(ws);
		res.data.on("error", reject);
		ws.on("finish", resolve);
		ws.on("error", reject);
	});

	return fs.createReadStream(outPath);
}

async function getSubmissionDocs(senderID, task) {
	const clients = await getClientsForUser(senderID);
	if (!clients)
		throw new Error("NOT_LOGGED_IN");
	const { drive } = clients;
	const attachments = task?.submission?.assignmentSubmission?.attachments || [];
	const streams = [];
	const notes = [];

	for (const att of attachments) {
		if (att?.driveFile?.driveFile?.id) {
			const f = att.driveFile.driveFile;
			try {
				streams.push(await downloadDriveFile(drive, f.id, f.title || f.id, f.alternateLinkMimeType || f.mimeType));
			}
			catch (err) {
				notes.push(`Failed to download ${f.title || f.id}: ${err.message}`);
			}
		}
		else if (att?.link?.url) {
			notes.push(`Link attachment: ${att.link.url}`);
		}
	}
	return { streams, notes };
}

async function createDraftAttachmentForTask(senderID, task, aiConfig = {}, userFullName = "") {
	const clients = await getClientsForUser(senderID);
	if (!clients)
		throw new Error("NOT_LOGGED_IN");
	const { classroom, drive } = clients;
	let googleDisplayName = "";
	try {
		const about = await drive.about.get({ fields: "user(displayName)" });
		googleDisplayName = about?.data?.user?.displayName || "";
	}
	catch (_e) {}

	const title = task?.courseWork?.title || "Classroom Draft";
	const description = task?.courseWork?.description || "No task description provided.";
	const due = toDateString(task);
	const finalDisplayName = googleDisplayName || userFullName || "Student";
	const courseAndSection = formatCourseAndSection(task);
	let aiDraft = "";
	let aiUsed = false;
	let aiCapable = null;
	let aiReason = "";
	let aiError = "";

	if (aiConfig.apiKey) {
		try {
			const ai = await evaluateAndGenerateWithGemini({
				apiKey: aiConfig.apiKey,
				model: aiConfig.model,
				task
			});
			aiUsed = true;
			aiCapable = ai.capable;
			aiReason = ai.reason;
			aiDraft = ai.responseText;
		}
		catch (err) {
			aiUsed = false;
			aiError = err?.response?.data?.error?.message || err?.message || "Gemini unavailable";
		}
	}

	if (!aiDraft) {
		const h = heuristicCapabilityCheck(task);
		aiCapable = h.capable;
		aiReason = aiReason || h.reason;
		aiDraft = h.responseText || (h.capable ? "- " : buildDetailedHowToGuide(task));
	}

	if (aiCapable === false && (!aiDraft || aiDraft.trim().length < 120))
		aiDraft = buildDetailedHowToGuide(task);

	let fileType = { ext: "docx", reason: "Default fallback" };
	if (aiConfig.apiKey) {
		try {
			fileType = await decideDraftFileTypeWithGemini({
				apiKey: aiConfig.apiKey,
				model: aiConfig.model,
				task,
				aiCapable,
				aiReason,
				aiDraft
			});
		}
		catch (_e) {}
	}
	const outputExt = fileType.ext || "docx";
	const outputMime = mimeForExt(outputExt);

	const content = [
		`Name: ${finalDisplayName}`,
		`Course & Section: ${courseAndSection}`,
		"",
		`Activity: ${title}`,
		"",
		aiDraft || "- "
	].join("\n");

	await fs.ensureDir(DOWNLOAD_DIR);
	const namePart = surnameOrFullName(userFullName || senderID);
	const activityPart = shortActivityNameFromTask(task);
	const localFileName = safeName(`${namePart} - ${activityPart}.${outputExt}`);
	const localPath = path.join(DOWNLOAD_DIR, localFileName);
	await writeDraftFile(localPath, outputExt, content);

	const uploaded = await drive.files.create({
		requestBody: {
			name: localFileName,
			mimeType: outputMime
		},
		media: {
			mimeType: outputMime,
			body: fs.createReadStream(localPath)
		},
		fields: "id,name,mimeType,webViewLink"
	});

	const fileId = uploaded?.data?.id;
	if (!fileId)
		throw new Error("Failed to create draft file");

	let attached = false;
	let attachError = "";
	try {
		await classroom.courses.courseWork.studentSubmissions.modifyAttachments({
			courseId: task.courseId,
			courseWorkId: task.courseWork.id,
			id: task.submission.id,
			requestBody: {
				addAttachments: [
					{
						driveFile: {
							id: fileId
						}
					}
				]
			}
		});
		attached = true;
	}
	catch (err) {
		attached = false;
		attachError = err?.errors?.[0]?.message || err?.message || "Failed to attach to submission";
	}

	const previewStream = fs.createReadStream(localPath);
	return {
		fileId,
		fileName: uploaded.data.name || localFileName,
		webViewLink: uploaded.data.webViewLink || "",
		previewStream,
		localPath,
		outputMime,
		aiUsed,
		aiCapable,
		aiReason,
		aiError,
		fileExt: outputExt,
		fileTypeReason: fileType.reason || "",
		attached,
		attachError
	};
}

module.exports = {
	config: {
		name: "gclass",
		version: "2.0",
		author: "Vince Pradas",
		countDown: 5,
		role: 0,
		description: {
			en: "Google Classroom task automation with per-user login"
		},
		category: "utility",
		guide: {
			en: "   gclass login\n"
				+ "   gclass authcode <code>\n"
				+ "   gclass logout\n"
				+ "   gclass courses\n"
				+ "   gclass tasks [courseIndex|courseId|courseName]\n"
				+ "   gclass getTaskText <index>\n"
				+ "   gclass automate [courseIndex|courseId|courseName]\n"
				+ "   gclass doAll [2|3] [courseIndex|courseId|courseName]\n"
				+ "   gclass tstatus <index>\n"
				+ "   gclass unsubmit <index>\n"
				+ "   gclass getDocs <index>"
		},
		envConfig: {
			geminiApiKey: "",
			geminiModel: "gemini-1.5-flash"
		}
	},
	langs: {
		en: {
			usage: "Options:\n- gclass login\n- gclass authcode <code>\n- gclass logout\n- gclass courses\n- gclass tasks [courseIndex|courseId|courseName]\n- gclass getTaskText <index>\n- gclass automate [courseIndex|courseId|courseName]\n- gclass doAll [2|3] [courseIndex|courseId|courseName]\n- gclass tstatus <index>\n- gclass unsubmit <index>\n- gclass getDocs <index>",
			loginStep1: "Open this URL, authorize your Google account, copy the 'code' from redirect URL, then send: gclass authcode <code>\n%1",
			loginSuccess: "Google Classroom account linked successfully for your Messenger account.",
			logoutSuccess: "Your Classroom token has been removed.",
			notLoggedIn: "You are not logged in. Run: gclass login",
			noCourses: "No active Classroom courses found.",
			courseList: "Active courses:\n%1",
			noTasks: "No pending Classroom tasks found.",
			taskList: "Pending tasks:\n%1",
			chooseTask: "Reply with task number to automate a specific task.\nTip: reply \"ti: taskinfo <index>\" to view full task text first.",
			analyzingTask: "Analyzing task, please wait...",
			confirmPrompt: "Selected task #%1\nCourse: %2\nTitle: %3\nState: %4\nDue: %5\n\nReply with:\n- make (create draft file + attach + preview)\n- submit (turn in now)\n- unsubmit (reclaim submission)\n- docs (preview/download attached docs)\n- cancel",
			pleaseWaitMake: "Please wait, creating and attaching your draft...",
			makeResult: "Draft created: %1\n%2\nAI mode: %3\nAI capability: %4\nReason: %5\nFile type: .%6 (%7)\nAttach status: %8\n\nReview it, then reply:\n- submit\n- docs\n- cancel",
			invalidIndex: "Invalid task index. Run gclass getTasks first.",
			taskStatus: "Task #%1\nCourse: %2\nTitle: %3\nState: %4\nDue: %5",
			automationResult: "Task #%1 automation result: %2",
			unsubmitResult: "Task #%1 unsubmit result: %2",
			doAllResult: "Processed %1 task(s).\n%2",
			noDocs: "No submitted/attached documents found for this task.",
			docsFailed: "Could not download docs:\n%1",
			subCommandUnknown: "Unknown subcommand.\n%1",
			replyOwnerOnly: "Only the requester can answer this selection prompt."
			,
			insufficientScope: "Google denied this action. If scopes are already correct, this is likely a Classroom restriction: submission modify/turn-in must use the same Google Cloud OAuth project that created the coursework item.\nDetails: %1",
			permissionBlocked: "Action blocked by Google for this coursework item (project mismatch or policy). The draft document is still created and returned, but submit/attach must be done manually in Classroom.\nDetails: %1"
			,
			tokenExpired: "Google auth token is invalid/expired (invalid_grant). Your stored token was cleared. Run: gclass login -> gclass authcode <code>."
		}
	},

	// Support "/gclass ..." even when thread/system prefix is not "/"
	onChat: async function (ctx) {
		const body = String(ctx?.event?.body || "").trim();
		if (!body)
			return;
		if (!/^\/gclass\b/i.test(body))
			return;
		// If the actual configured prefix is "/" this will be handled by onStart path already.
		if (ctx?.prefix === "/")
			return;

		const rest = body.replace(/^\/gclass\b/i, "").trim();
		const args = rest ? rest.split(/\s+/) : [];
		return module.exports.onStart({ ...ctx, args, commandName: "gclass" });
	},

	onStart: async function ({ args, event, message, getLang, commandName }) {
		const sub = (args[0] || "").trim().toLowerCase();
		const isSub = (...names) => names.includes(sub);
		if (!sub)
			return message.reply(getLang("usage"));

		const senderID = String(event.senderID);
		const threadID = String(event.threadID || "");
		try {
			if (sub === "login") {
				const oauth2 = createOAuthClient();
				const url = oauth2.generateAuthUrl({
					access_type: "offline",
					prompt: "consent",
					scope: OAUTH_SCOPES
				});
				return message.reply(getLang("loginStep1", url));
			}

			if (isSub("authcode")) {
				let code = (args.slice(1).join(" ") || "").trim();
				if (!code) {
					const body = String(event.body || "");
					const m = body.match(/\bauthcode\s+(.+)$/i);
					if (m?.[1])
						code = m[1].trim();
				}
				if (!code)
					return message.reply("Missing code. Usage: gclass authcode <code>");
				const oauth2 = createOAuthClient();
				const { tokens } = await oauth2.getToken(code);
				if (!tokens?.refresh_token) {
					const old = await getUserToken(senderID);
					if (old?.refresh_token)
						tokens.refresh_token = old.refresh_token;
				}
				await setUserToken(senderID, tokens);
				return message.reply(getLang("loginSuccess"));
			}

			if (sub === "logout") {
				await removeUserToken(senderID);
				return message.reply(getLang("logoutSuccess"));
			}

			const hasToken = await getUserToken(senderID);
			if (!hasToken)
				return message.reply(getLang("notLoggedIn"));

			if (isSub("courses", "getcourses")) {
				const courses = await fetchActiveCourses(senderID);
				const bucket = getStateBucket(senderID, threadID);
				Object.assign(bucket, { courses, at: Date.now() });
				if (!courses.length)
					return message.reply(getLang("noCourses"));
				return message.reply(getLang("courseList", courses.map((c, i) => summarizeCourse(c, i)).join("\n")));
			}

			if (isSub("tasks", "gettasks", "list")) {
				const selector = args.slice(1).join(" ").trim();
				const tasks = await fetchTodoTasks(senderID, selector);
				const bucket = getStateBucket(senderID, threadID);
				Object.assign(bucket, { tasks, at: Date.now(), lastCourseSelector: selector || null });
				if (!tasks.length)
					return message.reply(getLang("noTasks"));
				return message.reply(getLang("taskList", tasks.map((t, i) => summarizeTask(t, i)).join("\n")));
			}

			if (isSub("automate", "am")) {
				const selector = args.slice(1).join(" ").trim();
				const tasks = await fetchTodoTasks(senderID, selector);
				const bucket = getStateBucket(senderID, threadID);
				Object.assign(bucket, { tasks, at: Date.now(), lastCourseSelector: selector || null });
				if (!tasks.length)
					return message.reply(getLang("noTasks"));
				return message.reply(
					`${getLang("taskList", tasks.map((t, i) => summarizeTask(t, i)).join("\n"))}\n\n${getLang("chooseTask")}`,
					(err, info) => global.GoatBot.onReply.set(info.messageID, {
						commandName,
						messageID: info.messageID,
						author: senderID,
						type: "automateSelect"
					})
				);
			}

			if (isSub("bulk", "doall")) {
				const limitRaw = parseInt(args[1], 10);
				const limit = [2, 3].includes(limitRaw) ? limitRaw : 2;
				const selector = (args[2] || "").trim() || (isNaN(limitRaw) ? args.slice(1).join(" ").trim() : "");
				const tasks = await fetchTodoTasks(senderID, selector);
				if (!tasks.length)
					return message.reply(getLang("noTasks"));
				const picked = tasks.slice(0, limit);
				const results = [];
				for (let i = 0; i < picked.length; i++) {
					const r = await turnInTask(senderID, picked[i]);
					results.push(`#${i + 1}: ${r.ok ? "OK" : "FAILED"} - ${r.message}`);
				}
				return message.reply(getLang("doAllResult", picked.length, results.join("\n")));
			}

			if (isSub("taskstatus", "tstatus")) {
				const idx = parseInt(args[1], 10) - 1;
				const bucket = getStateBucket(senderID, threadID);
				const tasks = bucket?.tasks || await fetchTodoTasks(senderID);
				if (isNaN(idx) || idx < 0 || idx >= tasks.length)
					return message.reply(getLang("invalidIndex"));
				const t = tasks[idx];
				return message.reply(getLang("taskStatus", idx + 1, t.courseName, t.courseWork.title || "(Untitled)", t.submission.state || "UNKNOWN", toDateString(t)));
			}

			if (isSub("gettasktext", "tasktext", "taskinfo", "taskttext", "ttxt", "what")) {
				const idx = parseInt(args[1], 10) - 1;
				const bucket = getStateBucket(senderID, threadID);
				const tasks = bucket?.tasks || await fetchTodoTasks(senderID);
				if (isNaN(idx) || idx < 0 || idx >= tasks.length)
					return message.reply(getLang("invalidIndex"));
				return message.reply(renderTaskText(tasks[idx], idx));
			}

			if (sub === "unsubmit") {
				const idx = parseInt(args[1], 10) - 1;
				const bucket = getStateBucket(senderID, threadID);
				const tasks = bucket?.tasks || await fetchTodoTasks(senderID);
				if (isNaN(idx) || idx < 0 || idx >= tasks.length)
					return message.reply(getLang("invalidIndex"));
				const result = await reclaimTask(senderID, tasks[idx]);
				return message.reply(getLang("unsubmitResult", idx + 1, `${result.ok ? "OK" : "FAILED"} - ${result.message}`));
			}

			if (sub === "getDocs") {
				const idx = parseInt(args[1], 10) - 1;
				const bucket = getStateBucket(senderID, threadID);
				const tasks = bucket?.tasks || await fetchTodoTasks(senderID);
				if (isNaN(idx) || idx < 0 || idx >= tasks.length)
					return message.reply(getLang("invalidIndex"));
				const { streams, notes } = await getSubmissionDocs(senderID, tasks[idx]);
				if (!streams.length && !notes.length)
					return message.reply(getLang("noDocs"));
				if (streams.length) {
					return message.reply({
						body: notes.length ? `Downloaded docs.\n${notes.join("\n")}` : "Downloaded submitted docs.",
						attachment: streams
					});
				}
				return message.reply(getLang("docsFailed", notes.join("\n")));
			}

			return message.reply(getLang("subCommandUnknown", getLang("usage")));
		}
		catch (err) {
			if (isInvalidGrantError(err)) {
				await removeUserToken(senderID);
				return message.reply(getLang("tokenExpired"));
			}
			if (err.message === "NOT_LOGGED_IN")
				return message.reply(getLang("notLoggedIn"));
			if (err?.message?.includes("Insufficient Permission") || err?.response?.status === 403) {
				const details = err?.response?.data?.error?.message || err?.message || "Forbidden";
				return message.reply(getLang("insufficientScope", details));
			}
			const details = err?.response?.data?.error?.message || err.message || "Unknown error";
			return message.reply(`Classroom error: ${details}`);
		}
	},

	onReply: async function ({ event, Reply, message, getLang, envCommands, api }) {
		const senderID = String(event.senderID);
		const threadID = String(event.threadID || "");
		if (senderID !== String(Reply.author))
			return message.reply(getLang("replyOwnerOnly"));
		try {
			if (Reply.type === "automateSelect") {
			const input = String(event.body || "").trim();
			const lower = input.toLowerCase();
			const bucket = getStateBucket(senderID, threadID);
			const tasks = bucket?.tasks || [];

			// Allow: "taskinfo 2" while selecting from automate list
			if (lower.startsWith("ti ") || lower.startsWith("info ")) {
				const infoIndex = parseInt(lower.split(/\s+/)[1], 10) - 1;
				if (isNaN(infoIndex) || infoIndex < 0 || infoIndex >= tasks.length)
					return message.reply(getLang("invalidIndex"));
				const task = tasks[infoIndex];
				const waitMsg = await message.reply(getLang("analyzingTask"));
				let shortText;
				try {
					const cfg = envCommands?.[Reply.commandName] || {};
					const apiKey = cfg.geminiApiKey || process.env.GEMINI_API_KEY || "";
					const model = cfg.geminiModel || process.env.GEMINI_MODEL || "gemini-1.5-flash";
					shortText = apiKey
						? await summarizeTaskAboutWithGemini({ apiKey, model, task, index: infoIndex })
						: summarizeTaskAboutFallback(task, infoIndex);
				}
				catch (_e) {
					shortText = summarizeTaskAboutFallback(task, infoIndex);
				}
				finally {
					if (waitMsg?.messageID)
						message.unsend(waitMsg.messageID).catch(() => {});
				}
				if (isWeakTaskSummary(shortText, task))
					shortText = summarizeTaskAboutFallback(task, infoIndex);
				return message.reply(`Task #${infoIndex + 1}: ${shortText}\n\nReply with task number to continue automation.`);
			}

			const index = parseInt(input, 10) - 1;
			if (isNaN(index) || index < 0 || index >= tasks.length)
				return message.reply(`${getLang("invalidIndex")}\nTip: reply "ti: taskinfo <index>" to view full task text first.`);

			const t = tasks[index];
			return message.reply(
				getLang(
					"confirmPrompt",
					index + 1,
					t.courseName,
					t.courseWork.title || "(Untitled)",
					t.submission.state || "UNKNOWN",
					toDateString(t)
				),
				(err, info) => global.GoatBot.onReply.set(info.messageID, {
					commandName: Reply.commandName,
					messageID: info.messageID,
					author: senderID,
					type: "automateConfirm",
					taskIndex: index
				})
			);
			}

			if (Reply.type === "automateConfirm") {
			const bucket = getStateBucket(senderID, threadID);
			const tasks = bucket?.tasks || [];
			const index = Reply.taskIndex;
			if (typeof index !== "number" || index < 0 || index >= tasks.length)
				return message.reply(getLang("invalidIndex"));

			const cmd = String(event.body || "").trim().toLowerCase();
			const task = tasks[index];

			if (cmd === "cancel")
				return message.reply("Cancelled.");

				if (cmd === "make") {
					const waitMsg = await message.reply(getLang("pleaseWaitMake"));
					let draft;
					try {
						const cfg = envCommands?.[Reply.commandName] || {};
						let fullName = "";
						try {
							const info = await api.getUserInfo(senderID);
							fullName = info?.[senderID]?.name || "";
						}
						catch (_e) {}
						draft = await createDraftAttachmentForTask(senderID, task, {
							apiKey: cfg.geminiApiKey || process.env.GEMINI_API_KEY || "",
							model: cfg.geminiModel || process.env.GEMINI_MODEL || "gemini-1.5-flash"
						}, fullName);
					}
				catch (err) {
					if (err?.message?.includes("Insufficient Permission") || err?.response?.status === 403) {
						const details = err?.response?.data?.error?.message || err?.message || "Forbidden";
						return message.reply(getLang("permissionBlocked", details));
					}
					throw err;
				}
				finally {
					if (waitMsg?.messageID)
						message.unsend(waitMsg.messageID).catch(() => {});
				}
				const attachStatus = draft.attached ? "attached to Classroom submission" : `not attached (${draft.attachError || "permission/project restriction"})`;
				const aiMode = draft.aiUsed ? "enabled" : `fallback (${draft.aiError || "gemini unavailable"})`;
				const aiCapability = draft.aiCapable === true ? "capable" : "not capable";
					return message.reply({
						body: getLang(
							"makeResult",
							draft.fileName,
						draft.webViewLink || "(no web link)",
						aiMode,
						aiCapability,
						draft.aiReason || "No reason provided",
						draft.fileExt || "txt",
							draft.fileTypeReason || "default",
							attachStatus
						),
						attachment: [{
							value: draft.previewStream,
							options: {
								filename: draft.fileName,
								contentType: draft.outputMime || mimeForExt(draft.fileExt || "docx")
							}
						}]
					}, (err, info) => global.GoatBot.onReply.set(info.messageID, {
					commandName: Reply.commandName,
					messageID: info.messageID,
					author: senderID,
					type: "automateConfirm",
					taskIndex: index
				}));
			}

			if (cmd === "docs") {
				const { streams, notes } = await getSubmissionDocs(senderID, task);
				if (!streams.length && !notes.length)
					return message.reply(getLang("noDocs"));
				if (streams.length) {
					return message.reply({
						body: notes.length ? `Downloaded docs.\n${notes.join("\n")}\n\nReply "submit" to turn in, or "cancel".` : "Downloaded submitted docs.\n\nReply \"submit\" to turn in, or \"cancel\".",
						attachment: streams
					}, (err, info) => global.GoatBot.onReply.set(info.messageID, {
						commandName: Reply.commandName,
						messageID: info.messageID,
						author: senderID,
						type: "automateConfirm",
						taskIndex: index
					}));
				}
				return message.reply(`${getLang("docsFailed", notes.join("\n"))}\nReply "submit" to continue or "cancel".`);
			}

			if (cmd === "submit") {
				const result = await turnInTask(senderID, task);
				return message.reply(getLang("automationResult", index + 1, `${result.ok ? "OK" : "FAILED"} - ${result.message}`));
			}

			if (cmd === "unsubmit") {
				const result = await reclaimTask(senderID, task);
				return message.reply(getLang("unsubmitResult", index + 1, `${result.ok ? "OK" : "FAILED"} - ${result.message}`));
			}

			return message.reply("Reply with: make, submit, unsubmit, docs, or cancel.");
			}
		}
		catch (err) {
			if (isInvalidGrantError(err)) {
				await removeUserToken(senderID);
				return message.reply(getLang("tokenExpired"));
			}
			throw err;
		}
	}
};
