const WebSocket = require('ws');

function setupWebSocketServer(server) {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    console.log('New WebSocket connection');

    ws.send(JSON.stringify({ message: 'Welcome to the WebSocket server!' }));

    ws.on('message', (data) => {
      console.log('Received:', data);
    
      ws.send(JSON.stringify({ echo: data }));
    });

    const intervalId = setInterval(() => {
      ws.send(JSON.stringify({ event: 'dummyEvent', data: Math.random() }));
    }, 1000);

    ws.on('close', () => {
      console.log('WebSocket connection closed');
      clearInterval(intervalId);
    });
  });

  console.log('WebSocket server setup complete');
}

module.exports = setupWebSocketServer;
