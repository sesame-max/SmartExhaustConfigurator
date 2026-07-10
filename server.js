const express = require('express');
const http = require('http');
const path = require('path');
const dgram = require('dgram');
const os = require('os');

const PORT = 3000;
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

const app = express();
const server = http.createServer(app);

// =========================================================================
// SSDP Device Discovery
// =========================================================================
const discoveredDevices = new Map(); // USN -> device object
const sseClients = [];
let debugLog = [];
const MAX_DEBUG = 200;
const startTime = Date.now();

function addDebug(msg) {
  debugLog.push({ time: new Date().toISOString(), msg });
  if (debugLog.length > MAX_DEBUG) debugLog.shift();
}

function getLocalIPs() {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push({ name, address: net.address, mac: net.mac });
      }
    }
  }
  return ips;
}
console.log('[SSDP] 本机网络接口:', getLocalIPs().map(i => `${i.name}=${i.address}`).join(', '));

// ---- UDP 多播 Socket ----
const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

udpSocket.on('message', (msg, rinfo) => {
  const raw = msg.toString('utf-8').slice(0, 300);
  const firstLine = raw.split(/\r?\n/)[0];
  addDebug(`收到 ${rinfo.address}:${rinfo.port} → ${firstLine}`);

  // 记录所有非 SSDP 消息用于诊断（启动后前 2 分钟）
  if (Date.now() - startTime < 120000) {
    const isSmartExhaust = raw.toLowerCase().includes('smart-exhaust');
    if (!isSmartExhaust) {
      console.log('[SSDP-RAW]', rinfo.address, firstLine);
    }
  }

  const device = parseSSDPMessage(msg, rinfo);
  if (!device) return;

  // ssdp:byebye → 设备下线
  if (device.nts === 'ssdp:byebye') {
    discoveredDevices.delete(device.usn);
    broadcastToClients({ type: 'remove', usn: device.usn });
    console.log('[SSDP] 设备下线:', device.usn?.slice(0, 40));
    return;
  }

  // ssdp:alive 或 M-SEARCH 响应 → 添加/更新
  const key = device.usn || device.location;
  if (key) {
    discoveredDevices.set(key, device);
    broadcastToClients({ type: 'update', device });
    console.log('[SSDP] ✅ 发现智能排风设备:', device.location || device.usn?.slice(0, 50));
    addDebug(`发现设备: ${device.location || device.usn}`);
  }
});

udpSocket.on('error', (err) => {
  console.error('[SSDP] Socket 错误:', err.message);
});

udpSocket.bind(SSDP_PORT, () => {
  // Windows 多网卡环境需要为每个物理接口加入多播组
  const ifaces = getLocalIPs();
  let joinedAny = false;
  for (const iface of ifaces) {
    try {
      udpSocket.addMembership(SSDP_ADDR, iface.address);
      console.log(`[SSDP] 已加入多播组 ${SSDP_ADDR}:${SSDP_PORT} via ${iface.name} (${iface.address})`);
      joinedAny = true;
    } catch (err) {
      console.log(`[SSDP] 接口 ${iface.name} (${iface.address}) 加入多播失败: ${err.message}`);
    }
  }
  if (!joinedAny) {
    // 降级：不指定接口，让 OS 选择
    try {
      udpSocket.addMembership(SSDP_ADDR);
      console.log(`[SSDP] 已加入多播组 ${SSDP_ADDR}:${SSDP_PORT} (默认接口)`);
      joinedAny = true;
    } catch (err) {
      console.error('[SSDP] 加入多播组失败:', err.message);
      console.error('[SSDP] 请以管理员/root 权限运行');
    }
  }
  if (joinedAny) {
    // 启动后立即发送 M-SEARCH 主动探测
    sendMSEARCH();
  }
});

// ---- M-SEARCH 主动探测 ----
function sendMSEARCH() {
  // 标准 UPnP 搜索
  const msg1 = Buffer.from(
    'M-SEARCH * HTTP/1.1\r\n' +
    'HOST: 239.255.255.250:1900\r\n' +
    'MAN: "ssdp:discover"\r\n' +
    'MX: 3\r\n' +
    'ST: upnp:rootdevice\r\n' +
    '\r\n'
  );
  udpSocket.send(msg1, 0, msg1.length, SSDP_PORT, SSDP_ADDR, (err) => {
    if (err) console.error('[SSDP] M-SEARCH (upnp) 发送失败:', err.message);
  });

  // 全量搜索（捕获自定义设备）
  const msg2 = Buffer.from(
    'M-SEARCH * HTTP/1.1\r\n' +
    'HOST: 239.255.255.250:1900\r\n' +
    'MAN: "ssdp:discover"\r\n' +
    'MX: 3\r\n' +
    'ST: ssdp:all\r\n' +
    '\r\n'
  );
  udpSocket.send(msg2, 0, msg2.length, SSDP_PORT, SSDP_ADDR, (err) => {
    if (err) console.error('[SSDP] M-SEARCH (all) 发送失败:', err.message);
    else console.log('[SSDP] 已发送 M-SEARCH 探测 (upnp:rootdevice + ssdp:all)');
  });
}

// 每 30 秒主动探测一次
setInterval(sendMSEARCH, 30000);

// 每 5 秒检查超时（15 秒没收包视为离线）
setInterval(() => {
  const now = Date.now();
  const OFFLINE_TIMEOUT = 15000; // 15 秒
  for (const [key, dev] of discoveredDevices) {
    if (now - dev.lastSeen > OFFLINE_TIMEOUT) {
      discoveredDevices.delete(key);
      broadcastToClients({ type: 'remove', usn: key });
      console.log('[SSDP] 设备离线 (15s 超时):', dev.usn?.slice(0, 50));
    }
  }
}, 5000);

// ---- SSDP 消息解析 ----
function parseSSDPMessage(msg, rinfo) {
  const str = msg.toString('utf-8');
  const isNotify = str.startsWith('NOTIFY');
  const isResponse = str.startsWith('HTTP/1.1');
  if (!isNotify && !isResponse) return null;

  const lines = str.split(/\r?\n/);
  const headers = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      headers[key] = val;
    }
  }

  // 只关注智能排风设备
  if (headers['smart-exhaust'] !== 'true') return null;

  return {
    usn: headers.usn || '',
    location: headers.location || '',
    nt: headers.nt || '',
    nts: headers.nts || '',
    server: headers.server || '',
    cacheControl: headers['cache-control'] || '',
    'smart-exhaust': true,
    'printer-bound': headers['printer-bound'] || 'no',
    'printer-name': headers['printer-name'] || '',
    'printer-serial': headers['printer-serial'] || '',
    from: `${rinfo.address}:${rinfo.port}`,
    lastSeen: Date.now(),
  };
}

// ---- SSE 广播 ----
function broadcastToClients(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(msg);
  }
}

// =========================================================================
// Express 路由
// =========================================================================

// SSE 端点 — 浏览器实时接收设备发现事件
app.get('/api/devices/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // 立即推送已有设备
  for (const dev of discoveredDevices.values()) {
    res.write(`data: ${JSON.stringify({ type: 'update', device: dev })}\n\n`);
  }

  // 心跳保持连接
  const keepAlive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 15000);

  sseClients.push(res);
  console.log('[SSE] 客户端已连接, 当前在线:', sseClients.length);

  req.on('close', () => {
    clearInterval(keepAlive);
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
    console.log('[SSE] 客户端断开, 当前在线:', sseClients.length);
  });
});

// 手动触发 M-SEARCH 的端点（前端可调用）
app.post('/api/devices/scan', (_req, res) => {
  sendMSEARCH();
  res.json({ ok: true });
});

// 诊断端点
app.get('/api/devices/debug', (_req, res) => {
  res.json({
    uptime: Math.floor((Date.now() - startTime) / 1000) + 's',
    deviceCount: discoveredDevices.size,
    sseClients: sseClients.length,
    localIPs: getLocalIPs(),
    devices: [...discoveredDevices.values()].map(d => ({
      usn: d.usn,
      location: d.location,
      lastSeen: d.lastSeen ? new Date(d.lastSeen).toISOString() : null,
      bound: d['printer-bound'],
      printer: d['printer-name'],
    })),
    recentLog: debugLog.slice(-50),
  });
});

// ---- 静态文件 ----
app.use(express.static(path.join(__dirname, 'public')));

// =========================================================================
// 启动
// =========================================================================
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║     智能排风配置工具                               ║');
  console.log('║     SSDP 设备发现 + BLE WiFi 配网                 ║');
  console.log(`║     地址: http://localhost:${PORT}                   ║`);
  console.log('║     使用 Chrome/Edge 打开                         ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});
