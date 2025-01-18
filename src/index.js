// index.js
const express = require('express');
const http = require('http');
const setupWebSocketServer = require('./websocket');
const { register, httpRequestCounter, httpRequestDuration } = require('./metrics');

const app = express();
const PORT = process.env.PORT || 8000;

const server = http.createServer(app);

setupWebSocketServer(server);

// Middleware to track metrics for all requests
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000; // Duration in seconds
    httpRequestCounter.inc({ method: req.method, route: req.path, status: res.statusCode });
    httpRequestDuration.observe({ method: req.method, route: req.path, status: res.statusCode }, duration);
  });
  next();
});

// Expose metrics at /metrics
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
});

app.get('/', (req, res) => {
  res.send('Hello, World!');
});

server.listen(PORT, () => {
  console.log(`HTTP and WebSocket server running on port ${PORT}`);
});
