// Checks the hashing method of the pool (RandomX over the block's hashing blob, key = the seed hash) against real Scala
// mainnet blocks: the hash must equal the `pow_hash` reported by the node and meet the block's difficulty (hash * difficulty < 2^256).
// Needs the helper: make -C hasher RANDOMX=...   Run: node test/test-real-blocks.js
const {spawn} = require('child_process');
const path = require('path');
const data = require('./real-blocks.json');
const helper = spawn(path.join(__dirname, '..', 'hasher', 'rxhash'), ['--raw', '--threads', '1', '--light'], {stdio: ['pipe', 'pipe', 'inherit']});
helper.stdout.setEncoding('utf8');
let buf = '', waiting = null;
helper.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (waiting) { const w = waiting; waiting = null; w(line.split(' ')); } } });
const ask = line => new Promise(res => { waiting = res; helper.stdin.write(line + '\n'); });
(async () => {
	let failed = 0, key = null;
	for (const b of data.blocks) {
		if (b.seed_hash !== key) { key = b.seed_hash; await ask('K ' + key); }
		const r = await ask('H x ' + b.hashing_blob);
		const hash = r[2];
		const value = BigInt('0x' + Buffer.from(hash, 'hex').reverse().toString('hex'));
		const meets = value * BigInt(b.difficulty) < (1n << 256n);
		const ok = hash === b.pow_hash && meets;
		if (!ok) failed++;
		console.log((ok ? 'PASS  ' : 'FAIL  ') + 'block ' + b.height + ' (seed at ' + b.seed_height + ') hash ' + hash.slice(0, 16) + '... equals the node\'s and meets the difficulty');
	}
	helper.stdin.write('Q\n');
	console.log(failed ? '\n' + failed + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
	process.exit(failed ? 1 : 0);
})();
