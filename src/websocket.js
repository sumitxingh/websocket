const WebSocket = require('ws');

let connectionCount = 0;

function setupWebSocketServer(server) {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    connectionCount++;
    console.log('New WebSocket connection. Total connections:', connectionCount);

    ws.send(JSON.stringify({ message: 'Welcome to the WebSocket server!' }));

    ws.on('message', (data) => {
      console.log('Received:', data);
    
      ws.send(JSON.stringify({ echo: data }));
    });

    const intervalId = setInterval(() => {
      ws.send(JSON.stringify({ event: 'dummyEvent', data: Math.random() }));
    }, 1000);

    ws.on('close', () => {
      connectionCount--;
      console.log('WebSocket connection closed. Total connections:', connectionCount);
      clearInterval(intervalId);
    });
  });

  console.log('WebSocket server setup complete');
}

module.exports = setupWebSocketServer;
