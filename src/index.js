const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Redis = require('ioredis');
const cluster = require('cluster');
const os = require('os');
const { register, httpRequestCounter, httpRequestDuration } = require('./metrics');
const winston = require('winston'); // for logging
const { promisify } = require('util');

// Configure logging (winston)
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({ format: winston.format.simple() }),
    // Add other transports like File or CloudWatch if necessary
  ]
});

const app = express();
const PORT = process.env.PORT || 8000;
const numCPUs = os.cpus().length;

const server = http.createServer(app);

const redisClient = new Redis({
  host: 'localhost',
  port: 6379,
  retryStrategy: (times) => Math.min(times * 50, 2000), // Retry strategy for Redis connection
});

redisClient.on('connect', () => {
  logger.info('Connected to Redis');
});

redisClient.on('error', (err) => {
  logger.error('Error connecting to Redis:', err);
});

const pub = redisClient.duplicate();  // Publisher connection
const sub = redisClient.duplicate(); // Subscriber connection

const USER_DATA_CHANNEL = 'user_data_channel';

// Cluster logic
if (cluster.isMaster) {
  logger.info(`Master process ${process.pid} is running`);

  // Fork workers (one per CPU core)
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  // Handle worker exits and restart them
  cluster.on('exit', (worker, code, signal) => {
    logger.error(`Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork(); // Fork a new worker
  });

  // Redis Pub/Sub: Subscribe only in the master process to avoid multiple subscriptions
  sub.subscribe(USER_DATA_CHANNEL);
  sub.on('message', (channel, message) => {
    if (channel === USER_DATA_CHANNEL) {
      logger.info('Received message from Redis Pub/Sub:', message);
      // Broadcast message to all worker processes via Redis
      Object.values(cluster.workers).forEach(worker => {
        worker.send({ type: 'BROADCAST', message });
      });
    }
  });

  setInterval(() => {
    const eventData = JSON.stringify({ event: 'dummyEvent', data: Math.random() });
    pub.publish(USER_DATA_CHANNEL, eventData); // Publish dummy data periodically
  }, 1000);
} else {
  const wss = new WebSocket.Server({ server });
  let connectionCount = 0;

  wss.on('connection', (ws) => {
    connectionCount++;
    // logger.info(`New WebSocket connection. Total connections: ${connectionCount}`);

    // Send welcome message
    // ws.send(JSON.stringify({ message: `Welcome to the WebSocket server! Worker PID: ${process.pid}` }));

    // Handle incoming messages from clients
    ws.on('message', (data) => {
      // logger.info(`Received message: ${data}`);
      ws.send(JSON.stringify({ echo: data }));
    });

    ws.on('close', () => {
      connectionCount--;
      // logger.info(`WebSocket connection closed. Total connections: ${connectionCount}`);
    });
  });

  // Listen for messages from the master process (broadcasts)
  process.on('message', (message) => {
    if (message.type === 'BROADCAST') {
      // Broadcast the message to all WebSocket clients in this worker
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message.message);
        }
      });
    }
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down worker gracefully...');
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
    });

    await redisClient.quit();  // Close Redis connection
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

  // Route
  app.get('/', (req, res) => {
    res.send('Hello, World!');
  });

  // Start the server
  server.listen(PORT, () => {
    logger.info(`Worker ${process.pid} is running and handling WebSocket connections on port ${PORT}`);
  });
}
