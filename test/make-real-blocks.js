// Makes test/real-blocks.json from a Scala node: [POW_NODE=host:port] node test/make-real-blocks.js [host:port] [height ...]
// (a public node with a restricted RPC does not tell the pow_hash: POW_NODE, a node of your own, computes it with its RPC method calc_pow, i.e. with the node's own code)
// For every height (not divisible by 4: those blocks use another proof of work) it stores the hashing blob (header + tree root + tx count), the seed hash, the
// difficulty and the node's own pow_hash.
const http = require('http');
const path = require('path');
const fs = require('fs');
const utils = require(path.join(__dirname, '..', 'lib', 'utils.js'));
const [host, port] = (process.argv[2] || '127.0.0.1:11812').split(':');
const heights = process.argv.slice(3).map(Number);
const powNode = process.env.POW_NODE ? process.env.POW_NODE.split(':') : null;

function rpc (method, params, target) {
	const [h, pt] = target || [host, port];
	return new Promise((resolve, reject) => {
		const body = JSON.stringify({jsonrpc: '2.0', id: '0', method, params});
		const req = http.request({host: h, port: parseInt(pt), path: '/json_rpc', method: 'POST', headers: {'Content-Length': Buffer.byteLength(body)}}, res => {
			let d = ''; res.on('data', c => d += c); res.on('end', () => { try { const j = JSON.parse(d); j.error ? reject(new Error(JSON.stringify(j.error))) : resolve(j.result); } catch (e) { reject(e); } });
		});
		req.on('error', reject); req.end(body);
	});
}
const varintLen = b => { let i = 0; while (b[i] & 0x80) i++; return i + 1; };
const varint = n => { const o = []; while (n >= 0x80) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
// Monero's tree hash (cn_fast_hash = Keccak-256)
function treeHash (hashes) {
	const h = b => utils.keccak256(b);
	if (hashes.length === 1) return hashes[0];
	if (hashes.length === 2) return h(Buffer.concat(hashes));
	let cnt = 1; while (cnt * 2 < hashes.length) cnt *= 2;      // the largest power of two below the count
	const ints = hashes.slice(0, 2 * cnt - hashes.length);
	const tail = hashes.slice(2 * cnt - hashes.length);
	let row = ints.concat([]);
	for (let i = 0; i < tail.length; i += 2) row.push(h(Buffer.concat([tail[i], tail[i + 1]])));
	while (row.length > 1) { const next = []; for (let i = 0; i < row.length; i += 2) next.push(h(Buffer.concat([row[i], row[i + 1]]))); row = next; }
	return row[0];
}
const seedHeight = h => (h <= 2048 + 64) ? 0 : (h - 64 - 1) & ~(2048 - 1);

(async () => {
	const out = [];
	for (const height of heights) {
		if (height % 4 === 0) { console.log('skip', height, '(Diardi height)'); continue; }
		const hdr = (await rpc('get_block_header_by_height', {height, fill_pow_hash: true})).block_header;
		const blk = await rpc('get_block', {height});
		const blob = Buffer.from(blk.blob, 'hex');
		const info = JSON.parse(blk.json);
		let pos = 0; for (let i = 0; i < 3; i++) pos += varintLen(blob.slice(pos));       // major, minor, timestamp
		pos += 32 + 4;                                                                     // previous id, nonce
		if (hdr.major_version >= 13) pos += 64;                                            // Diardi signature
		const header = blob.slice(0, pos);
		const hashes = [Buffer.from(blk.miner_tx_hash, 'hex')].concat((info.tx_hashes || []).map(x => Buffer.from(x, 'hex')));
		const root = treeHash(hashes);
		const hashing = Buffer.concat([header, root, varint(hashes.length)]);
		const sh = seedHeight(height);
		const seed = (await rpc('get_block_header_by_height', {height: sh})).block_header.hash;
		let pow = hdr.pow_hash;
		if (!pow) {
			if (!powNode) throw new Error('the node does not tell the pow_hash: set POW_NODE');
			pow = await rpc('calc_pow', {major_version: hdr.major_version, height, block_blob: hashing.toString('hex'), seed_hash: seed}, powNode);
		}
		out.push({height, seed_height: sh, seed_hash: seed, difficulty: hdr.difficulty, major_version: hdr.major_version, pow_hash: pow, hashing_blob: hashing.toString('hex')});
		console.log('block', height, 'txs', hashes.length - 1, 'seed', sh, 'pow', pow.slice(0, 16));
	}
	fs.writeFileSync(path.join(__dirname, 'real-blocks.json'), JSON.stringify({node: 'scalad (mainnet)', blocks: out}, null, 1) + '\n');
	console.log('written', out.length, 'blocks');
})().catch(e => { console.error(e); process.exit(1); });
