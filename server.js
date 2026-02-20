const WebSocket = require("ws");
const fetch = require("node-fetch");

const PORT = process.env.PORT || 10000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

const wss = new WebSocket.Server({ port: PORT });

function roleFromPath(path) {
	if (path === "/in") return "Rep";
	if (path === "/out") return "Prospect";
	return "Unknown";
}

wss.on("connection", (telnyxWs, req) => {
	const path = req.url;
	const role = roleFromPath(path);
	let callControlId = "";

	// Prevent crashes from Telnyx socket errors
	telnyxWs.on("error", () => {});
	telnyxWs.on("close", () => {});

	const dgUrl =
		"wss://api.deepgram.com/v1/listen" +
		"?model=flux" +
		"&encoding=alaw" +
		"&sample_rate=8000" +
		"&smart_format=true" +
		"&interim_results=true" +
		"&endpointing=300";

	const dgWs = new WebSocket(dgUrl, {
		headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }
	});

	// Prevent crashes from Deepgram socket errors
	dgWs.on("error", () => {});
	dgWs.on("close", () => {});

	dgWs.on("message", async (dgMsg) => {
		let j;
		try {
			j = JSON.parse(dgMsg);
		} catch {
			return;
		}

		if (!j.channel || !j.channel.alternatives || !j.channel.alternatives[0]) return;

		const alt = j.channel.alternatives[0];
		const text = alt.transcript;
		if (!text || text.trim() === "") return;

		let start = 0;
		let end = 0;

		if (alt.words && alt.words.length > 0) {
			start = alt.words[0].start || 0;
			end = alt.words[alt.words.length - 1].end || 0;
		}

		try {
			await fetch("https://lumafront.com/database/AI/sale_assistant/webhooks/transcript.php", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					call_control_id: callControlId,
					role,
					text,
					start,
					end,
					is_final: j.is_final || false
				})
			});
		} catch {}
	});

	telnyxWs.on("message", (msg) => {
		let data;
		try {
			data = JSON.parse(msg);
		} catch {
			return;
		}

		if (data.event === "start" && data.start && data.start.call_control_id) {
			callControlId = data.start.call_control_id;
		}

		if (data.event === "media" && data.media && data.media.payload) {
			const audio = Buffer.from(data.media.payload, "base64");
			if (dgWs.readyState === WebSocket.OPEN) {
				dgWs.send(audio);
			}
		}

		if (data.event === "stop") {
			try {
				if (dgWs.readyState === WebSocket.OPEN) {
					dgWs.send(JSON.stringify({ type: "Finalize" }));
				}
			} catch {}
			try {
				dgWs.close();
			} catch {}
		}
	});
});

console.log("WebSocket server running on port", PORT);
