const client = require('prom-client');

// Create a Registry to hold all metrics
const register = new client.Registry();

// Enable default metrics (e.g., memory usage, CPU usage)
client.collectDefaultMetrics({ register });

// Define custom metrics
// Counter: Counts the number of HTTP requests
const httpRequestCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'], // Labels for additional context
});
register.registerMetric(httpRequestCounter);

// Histogram: Tracks request durations
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Histogram of HTTP request durations in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5], // Buckets for response time
});
register.registerMetric(httpRequestDuration);

module.exports = {
  register,
  httpRequestCounter,
  httpRequestDuration,
};
