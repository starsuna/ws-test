const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";

function ts() {
	return new Date().toISOString();
}

function roleFromPath(path) {
	if (path === "/in") return "Prospect";  // inbound = audio from the person you called
	if (path === "/out") return "Rep";       // outbound = your voice going out
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

	// PCMA = G.711 A-law, confirmed from Telnyx STREAM START logs
	const dgUrl =
		"wss://api.deepgram.com/v1/listen" +
		"?model=nova-2" +
		"&encoding=alaw" +
		"&sample_rate=8000" +
		"&smart_format=true" +
		"&interim_results=true" +
		"&endpointing=200" +
		"&utterance_end_ms=1000";

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
		try {
			j = JSON.parse(dgMsg);
		} catch {
			return;
		}

		// Only post final transcripts to reduce PHP load
		if (!j.is_final) return;

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
			is_final: true
		};

		console.log(ts(), "TRANSCRIPT", { role, text, callControlId });

		try {
			const r = await fetch("https://lumafront.com/database/AI/sale_assistant/webhooks/transcript.php", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload)
			});
			console.log(ts(), "TRANSCRIPT POST STATUS", { status: r.status, role });
		} catch (e) {
			console.log(ts(), "TRANSCRIPT POST ERROR", e && e.message ? e.message : e);
		}
	});

	telnyxWs.on("message", (msg) => {
		let data;
		try {
			data = JSON.parse(msg);
		} catch {
			return;
		}

		if (data.event === "connected") {
			console.log(ts(), "TELNYX CONNECTED EVENT", { role });
			return;
		}

		if (data.event === "start") {
			const cc =
				data?.start?.call_control_id ||
				data?.call_control_id ||
				"";

			if (cc && !callControlId) {
				callControlId = cc;
				console.log(ts(), "CALL CONTROL ID SET", { callControlId, role, path });
			}

			// Log the actual encoding Telnyx is sending
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
	console.log(ts(), "ENV", {
		hasDeepgramKey: !!DEEPGRAM_API_KEY
	});
});
