// Unlocker + payment processor against a mock daemon + wallet (JSON-RPC 2.0). Needs the throwaway redis of test/config.test.json (flushed!).
// Run: node test/test-scala-payments.js
const {spawn} = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const redis = require(path.join(__dirname, '../node_modules/redis'));
const {makeAddress} = require('./testaddr.js');
const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.test.json'), 'utf8'));

const PORT = 25557;
const A1 = makeAddress(11), A2 = makeAddress(12), DEV = makeAddress(13);
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined ? '  ' + extra : '')); if (!ok) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const coins = a => a / 1e8;
const FEE = 200000;

// ---- mock node + wallet (one server answers both)
const M = {tip: 1000, coinbase: {}, txs: {}, calls: [], balance: 5000000000, mode: 'normal', sent: 0};
function rpcHandle (method, p, reply, fail, res) {
	M.calls.push(method);
	switch (method) {
		case 'get_last_block_header': return reply({block_header: {height: M.tip, hash: 'h' + M.tip}, status: 'OK'});
		case 'get_block_header_by_height':
			if (p.height > M.tip || p.height < 900) return fail(-2, 'height out of range');
			return reply({block_header: {height: p.height, hash: 'h' + p.height, orphan_status: false, miner_tx_hash: 'cb' + p.height}, status: 'OK'});
		case 'get_transfer_by_txid': {
			if (p.txid.startsWith('cb')) {
				const v = M.coinbase[p.txid];
				return v === undefined ? fail(-8, 'Transaction not found.') : reply({transfer: {txid: p.txid, type: 'block', amount: v, confirmations: 100}});
			}
			const t = M.txs[p.txid];
			return t ? reply({transfer: {txid: t.txid, type: t.failed ? 'failed' : (t.confirmations > 0 ? 'out' : 'pending'), confirmations: t.confirmations, fee: FEE, height: 990, amount: t.total}}) : fail(-8, 'Transaction not found.');
		}
		case 'get_balance': return reply({balance: M.balance, unlocked_balance: M.balance});
		case 'get_transfers': {
			const list = Object.values(M.txs).map(t => ({txid: t.txid, timestamp: t.timestamp, destinations: t.destinations, amount: t.total, confirmations: t.confirmations, type: t.confirmations > 0 ? 'out' : 'pending'}));
			return reply({out: list.filter(t => t.type === 'out'), pending: list.filter(t => t.type === 'pending')});
		}
		case 'transfer': {
			if (M.mode === 'refuse') return fail(-4, 'not enough unlocked money');
			const txid = 'tx' + (Object.keys(M.txs).length + 1);
			const share = p.subtract_fee_from_outputs.length ? Math.floor(FEE / p.subtract_fee_from_outputs.length) : 0;
			const destinations = p.destinations.map((d, i) => ({address: d.address, amount: p.subtract_fee_from_outputs.indexOf(i) !== -1 ? d.amount - share : d.amount}));
			M.txs[txid] = {txid, confirmations: 0, timestamp: Math.floor(Date.now() / 1000), requested: p.destinations, subtract: p.subtract_fee_from_outputs, destinations, total: destinations.reduce((a, d) => a + d.amount, 0)};
			M.sent++;
			if (M.mode === 'lost') { res.socket.destroy(); return; }       // the tx exists, but the answer never arrives
			return reply({tx_hash: txid, fee: FEE, amount: M.txs[txid].total});
		}
	}
	fail(-32601, 'Method not found: ' + method);
}
http.createServer((req, res) => {
	let b = ''; req.on('data', d => b += d);
	req.on('end', () => {
		const m = JSON.parse(b);
		const reply = r => { res.writeHead(200); res.end(JSON.stringify({jsonrpc: '2.0', id: m.id, result: r})); };
		const fail = (code, message) => { res.writeHead(200); res.end(JSON.stringify({jsonrpc: '2.0', id: m.id, error: {code, message}})); };
		rpcHandle(m.method, m.params || {}, reply, fail, res);
	});
}).listen(PORT, '127.0.0.1');

// ---- redis
const R = redis.createClient(base.redis.port, base.redis.host, {auth_pass: base.redis.auth, db: base.redis.db || 0});
const rc = (cmd, ...a) => new Promise((res, rej) => R[cmd](...a, (e, v) => e ? rej(e) : res(v)));

const procs = [];
function startModule (name, patch) {
	const cfg = JSON.parse(JSON.stringify(base));
	cfg.node = {host: '127.0.0.1', port: PORT};
	cfg.wallet = {host: '127.0.0.1', port: PORT};
	cfg.poolServer.slushMining = {enabled: false};
	cfg.blockUnlocker = Object.assign({enabled: true, interval: 1, depth: 3, poolFee: 1, donations: {[DEV]: 0.5}}, patch.blockUnlocker || {});
	cfg.payments = Object.assign({enabled: true, interval: 1, minPayment: 50000000, maxTransactionAmount: 5000000000, maxPaymentsPerRound: 8, minConfirmations: 2, pendingTimeoutHours: 48, reserve: 1000000, dryRun: false, minerPayFee: true, unknownAfterSeconds: 2, onlyAccounts: [], stopFile: path.join(os.tmpdir(), 'scala-test-stop')}, patch.payments || {});
	const file = path.join(os.tmpdir(), 'scala-test-' + name + '.json');
	fs.writeFileSync(file, JSON.stringify(cfg));
	const p = spawn('node', [path.join(__dirname, '..', 'init.js'), '-config=' + file, '-module=' + name], {cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe']});
	p.log = ''; p.stdout.on('data', d => p.log += d); p.stderr.on('data', d => p.log += d);
	procs.push(p);
	return p;
}
const stop = p => new Promise(res => { p.once('exit', res); p.kill(); });
process.on('exit', () => procs.forEach(p => { try { p.kill(); } catch (e) {} }));
const key = (...a) => ['Scala'].concat(a).join(':');
const bal = async acc => parseInt((await rc('hget', key('workers', acc), 'balance')) || 0);

(async () => {
	await rc('flushdb');
	try { fs.unlinkSync(path.join(os.tmpdir(), 'scala-test-stop')); } catch (e) {}

	// ===== unlocker
	// block 950: reward 10 XLA to the wallet, found by A1; A1 has score 3, A2 score 1. block 951: orphaned (other hash). block 999: not mature yet.
	M.coinbase.cb950 = 1000000000;
	await rc('zadd', key('blocks', 'candidates'), 950, ['prop', A1, 'h950', 111, 1e9, 4, 4].join(':'));
	await rc('zadd', key('blocks', 'candidates'), 951, ['prop', A1, 'OTHER', 111, 1e9, 4, 4].join(':'));
	await rc('zadd', key('blocks', 'candidates'), 999, ['prop', A1, 'h999', 111, 1e9, 4, 4].join(':'));
	await rc('hset', key('scores', 'prop', 'round950'), A1, 3); await rc('hset', key('scores', 'prop', 'round950'), A2, 1);
	await rc('hset', key('scores', 'prop', 'round951'), A1, 1);
	let un = startModule('unlocker', {});
	await sleep(4000);
	const b1 = await bal(A1), b2 = await bal(A2), bd = await bal(DEV);
	// reward 10, fee 1% + donation 0.5%: miners share 9.85 in 3:1 -> 7.3875 / 2.4625; dev gets 0.05
	check('donation credited to the developer address', bd === 5000000, coins(bd));
	check('miner A1 (score 3 of 4) credited', b1 === 738750000, coins(b1));
	check('miner A2 (score 1 of 4) credited', b2 === 246250000, coins(b2));
	check('the mature block moved to matured, the orphan too', (await rc('zcard', key('blocks', 'matured'))) === 2);
	check('the block that is not mature stays a candidate', (await rc('zcard', key('blocks', 'candidates'))) === 1);
	const matured = await rc('zrange', key('blocks', 'matured'), 0, -1);
	check('orphan is marked', matured.some(m => m.indexOf('OTHER') !== -1 && m.split(':')[6] === '1'));
	await stop(un);

	// ===== unlocker: the wallet does not know the coinbase yet (not synchronised) -> nothing is credited, the block waits
	await rc('zadd', key('blocks', 'candidates'), 952, ['prop', A1, 'h952', 111, 1e9, 4, 4].join(':'));
	await rc('hset', key('scores', 'prop', 'round952'), A1, 1);
	un = startModule('unlocker', {});
	await sleep(3000);
	check('unknown coinbase: the block waits, nothing credited', (await bal(A1)) === b1 && (await rc('zcard', key('blocks', 'candidates'))) === 2 && /wallet does not know the coinbase of block 952/.test(un.log));
	await stop(un);
	await rc('zrem', key('blocks', 'candidates'), ['prop', A1, 'h952', 111, 1e9, 4, 4].join(':'));

	// ===== payments: dry run
	await rc('hset', key('workers', 'X'), 'balance', 1);   // junk account (invalid address) must never be paid
	let pay = startModule('payments', {payments: {dryRun: true}});
	await sleep(2500);
	check('dry run: nothing sent', !M.sent && /dry run/.test(pay.log));
	check('dry run: balances untouched', (await bal(A1)) === b1);
	await stop(pay);

	// ===== payments: refusal by the wallet -> refund
	M.mode = 'refuse';
	pay = startModule('payments', {});
	await sleep(3000);
	check('wallet refusal: balances are back', (await bal(A1)) === b1 && (await bal(A2)) === b2 && (await rc('hlen', key('payments', 'pending'))) === 0);
	await stop(pay);

	// ===== payments: normal batch in one transaction
	M.mode = 'normal';
	pay = startModule('payments', {});
	await sleep(3000);
	const tx = M.txs.tx1;
	check('one transfer for both miners', M.sent === 1, 'transfer calls: ' + M.sent);
	const req = tx && Object.fromEntries(tx.requested.map(d => [d.address, d.amount]));
	check('batch has A1 and A2; the developer (0.05, below the minimum) waits', req && req[A1] === 738750000 && req[A2] === 246250000 && req[DEV] === undefined && tx.requested.length === 2, JSON.stringify(req));
	check('the fee is subtracted from the paid miners', tx && tx.subtract.length === 2);
	check('junk account not paid', !(tx && req.X));
	check('balances debited, pending set', (await bal(A1)) === 0 && parseInt(await rc('hget', key('workers', A1), 'pending')) === 738750000);
	M.txs.tx1.confirmations = 5;
	await sleep(2500);
	check('confirmed: paid recorded', parseInt(await rc('hget', key('workers', A1), 'paid')) === 738750000 && parseInt(await rc('hget', key('workers', A1), 'pending')) === 0);
	check('payment history written', (await rc('zcard', key('payments', 'all'))) === 2 && (await rc('zcard', key('payments', A1))) === 1);
	const member = (await rc('zrange', key('payments', A1), 0, -1))[0].split(':');
	check('history line has txid:amount:fee:...', member[0] === 'tx1' && parseInt(member[1]) === 738750000 && parseInt(member[2]) === FEE / 2, member.join(':'));
	check('no open payouts left', (await rc('hlen', key('payments', 'pending'))) === 0);
	check('no second transaction was sent', M.sent === 1, 'transfer calls: ' + M.sent);
	await stop(pay);

	// ===== payments: the answer of transfer is lost -> found among the wallet's transfers, no double payment
	await rc('hincrby', key('workers', A1), 'balance', 100000000);
	M.mode = 'lost'; M.sent = 0;
	pay = startModule('payments', {});
	await sleep(5000);
	const lost = Object.values(M.txs).filter(t => t.txid !== 'tx1');
	check('lost answer: the tx exists in the wallet once', lost.length === 1 && M.sent === 1, 'sent ' + M.sent);
	M.mode = 'normal';
	await sleep(3500);
	const entryRaw = await rc('hgetall', key('payments', 'pending'));
	const entry = entryRaw && Object.values(entryRaw).map(JSON.parse)[0];
	check('the record was reconciled with the wallet (txid known)', entry && entry.state === 'sent' && entry.txid === lost[0].txid, entry && entry.state);
	check('and it was still sent only once', M.sent === 1);
	lost[0].confirmations = 3;
	await sleep(2500);
	check('lost answer: paid after confirmation', parseInt(await rc('hget', key('workers', A1), 'paid')) === 738750000 + 100000000);
	await stop(pay);

	// ===== payments: a transaction the wallet marks as failed goes back to the balance
	await rc('hincrby', key('workers', A2), 'balance', 100000000);
	M.mode = 'normal'; M.sent = 0;
	const failedBefore = Object.keys(M.txs).length;
	pay = startModule('payments', {});
	await sleep(3000);
	const newest = M.txs['tx' + (failedBefore + 1)];
	check('a further payout was sent', !!newest && M.sent === 1);
	check('while it is unconfirmed the amount is pending, not spendable', (await bal(A2)) === 0 && parseInt(await rc('hget', key('workers', A2), 'pending')) === 100000000);
	newest.failed = true;
	await sleep(2500);
	check('failed transaction: the amount went back to the balance ...', /returned to the balances: the transaction failed/.test(pay.log));
	check('... and was paid again in a new transaction', M.sent === 2 && parseInt(await rc('hget', key('workers', A2), 'pending')) === 100000000, 'sent ' + M.sent);
	await stop(pay);

	// ===== emergency brake
	await rc('hincrby', key('workers', A1), 'balance', 100000000);
	fs.writeFileSync(path.join(os.tmpdir(), 'scala-test-stop'), '');
	M.sent = 0;
	pay = startModule('payments', {});
	await sleep(3000);
	check('stop file: nothing sent', M.sent === 0 && /PAUSED/.test(pay.log));
	fs.unlinkSync(path.join(os.tmpdir(), 'scala-test-stop'));
	await sleep(2500);
	check('stop file removed: payout goes without a restart', M.sent === 1, 'sent ' + M.sent);
	await stop(pay);

	console.log(failed ? '\n' + failed + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); process.exit(2); });
