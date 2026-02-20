const http = require('http');
const WebSocket = require('ws');

const port = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
	res.writeHead(200, { 'Content-Type': 'text/plain' });
	res.end('ok\n');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
	console.log('WS_CONNECTED', req.headers['user-agent'] || '');

	ws.on('message', (msg) => {
		if (Buffer.isBuffer(msg)) {
			console.log('WS_BIN', msg.length);
			return;
		}

		const s = msg.toString('utf8');
		console.log('WS_TEXT', s.length);

		try {
			const j = JSON.parse(s);
			console.log('WS_JSON_KEYS', Object.keys(j));
			if (j.event) console.log('WS_EVENT', j.event);
			if (j.event_type) console.log('WS_EVENT_TYPE', j.event_type);
			if (j.stream_id) console.log('WS_STREAM_ID', j.stream_id);
		} catch (e) {
			console.log('WS_TEXT_RAW', s.slice(0, 200));
		}
	});

	ws.on('close', (code, reason) => {
		console.log('WS_CLOSED', code, reason?.toString() || '');
	});

	ws.on('error', (err) => {
		console.log('WS_ERROR', err.message);
	});
});

server.listen(port, () => {
	console.log('Listening on', port);
});
