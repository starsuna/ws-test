const http = require("http");
const WebSocket = require("ws");
const https = require("https");

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const TRANSCRIPT_ENDPOINT = "https://lumafront.com/database/AI/sale_assistant/webhooks/transcript.php";

const port = process.env.PORT || 10000;

function postTranscript(obj) {
	const payload = JSON.stringify(obj);

	const req = https.request(TRANSCRIPT_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Content-Length": Buffer.byteLength(payload),
		},
	}, (res) => {
		res.resume();
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

wss.on("connection", (telnyxWs, req) => {
	console.log("TELNYX_WS_CONNECTED");

	const dgUrl = "wss://api.deepgram.com/v1/listen?encoding=alaw&sample_rate=8000&punctuate=true&diarize=true";
	const dgWs = new WebSocket(dgUrl, {
		headers: {
			Authorization: `Token ${DEEPGRAM_API_KEY}`,
		},
	});

	dgWs.on("open", () => {
		console.log("DEEPGRAM_CONNECTED");
	});

	dgWs.on("message", (dgMsg) => {
		let j;
		try {
			j = JSON.parse(dgMsg.toString("utf8"));
		} catch (e) {
			return;
		}

		const alt = j?.channel?.alternatives?.[0];
		const transcript = alt?.transcript || "";
		if (!transcript) return;

		postTranscript({
			ts: Date.now(),
			transcript,
			confidence: alt?.confidence ?? null,
			is_final: j?.is_final ?? null,
		});
	});

	dgWs.on("close", (code, reason) => {
		console.log("DEEPGRAM_CLOSED", code, reason?.toString?.() || "");
	});

	dgWs.on("error", (e) => {
		console.log("DEEPGRAM_ERROR", e.message);
	});

	telnyxWs.on("message", (msg) => {
		if (Buffer.isBuffer(msg)) {
			// If Telnyx ever sends binary, forward it too
			if (dgWs.readyState === WebSocket.OPEN) {
				dgWs.send(msg);
			}
			return;
		}

		let j;
		try {
			j = JSON.parse(msg.toString("utf8"));
		} catch (e) {
			return;
		}

		if (j.event === "connected") {
			console.log("TELNYX_CONNECTED_EVENT");
			return;
		}

		if (j.event === "media" && j.media && typeof j.media.payload === "string") {
			const audio = Buffer.from(j.media.payload, "base64");
			if (dgWs.readyState === WebSocket.OPEN) {
				dgWs.send(audio);
			}
			return;
		}

		if (j.event === "error") {
			console.log("TELNYX_STREAM_ERROR", JSON.stringify(j));
		}
	});

	telnyxWs.on("close", () => {
		console.log("TELNYX_WS_CLOSED");
		if (dgWs.readyState === WebSocket.OPEN) {
			dgWs.close();
		}
	});

	telnyxWs.on("error", (e) => {
		console.log("TELNYX_WS_ERROR", e.message);
	});
});

server.listen(port, () => {
	console.log("Listening on", port);
});
