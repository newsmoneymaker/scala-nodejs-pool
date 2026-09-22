// Integration test: mock scalad + the pool (module pool) + a miner client that really mines (RandomX, Monero style stratum).
// Needs a throwaway redis as in test/config.test.json (it is flushed!). Run: node test/test-scala-pool.js
const {spawn} = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const redis = require(path.join(__dirname, '../node_modules/redis'));
const {makeAddress} = require('./testaddr.js');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.test.json'), 'utf8'));

const ADDRESS = makeAddress(1);
cfg.poolServer.poolAddress = makeAddress(9);
const CONFIG_FILE = path.join(os.tmpdir(), 'scala-test-pool.json');
fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg));
const HARD = '1099511627776', EASY = '300';       // network difficulty 2^40 (no block) / 300 hashes
const HASHER = path.join(__dirname, '..', 'hasher', 'rxhash');
const NONCE_HEX = 78;                             // the nonce sits 39 bytes into the blob (1+1 byte versions, 5 byte timestamp, 32 byte previous id)
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined ? '  ' + extra : '')); if (!ok) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = [];
const cleanup = () => procs.forEach(p => { try { p.kill(); } catch (e) {} });
process.on('exit', cleanup);

function rpc (method, params) {
	return new Promise(resolve => {
		const body = JSON.stringify({jsonrpc: '2.0', method, params: params || [], id: 1});
		const req = http.request({host: '127.0.0.1', port: cfg.node.port, path: '/json_rpc', method: 'POST', headers: {'Content-Length': Buffer.byteLength(body)}}, res => {
			let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d).result));
		});
		req.end(body);
	});
}

// the miner's own hasher
const mh = spawn(HASHER, ['--raw', '--threads', '2', '--light'], {stdio: ['pipe', 'pipe', 'inherit']}); procs.push(mh);
mh.stdout.setEncoding('utf8');
let mbuf = '', mwait = {}, mkey = null, mid = 0;
mh.stdout.on('data', d => { mbuf += d; let i; while ((i = mbuf.indexOf('\n')) !== -1) { const p = mbuf.slice(0, i).split(' '); mbuf = mbuf.slice(i + 1); if (p[0] === 'K' && mkey) mkey(); else if (p[0] === 'H' && mwait[p[1]]) { mwait[p[1]](p[2]); delete mwait[p[1]]; } } });
const setKey = raw => new Promise(res => { mkey = res; mh.stdin.write('K ' + raw + '\n'); });
const hashBlob = hex => new Promise(res => { const id = 'c' + (++mid); mwait[id] = res; mh.stdin.write('H ' + id + ' ' + hex + '\n'); });
// what a miner compares with the job target: the last 8 bytes of the hash as a little endian number
const shareValue = hashHex => Buffer.from(hashHex, 'hex').readBigUInt64LE(24);

function client () {
	const sock = net.connect(cfg.poolServer.ports[0].port, '127.0.0.1');
	sock.setEncoding('utf8');
	let buf = '';
	const waiting = {}; const jobs = [];
	sock.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); if (m.method === 'job') jobs.push(m.params); else if (waiting[m.id]) { waiting[m.id](m); delete waiting[m.id]; } } });
	let n = 0;
	return {
		jobs, sock,
		call: (method, params) => new Promise(res => { const id = ++n; waiting[id] = res; sock.write(JSON.stringify({id, jsonrpc: '2.0', method, params}) + '\n'); }),
		closed: new Promise(res => sock.on('close', res))
	};
}

async function mine (c, job, wantShares) {
	// scan nonces from the given start until enough shares were accepted
	let accepted = 0, tried = 0;
	const start = Buffer.from(job.blob.substr(NONCE_HEX, 8), 'hex').readUInt32LE(0);
	const target = Buffer.from(job.target, 'hex').readBigUInt64LE(0);
	for (let base = 0; accepted < wantShares && tried < 20000; base += 64) {
		const batch = [];
		for (let k = 0; k < 64; k++) {
			const nb = Buffer.alloc(4); nb.writeUInt32LE((start + base + k) >>> 0);
			const blob = job.blob.slice(0, NONCE_HEX) + nb.toString('hex') + job.blob.slice(NONCE_HEX + 8);
			batch.push(hashBlob(blob).then(h => ({nonce: nb.toString('hex'), hash: h})));
		}
		for (const r of await Promise.all(batch)) {
			tried++;
			if (shareValue(r.hash) < target) {
				const reply = await c.call('submit', {id: c.minerId, job_id: job.job_id, nonce: r.nonce, result: r.hash});
				if (reply.result && reply.result.status === 'OK') accepted++;
				else return {accepted, tried, error: reply.error, expired: reply.error && /expired/i.test(reply.error.message)};
				if (accepted >= wantShares) break;
			}
		}
	}
	return {accepted, tried};
}

(async () => {
	const R = redis.createClient(cfg.redis.port, cfg.redis.host, {auth_pass: cfg.redis.auth, db: cfg.redis.db || 0});
	const rcall = (cmd, ...a) => new Promise((res, rej) => R[cmd](...a, (e, v) => e ? rej(e) : res(v)));
	await rcall('flushdb');

	const mock = spawn('node', [path.join(__dirname, 'mock-scala-node.js'), String(cfg.node.port), HARD], {stdio: 'inherit'}); procs.push(mock);
	await sleep(1500);
	const pool = spawn('node', [path.join(__dirname, '..', 'init.js'), '-config=' + CONFIG_FILE, '-module=pool'], {cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe']}); procs.push(pool);
	let poolLog = ''; pool.stdout.on('data', d => poolLog += d); pool.stderr.on('data', d => poolLog += d);
	await sleep(500);

	// 1. logins
	let c = client(); await sleep(300);
	let bad = await c.call('login', {login: 'notanaddress', pass: 'x', agent: 'test'});
	check('invalid address is refused', !!bad.error && /Invalid Scala address/.test(bad.error.message), bad.error && bad.error.message);
	// wait for the pool: template + hasher init (dataset, a few seconds)
	let login;
	for (let i = 0; i < 60; i++) {
		c = client(); await sleep(200);
		login = await c.call('login', {login: ADDRESS + '+rig1', pass: 'x', agent: 'test/1.0'});
		if (login.result) break;
		c.sock.destroy(); await sleep(1000);
	}
	check('login accepted after the pool is ready', !!(login && login.result && login.result.job), login && login.error && login.error.message);
	const job = login.result.job; c.minerId = login.result.id;
	check('job has a 76 byte hashing blob, rx/xla, seed and 64 bit target', job.blob.length === 152 && job.algo === 'rx/xla' && job.seed_hash.length === 64 && job.target.length === 16 && job.height === 100001, JSON.stringify({len: job.blob.length, algo: job.algo, h: job.height}));
	check('extensions announced', login.result.extensions.indexOf('algo') !== -1);
	await setKey(job.seed_hash);

	// 2. bad shares
	const nb = Buffer.alloc(4); nb.writeUInt32LE(12345);
	const blob = job.blob.slice(0, NONCE_HEX) + nb.toString('hex') + job.blob.slice(NONCE_HEX + 8);
	const hash = await hashBlob(blob);
	let r = await c.call('submit', {id: c.minerId, job_id: job.job_id, nonce: nb.toString('hex'), result: '00'.repeat(32)});
	check('wrong hash is rejected', !!r.error && /Bad hash/.test(r.error.message), r.error && r.error.message);
	r = await c.call('submit', {id: c.minerId, job_id: 'nope', nonce: nb.toString('hex'), result: hash});
	check('unknown job is rejected', !!r.error && /expired/i.test(r.error.message), r.error && r.error.message);
	r = await c.call('submit', {id: c.minerId, job_id: job.job_id, nonce: 'zz', result: hash});
	check('malformed nonce is rejected', !!r.error && /Invalid nonce/.test(r.error.message));
	const tv = Buffer.from(job.target, 'hex').readBigUInt64LE(0);
	if (shareValue(hash) >= tv) {
		r = await c.call('submit', {id: c.minerId, job_id: job.job_id, nonce: nb.toString('hex'), result: hash});
		check('a hash above the share target is rejected', !!r.error && /Low difficulty/.test(r.error.message), r.error && r.error.message);
	}

	// 3. real mining: shares first (the network difficulty is out of reach), then a block
	const res = await mine(c, job, 12);
	check('real shares are accepted', res.accepted >= 12, JSON.stringify(res));
	let st = await rpc('mock_state');
	check('no block yet', st.accepted === 0);
	const jobsBefore = c.jobs.length;
	await rpc('mock_setdiff', [EASY]);
	for (let i = 0; i < 60 && c.jobs.length === jobsBefore; i++) await sleep(200);
	check('the pool pushed a job for the new template', c.jobs.length > jobsBefore);
	const job2 = c.jobs[c.jobs.length - 1];
	check('the new job is at the same height', job2 && job2.height === job.height);
	await mine(c, job2, 400);
	st = await rpc('mock_state');
	check('the node received and accepted a block', st.accepted >= 1, JSON.stringify(st));
	await sleep(2500);
	check('the pool sent a job for the next block', c.jobs.some(j => j.height > job.height), c.jobs.length + ' jobs pushed');

	// 4. redis
	const candidates = await rcall('zrange', 'Scala:blocks:candidates', 0, -1, 'WITHSCORES');
	check('block candidate stored', candidates.length >= 2 && candidates[0].split(':')[1] === ADDRESS, candidates[0] && candidates[0].split(':').slice(0, 3).join(':').slice(0, 60));
	// the round scores must be kept under the block's height, and the candidate must carry their total
	const cand = candidates[0].split(':');
	const kept = await rcall('hgetall', 'Scala:scores:prop:round' + candidates[1]);
	check('round scores are kept for the block and the candidate has a positive score total', !!kept && parseFloat(kept[ADDRESS]) > 0 && parseFloat(cand[6]) > 0, 'score field ' + cand[6]);
	check('no stray scores of the current round in an untyped key', (await rcall('exists', 'Scala:scores:roundCurrent')) === 0);
	const workers = await rcall('hgetall', 'Scala:workers:' + ADDRESS);
	check('worker stats recorded', workers && parseInt(workers.hashes) > 0, JSON.stringify(workers));
	const uw = await rcall('hgetall', 'Scala:unique_workers:' + ADDRESS + '~rig1');
	check('worker name recorded', uw && parseInt(uw.hashes) > 0);
	const netData = await rcall('hgetall', 'Scala:network');
	check('network data published', netData && netData.algorithm === 'randomx' && parseInt(netData.height) >= 100001, JSON.stringify(netData));
	check('the pool log shows BLOCK FOUND', /BLOCK FOUND at height 10000\d by \S+ \(worker rig1\)/.test(poolLog));

	// 5. a share that is being checked while the miner's connection dies is still credited (the pool checks shares itself, nothing depends on the socket)
	const c3 = client(); await sleep(200);
	const l3 = await c3.call('login', {login: ADDRESS + '+late', pass: 'x', agent: 'test'});
	const j3 = l3.result.job;
	const t3 = Buffer.from(j3.target, 'hex').readBigUInt64LE(0), st3 = Buffer.from(j3.blob.substr(NONCE_HEX, 8), 'hex').readUInt32LE(0);
	await setKey(j3.seed_hash);
	let found = null;
	for (let k = 0; k < 4000 && !found; k++) {
		const nb = Buffer.alloc(4); nb.writeUInt32LE((st3 + k) >>> 0);
		const h = await hashBlob(j3.blob.slice(0, NONCE_HEX) + nb.toString('hex') + j3.blob.slice(NONCE_HEX + 8));
		if (shareValue(h) < t3) found = {nonce: nb.toString('hex'), hash: h};
	}
	c3.sock.write(JSON.stringify({id: 9, jsonrpc: '2.0', method: 'submit', params: {id: l3.result.id, job_id: j3.job_id, nonce: found.nonce, result: found.hash}}) + '\n');
	c3.sock.destroy();                                  // the connection dies right after the submit, the answer can not be delivered
	await sleep(1500);
	const lateHashes = await rcall('hget', 'Scala:unique_workers:' + ADDRESS + '~late', 'hashes');
	check('a share sent just before the connection died is credited', parseInt(lateHashes || 0) > 0, 'hashes ' + lateHashes);

	cleanup();
	console.log(failed ? '\n' + failed + ' CHECK(S) FAILED\n' + poolLog.slice(-1500) : '\nALL CHECKS PASSED');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); cleanup(); process.exit(2); });
