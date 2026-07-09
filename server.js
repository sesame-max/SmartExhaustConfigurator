const express = require('express');
const http = require('http');
const path = require('path');

const PORT = 3000;

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║     BLE 蓝牙设备扫描器                            ║');
  console.log(`║     地址: http://localhost:${PORT}                   ║`);
  console.log('║     使用 Chrome/Edge 打开                         ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});
