const cluster = require('cluster');
const os = require('os');
const Redis = require('ioredis');

if (cluster.isMaster) {
  const intervalId = setInterval(() => {
    const eventData = JSON.stringify({ event: 'dummyEvent', data: Math.random() });
    pub.publish(USER_DATA_CHANNEL, eventData);
  }, 1000);
  
  const numCPUs = os.cpus().length;
  console.log(`Master ${process.pid} is running`);

  // Fork workers
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died`);
    cluster.fork(); // Restart a new worker
  });
} else {
  // Each worker needs to subscribe to Redis channels for scaling
  const redis = new Redis();
  redis.subscribe('user_data_channel', (err, count) => {
    if (err) {
      console.error('Error subscribing to Redis channel:', err);
    } else {
      console.log(`Worker ${process.pid} subscribed to ${count} channel(s)`);
    }
  });

  redis.on('message', (channel, message) => {
    if (channel === 'user_data_channel') {
      console.log(`Worker ${process.pid} received message: ${message}`);
      // Here you could forward the message to WebSocket clients, if needed
    }
  });

  // Worker process code (WebSocket server and HTTP server setup)
  require('./index');
}
