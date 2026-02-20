const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";
const CONTROL_SECRET = process.env.CONTROL_SECRET || "";

function ts() {
	return new Date().toISOString();
}

function jsonRead(req) {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (c) => {
			body += c.toString("utf8");
			if (body.length > 2_000_000) {
				reject(new Error("Body too large"));
			}
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(body || "{}"));
			} catch (e) {
				reject(e);
			}
		});
	});
}

function roleFromPath(path) {
	if (path === "/in") return "Rep";
	if (path === "/out") return "Prospect";
	return "Unknown";
}

async function telnyxStreamingStart(callControlId, streamTrack, streamUrl) {
	const url = `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/streaming_start`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${TELNYX_API_KEY}`
		},
		body: JSON.stringify({
			stream_track: streamTrack,
			stream_url: streamUrl
		})
	});
	const text = await res.text().catch(() => "");
	return { status: res.status, body_snip: text.slice(0, 300) };
}

const server = http.createServer(async (req, res) => {
	const url = req.url || "/";
	if (req.method === "GET" && (url === "/" || url === "/health")) {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("ok");
		return;
	}

	if (req.method === "POST" && url === "/control/start_streams") {
		try {
			const j = await jsonRead(req);

			if (!CONTROL_SECRET || j.secret !== CONTROL_SECRET) {
				res.writeHead(401, { "Content-Type": "text/plain" });
				res.end("unauthorized");
				return;
			}

			if (!TELNYX_API_KEY) {
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end("TELNYX_API_KEY missing");
				return;
			}

			const callControlId = (j.call_control_id || "").toString();
			if (!callControlId) {
				res.writeHead(400, { "Content-Type": "text/plain" });
				res.end("call_control_id missing");
				return;
			}

			console.log(ts(), "CONTROL start_streams", { callControlId });

			const inRes = await telnyxStreamingStart(callControlId, "inbound_track", "wss://stream.lumafront.com/in");
			const outRes = await telnyxStreamingStart(callControlId, "outbound_track", "wss://stream.lumafront.com/out");

			console.log(ts(), "CONTROL start_streams result", { callControlId, inRes, outRes });

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ call_control_id: callControlId, inbound: inRes, outbound: outRes }));
			return;
		} catch (e) {
			console.log(ts(), "CONTROL error", e && e.message ? e.message : e);
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end("bad request");
			return;
		}
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

	const dgUrl =
	    "wss://api.deepgram.com/v1/listen" +
	    "?model=nova-2" +
	    "&encoding=mulaw" +
	    "&sample_rate=8000" +
	    "&smart_format=true" +
	    "&interim_results=true" +
	    "&endpointing=200";

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
			const r = await fetch("https://lumafront.com/database/AI/sale_assistant/webhooks/transcript.php", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload)
			});

			if (!r.ok) {
				console.log(ts(), "TRANSCRIPT POST BAD STATUS", { status: r.status, role, callControlId });
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
				"";

			if (cc && !callControlId) {
				callControlId = cc;
				console.log(ts(), "CALL CONTROL ID SET", { callControlId, role, path });
			} else if (!cc) {
				console.log(ts(), "WARNING start missing call_control_id", { role, path });
			}
			return;
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

			try {
				dgWs.close();
			} catch {}
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
		hasDeepgramKey: !!DEEPGRAM_API_KEY,
		hasTelnyxKey: !!TELNYX_API_KEY,
		hasControlSecret: !!CONTROL_SECRET
	});
});

