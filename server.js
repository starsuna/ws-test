 const http = require("http");
const WebSocket = require("ws");

const port = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
	res.writeHead(200);
	res.end("ok");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
	ws.send("connected");
	ws.on("message", (msg) => {
		ws.send(msg);
	});
});

server.listen(port, () => {
	console.log("Listening on " + port);
});