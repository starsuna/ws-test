const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

function ts() {
	return new Date().toISOString();
}

function roleFromPath(path) {
	if (path === "/in") return "Rep";
	if (path === "/out") return "Prospect";
	return "Unknown";
}

if (!DEEPGRAM_API_KEY) {
	console.log(ts(), "FATAL: DEEPGRAM_API_KEY is not set");
}

// Render expects an HTTP listener, attach WebSocket to it
const server = http.createServer((req, res) => {
	if (req.url === "/health" || req.url === "/") {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("ok");
		return;
	}
	res.writeHead(404, { "Content-Type": "text/plain" });
	res.end("not found");
});

const wss = new WebSocket.Server({ server });

console.log(ts(), "HTTP+WS listening on", PORT);

wss.on("connection", (telnyxWs, req) => {
	const path = (req && req.url) ? req.url : "";
	const role = roleFromPath(path);
	let callControlId = "";
	let mediaFrames = 0;

	console.log(ts(), "TELNYX CONNECT", { path, role });

	telnyxWs.on("error", (e) => {
		console.log(ts(), "TELNYX WS ERROR", e && e.message ? e.message : e);
	});
	telnyxWs.on("close", (code, reason) => {
		console.log(ts(), "TELNYX CLOSE", { code, reason: reason ? reason.toString() : "" });
	});

	const dgUrl =
		"wss://api.deepgram.com/v1/listen" +
		"?model=flux" +
		"&encoding=alaw" +
		"&sample_rate=8000" +
		"&smart_format=true" +
		"&interim_results=true" +
		"&endpointing=300";

	const dgWs = new WebSocket(dgUrl, {
		headers: { Authorization: `Token ${DEEPGRAM_API_KEY || ""}` }
	});

	dgWs.on("open", () => {
		console.log(ts(), "DEEPGRAM OPEN", { role, path });
	});

	dgWs.on("error", (e) => {
		console.log(ts(), "DEEPGRAM WS ERROR", e && e.message ? e.message : e);
	});
	dgWs.on("close", (code, reason) => {
		console.log(ts(), "DEEPGRAM CLOSE", { code, reason: reason ? reason.toString() : "" });
	});

	dgWs.on("message", async (dgMsg) => {
		let j;
		try {
			j = JSON.parse(dgMsg);
		} catch {
			return;
		}

		const alt = j?.channel?.alternatives?.[0];
		const text = alt?.transcript;
		if (!text || text.trim() === "") return;

		let start = 0;
		let end = 0;

		if (alt.words && alt.words.length > 0) {
			start = alt.words[0].start || 0;
			end = alt.words[alt.words.length - 1].end || 0;
		}

		const payload = {
			call_control_id: callControlId,
			role,
			text,
			start,
			end,
			is_final: j.is_final || false
		};

		try {
			const res = await fetch("https://lumafront.com/database/AI/sale_assistant/webhooks/transcript.php", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload)
			});

			if (!res.ok) {
				console.log(ts(), "TRANSCRIPT POST BAD STATUS", { status: res.status, role, callControlId });
			}
		} catch (e) {
			console.log(ts(), "TRANSCRIPT POST ERROR", e && e.message ? e.message : e);
		}
	});

	telnyxWs.on("message", (msg) => {
		let data;
		try {
			data = JSON.parse(msg);
		} catch {
			console.log(ts(), "TELNYX NON-JSON MESSAGE (ignored)");
			return;
		}

		if (data.event === "start") {
			const cc =
				data?.start?.call_control_id ||
				data?.call_control_id ||
				data?.start?.callControlId ||
				data?.callControlId ||
				"";

			if (cc && !callControlId) {
				callControlId = cc;
				console.log(ts(), "CALL CONTROL ID SET", { callControlId, role, path });
			} else if (!cc) {
				console.log(ts(), "WARNING: start event missing call_control_id", { role, path });
			}
		}

		if (data.event === "media" && data.media && data.media.payload) {
			mediaFrames += 1;

			if (mediaFrames === 1) {
				console.log(ts(), "FIRST MEDIA FRAME", { role, path, hasCallControlId: !!callControlId });
			} else if (mediaFrames % 200 === 0) {
				console.log(ts(), "MEDIA FRAMES", { role, path, mediaFrames, hasCallControlId: !!callControlId });
			}

			const audio = Buffer.from(data.media.payload, "base64");
			if (dgWs.readyState === WebSocket.OPEN) {
				dgWs.send(audio);
			}
		}

		if (data.event === "stop") {
			console.log(ts(), "TELNYX STOP", { role, path, mediaFrames, callControlId });

			try {
				if (dgWs.readyState === WebSocket.OPEN) {
					dgWs.send(JSON.stringify({ type: "Finalize" }));
				}
			} catch (e) {
				console.log(ts(), "DEEPGRAM FINALIZE ERROR", e && e.message ? e.message : e);
			}

			try {
				dgWs.close();
			} catch {}
		}
	});
});

server.listen(PORT, () => {
	console.log(ts(), "SERVER READY");
});
