// index.js
const express = require('express');
const http = require('http');
const setupWebSocketServer = require('./websocket');

const app = express();
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);

setupWebSocketServer(server);

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Hello, World!');
});

server.listen(PORT, () => {
  console.log(`HTTP and WebSocket server running on port ${PORT}`);
});
