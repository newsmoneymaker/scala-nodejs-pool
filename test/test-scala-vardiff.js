// Variable difficulty and its memory across reconnects: a worker that reconnects every half minute must not start from the start difficulty
// again and again. Needs the throwaway redis of test/config.test.json (flushed!). Run: node test/test-scala-vardiff.js
const {spawn} = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const redis = require(path.join(__dirname, '../node_modules/redis'));
const {makeAddress} = require('./testaddr.js');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.test.json'), 'utf8'));

const ADDRESS = makeAddress(21);
cfg.poolServer.poolAddress = makeAddress(9);
cfg.poolServer.varDiff = {startDiff: 4, minDiff: 1, maxDiff: 100000, targetTime: 20, retargetTime: 2, variancePercent: 30, maxJump: 100};
cfg.poolServer.banning = {enabled: false};
const CONFIG_FILE = path.join(os.tmpdir(), 'scala-test-vardiff.json');
fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg));
const HASHER = path.join(__dirname, '..', 'hasher', 'rxhash');
const NONCE_HEX = 78;
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined ? '  ' + extra : '')); if (!ok) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = [];
const cleanup = () => procs.forEach(p => { try { p.kill(); } catch (e) {} });
process.on('exit', cleanup);

const mh = spawn(HASHER, ['--raw', '--threads', '2', '--light'], {stdio: ['pipe', 'pipe', 'inherit']}); procs.push(mh);
mh.stdout.setEncoding('utf8');
let mbuf = '', mwait = {}, mkey = null, mid = 0;
mh.stdout.on('data', d => { mbuf += d; let i; while ((i = mbuf.indexOf('\n')) !== -1) { const p = mbuf.slice(0, i).split(' '); mbuf = mbuf.slice(i + 1); if (p[0] === 'K' && mkey) mkey(); else if (p[0] === 'H' && mwait[p[1]]) { mwait[p[1]](p[2]); delete mwait[p[1]]; } } });
const setKey = raw => new Promise(res => { mkey = res; mh.stdin.write('K ' + raw + '\n'); });
const hashBlob = hex => new Promise(res => { const id = 'c' + (++mid); mwait[id] = res; mh.stdin.write('H ' + id + ' ' + hex + '\n'); });
const shareValue = h => Buffer.from(h, 'hex').readBigUInt64LE(24);
const diffOf = job => Number(18446744073709551616n / Buffer.from(job.target, 'hex').readBigUInt64LE(0));

function client () {
	const sock = net.connect(cfg.poolServer.ports[0].port, '127.0.0.1');
	sock.setEncoding('utf8');
	let buf = '';
	const waiting = {}; const jobs = [];
	sock.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); if (m.method === 'job') jobs.push(m.params); else if (waiting[m.id]) { waiting[m.id](m); delete waiting[m.id]; } } });
	let n = 0;
	return {jobs, sock, call: (method, params) => new Promise(res => { const id = ++n; waiting[id] = res; sock.write(JSON.stringify({id, jsonrpc: '2.0', method, params}) + '\n'); })};
}

async function login (worker) {
	for (let i = 0; i < 60; i++) {
		const c = client(); await sleep(200);
		const l = await c.call('login', {login: ADDRESS + '+' + worker, pass: 'x', agent: 'test'});
		if (l.result) { c.minerId = l.result.id; return {c, job: l.result.job}; }
		c.sock.destroy(); await sleep(1000);
	}
	throw new Error('no login');
}

// submit shares for `ms` milliseconds
async function mineFor (c, job, ms) {
	const target = Buffer.from(job.target, 'hex').readBigUInt64LE(0);
	let n = 0, accepted = 0;
	const t0 = Date.now();
	let start = Buffer.from(job.blob.substr(NONCE_HEX, 8), 'hex').readUInt32LE(0);
	while (Date.now() - t0 < ms) {
		const batch = [];
		for (let k = 0; k < 32; k++) {
			const nb = Buffer.alloc(4); nb.writeUInt32LE((start + n++) >>> 0);
			batch.push(hashBlob(job.blob.slice(0, NONCE_HEX) + nb.toString('hex') + job.blob.slice(NONCE_HEX + 8)).then(h => ({nonce: nb.toString('hex'), hash: h})));
		}
		for (const r of await Promise.all(batch)) {
			if (shareValue(r.hash) < target) {
				const reply = await c.call('submit', {id: c.minerId, job_id: job.job_id, nonce: r.nonce, result: r.hash});
				if (reply.result) accepted++;
			}
		}
	}
	return accepted;
}

(async () => {
	const R = redis.createClient(cfg.redis.port, cfg.redis.host, {auth_pass: cfg.redis.auth, db: cfg.redis.db || 0});
	await new Promise(res => R.flushdb(res));
	const mock = spawn('node', [path.join(__dirname, 'mock-scala-node.js'), String(cfg.node.port), '1099511627776'], {stdio: 'inherit'}); procs.push(mock);
	await sleep(1500);
	const pool = spawn('node', [path.join(__dirname, '..', 'init.js'), '-config=' + CONFIG_FILE, '-module=pool'], {cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe']}); procs.push(pool);
	let poolLog = ''; pool.stdout.on('data', d => poolLog += d); pool.stderr.on('data', d => poolLog += d);
	await sleep(500);

	let {c, job} = await login('memo');
	await setKey(job.seed_hash);
	check('a new worker starts at the start difficulty', diffOf(job) === 4, 'difficulty ' + diffOf(job));
	// a fast miner: many shares, then the variable difficulty raises the difficulty
	let accepted = await mineFor(c, job, 2500);
	accepted += await mineFor(c, job, 3000);
	const raised = c.jobs.length ? diffOf(c.jobs[c.jobs.length - 1]) : 4;
	check('the difficulty was raised on the first connection', raised > 4, 'shares ' + accepted + ', pushed difficulty ' + raised + ', jobs pushed ' + c.jobs.length);

	// the connection is renewed (a short-lived connection): the worker comes back
	c.sock.destroy(); await sleep(500);
	const again = await login('memo');
	check('the same worker keeps its raised difficulty after a reconnect', diffOf(again.job) >= raised, 'difficulty ' + diffOf(again.job) + ' (raised ' + raised + ')');
	again.c.sock.destroy(); await sleep(300);
	const other = await login('other');
	check('another worker starts at the start difficulty', diffOf(other.job) === 4, 'difficulty ' + diffOf(other.job));
	other.c.sock.destroy();

	cleanup();
	console.log(failed ? '\n' + failed + ' CHECK(S) FAILED\n' + poolLog.slice(-1500) : '\nALL CHECKS PASSED');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); cleanup(); process.exit(2); });
