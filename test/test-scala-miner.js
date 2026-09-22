// End to end with a REAL miner: mock scalad (verifies submitted blocks with the real helper, i.e. the node's own Panthera library)
// + the pool + a real poolpayminer (algorithm rx/xla). Every share the miner sends is checked by the pool with the helper: a single
// disagreement between the miner's Panthera hash and the node's library shows as a rejected share.
// MINER_BIN=/path/to/poolpayminer [NO_PAUSE=1] node test/test-scala-miner.js   (NO_PAUSE=1: the miner keeps hashing at the Diardi height and the pool refuses its solution; needs the throwaway redis of config.test.json, it is flushed)
const {spawn} = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const redis = require(path.join(__dirname, '../node_modules/redis'));
const {makeAddress} = require('./testaddr.js');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.test.json'), 'utf8'));
const MINER = process.env.MINER_BIN;
if (!MINER) { console.log('set MINER_BIN'); process.exit(2); }

const ADDRESS = makeAddress(1);
cfg.poolServer.poolAddress = makeAddress(9);
const CONFIG_FILE = path.join(os.tmpdir(), 'scala-test-miner-pool.json');
fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg));
const NETDIFF = '400';                       // hashes per block: the miner finds some at once

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
			let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d).result); } catch (e) { resolve(null); } });
		});
		req.on('error', () => resolve(null));
		req.end(body);
	});
}

(async () => {
	const R = redis.createClient(cfg.redis.port, cfg.redis.host, {auth_pass: cfg.redis.auth, db: cfg.redis.db || 0});
	await new Promise(res => R.flushdb(res));

	const mock = spawn('node', [path.join(__dirname, 'mock-scala-node.js'), String(cfg.node.port), NETDIFF], {stdio: 'inherit'}); procs.push(mock);
	await sleep(1500);
	const pool = spawn('node', [path.join(__dirname, '..', 'init.js'), '-config=' + CONFIG_FILE, '-module=pool'], {cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe']}); procs.push(pool);
	let poolLog = ''; pool.stdout.on('data', d => poolLog += d); pool.stderr.on('data', d => poolLog += d);
	await sleep(3000);

	const miner = spawn(MINER, ['-a', 'rx/xla', '-o', '127.0.0.1:' + cfg.poolServer.ports[0].port, '-u', ADDRESS + '+realminer', '-p', 'x', '-t', '2', '--no-color', '--randomx-no-numa'].concat(process.env.NO_PAUSE ? ['--no-diardi-pause'] : []), {stdio: ['ignore', 'pipe', 'pipe']}); procs.push(miner);
	let minerLog = ''; miner.stdout.on('data', d => minerLog += d); miner.stderr.on('data', d => minerLog += d);

	let scoreLines = 0, rejected = 0;
	for (let i = 0; i < 100; i++) {
		await sleep(1000);
		const plain = poolLog.replace(/\x1b\[[0-9;]*m/g, '');
		scoreLines = (plain.match(/Submitted score/g) || []).length;
		rejected = (plain.match(/Rejected share[^\n]*(Bad hash|Low difficulty)/g) || []).length;    // "Job expired" after a new block is normal
		if (scoreLines >= 8) break;
	}
	const plain = poolLog.replace(/\x1b\[[0-9;]*m/g, '');
	const mlog = minerLog.replace(/\x1b\[[0-9;]*m/g, '');
	check('the real miner (rx/xla) found shares that the pool accepted', scoreLines >= 8, scoreLines + ' shares');
	check('not a single share was rejected (the miner\'s hash equals the node library\'s hash)', rejected === 0, rejected + ' rejected; ' + (plain.match(/Rejected share[^\n]*/) || [''])[0]);
	check('the miner reports accepted shares (rejections only as stale jobs after a block)', /accepted \(\d+\/\d+\)/.test(mlog) && !/Bad hash|Low difficulty/.test(mlog), (mlog.match(/accepted[^\n]*/g) || []).slice(-1)[0]);
	// height 100004 is divisible by 4: a Diardi height, a solution there is never submitted
	await sleep(15000);
	const plain2 = poolLog.replace(/\x1b\[[0-9;]*m/g, '');
	const st2 = await rpc('mock_state');
	check('blocks found by the miner were accepted by the mock node (verified with the library)', st2 && st2.accepted >= 1, JSON.stringify(st2));
	check('the chain stopped before the Diardi height 100004 (nobody outside the list can mine it)', st2 && st2.height === 100003, JSON.stringify(st2));
	if (process.env.NO_PAUSE) check('at the Diardi height 100004 a solution is refused by the pool (not submitted to the node)', /Solution at Diardi height 100004/.test(plain2), JSON.stringify(st2));
	if (!process.env.NO_PAUSE && st2 && st2.height === 100003) {
		// the pool marked the Diardi job and poolpayminer rests: it says why, and no more shares arrive
		const n1 = (plain2.match(/Submitted score/g) || []).length;
		await sleep(10000);
		const n2 = (poolLog.replace(/\x1b\[[0-9;]*m/g, '').match(/Submitted score/g) || []).length;
		const mlog2 = minerLog.replace(/\x1b\[[0-9;]*m/g, '');
		check('the miner explains that it rests at the Diardi height', /Scala: resting while block 100004 is found/.test(mlog2), (mlog2.match(/Scala: resting[^\n]*/) || [''])[0].slice(0, 90));
		check('while it rests no shares arrive', n2 - n1 <= 1, n1 + ' -> ' + n2);
	}
	cleanup();
	console.log(failed ? '\n' + failed + ' CHECK(S) FAILED\n' + plain2.slice(-1500) + '\n--- miner\n' + mlog.slice(-1500) : '\nALL CHECKS PASSED');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); cleanup(); process.exit(2); });
