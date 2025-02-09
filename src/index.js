const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Redis = require('ioredis');
const cluster = require('cluster');
const os = require('os');
const winston = require('winston');
const { register, httpRequestCounter, httpRequestDuration } = require('./metrics');

const PORT = process.env.PORT || 8000;
const IS_PUBLISHER = process.env.IS_PUBLISHER === 'true'; // Ensure only one publisher
const numCPUs = os.cpus().length;
const MAX_WORKERS = Math.min(numCPUs, 4);

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console(), new winston.transports.File({ filename: 'app.log', maxsize: 1000000 })],
});

const redisOptions = { host: 'localhost', port: 6379, retryStrategy: (times) => Math.min(times * 50, 2000) };

if (cluster.isPrimary) {
  logger.info(`Master process ${process.pid} running. Forking ${MAX_WORKERS} workers...`);

  for (let i = 0; i < MAX_WORKERS; i++) cluster.fork();

  cluster.on('exit', (worker) => {
    logger.warn(`Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork();
  });

  if (IS_PUBLISHER) {
    logger.info('Starting Redis publisher...');
    const pub = new Redis(redisOptions);

    // List of coins (can be dynamic or fetched from a database/API)
    const coins = ['BTC', 'BNB', 'ETH', 'XRP', 'LTC', 'ADA', 'SOL', 'DOT', 'MATIC', 'DOGE'];

    setInterval(() => {
      // For each coin, generate a unique channel and publish data
      coins.forEach((coin) => {
        const data = JSON.stringify({ event: 'update', coin, data: Math.random() });
        const channel = `coin_${coin}_data_channel`;  // Unique channel per coin
        pub.publish(channel, data);
        logger.info(`Published data to ${channel}: ${data}`);
      });
    }, 1000);  // Adjust the interval as needed
  }
} else {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, maxPayload: 1024 * 1024, perMessageDeflate: false, maxConnections: 10000 });

  const sub = new Redis(redisOptions);
  // const clients = new Set();

  // List of channels (coins in this case)
  const availableChannels = [
    'coin_BTC_data_channel',
    'coin_BNB_data_channel',
    'coin_ETH_data_channel',
    'coin_XRP_data_channel',
    'coin_LTC_data_channel',
    'coin_ADA_data_channel',
    'coin_SOL_data_channel',
    'coin_DOT_data_channel',
    'coin_MATIC_data_channel',
    'coin_DOGE_data_channel'
  ];

  const clients = new Map(); // Store clients by their WebSocket connection

  // A mapping of channels to active Redis subscribers to avoid multiple subscriptions to the same channel
  const activeChannels = new Set();

  // WebSocket connection handler
  wss.on('connection', (ws, req) => {
    ws.isAlive = true;

    // Extract the 'channel' query parameter or pick a random channel if not provided
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const channel = urlParams.get('channel') || availableChannels[Math.floor(Math.random() * availableChannels.length)];

    // Add client to the list of connected clients
    clients.set(ws, { channel });

    // Subscribe to the selected channel if it's not already subscribed to
    if (!activeChannels.has(channel)) {
      sub.subscribe(channel, (err) => {
        if (err) {
          logger.error(`Redis subscription error for channel ${channel}:`, err);
        } else {
          activeChannels.add(channel);
          logger.info(`Client subscribed to channel: ${channel}`);
        }
      });
    }

    // Handle WebSocket events
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('close', () => {
      // Remove the client and unsubscribe from channel if no more clients are subscribed
      const clientChannel = clients.get(ws).channel;
      clients.delete(ws);

      // Unsubscribe from the channel only if no clients are left
      const clientsInChannel = [...clients.values()].filter(c => c.channel === clientChannel).length;
      if (clientsInChannel === 0 && activeChannels.has(clientChannel)) {
        sub.unsubscribe(clientChannel, (err) => {
          if (err) logger.error(`Error unsubscribing from channel ${clientChannel}:`, err);
        });
        activeChannels.delete(clientChannel);
        logger.info(`Unsubscribed from channel: ${clientChannel}`);
      }
    });
  });

  // Redis message handler
  sub.on('message', (channel, message) => {
    // Efficiently broadcast message to only active WebSocket clients subscribed to the channel
    clients.forEach((clientData, client) => {
      if (client.readyState === WebSocket.OPEN && clientData.channel === channel) {
        client.send(message);
      }
    });
  });

  // WebSocket Keep-Alive to handle dead connections
  setInterval(() => {
    clients.forEach((clientData, client) => {
      if (!client.isAlive) {
        client.terminate();
        clients.delete(client);
      } else {
        client.isAlive = false;
        client.ping();
      }
    });
  }, 30000);

  // HTTP request performance monitoring
  app.use((req, res, next) => {
    const start = process.hrtime();
    res.on('finish', () => {
      const duration = process.hrtime(start);
      const elapsed = duration[0] + duration[1] / 1e9;
      httpRequestCounter.inc({ method: req.method, route: req.path, status: res.statusCode });
      httpRequestDuration.observe({ method: req.method, route: req.path, status: res.statusCode }, elapsed);
    });
    next();
  });

  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.send(await register.metrics());
  });

  app.get('/', (req, res) => res.send('WebSocket Server Running'));

  process.on('SIGINT', async () => {
    logger.info('Shutting down worker gracefully...');
    for (const client of clients) client.terminate();
    await sub.quit();
    server.close(() => process.exit(0));
  });

  server.listen(PORT, () => logger.info(`Worker ${process.pid} handling connections on port ${PORT}`));
}
