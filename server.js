const http = require("http");
const WebSocket = require("ws");
const https = require("https");

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const TRANSCRIPT_ENDPOINT = "https://lumafront.com/database/AI/sale_assistant/webhooks/transcript.php";

const port = process.env.PORT || 10000;

function postToLumafront(obj) {
	const payload = JSON.stringify(obj);
	console.log("POST_TRY", payload.slice(0, 200));

	const req = https.request(TRANSCRIPT_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Content-Length": Buffer.byteLength(payload),
			"User-Agent": "render-telnyx-forwarder"
		},
		timeout: 5000
	}, (res) => {
		console.log("POST_RES", res.statusCode);
		let body = "";
		res.on("data", (d) => body += d.toString("utf8"));
		res.on("end", () => console.log("POST_BODY", body.slice(0, 200)));
	});

	req.on("timeout", () => {
		console.log("POST_ERR", "timeout");
		req.destroy();
	});

	req.on("error", (e) => {
		console.log("POST_ERR", e.message);
	});

	req.write(payload);
	req.end();
}

const server = http.createServer((req, res) => {
	res.writeHead(200, { "Content-Type": "text/plain" });
	res.end("ok\n");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (telnyxWs) => {

	console.log("TELNYX_WS_CONNECTED");

	if (!DEEPGRAM_API_KEY) {
		console.log("FATAL", "DEEPGRAM_API_KEY missing");
	}

	const dgUrl = "wss://api.deepgram.com/v1/listen?encoding=alaw&sample_rate=8000&channels=1&punctuate=true&diarize=true";
	const dgWs = new WebSocket(dgUrl, {
		headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }
	});

	dgWs.on("open", () => console.log("DEEPGRAM_CONNECTED"));
	dgWs.on("close", (c, r) => console.log("DEEPGRAM_CLOSED", c, (r || "").toString()));
	dgWs.on("error", (e) => console.log("DEEPGRAM_ERROR", e.message));

	let mediaCount = 0;
	let dgMsgCount = 0;

	dgWs.on("message", (dgMsg) => {
		dgMsgCount++;
		if (dgMsgCount <= 3) {
			console.log("DEEPGRAM_MSG_SAMPLE", dgMsg.toString("utf8").slice(0, 250));
		}

		let j;
		try {
			j = JSON.parse(dgMsg.toString("utf8"));
		} catch {
			return;
		}

		const alt = j?.channel?.alternatives?.[0];
		const transcript = alt?.transcript || "";
		if (!transcript) return;

		console.log("DG_TRANSCRIPT", transcript);
		postToLumafront({
			ts: Date.now(),
			transcript,
			is_final: j?.is_final ?? null,
			confidence: alt?.confidence ?? null
		});
	});

	telnyxWs.on("message", (msg) => {

		// Telnyx may send JSON frames with base64 audio
		if (!Buffer.isBuffer(msg)) {
			let j;
			try {
				j = JSON.parse(msg.toString("utf8"));
			} catch {
				console.log("TELNYX_TEXT_NONJSON", msg.toString("utf8").slice(0, 200));
				return;
			}

			if (j.event === "connected") {
				console.log("TELNYX_EVENT", "connected");
				return;
			}

			if (j.event === "start") {
				console.log("TELNYX_EVENT", "start");
				console.log("TELNYX_START_KEYS", Object.keys(j));
				return;
			}

			if (j.event === "media" && j.media && typeof j.media.payload === "string") {
				mediaCount++;
				if (mediaCount <= 3) console.log("TELNYX_MEDIA_SAMPLE_LEN", j.media.payload.length);

				const audio = Buffer.from(j.media.payload, "base64");
				if (dgWs.readyState === WebSocket.OPEN) {
					dgWs.send(audio);
				}
				return;
			}

			if (j.event === "stop") {
				console.log("TELNYX_EVENT", "stop");
				return;
			}

			console.log("TELNYX_JSON_OTHER", Object.keys(j));
			return;
		}

		// If Telnyx sends binary, forward it
		if (dgWs.readyState === WebSocket.OPEN) {
			dgWs.send(msg);
		}
	});

	telnyxWs.on("close", () => {
		console.log("TELNYX_WS_CLOSED", "mediaCount=" + mediaCount, "dgMsgCount=" + dgMsgCount);
		if (dgWs.readyState === WebSocket.OPEN) dgWs.close();
	});

	telnyxWs.on("error", (e) => console.log("TELNYX_WS_ERROR", e.message));
});

server.listen(port, () => console.log("Listening on", port));
