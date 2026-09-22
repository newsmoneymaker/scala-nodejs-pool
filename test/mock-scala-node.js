// Mock of scalad for the pool tests: JSON-RPC 2.0 on /json_rpc with get_last_block_header, get_block_template, submit_block,
// get_block_header_by_height and get_info. A submitted block is verified with the real RandomX helper, so a solution has to be real.
// node mock-scala-node.js <port> <difficulty> [hasherPath]
const http = require('http');
const crypto = require('crypto');
const {spawn} = require('child_process');
const path = require('path');

const PORT = parseInt(process.argv[2] || '25556');
let DIFF = BigInt(process.argv[3] || '1000000');
const HASHER = process.argv[4] || path.join(__dirname, '..', 'hasher', 'rxhash');
const SEED = crypto.createHash('sha256').update('scala-test-seed').digest('hex');     // seed_hash as the node prints it (raw bytes in hex)
const TWO_256 = 1n << 256n;

let height = 100000;                                         // height of the tip
let tip = crypto.randomBytes(32).toString('hex');
const templates = new Map();                                 // header without nonce -> {height, treeRoot}
const blocks = {};
blocks[height] = {hash: tip, miner_tx_hash: crypto.randomBytes(32).toString('hex')};
let accepted = 0, submitted = 0;

const hasher = spawn(HASHER, ['--raw', '--light', '--threads', '1']);
hasher.stdout.setEncoding('utf8');
let hbuf = '', hwait = {}, keyOk = false, keyWaiters = [];
hasher.stdout.on('data', function (d) {
	hbuf += d; let i;
	while ((i = hbuf.indexOf('\n')) !== -1) {
		const parts = hbuf.slice(0, i).split(' '); hbuf = hbuf.slice(i + 1);
		if (parts[0] === 'K') { keyOk = true; keyWaiters.forEach(f => f()); keyWaiters = []; }
		else if (parts[0] === 'H' && hwait[parts[1]]) { hwait[parts[1]](parts[2]); delete hwait[parts[1]]; }
	}
});
hasher.stdin.write('K ' + SEED + '\n');
let hid = 0;
function hashBlob (hex, cb) {
	const start = () => { const id = 'm' + (++hid); hwait[id] = cb; hasher.stdin.write('H ' + id + ' ' + hex + '\n'); };
	keyOk ? start() : keyWaiters.push(start);
}

function varint (n) {
	const out = [];
	while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
	out.push(n);
	return Buffer.from(out);
}

const wide = () => '0x' + DIFF.toString(16);

function makeTemplate () {
	const header = Buffer.concat([Buffer.from([0x11, 0x11]), varint(Math.floor(Date.now() / 1000)), Buffer.from(tip, 'hex'), Buffer.alloc(4)]);
	const treeRoot = crypto.randomBytes(32);
	const tail = crypto.randomBytes(80);
	const noNonce = header.slice(0, header.length - 4).toString('hex');
	templates.set(noNonce, {height: height + 1, treeRoot, headerLength: header.length, diff: DIFF});
	return {
		blocktemplate_blob: Buffer.concat([header, tail]).toString('hex'),
		blockhashing_blob: Buffer.concat([header, treeRoot, Buffer.from([1])]).toString('hex'),
		difficulty: Number(DIFF), difficulty_top64: 0, wide_difficulty: wide(),
		expected_reward: 35000000000, height: height + 1, prev_hash: tip,
		reserved_offset: 120, seed_hash: SEED, seed_height: 0, next_seed_hash: '', status: 'OK', untrusted: false
	};
}

function header (h) {
	const b = blocks[h];
	return {hash: b.hash, height: h, orphan_status: false, miner_tx_hash: b.miner_tx_hash, reward: 35000000000, difficulty: Number(DIFF), wide_difficulty: wide(), timestamp: Math.floor(Date.now() / 1000) - 30, major_version: 17};
}

function handle (method, params, cb) {
	if (method === 'get_last_block_header') return cb(null, {block_header: header(height), status: 'OK'});
	if (method === 'get_info') return cb(null, {height: height + 1, difficulty: Number(DIFF), wide_difficulty: wide(), status: 'OK', synchronized: true, top_block_hash: tip});
	if (method === 'get_block_template') return cb(null, makeTemplate());
	if (method === 'get_block_header_by_height') {
		return blocks[params.height] ? cb(null, {block_header: header(params.height), status: 'OK'}) : cb({code: -2, message: 'Requested block height: ' + params.height + ' greater than current top block height: ' + height});
	}
	if (method === 'submit_block') {
		submitted++;
		const blob = Buffer.from(params[0], 'hex');
		const entry = Array.from(templates.entries()).find(([key]) => params[0].startsWith(key));
		if (!entry) return cb({code: -7, message: 'Block not accepted'});
		const tpl = entry[1];
		const hashing = Buffer.concat([blob.slice(0, tpl.headerLength), tpl.treeRoot, Buffer.from([1])]).toString('hex');
		return hashBlob(hashing, function (hashHex) {
			const value = BigInt('0x' + Buffer.from(hashHex, 'hex').reverse().toString('hex'));
			if (value * tpl.diff >= TWO_256) return cb({code: -7, message: 'Block not accepted'});
			if (tpl.height !== height + 1) return cb({code: -7, message: 'Block not accepted'});
			height = tpl.height;
			tip = crypto.createHash('sha256').update(blob).digest('hex');
			blocks[height] = {hash: tip, miner_tx_hash: crypto.randomBytes(32).toString('hex')};
			accepted++;
			cb(null, {status: 'OK'});
		});
	}
	if (method === 'mock_setdiff') { DIFF = BigInt(params[0]); return cb(null, true); }
	if (method === 'mock_state') return cb(null, {height, tip, accepted, submitted});
	cb({code: -32601, message: 'Method not found'});
}

http.createServer(function (req, res) {
	let body = '';
	req.on('data', d => body += d);
	req.on('end', function () {
		let msg; try { msg = JSON.parse(body); } catch (e) { res.writeHead(400); return res.end(); }
		handle(msg.method, msg.params || {}, function (err, result) {
			res.writeHead(200, {'Content-Type': 'application/json'});
			res.end(JSON.stringify(err ? {jsonrpc: '2.0', id: msg.id, error: err} : {jsonrpc: '2.0', id: msg.id, result}));
		});
	});
}).listen(PORT, '127.0.0.1', () => console.log('mock scalad on', PORT, 'difficulty', DIFF.toString()));
