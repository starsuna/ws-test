const http = require("http");
const WebSocket = require("ws");

const PORT             = process.env.PORT || 10000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const PHP_BASE         = "https://lumafront.com/database/AI/sale_assistant/webhooks";

function ts() { return new Date().toISOString(); }

function roleFromPath(path) {
	if (path === "/in")  return "Rep";
	if (path === "/out") return "Prospect";
	return "Unknown";
}

const callSpeechTimes = {};
const audioBuffers    = {};

const ALAW_DECODE = (() => {
	const t = new Int16Array(256);
	for (let i = 0; i < 256; i++) {
		let val = i ^ 0x55;
		let seg = (val & 0x70) >> 4;
		let s   = (val & 0x0F) << 1 | 1;
		if (seg) s = (s + 32) << (seg - 1);
		t[i] = (val & 0x80) ? s : -s;
	}
	return t;
})();

function buildStereoWav(repFrames, prospectFrames) {
	const SAMPLE_RATE      = 8000;
	const CHANNELS         = 2;
	const BYTES_PER_SAMPLE = 2;
	const GAIN             = 6.0;
	let maxTs = 0;
	for (const f of repFrames)      if (f.ts > maxTs) maxTs = f.ts;
	for (const f of prospectFrames) if (f.ts > maxTs) maxTs = f.ts;
	const totalSamples = Math.ceil((maxTs + 20) * SAMPLE_RATE / 1000);
	const pcm          = Buffer.alloc(totalSamples * CHANNELS * BYTES_PER_SAMPLE, 0);
	function writeFrames(frames, channel) {
		for (const { ts, audio } of frames) {
			const startSample = Math.floor(ts * SAMPLE_RATE / 1000);
			for (let i = 0; i < audio.length; i++) {
				const amp        = Math.max(-32768, Math.min(32767, Math.round(ALAW_DECODE[audio[i]] * GAIN)));
				const byteOffset = ((startSample + i) * CHANNELS + channel) * BYTES_PER_SAMPLE;
				if (byteOffset + 1 < pcm.length) pcm.writeInt16LE(amp, byteOffset);
			}
		}
	}
	writeFrames(repFrames, 0);
	writeFrames(prospectFrames, 1);
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(pcm.length + 36, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(CHANNELS, 22);
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, 28);
	header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

async function uploadAudio(callControlId, repFrames, prospectFrames) {
	try {
		if (!repFrames.length && !prospectFrames.length) return;
		const wavFile  = buildStereoWav(repFrames, prospectFrames);
		const boundary = "----Boundary" + Date.now();
		const CRLF     = "\r\n";
		const meta     =
			"--" + boundary + CRLF +
			'Content-Disposition: form-data; name="call_control_id"' + CRLF + CRLF +
			callControlId + CRLF +
			"--" + boundary + CRLF +
			'Content-Disposition: form-data; name="audio"; filename="audio.wav"' + CRLF +
			"Content-Type: audio/wav" + CRLF + CRLF;
		const body = Buffer.concat([Buffer.from(meta), wavFile, Buffer.from(CRLF + "--" + boundary + "--" + CRLF)]);
		const r    = await fetch(PHP_BASE + "/save_audio.php", {
			method: "POST",
			headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": body.length },
			body
		});
		console.log(ts(), "AUDIO UPLOAD", r.status, { wavBytes: wavFile.length });
	} catch (e) {
		console.log(ts(), "AUDIO UPLOAD ERROR", e && e.message ? e.message : e);
	}
}

async function saveCost(callControlId, repFrameCount, prospectFrameCount) {
	try {
		const DG_COST_PER_MIN = 0.0043;
		const repMs           = repFrameCount * 20;
		const prospectMs      = prospectFrameCount * 20;
		const repMin          = Math.ceil(repMs      / 1000) / 60;
		const prospectMin     = Math.ceil(prospectMs / 1000) / 60;
		const cost_usd        = parseFloat(((repMin + prospectMin) * DG_COST_PER_MIN).toFixed(6));
		const payload         = {
			call_control_id: callControlId,
			rep_seconds:      Math.round(repMs / 1000),
			prospect_seconds: Math.round(prospectMs / 1000),
			total_seconds:    Math.round((repMs + prospectMs) / 1000),
			cost_usd
		};
		console.log(ts(), "DEEPGRAM COST", payload);
		await fetch(PHP_BASE + "/save_cost.php", {
			method:  "POST",
			headers: { "Content-Type": "application/json" },
			body:    JSON.stringify(payload)
		});
	} catch (e) {
		console.log(ts(), "SAVE COST ERROR", e && e.message ? e.message : e);
	}
}

function makeDgWs(role, getCC, getCSW) {
	const dgUrl =
		"wss://api.deepgram.com/v1/listen" +
		"?model=nova-2-phonecall" +
		"&encoding=alaw" +
		"&sample_rate=8000" +
		"&smart_format=true" +
		"&interim_results=true" +
		"&endpointing=150";

	const dg = new WebSocket(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });
	dg.on("open",  ()  => console.log(ts(), "DEEPGRAM OPEN",  { role }));
	dg.on("error", (e) => console.log(ts(), "DEEPGRAM ERROR", { role, err: e && e.message ? e.message : e }));
	dg.on("close", (c) => console.log(ts(), "DEEPGRAM CLOSE", { role, code: c }));

	dg.on("message", async (raw) => {
		let j; try { j = JSON.parse(raw); } catch { return; }
		if (!j.is_final) return;
		const alt  = j?.channel?.alternatives?.[0];
		const text = alt?.transcript;
		if (!text || !text.trim()) return;

		const callControlId   = getCC();
		const callStartWallMs = getCSW();
		const nowMs           = Date.now();
		let durMs = 0;
		if (alt.words && alt.words.length > 0) {
			durMs = Math.round(((alt.words[alt.words.length-1].end||0) - (alt.words[0].start||0)) * 1000);
		}
		const startMs   = nowMs - durMs;
		const otherRole = role === "Rep" ? "Prospect" : "Rep";
		if (!callSpeechTimes[callControlId]) callSpeechTimes[callControlId] = {};
		const overlap = startMs < ((callSpeechTimes[callControlId][otherRole] || 0) - 800);
		callSpeechTimes[callControlId][role] = nowMs;

		console.log(ts(), "TRANSCRIPT", { role, text, overlap });

		try {
			await fetch(PHP_BASE + "/transcript.php", {
				method:  "POST",
				headers: { "Content-Type": "application/json" },
				body:    JSON.stringify({
					call_control_id: callControlId, role, text, overlap,
					start: (startMs - callStartWallMs) / 1000,
					end:   (nowMs   - callStartWallMs) / 1000,
					is_final: true
				})
			});
		} catch (e) {
			console.log(ts(), "TRANSCRIPT POST ERROR", e && e.message ? e.message : e);
		}

		// Trigger AI suggestion instantly after every Prospect utterance
		if (role === "Prospect") {
			fetch(PHP_BASE + "/suggest.php", {
				method:  "POST",
				headers: { "Content-Type": "application/json" },
				body:    JSON.stringify({ call_control_id: callControlId })
			}).catch(e => console.log(ts(), "SUGGEST TRIGGER ERROR", e && e.message ? e.message : e));
		}
	});

	return dg;
}

const server = http.createServer((req, res) => {
	if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
		res.writeHead(200); res.end("ok"); return;
	}
	res.writeHead(404); res.end("not found");
});

const wss = new WebSocket.Server({ noServer: true });

wss.on("connection", (telnyxWs, req) => {
	const path = (req && req.url) ? req.url : "";
	const role = roleFromPath(path);

	let callControlId   = "";
	let callStartWallMs = Date.now();
	let mediaFrames     = 0;
	let firstRtpTs      = null;

	const dg = makeDgWs(role, () => callControlId, () => callStartWallMs);

	console.log(ts(), "TELNYX CONNECT", { path, role });
	telnyxWs.on("error", (e) => console.log(ts(), "TELNYX ERROR", e && e.message ? e.message : e));
	telnyxWs.on("close", (c) => console.log(ts(), "TELNYX CLOSE", { code: c, role }));

	telnyxWs.on("message", (msg) => {
		let data; try { data = JSON.parse(msg); } catch { return; }
		if (data.event === "connected") return;

		if (data.event === "start") {
			const cc = data?.start?.call_control_id || data?.call_control_id || "";
			if (cc && !callControlId) {
				callControlId   = cc;
				callStartWallMs = Date.now();
				console.log(ts(), "CALL CONTROL ID SET", { callControlId, role });
				const pk = "pending_" + path;
				if (audioBuffers[pk]) {
					if (!audioBuffers[callControlId]) audioBuffers[callControlId] = { Rep: [], Prospect: [], stopped: 0 };
					audioBuffers[callControlId][role].push(...audioBuffers[pk][role]);
					delete audioBuffers[pk];
				}
			}
			console.log(ts(), "STREAM START", { role, encoding: data?.start?.media_format?.encoding });
			return;
		}

		if (data.event === "media" && data.media && data.media.payload) {
			mediaFrames++;
			if (mediaFrames === 1) console.log(ts(), "FIRST MEDIA FRAME", { role, path });
			const audio    = Buffer.from(data.media.payload, "base64");
			const rawRtpTs = parseInt(data.media.timestamp || "0", 10);
			if (firstRtpTs === null) firstRtpTs = rawRtpTs;
			const frameTs  = Math.round((rawRtpTs - firstRtpTs) / 8);
			if (dg.readyState === WebSocket.OPEN) dg.send(audio);
			const bufKey = callControlId || ("pending_" + path);
			if (!audioBuffers[bufKey]) audioBuffers[bufKey] = { Rep: [], Prospect: [], stopped: 0 };
			audioBuffers[bufKey][role].push({ ts: frameTs, audio });
			return;
		}

		if (data.event === "stop") {
			console.log(ts(), "TELNYX STOP", { role, mediaFrames, callControlId });
			try { if (dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: "Finalize" })); } catch {}
			setTimeout(() => {
				try { dg.close(); } catch {}
				if (!audioBuffers[callControlId]) return;
				audioBuffers[callControlId].stopped += 1;
				const doUpload = () => {
					const buf = audioBuffers[callControlId];
					if (!buf) return;
					delete audioBuffers[callControlId];
					uploadAudio(callControlId, buf.Rep, buf.Prospect);
					saveCost(callControlId, buf.Rep.length, buf.Prospect.length);
					setTimeout(() => { delete callSpeechTimes[callControlId]; }, 5000);
				};
				if (audioBuffers[callControlId].stopped >= 2) {
					doUpload();
				} else {
					setTimeout(() => { if (audioBuffers[callControlId]) doUpload(); }, 5000);
				}
			}, 4000);
			return;
		}
	});
});

server.on("upgrade", (req, socket, head) => {
	const url = req.url || "";
	if (url !== "/in" && url !== "/out") { socket.destroy(); return; }
	wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(PORT, () => {
	console.log(ts(), "HTTP+WS listening on", PORT);
	console.log(ts(), "ENV", { hasDeepgramKey: !!DEEPGRAM_API_KEY });
});
