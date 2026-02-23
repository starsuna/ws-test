const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";

function ts() { return new Date().toISOString(); }

function trackToRole(track) {
	if (track === "inbound")  return "Rep";
	if (track === "outbound") return "Prospect";
	return "Unknown";
}

// ── Shared state ────────────────────────────────────────────────
const callSpeechTimes = {}; // callControlId -> { Rep: ms, Prospect: ms }
const audioBuffers    = {}; // callControlId -> { Rep: [], Prospect: [], stopped: 0 }

// ── WAV / audio helpers ─────────────────────────────────────────
// A-law decode table (256 entries -> 16-bit PCM)
const ALAW_DECODE = (() => {
	const t = new Int16Array(256);
	for (let i = 0; i < 256; i++) {
		let val = i ^ 0x55;
		let seg = (val & 0x70) >> 4;
		let s = (val & 0x0F) << 1 | 1;
		if (seg) s = (s + 32) << (seg - 1);
		t[i] = (val & 0x80) ? s : -s;
	}
	return t;
})();

// Build a stereo (2-channel) 16-bit PCM WAV
// Left channel = Rep, Right channel = Prospect
// Frames are placed by their Telnyx timestamp (milliseconds)
// Each frame = 20ms = 160 samples @ 8000Hz
function buildStereoWav(repFrames, prospectFrames) {
	const SAMPLE_RATE   = 8000;
	const SAMPLES_20MS  = 160; // 20ms at 8kHz
	const BYTES_PER_SAMPLE = 2; // 16-bit PCM
	const CHANNELS      = 2;

	// Find total duration from last timestamp + 20ms
	let maxTs = 0;
	for (const f of repFrames)      if (f.ts > maxTs) maxTs = f.ts;
	for (const f of prospectFrames) if (f.ts > maxTs) maxTs = f.ts;
	const totalMs      = maxTs + 20;
	const totalSamples = Math.ceil(totalMs * SAMPLE_RATE / 1000);

	// Allocate stereo interleaved buffer (L,R,L,R...)
	const pcm = Buffer.alloc(totalSamples * CHANNELS * BYTES_PER_SAMPLE, 0);

	function writeFrames(frames, channel) { // channel: 0=Left(Rep), 1=Right(Prospect)
		for (const { ts, audio } of frames) {
			const startSample = Math.floor(ts * SAMPLE_RATE / 1000);
			for (let i = 0; i < audio.length; i++) {
				const sample     = ALAW_DECODE[audio[i]];
				const sampleIdx  = startSample + i;
				const byteOffset = (sampleIdx * CHANNELS + channel) * BYTES_PER_SAMPLE;
				if (byteOffset + 1 < pcm.length) {
					pcm.writeInt16LE(sample, byteOffset);
				}
			}
		}
	}

	writeFrames(repFrames,      0); // Left  = Rep
	writeFrames(prospectFrames, 1); // Right = Prospect

	// Build stereo WAV header
	const dataBytes = pcm.length;
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(dataBytes + 36, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);                          // PCM = 1
	header.writeUInt16LE(CHANNELS, 22);
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, 28);
	header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(dataBytes, 40);

	return Buffer.concat([header, pcm]);
}

async function uploadMixedAudio(callControlId, repFrames, prospectFrames) {
	try {
		if (repFrames.length === 0 && prospectFrames.length === 0) {
			console.log(ts(), "AUDIO UPLOAD SKIPPED - no frames", { callControlId });
			return;
		}

		const wavFile = buildStereoWav(repFrames, prospectFrames);
		console.log(ts(), "AUDIO BUILD", {
			callControlId,
			repFrames:      repFrames.length,
			prospectFrames: prospectFrames.length,
			wavBytes:       wavFile.length
		});

		const boundary = "----FormBoundary" + Date.now();
		const CRLF = "\r\n";
		const metaPart =
			"--" + boundary + CRLF +
			'Content-Disposition: form-data; name="call_control_id"' + CRLF + CRLF +
			callControlId + CRLF +
			"--" + boundary + CRLF +
			'Content-Disposition: form-data; name="audio"; filename="audio.wav"' + CRLF +
			"Content-Type: audio/wav" + CRLF + CRLF;
		const endPart = CRLF + "--" + boundary + "--" + CRLF;
		const body = Buffer.concat([Buffer.from(metaPart), wavFile, Buffer.from(endPart)]);

		const r = await fetch("https://lumafront.com/database/AI/sale_assistant/webhooks/save_audio.php", {
			method: "POST",
			headers: {
				"Content-Type":  "multipart/form-data; boundary=" + boundary,
				"Content-Length": body.length
			},
			body
		});
		console.log(ts(), "AUDIO UPLOAD STATUS", r.status, { wavBytes: wavFile.length });
	} catch (e) {
		console.log(ts(), "AUDIO UPLOAD ERROR", e && e.message ? e.message : e);
	}
}

// ── Deepgram connection factory ──────────────────────────────────
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
	dg.on("open",  ()    => console.log(ts(), "DEEPGRAM OPEN",  { role }));
	dg.on("error", (e)   => console.log(ts(), "DEEPGRAM ERROR", { role, err: e && e.message ? e.message : e }));
	dg.on("close", (c,r) => console.log(ts(), "DEEPGRAM CLOSE", { role, code: c, reason: r ? r.toString() : "" }));

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
			durMs = Math.round(((alt.words[alt.words.length-1].end || 0) - (alt.words[0].start || 0)) * 1000);
		}
		const startMs = nowMs - durMs;
		const otherRole = role === "Rep" ? "Prospect" : "Rep";
		if (!callSpeechTimes[callControlId]) callSpeechTimes[callControlId] = {};
		const otherEnd = callSpeechTimes[callControlId][otherRole] || 0;
		const overlap  = startMs < (otherEnd - 800);
		callSpeechTimes[callControlId][role] = nowMs;

		console.log(ts(), "TRANSCRIPT", { role, text, overlap });

		try {
			await fetch("https://lumafront.com/database/AI/sale_assistant/webhooks/transcript.php", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					call_control_id: callControlId, role, text, overlap,
					start: (startMs - callStartWallMs) / 1000,
					end:   (nowMs   - callStartWallMs) / 1000,
					is_final: true
				})
			});
		} catch (e) { console.log(ts(), "TRANSCRIPT POST ERROR", e && e.message ? e.message : e); }
	});

	return dg;
}

// ── HTTP server ──────────────────────────────────────────────────
const server = http.createServer((req, res) => {
	if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
		res.writeHead(200); res.end("ok"); return;
	}
	res.writeHead(404); res.end("not found");
});

// ── WebSocket server ─────────────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });

wss.on("connection", (telnyxWs, req) => {
	const path = (req && req.url) ? req.url : "";
	console.log(ts(), "TELNYX CONNECT", { path });

	let callControlId   = "";
	let callStartWallMs = Date.now();
	let mediaFrames     = 0;

	const getCC  = () => callControlId;
	const getCSW = () => callStartWallMs;

	// Create TWO Deepgram connections — one per track (Rep=inbound, Prospect=outbound)
	// This guarantees correct speaker separation regardless of which endpoint Telnyx uses
	const dgRep      = makeDgWs("Rep",      getCC, getCSW);
	const dgProspect = makeDgWs("Prospect", getCC, getCSW);

	telnyxWs.on("error", (e)   => console.log(ts(), "TELNYX ERROR", e && e.message ? e.message : e));
	telnyxWs.on("close", (c,r) => console.log(ts(), "TELNYX CLOSE", { code: c }));

	telnyxWs.on("message", (msg) => {
		let data; try { data = JSON.parse(msg); } catch { return; }

		if (data.event === "connected") return;

		if (data.event === "start") {
			const cc = data?.start?.call_control_id || data?.call_control_id || "";
			if (cc && !callControlId) {
				callControlId   = cc;
				callStartWallMs = Date.now();
				console.log(ts(), "CALL CONTROL ID SET", { callControlId, path });

				// Merge pre-buffered frames (these had ts=0 before callControlId known - still correct
				// because Telnyx timestamps are relative to stream start, not wall clock)
				const pk = "pending_" + path;
				if (audioBuffers[pk]) {
					if (!audioBuffers[callControlId]) audioBuffers[callControlId] = { Rep: [], Prospect: [], stopped: 0 };
					audioBuffers[callControlId].Rep.push(...(audioBuffers[pk].Rep || []));
					audioBuffers[callControlId].Prospect.push(...(audioBuffers[pk].Prospect || []));
					delete audioBuffers[pk];
					console.log(ts(), "MERGED PENDING AUDIO", { path });
				}
			}
			console.log(ts(), "STREAM START", { encoding: data?.start?.media_format?.encoding, callControlId });
			return;
		}

		if (data.event === "media" && data.media && data.media.payload) {
			mediaFrames++;
			const track = data.media.track || "inbound";
			const role  = trackToRole(track);
			const audio = Buffer.from(data.media.payload, "base64");

			if (mediaFrames === 1) console.log(ts(), "FIRST MEDIA FRAME", { path, track, role });

			// Route audio to the correct Deepgram connection
			const dg = (role === "Rep") ? dgRep : dgProspect;
			if (dg.readyState === WebSocket.OPEN) dg.send(audio);

			// Buffer for recording - store with Telnyx timestamp for exact alignment
			// Telnyx timestamp is in milliseconds from call start
			const frameTs  = parseInt(data.media.timestamp || "0", 10);
			const bufKey   = callControlId || ("pending_" + path);
			if (!audioBuffers[bufKey]) audioBuffers[bufKey] = { Rep: [], Prospect: [], stopped: 0 };
			if (role === "Rep" || role === "Prospect") {
				audioBuffers[bufKey][role].push({ ts: frameTs, audio });
			}
			return;
		}

		if (data.event === "stop") {
			console.log(ts(), "TELNYX STOP", { path, mediaFrames, callControlId });

			// Finalize both Deepgram streams
			[dgRep, dgProspect].forEach(dg => {
				try { if (dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: "Finalize" })); } catch {}
			});

			// Wait 4s for final transcripts, then upload audio
			setTimeout(() => {
				[dgRep, dgProspect].forEach(dg => { try { dg.close(); } catch {} });

				if (!audioBuffers[callControlId]) return;
				audioBuffers[callControlId].stopped += 1;

				const doUpload = () => {
					const buf = audioBuffers[callControlId];
					if (!buf) return;
					delete audioBuffers[callControlId];
					uploadMixedAudio(callControlId, buf.Rep, buf.Prospect);
				};

				// Each call now has only ONE Telnyx WS connection (using /both or single track)
				// so stopped===1 means done. Use timeout as safety net.
				doUpload();

				setTimeout(() => { if (callSpeechTimes[callControlId]) delete callSpeechTimes[callControlId]; }, 5000);
			}, 4000);
			return;
		}
	});
});

server.on("upgrade", (req, socket, head) => {
	const url = req.url || "";
	// Accept /in, /out, and /both (new primary endpoint)
	if (url !== "/in" && url !== "/out" && url !== "/both") {
		socket.destroy(); return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(PORT, () => {
	console.log(ts(), "HTTP+WS listening on", PORT);
	console.log(ts(), "ENV", { hasDeepgramKey: !!DEEPGRAM_API_KEY });
});
