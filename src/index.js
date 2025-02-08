const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Redis = require('ioredis');
const cluster = require('cluster');
const os = require('os');
const { Server } = require('http');
const winston = require('winston'); // For logging
const { register, httpRequestCounter, httpRequestDuration } = require('./metrics');

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

// Redis client for publisher and subscriber
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

// Duplicate Redis connections for pub and sub
const pub = redisClient.duplicate();  // Publisher connection
const sub = redisClient.duplicate(); // Subscriber connection

const USER_DATA_CHANNEL = 'user_data_channel';

// Cluster logic
if (cluster.isPrimary) {
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

  setInterval(() => {
    const eventData = JSON.stringify({ event: 'dummyEvent', data: Math.random() });
    pub.publish(USER_DATA_CHANNEL, eventData);
  }, 1000);

} else {
  
  const wss = new WebSocket.Server({ server, maxPayload: 1024 * 1024, perMessageDeflate: false });

  let connectionCount = redisClient.get('connectionCount') || 0;

  wss.on('connection', (ws) => {
    connectionCount++;
    // logger.info(`New WebSocket connection. Total connections: ${connectionCount}`);

    // Send a welcome message to the client
    // ws.send(JSON.stringify({ message: `Welcome to WebSocket server! Worker PID: ${process.pid}` }));

    redisClient.set('connectionCount', connectionCount);


    sub.subscribe(USER_DATA_CHANNEL, (err, count) => {
      if (err) {
        logger.error('Error subscribing to Redis channel:', err);
      } else {
        logger.info(`Worker ${process.pid} subscribed to ${count} channel(s)`);
      }
    })

    sub.on('message', (channel, message) => {
      if (channel === USER_DATA_CHANNEL) {
        // logger.info('Received message from Redis Pub/Sub:', message);
        ws.send(message);
      }
    })


    // Handle connection close
    ws.on('close', () => {
      connectionCount--;
      // logger.info(`WebSocket connection closed. Total connections: ${connectionCount}`);
    });
  });

  // Graceful shutdown logic
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

  // HTTP Metrics Middleware (optional)
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = (Date.now() - start) / 1000;
      logger.info(`Request completed in ${duration}s: ${req.method} ${req.path} - ${res.statusCode}`);
    });
    next();
  });

  // Expose /metrics endpoint (optional)
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
