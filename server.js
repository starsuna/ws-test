const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

function ts() {
	return new Date().toISOString();
}

if (!DEEPGRAM_API_KEY) {
	console.log(ts(), "FATAL: DEEPGRAM_API_KEY is not set");
}

const wss = new WebSocket.Server({ port: PORT });

function roleFromPath(path) {
	if (path === "/in") return "Rep";
	if (path === "/out") return "Prospect";
	return "Unknown";
}

console.log(ts(), "WebSocket server listening on", PORT);

wss.on("connection", (telnyxWs, req) => {
	const path = (req && req.url) ? req.url : (telnyxWs && telnyxWs._path ? telnyxWs._path : "");
	const role = roleFromPath(path);
	let callControlId = "";
	let mediaFrames = 0;

	console.log(ts(), "TELNYX CONNECT", { path, role });

	// Prevent crashes from Telnyx socket errors, but log them
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

	// Log Deepgram errors/closes
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

		// Log the first couple messages so we can see the real schema
		if (mediaFrames === 0 && data && data.event && data.event !== "media") {
			console.log(ts(), "TELNYX EVENT", data.event, JSON.stringify(data).slice(0, 500));
		}

		if (data.event === "start") {
			// Telnyx start payload varies, grab call_control_id from common locations
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

			// occasional progress log
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
