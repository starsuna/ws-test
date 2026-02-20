const http = require("http");
const WebSocket = require("ws");
const https = require("https");

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const TRANSCRIPT_ENDPOINT = "https://lumafront.com/database/AI/sale_assistant/webhooks/transcript.php";

const port = process.env.PORT || 10000;

function postJson(obj) {
	const payload = JSON.stringify(obj);
	const req = https.request(TRANSCRIPT_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Content-Length": Buffer.byteLength(payload)
		},
		timeout: 5000
	}, (res) => res.resume());

	req.on("timeout", () => req.destroy());
	req.on("error", () => {});
	req.write(payload);
	req.end();
}

function roleFromPath(pathname) {
	// IMPORTANT: if labels come out swapped, just swap these two strings.
	if (pathname === "/in") return "Rep";
	if (pathname === "/out") return "Prospect";
	return "Unknown";
}

function segmentTimesFromWords(words) {
	if (!Array.isArray(words) || words.length === 0) return { start: null, end: null };
	const start = (words[0] && typeof words[0].start === "number") ? words[0].start : null;
	const end = (words[words.length - 1] && typeof words[words.length - 1].end === "number") ? words[words.length - 1].end : null;
	return { start, end };
}

const server = http.createServer((req, res) => {
	res.writeHead(200, { "Content-Type": "text/plain" });
	res.end("ok\n");
});

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
	const path = (req.url || "/").split("?")[0];
	wss.handleUpgrade(req, socket, head, (ws) => {
		ws._path = path;
		wss.emit("connection", ws, req);
	});
});

wss.on("connection", (telnyxWs) => {
	const role = roleFromPath(telnyxWs._path);
	let callControlId = "";

	const dgUrl =
		"wss://api.deepgram.com/v1/listen" +
		"?model=flux" +
		"&encoding=alaw" +
		"&sample_rate=8000" +
		"&smart_format=true" +
		"&interim_results=true";

	const dgWs = new WebSocket(dgUrl, {
		headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }
	});

	dgWs.on("message", (dgMsg) => {
		let j;
		try {
			j = JSON.parse(dgMsg.toString("utf8"));
		} catch {
			return;
		}

		const alt = j?.channel?.alternatives?.[0];
		const transcript = (alt?.transcript || "").trim();
		if (!transcript) return;

		const isFinal = !!j?.is_final;
		if (!isFinal) return;

		const words = alt?.words || [];
		const seg = segmentTimesFromWords(words);

		postJson({
			call_control_id: callControlId,
			role,
			text: transcript,
			start: seg.start,
			end: seg.end,
			is_final: true
		});
	});

	telnyxWs.on("message", (msg) => {
		if (Buffer.isBuffer(msg)) {
			if (dgWs.readyState === WebSocket.OPEN) dgWs.send(msg);
			return;
		}

		let j;
		try {
			j = JSON.parse(msg.toString("utf8"));
		} catch {
			return;
		}

		if (j.event === "start") {
			callControlId = j?.start?.call_control_id || callControlId;
			return;
		}

		if (j.event === "media" && j.media && typeof j.media.payload === "string") {
			const audio = Buffer.from(j.media.payload, "base64");
			if (dgWs.readyState === WebSocket.OPEN) dgWs.send(audio);
			return;
		}

		if (j.event === "stop") {
			try { dgWs.close(); } catch {}
		}
	});

	telnyxWs.on("close", () => {
		try { dgWs.close(); } catch {}
	});
});

server.listen(port, () => {
	console.log("Listening on", port);
});
