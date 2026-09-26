'use strict';
const http = require('http');
const express = require('express');
const { shutdown, registerShutdownTargets } = require('../../src/utils/shutdown');

const app = express();
app.get('/ping', (req, res) => res.send('pong'));

const server = http.createServer(app);

registerShutdownTargets({
  server,
  closeSocket: async () => {},
  closeAdapter: async () => {},
  closeRedis: async () => {},
  closeDB: async () => {},
});

server.listen(0, '127.0.0.1', () => {
  if (process.send) process.send('READY');
});

process.on('message', (msg) => {
  if (msg === 'TRIGGER_SHUTDOWN') {
    shutdown('SIGTERM', { exitProcess: true, timeoutMs: 3000 });
  }
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM', { exitProcess: true, timeoutMs: 3000 });
});
