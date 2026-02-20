const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";

function ts() {
	return new Date().toISOString();
}

function roleFromPath(path) {
	if (path === "/in") return "Prospect";  // inbound = audio from the person you called
	if (path === "/out") return "Rep";       // outbound = your voice from Zoiper
	return "Unknown";
}

const server = http.createServer(async (req, res) => {
	const url = req.url || "/";
	if (req.method === "GET" && (url === "/" || url === "/health")) {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("ok");
		return;
	}
	res.writeHead(404, { "Content-Type": "text/plain" });
	res.end("not found");
});

const wss = new WebSocket.Server({ noServer: true });

// Track last-speech end time per call, per role, using WALL CLOCK time
// Key: callControlId, Value: { Rep: wallMs, Prospect: wallMs }
const callSpeechTimes = {};

wss.on("connection", (telnyxWs, req) => {
	const path = (req && req.url) ? req.url : "";
	const role = roleFromPath(path);

	let callControlId = "";
	let mediaFrames = 0;
	let callStartWallMs = Date.now(); // when this WS connection opened

	console.log(ts(), "TELNYX CONNECT", { path, role });

	telnyxWs.on("error", (e) => {
		console.log(ts(), "TELNYX WS ERROR", e && e.message ? e.message : e);
	});
	telnyxWs.on("close", (code, reason) => {
		console.log(ts(), "TELNYX CLOSE", { code, reason: reason ? reason.toString() : "" });
	});

	const dgUrl =
		"wss://api.deepgram.com/v1/listen" +
		"?model=nova-3" +
		"&encoding=alaw" +
		"&sample_rate=8000" +
		"&smart_format=true" +
		"&interim_results=true" +
		"&endpointing=150" +
		"&utterance_end_ms=800";

	const dgWs = new WebSocket(dgUrl, {
		headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }
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
		try { j = JSON.parse(dgMsg); } catch { return; }

		// Only process final transcripts
		if (!j.is_final) return;

		const alt = j?.channel?.alternatives?.[0];
		const text = alt?.transcript;
		if (!text || text.trim() === "") return;

		// Use wall clock time for overlap detection
		// Deepgram's start/end are relative to the utterance, not the call
		// So we use actual real-world time instead
		const nowMs = Date.now();

		// Duration of this utterance from Deepgram word timestamps
		let utteranceDurationMs = 0;
		if (alt.words && alt.words.length > 0) {
			const dgStart = alt.words[0].start || 0;
			const dgEnd   = alt.words[alt.words.length - 1].end || 0;
			utteranceDurationMs = Math.round((dgEnd - dgStart) * 1000);
		}

		// Estimate when this utterance started in wall time
		const utteranceStartWallMs = nowMs - utteranceDurationMs;
		const utteranceEndWallMs   = nowMs;

		// Check overlap against the other role
		const otherRole = (role === "Rep") ? "Prospect" : "Rep";
		const callTimes = callSpeechTimes[callControlId] || {};
		const otherEndWallMs = callTimes[otherRole] || 0;

		// Overlap if this utterance started before the other person finished
		// Add 300ms grace period to avoid false overlaps from timing jitter
		const OVERLAP_GRACE_MS = 300;
		const overlap = (utteranceStartWallMs < (otherEndWallMs - OVERLAP_GRACE_MS));

		// Update this role's last speech end time
		if (!callSpeechTimes[callControlId]) callSpeechTimes[callControlId] = {};
		callSpeechTimes[callControlId][role] = utteranceEndWallMs;

		const payload = {
			call_control_id: callControlId,
			role,
			text,
			overlap,
			// Send wall-clock based times as seconds-since-call-start
			start: (utteranceStartWallMs - callStartWallMs) / 1000,
			end:   (utteranceEndWallMs   - callStartWallMs) / 1000,
			is_final: true
		};

		console.log(ts(), "TRANSCRIPT", { role, text, overlap, callControlId });

		try {
			const r = await fetch("https://lumafront.com/database/AI/sale_assistant/webhooks/transcript.php", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload)
			});
			if (!r.ok) {
				console.log(ts(), "TRANSCRIPT POST BAD STATUS", { status: r.status });
			}
		} catch (e) {
			console.log(ts(), "TRANSCRIPT POST ERROR", e && e.message ? e.message : e);
		}
	});

	telnyxWs.on("message", (msg) => {
		let data;
		try { data = JSON.parse(msg); } catch { return; }

		if (data.event === "connected") {
			return;
		}

		if (data.event === "start") {
			const cc =
				data?.start?.call_control_id ||
				data?.call_control_id ||
				"";
			if (cc && !callControlId) {
				callControlId = cc;
				callStartWallMs = Date.now();
				console.log(ts(), "CALL CONTROL ID SET", { callControlId, role, path });
			}
			const encoding = data?.start?.media_format?.encoding || "unknown";
			console.log(ts(), "STREAM START", { role, encoding, callControlId });
			return;
		}

		if (data.event === "media" && data.media && data.media.payload) {
			mediaFrames += 1;
			if (mediaFrames === 1) {
				console.log(ts(), "FIRST MEDIA FRAME", { role, path, hasCallControlId: !!callControlId });
			} else if (mediaFrames % 500 === 0) {
				console.log(ts(), "MEDIA FRAMES", { role, mediaFrames });
			}
			const audio = Buffer.from(data.media.payload, "base64");
			if (dgWs.readyState === WebSocket.OPEN) {
				dgWs.send(audio);
			}
			return;
		}

		if (data.event === "stop") {
			console.log(ts(), "TELNYX STOP", { role, path, mediaFrames, callControlId });
			// Clean up call state after a delay
			setTimeout(() => {
				if (callSpeechTimes[callControlId]) {
					delete callSpeechTimes[callControlId];
				}
			}, 10000);
			try {
				if (dgWs.readyState === WebSocket.OPEN) {
					dgWs.send(JSON.stringify({ type: "Finalize" }));
				}
			} catch (e) {
				console.log(ts(), "DEEPGRAM FINALIZE ERROR", e && e.message ? e.message : e);
			}
			try { dgWs.close(); } catch {}
			return;
		}
	});
});

server.on("upgrade", (req, socket, head) => {
	const url = req.url || "";
	if (url !== "/in" && url !== "/out") {
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		wss.emit("connection", ws, req);
	});
});

server.listen(PORT, () => {
	console.log(ts(), "HTTP+WS listening on", PORT);
	console.log(ts(), "ENV", { hasDeepgramKey: !!DEEPGRAM_API_KEY });
});
