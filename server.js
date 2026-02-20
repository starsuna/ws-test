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

// Buffer raw PCMA audio per call per role
// Key: callControlId, Value: { Rep: [Buffer,...], Prospect: [Buffer,...], stopped: 0 }
const audioBuffers = {};

function makeWavHeader(dataLength, sampleRate = 8000, channels = 1) {
	const header = Buffer.alloc(44);
	header.write('RIFF', 0);
	header.writeUInt32LE(dataLength + 36, 4);
	header.write('WAVE', 8);
	header.write('fmt ', 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(6, 20);            // 6 = PCMA / A-law
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * channels, 28);
	header.writeUInt16LE(channels, 32);
	header.writeUInt16LE(8, 34);            // 8-bit samples
	header.write('data', 36);
	header.writeUInt32LE(dataLength, 40);
	return header;
}

function mixAlaw(repBuf, prospectBuf) {
	// Decode A-law to 16-bit PCM, mix, re-encode to A-law
	// A-law decode/encode tables
	const alawDecode = new Int16Array(256);
	for (let i = 0; i < 256; i++) {
		let val = i ^ 0x55;
		let seg = (val & 0x70) >> 4;
		let t = (val & 0x0F) << 1 | 1;
		if (seg) t = (t + 32) << (seg - 1);
		alawDecode[i] = (val & 0x80) ? t : -t;
	}

	const len = Math.max(repBuf.length, prospectBuf.length);
	const mixed = Buffer.alloc(len);

	for (let i = 0; i < len; i++) {
		const s1 = i < repBuf.length      ? alawDecode[repBuf[i]]      : 0;
		const s2 = i < prospectBuf.length ? alawDecode[prospectBuf[i]] : 0;
		let sum = s1 + s2;
		// Clamp to 16-bit
		if (sum > 32767)  sum = 32767;
		if (sum < -32768) sum = -32768;
		// Re-encode to A-law
		const sign = (sum >= 0) ? 0x80 : 0x00;
		if (sum < 0) sum = -sum;
		let enc;
		if      (sum <= 31)    enc = (sum >> 1) | 0x00;
		else if (sum <= 63)    enc = ((sum - 32) >> 1) | 0x10;
		else if (sum <= 127)   enc = ((sum - 64) >> 2) | 0x20;
		else if (sum <= 255)   enc = ((sum - 128) >> 3) | 0x30;
		else if (sum <= 511)   enc = ((sum - 256) >> 4) | 0x40;
		else if (sum <= 1023)  enc = ((sum - 512) >> 5) | 0x50;
		else if (sum <= 2047)  enc = ((sum - 1024) >> 6) | 0x60;
		else if (sum <= 4095)  enc = ((sum - 2048) >> 7) | 0x70;
		else                   enc = 0x7F;
		mixed[i] = (enc | sign) ^ 0x55;
	}
	return mixed;
}

async function uploadMixedAudio(callControlId, repChunks, prospectChunks) {
	try {
		const repBuf      = Buffer.concat(repChunks);
		const prospectBuf = Buffer.concat(prospectChunks);
		const mixedPcm    = mixAlaw(repBuf, prospectBuf);
		const wavHeader   = makeWavHeader(mixedPcm.length);
		const wavFile     = Buffer.concat([wavHeader, mixedPcm]);

		console.log(ts(), 'AUDIO MIX', { callControlId, repBytes: repBuf.length, prospectBytes: prospectBuf.length, mixedBytes: mixedPcm.length });

		const boundary = '----FormBoundary' + Date.now();
		const CRLF = '\r\n';
		const metaPart =
			'--' + boundary + CRLF +
			'Content-Disposition: form-data; name="call_control_id"' + CRLF + CRLF +
			callControlId + CRLF +
			'--' + boundary + CRLF +
			'Content-Disposition: form-data; name="audio"; filename="audio.wav"' + CRLF +
			'Content-Type: audio/wav' + CRLF + CRLF;
		const endPart = CRLF + '--' + boundary + '--' + CRLF;
		const body = Buffer.concat([Buffer.from(metaPart), wavFile, Buffer.from(endPart)]);

		const r = await fetch('https://lumafront.com/database/AI/sale_assistant/webhooks/save_audio.php', {
			method: 'POST',
			headers: {
				'Content-Type': 'multipart/form-data; boundary=' + boundary,
				'Content-Length': body.length
			},
			body
		});
		console.log(ts(), 'AUDIO UPLOAD', { callControlId, status: r.status, wavBytes: wavFile.length });
	} catch (e) {
		console.log(ts(), 'AUDIO UPLOAD ERROR', e && e.message ? e.message : e);
	}
}

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
		"?model=nova-2-phonecall" +
		"&encoding=alaw" +
		"&sample_rate=8000" +
		"&smart_format=true" +
		"&interim_results=true" +
		"&endpointing=150";

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
		const OVERLAP_GRACE_MS = 800;
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
			// Buffer audio for mixing after call ends
			if (callControlId) {
				if (!audioBuffers[callControlId]) audioBuffers[callControlId] = { Rep: [], Prospect: [], stopped: 0 };
				audioBuffers[callControlId][role].push(audio);
			}
			return;
		}

		if (data.event === "stop") {
			console.log(ts(), "TELNYX STOP", { role, path, mediaFrames, callControlId });

			// When both tracks have stopped, mix and upload one combined WAV
			if (audioBuffers[callControlId]) {
				audioBuffers[callControlId].stopped += 1;
				if (audioBuffers[callControlId].stopped === 2) {
					const buf = audioBuffers[callControlId];
					delete audioBuffers[callControlId];
					uploadMixedAudio(callControlId, buf.Rep, buf.Prospect);
				}
			}

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
