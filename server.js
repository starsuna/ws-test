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
			"Content-Length": Buffer.byteLength(payload),
			"User-Agent": "telnyx-deepgram-forwarder"
		},
		timeout: 5000
	}, (res) => {
		res.resume();
	});
	req.on("timeout", () => req.destroy());
	req.on("error", () => {});
	req.write(payload);
	req.end();
}

function wordsToSpeakerLines(words) {
	// words: [{word, speaker, start, end}, ...]
	const lines = [];
	let curSpeaker = null;
	let cur = [];

	for (const w of words || []) {
		const sp = (w && w.speaker !== undefined) ? w.speaker : null;
		const txt = (w && w.word) ? String(w.word) : "";
		if (!txt) continue;

		if (curSpeaker === null) {
			curSpeaker = sp;
		}

		if (sp !== curSpeaker) {
			const line = cur.join(" ").trim();
			if (line) lines.push({ speaker: curSpeaker, text: line });
			curSpeaker = sp;
			cur = [txt];
		} else {
			cur.push(txt);
		}
	}

	const last = cur.join(" ").trim();
	if (last) lines.push({ speaker: curSpeaker, text: last });

	return lines;
}

const server = http.createServer((req, res) => {
	res.writeHead(200, { "Content-Type": "text/plain" });
	res.end("ok\n");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (telnyxWs) => {
	let callControlId = "";
	let dgReady = false;

	// Speed-first model, diarization enabled (adds cost)
	const dgUrl =
		"wss://api.deepgram.com/v1/listen" +
		"?model=flux" +
		"&encoding=alaw" +
		"&sample_rate=8000" +
		"&diarize=true" +
		"&smart_format=true" +
		"&interim_results=true";

	const dgWs = new WebSocket(dgUrl, {
		headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }
	});

	dgWs.on("open", () => {
		dgReady = true;
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
		const isFinal = !!j?.is_final;

		// We only post finals to reduce spam/latency load on your PHP
		if (!isFinal || !transcript) return;

		const words = alt?.words || [];
		const speakerLines = wordsToSpeakerLines(words);

		// If diarization didn’t label words (rare), fall back to unknown speaker
		if (!speakerLines.length) {
			postJson({
				call_control_id: callControlId,
				speaker: null,
				text: transcript,
				is_final: true
			});
			return;
		}

		for (const line of speakerLines) {
			postJson({
				call_control_id: callControlId,
				speaker: line.speaker,
				text: line.text,
				is_final: true
			});
		}
	});

	telnyxWs.on("message", (msg) => {
		if (Buffer.isBuffer(msg)) {
			// If Telnyx sends binary, forward directly
			if (dgReady) dgWs.send(msg);
			return;
		}

		let j;
		try {
			j = JSON.parse(msg.toString("utf8"));
		} catch {
			return;
		}

		// Telnyx sends audio as base64 RTP payload wrapped in JSON "media" events
		// :contentReference[oaicite:3]{index=3}
		if (j.event === "start") {
			callControlId = j?.start?.call_control_id || callControlId;
			return;
		}

		if (j.event === "media" && j.media && typeof j.media.payload === "string") {
			const audio = Buffer.from(j.media.payload, "base64");
			if (dgReady) dgWs.send(audio);
			return;
		}

		if (j.event === "stop") {
			try {
				dgWs.close();
			} catch {}
		}
	});

	telnyxWs.on("close", () => {
		try {
			dgWs.close();
		} catch {}
	});
});

server.listen(port, () => {
	console.log("Listening on", port);
});
