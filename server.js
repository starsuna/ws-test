const http = require('http');
const WebSocket = require('ws');
const https = require('https');

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const TRANSCRIPT_ENDPOINT = "https://lumafront.com/database/AI/sale_assistant/webhooks/transcript.php";

const port = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
	res.writeHead(200);
	res.end("ok\n");
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (telnyxWs) => {

	const dgWs = new WebSocket(
		"wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=2&diarize=true",
		{
			headers: {
				Authorization: `Token ${DEEPGRAM_API_KEY}`
			}
		}
	);

	dgWs.on('open', () => {
		console.log("DEEPGRAM_CONNECTED");
	});

	telnyxWs.on('message', (msg) => {

		if (Buffer.isBuffer(msg)) {
			if (dgWs.readyState === WebSocket.OPEN) {
				dgWs.send(msg);
			}
			return;
		}

	});

	dgWs.on('message', (dgMsg) => {

		const data = JSON.parse(dgMsg.toString());

		if (!data.channel || !data.channel.alternatives) return;

		const transcript = data.channel.alternatives[0].transcript;
		if (!transcript) return;

		const payload = JSON.stringify({ transcript });

		const req = https.request(TRANSCRIPT_ENDPOINT, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': payload.length
			}
		});

		req.write(payload);
		req.end();
	});

	telnyxWs.on('close', () => {
		if (dgWs.readyState === WebSocket.OPEN) {
			dgWs.close();
		}
	});

});

server.listen(port, () => {
	console.log("Listening on", port);
});
