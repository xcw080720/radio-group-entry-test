/* ================================================================
   极简 WebSocket 服务端（零依赖）
   ----------------------------------------------------------------
   只实现对接 QQ bot 所需的部分：
     · RFC6455 握手
     · 文本帧收发（含分片重组）
     · ping / pong / close
   不支持：二进制帧外发、扩展协商（permessage-deflate）——OneBot 用不到。
   ================================================================ */
const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(clientKey) {
  return crypto.createHash('sha1').update(clientKey + GUID).digest('base64');
}

class WSConn {
  constructor(socket, req) {
    this.socket = socket;
    this.req = req;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragOp = 0;
    this.alive = true;
    this._handlers = {};
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
    socket.setTimeout(0);
    socket.setNoDelay(true);
  }

  on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); return this; }
  _emit(ev, a) { (this._handlers[ev] || []).forEach((f) => { try { f(a); } catch (e) {} }); }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const f = this._readFrame();
      if (!f) break;
      this._handleFrame(f);
    }
  }

  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < off + 2) return null; len = b.readUInt16BE(off); off += 2; }
    else if (len === 127) {
      if (b.length < off + 8) return null;
      const hi = b.readUInt32BE(off), lo = b.readUInt32BE(off + 4);
      len = hi * 4294967296 + lo; off += 8;
    }
    let mask = null;
    if (masked) { if (b.length < off + 4) return null; mask = b.slice(off, off + 4); off += 4; }
    if (b.length < off + len) return null;
    let payload = b.slice(off, off + len);
    if (mask) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    this.buf = b.slice(off + len);
    return { fin, opcode, payload };
  }

  _handleFrame(f) {
    if (f.opcode === 0x8) { this.close(); return; }
    if (f.opcode === 0x9) { this._send(0xA, f.payload); return; }
    if (f.opcode === 0xA) return;
    if (f.opcode === 0x0) { this.frags.push(f.payload); }
    else { this.frags = [f.payload]; this.fragOp = f.opcode; }
    if (!f.fin) return;
    const data = Buffer.concat(this.frags);
    this.frags = [];
    if (this.fragOp === 0x1) this._emit('message', data.toString('utf8'));
    else if (this.fragOp === 0x2) this._emit('binary', data);
  }

  _send(opcode, payload) {
    if (!this.alive || !this.socket.writable) return;
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    head[0] = 0x80 | opcode;
    try { this.socket.write(Buffer.concat([head, payload])); } catch (e) { this.alive = false; }
  }

  send(text) { this._send(0x1, Buffer.from(String(text), 'utf8')); }
  ping() { this._send(0x9, Buffer.alloc(0)); }

  close() {
    if (!this.alive) return;
    this.alive = false;
    try { this._send(0x8, Buffer.alloc(0)); } catch (e) {}
    try { this.socket.end(); } catch (e) {}
    this._emit('close');
  }

  _closed() { if (this.alive) { this.alive = false; this._emit('close'); } }
}

/* 处理 HTTP Upgrade：握手成功后回调 conn */
function handleUpgrade(req, socket, head, onConn) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return false; }
  const res = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + acceptKey(key),
    '', '',
  ].join('\r\n');
  try { socket.write(res); } catch (e) { socket.destroy(); return false; }
  const conn = new WSConn(socket, req);
  if (head && head.length) conn._onData(head);
  onConn(conn);
  return true;
}

module.exports = { WSConn, handleUpgrade, acceptKey };
