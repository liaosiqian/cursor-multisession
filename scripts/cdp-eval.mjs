#!/usr/bin/env node
/**
 * 隔离 Cursor 窗口的 CDP 驱动工具(不依赖物理屏幕、鼠标键盘、解锁状态)。
 *
 * 场景:用 --remote-debugging-port 启动的隔离窗口,需要读界面状态或注入输入做 GUI 验收。
 * 屏幕锁定时 CUA 不可用,CDP 仍可工作,是锁屏环境下唯一的 GUI 驱动方式。
 * 纯 Node 实现(自带最小 WebSocket 客户端),不新增依赖。
 *
 * 用法:
 *   node scripts/cdp-eval.mjs list [--port 9333]
 *   node scripts/cdp-eval.mjs eval '<js>' [--target page|iframe:N] [--port 9333]
 *   node scripts/cdp-eval.mjs ax [关键词] [--target page]
 *   node scripts/cdp-eval.mjs insert '<text>' [--target page]
 *   node scripts/cdp-eval.mjs enter [--target page]
 *   node scripts/cdp-eval.mjs shot <path.png> [--target page]
 *   node scripts/cdp-eval.mjs raw <Cdp.Method> ['<json 参数>'] [--target node] [--port 9401]
 *     —— 直接发任意 CDP 方法,调试扩展宿主时用(例:raw HeapProfiler.collectGarbage --target node)
 */
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';

const CR = String.fromCharCode(13);

function httpJson(port, urlPath) {
	return new Promise((resolve, reject) => {
		const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 5000 }, (res) => {
			let body = '';
			res.setEncoding('utf-8');
			res.on('data', (chunk) => { body += chunk; });
			res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
		});
		req.on('error', reject);
		req.on('timeout', () => req.destroy(new Error('查询 CDP 端口超时')));
	});
}

function encodeFrame(text) {
	const payload = Buffer.from(text, 'utf-8');
	const mask = crypto.randomBytes(4);
	let header;
	if (payload.length < 126) {
		header = Buffer.from([0x81, 0x80 | payload.length]);
	} else if (payload.length < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x81;
		header[1] = 0x80 | 126;
		header.writeUInt16BE(payload.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x81;
		header[1] = 0x80 | 127;
		header.writeBigUInt64BE(BigInt(payload.length), 2);
	}
	const masked = Buffer.alloc(payload.length);
	for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
	return Buffer.concat([header, mask, masked]);
}

/** 从缓冲区取一帧,数据不足返回 null */
function decodeFrame(buffer) {
	if (buffer.length < 2) return null;
	const opcode = buffer[0] & 0x0f;
	const masked = (buffer[1] & 0x80) !== 0;
	let length = buffer[1] & 0x7f;
	let offset = 2;
	if (length === 126) {
		if (buffer.length < 4) return null;
		length = buffer.readUInt16BE(2);
		offset = 4;
	} else if (length === 127) {
		if (buffer.length < 10) return null;
		length = Number(buffer.readBigUInt64BE(2));
		offset = 10;
	}
	let mask = null;
	if (masked) {
		if (buffer.length < offset + 4) return null;
		mask = buffer.subarray(offset, offset + 4);
		offset += 4;
	}
	if (buffer.length < offset + length) return null;
	const payload = Buffer.from(buffer.subarray(offset, offset + length));
	if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
	return { opcode, payload, rest: buffer.subarray(offset + length) };
}

class Cdp {
	constructor(socketUrl) {
		this.pending = new Map();
		this.outbox = [];
		this.seq = 0;
		this.buffer = Buffer.alloc(0);
		this.handshakeDone = false;
		this.closed = false;
		const parsed = new URL(socketUrl);
		this.socket = net.connect({ host: parsed.hostname, port: Number(parsed.port) });
		this.socket.on('connect', () => {
			const key = crypto.randomBytes(16).toString('base64');
			this.socket.write(
				'GET ' + parsed.pathname + ' HTTP/1.1' + CR + '\n' +
				'Host: ' + parsed.host + CR + '\n' +
				'Upgrade: websocket' + CR + '\n' +
				'Connection: Upgrade' + CR + '\n' +
				'Sec-WebSocket-Key: ' + key + CR + '\n' +
				'Sec-WebSocket-Version: 13' + CR + '\n' + CR + '\n'
			);
		});
		this.socket.on('data', (chunk) => this.onData(chunk));
		this.socket.on('error', (error) => this.failAll(error));
		this.socket.on('close', () => this.failAll(new Error('CDP 连接已关闭')));
	}

	onData(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		if (!this.handshakeDone) {
			const end = this.buffer.indexOf('\r\n\r\n');
			if (end < 0) return;
			const head = this.buffer.subarray(0, end).toString('utf-8');
			if (!/ 101 /.test(head)) { this.failAll(new Error('WebSocket 握手失败: ' + head.split('\n')[0])); return; }
			this.buffer = this.buffer.subarray(end + 4);
			this.handshakeDone = true;
			for (const frame of this.outbox) this.socket.write(frame);
			this.outbox = [];
		}
		for (;;) {
			const frame = decodeFrame(this.buffer);
			if (!frame) return;
			this.buffer = frame.rest;
			if (frame.opcode === 8) { this.failAll(new Error('对端关闭连接')); return; }
			if (frame.opcode === 9) { this.socket.write(Buffer.concat([Buffer.from([0x8a, 0x80]), crypto.randomBytes(4)])); continue; }
			if (frame.opcode !== 1) continue;
			let message;
			try { message = JSON.parse(frame.payload.toString('utf-8')); } catch { continue; }
			if (message.id !== undefined && this.pending.has(message.id)) {
				this.pending.get(message.id)(message);
				this.pending.delete(message.id);
			}
		}
	}

	failAll(error) {
		if (this.closed) return;
		this.closed = true;
		for (const settle of this.pending.values()) settle({ error });
		this.pending.clear();
	}

	call(method, params, timeoutMs) {
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error('CDP 调用超时: ' + method));
			}, timeoutMs || 60000);
			this.pending.set(id, (message) => {
				clearTimeout(timer);
				if (message.error) reject(new Error(message.error.message));
				else resolve(message.result);
			});
			// 握手完成前先排队,否则帧会排到 HTTP 握手请求前面,被对端重置连接
			const frame = encodeFrame(JSON.stringify({ id, method, params: params || {} }));
			if (this.handshakeDone) this.socket.write(frame);
			else this.outbox.push(frame);
		});
	}

	close() { this.closed = true; try { this.socket.end(); } catch { /* ignore */ } }
}

async function main() {
	const argv = process.argv.slice(2);
	let port = 9333;
	let targetSpec = 'page';
	let inFrame = false;
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--port') { port = Number(argv[++i]); continue; }
		if (argv[i] === '--target') { targetSpec = argv[++i]; continue; }
		if (argv[i] === '--frame') { inFrame = true; continue; }
		rest.push(argv[i]);
	}
	// VS Code webview 的真实内容在 host 页的 #active-frame 内联 iframe 里;
	// --frame 把用户脚本的 document/window 换成内层文档,直接操作扩展的 DOM。
	const wrapFrame = (code) => "(function(document, window) { return eval(" + JSON.stringify(code) + "); })" +
		"(document.getElementById('active-frame').contentDocument," +
		" document.getElementById('active-frame').contentDocument.defaultView)";
	const command = rest[0] || 'list';
	const targets = await httpJson(port, '/json/list');
	if (command === 'list') {
		for (const t of targets) console.log(t.type + ' | ' + (t.title || '').slice(0, 40) + ' | ' + (t.url || '').slice(0, 70));
		return;
	}
	const parts = targetSpec.split(':');
	const index = parts[1] ? Number(parts[1]) : 0;
	const matched = targets.filter((t) => t.type === parts[0]);
	if (matched.length === 0) throw new Error('没有 ' + parts[0] + ' 类型的 target');
	const target = matched[Math.min(index, matched.length - 1)];
	const cdp = new Cdp(target.webSocketDebuggerUrl);
	try {
		if (command === 'eval') {
			const result = await cdp.call('Runtime.evaluate', {
				expression: inFrame ? wrapFrame(rest[1]) : rest[1],
				returnByValue: true,
				awaitPromise: true,
			});
			console.log(JSON.stringify(result, null, 1).slice(0, 6000));
		} else if (command === 'ax') {
			const tree = await cdp.call('Accessibility.getFullAXTree', {}, 120000);
			const keyword = rest[1] ? rest[1].toLowerCase() : null;
			const rows = [];
			for (const node of tree.nodes || []) {
				if (node.ignored) continue;
				const role = (node.role || {}).value || '';
				const name = ((node.name || {}).value || '').trim();
				if (!name) continue;
				if (keyword && (name + ' ' + role).toLowerCase().indexOf(keyword) < 0) continue;
				rows.push(role + ': ' + name.slice(0, 90));
			}
			console.log(rows.length + ' 个可见节点');
			for (const row of rows.slice(0, 80)) console.log(row);
		} else if (command === 'insert') {
			await cdp.call('Input.insertText', { text: rest[1] });
			console.log('inserted');
		} else if (command === 'enter') {
			await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
			await cdp.call('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: CR, unmodifiedText: CR, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
			await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
			console.log('sent Enter');
		} else if (command === 'shot') {
			const shot = await cdp.call('Page.captureScreenshot', { format: 'png' }, 120000);
			fs.writeFileSync(rest[1] || '/tmp/cdp-shot.png', Buffer.from(shot.data, 'base64'));
			console.log('saved ' + (rest[1] || '/tmp/cdp-shot.png'));
		} else if (command === 'raw') {
			// 直接发任意 CDP 方法,例如给扩展宿主发 HeapProfiler.collectGarbage 看真实常驻内存
			const out = await cdp.call(rest[1], rest[2] ? JSON.parse(rest[2]) : {}, 120000);
			console.log(JSON.stringify(out).slice(0, 4000));
		} else {
			throw new Error('未知命令: ' + command);
		}
	} finally {
		cdp.close();
	}
}

main().catch((error) => {
	console.error('失败: ' + (error && error.message ? error.message : error));
	process.exit(1);
});
