const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Redis = require('ioredis');
const cluster = require('cluster');
const os = require('os');
const winston = require('winston');
const { register, httpRequestCounter, httpRequestDuration } = require('./metrics');

// Configure logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({ format: winston.format.simple() }),
    new winston.transports.File({ filename: 'app.log', maxsize: 1000000 })
  ]
});

const app = express();
const PORT = process.env.PORT || 8000;
const numCPUs = os.cpus().length;

// Redis client configuration
const redisOptions = {
  host: 'localhost',
  port: 6379,
  retryStrategy: (times) => Math.min(times * 50, 2000),
};

const redisClient = new Redis(redisOptions);
const pub = new Redis(redisOptions);
const sub = new Redis(redisOptions);

const USER_DATA_CHANNEL = 'user_data_channel';

// Cluster setup
if (cluster.isPrimary) {
  logger.info(`Master process ${process.pid} is running`);

  // Fork workers
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  // Restart workers on exit
  cluster.on('exit', (worker, code, signal) => {
    logger.error(`Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork();
  });

  // Publish dummy events
  setInterval(() => {
    const eventData = JSON.stringify({ event: 'dummyEvent', data: Math.random() });
    pub.publish(USER_DATA_CHANNEL, eventData);
  }, 1000);

} else {
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, maxPayload: 1024 * 1024, perMessageDeflate: false });

  // Subscribe to Redis channel
  sub.subscribe(USER_DATA_CHANNEL, (err, count) => {
    if (err) {
      logger.error('Error subscribing to Redis channel:', err);
    } else {
      logger.info(`Worker ${process.pid} subscribed to ${count} channel(s)`);
    }
  });

  // Handle incoming WebSocket connections
  wss.on('connection', (ws) => {
    ws.on('message', (message) => {
      // Handle incoming messages from clients
    });

    ws.on('close', () => {
      // Handle connection closure
    });
  });

  // Broadcast messages received from Redis to WebSocket clients
  sub.on('message', (channel, message) => {
    if (channel === USER_DATA_CHANNEL) {
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    }
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down worker gracefully...');
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
    });

    await redisClient.quit();
    server.close(() => {
      logger.info(`Worker ${process.pid} closed gracefully`);
      process.exit(0);
    });
  });

  // HTTP Metrics Middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = (Date.now() - start) / 1000;
      logger.info(`Request completed in ${duration}s: ${req.method} ${req.path} - ${res.statusCode}`);
      httpRequestCounter.inc({ method: req.method, route: req.path, status: res.statusCode });
      httpRequestDuration.observe({ method: req.method, route: req.path, status: res.statusCode }, duration);
    });
    next();
  });

  // Metrics endpoint
  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.send(await register.metrics());
  });

  // Basic route
  app.get('/', (req, res) => {
    res.send('Hello, WebSocket Server!');
  });

  // Start the server
  server.listen(PORT, () => {
    logger.info(`Worker ${process.pid} is running and handling WebSocket connections on port ${PORT}`);
  });
}
