// wsclient.mjs — 零依赖 WebSocket 客户端（node:tls 手写握手 + 帧编解码）
// 为什么不用内置 WebSocket：WHATWG 的 WebSocket 不能自定义 Cookie / Origin 头，
// 而这两个很可能就是握手能否成功的关键（方案的 U2/U3）。
import tls from 'node:tls';
import crypto from 'node:crypto';

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + text
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function tryDecode(buf) {
  const frames = [];
  let offset = 0;
  while (buf.length - offset >= 2) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = offset + 2;
    if (len === 126) {
      if (buf.length < p + 2) break;
      len = buf.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (buf.length < p + 8) break;
      len = Number(buf.readBigUInt64BE(p)); p += 8;
    }
    let mask = null;
    if (masked) {
      if (buf.length < p + 4) break;
      mask = buf.subarray(p, p + 4); p += 4;
    }
    if (buf.length < p + len) break;
    const data = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    frames.push({ opcode, data });
    offset = p + len;
  }
  return { frames, rest: buf.subarray(offset) };
}

/**
 * @param {object} opts
 * @param {string} opts.url     wss://... 完整地址（含 query）
 * @param {object} opts.headers 额外头，例如 Cookie / Origin / User-Agent
 * @param {number} opts.timeoutMs 握手超时
 */
export function connectWs(opts) {
  const u = new URL(opts.url);
  if (u.protocol !== 'wss:') throw new Error('只支持 wss://');
  const host = u.hostname;
  const port = u.port ? Number(u.port) : 443;
  const pathWithQuery = u.pathname + u.search;
  const key = crypto.randomBytes(16).toString('base64');
  const expectedAccept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  return new Promise((resolve, reject) => {
    const listeners = { message: [], close: [], error: [] };
    const socket = tls.connect({ host, port, servername: host }, () => {
      const lines = [
        'GET ' + pathWithQuery + ' HTTP/1.1',
        'Host: ' + host,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + key,
        'Sec-WebSocket-Version: 13'
      ];
      for (const [k, v] of Object.entries(opts.headers || {})) {
        if (v != null && v !== '') lines.push(k + ': ' + v);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });

    let handshakeBuf = Buffer.alloc(0);
    let upgraded = false;
    let frameBuf = Buffer.alloc(0);

    const timer = setTimeout(() => {
      try { socket.destroy(); } catch { /* ignore */ }
      reject(new Error('握手超时 ' + (opts.timeoutMs || 15000) + 'ms'));
    }, opts.timeoutMs || 15000);

    socket.on('data', (chunk) => {
      if (!upgraded) {
        handshakeBuf = Buffer.concat([handshakeBuf, chunk]);
        const idx = handshakeBuf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = handshakeBuf.subarray(0, idx).toString('utf8');
        frameBuf = handshakeBuf.subarray(idx + 4);
        const status = head.split('\r\n')[0];
        if (!/ 101 /.test(status)) {
          clearTimeout(timer);
          try { socket.destroy(); } catch { /* ignore */ }
          reject(new Error('握手被拒: ' + status + '\n' + head.slice(0, 400)));
          return;
        }
        const m = /sec-websocket-accept:\s*(\S+)/i.exec(head);
        if (m && m[1] !== expectedAccept) {
          clearTimeout(timer);
          try { socket.destroy(); } catch { /* ignore */ }
          reject(new Error('Sec-WebSocket-Accept 不匹配'));
          return;
        }
        upgraded = true;
        clearTimeout(timer);
        resolve({
          socket,
          status,
          rawHead: head,
          send(obj) {
            socket.write(encodeFrame(typeof obj === 'string' ? obj : JSON.stringify(obj)));
          },
          on(ev, fn) { (listeners[ev] || []).push(fn); },
          close() { try { socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0])); } catch { /* ignore */ } try { socket.destroy(); } catch { /* ignore */ } }
        });
        return;
      }

      frameBuf = Buffer.concat([frameBuf, chunk]);
      const { frames, rest } = tryDecode(frameBuf);
      frameBuf = rest;
      for (const f of frames) {
        if (f.opcode === 8) { for (const fn of listeners.close) fn('close-frame'); try { socket.destroy(); } catch { /* ignore */ } return; }
        if (f.opcode === 9) { continue; } // ping 忽略（真实客户端会回 pong）
        if (f.opcode !== 1) continue;
        for (const fn of listeners.message) {
          try { fn(f.data.toString('utf8')); } catch { /* ignore */ }
        }
      }
    });

    socket.on('error', (e) => {
      clearTimeout(timer);
      if (!upgraded) reject(e);
      else for (const fn of listeners.error) fn(e);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!upgraded) reject(new Error('连接在握手前关闭'));
      else for (const fn of listeners.close) fn('socket-close');
    });
  });
}
