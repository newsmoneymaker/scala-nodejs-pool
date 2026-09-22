/**
 * Scala Pool (based on cryptonote-nodejs-pool, GPL-2.0)
 *
 * Stratum server for Scala's RandomX variant (Panthera / DefyX: "rx/xla", XMRig style JSON-RPC over TCP/TLS).
 *
 *   node get_block_template --> job manager --job--> miners
 *   miners --submit--> share check (helper: RandomX(blob), key = seed_hash) --> redis (shares.js)
 *   a share that meets the network difficulty is sent to the node with submit_block.
 *
 * Scala is a Monero code base (hard fork 16). The mining blob is the block's hashing blob (the nonce is 4 bytes after the
 * previous block id, the 64 byte "Diardi" signature field follows it), the hash is Panthera(blob) with the seed hash as key
 * (the helper links the node's own library). A hash is a 256 bit little endian number: it solves a block when
 * hash * difficulty < 2^256. Job target: 64 bit, little endian hex, the miner compares the last 8 bytes of its hash
 * (little endian) with it.
 *
 * Diardi: since hard fork 13 every block whose height is divisible by 4 belongs to the allow-listed Diardi miners of the
 * Scala team (other proof of work, felidae, and a signature of a listed key). Nobody else can mine those heights: the
 * pool still hands out jobs there (the shares are real work and count in the round like any other) but a "block" found at
 * such a height is never submitted (job.diardi).
 **/

let net = require('net');
let tls = require('tls');
let fs = require('fs');
let crypto = require('crypto');

let utils = require('./utils.js');
let shares = require('./shares.js');
let rpc = require('./scalaRpc.js');
let hasher = require('./hasher.js');

let logSystem = 'pool';
require('./exceptionWriter.js')(logSystem);

let poolConfig = config.poolServer;
let varDiffConfig = Object.assign({startDiff: 20000, minDiff: 2000, maxDiff: 5000000, targetTime: 20, retargetTime: 60, variancePercent: 30, maxJump: 100}, poolConfig.varDiff || {});
let JOB_REFRESH = poolConfig.jobRefresh || 1000;
let ALGO_NAME = 'rx/xla';
let TEMPLATE_REFRESH = (poolConfig.templateRefresh || 20) * 1000;   // a new template of the same tip at most this often (it carries new transactions)

let banningEnabled = poolConfig.banning && poolConfig.banning.enabled;
let bannedIPs = {};
let perIPStats = {};

const MAX_CLIENT_LINE = 16 * 1024;
const MAX_WORKERNAME = 32;
const TWO_64 = 18446744073709551616n;
const TWO_256 = 1n << 256n;

/**
 * Split a byte stream into lines
 **/
function lineSplitter (maxLength, onLine, onOverflow) {
	let buffer = '';
	return function (data) {
		buffer += data;
		let idx;
		while ((idx = buffer.indexOf('\n')) !== -1) {
			let line = buffer.slice(0, idx).replace(/\r$/, '');
			buffer = buffer.slice(idx + 1);
			if (line.length) onLine(line);
		}
		if (buffer.length > maxLength) {
			buffer = '';
			onOverflow();
		}
	};
}

function reverseHex (hex) {
	return Buffer.from(hex, 'hex').reverse().toString('hex');
}

/** LEB128 varint at `offset`: {value, length} */
function readVarint (buf, offset) {
	let value = 0;
	let length = 0;
	let byte;
	do {
		if (offset + length >= buf.length || length > 9) throw new Error('bad varint in the block blob');
		byte = buf[offset + length];
		value += (byte & 0x7f) * Math.pow(2, 7 * length);
		length++;
	} while (byte & 0x80);
	return {value: value, length: length};
}

/** offset (bytes) of the 4 byte nonce in a block blob: major, minor, timestamp (varints), previous id (32 bytes), nonce */
function nonceOffset (blobHex) {
	let buf = Buffer.from(blobHex.substr(0, 40), 'hex');
	let offset = 0;
	for (let i = 0; i < 3; i++) offset += readVarint(buf, offset).length;
	return offset + 32;
}

/** the 256 bit little endian number of a hash */
function hashValueLE (hashHex) {
	return BigInt('0x' + reverseHex(hashHex));
}

/** the difficulty of a block a hash solves: hash * difficulty < 2^256 (as Monero's check_hash) */
function meetsDifficulty (hashHex, difficulty) {
	return hashValueLE(hashHex) * difficulty < TWO_256;
}

/** 64 bit target (little endian hex, 16 chars) for a share of `hashes` expected hashes */
function targetHex (hashes) {
	let t = TWO_64 / BigInt(Math.max(1, Math.round(hashes)));
	if (t >= TWO_64) t = TWO_64 - 1n;
	let buf = Buffer.alloc(8);
	buf.writeBigUInt64LE(t);
	return {hex: buf.toString('hex'), value: t};
}

/**
 * Parse the stratum login: [prop:|solo:]<Scala address>[+workername]
 * Returns {address, workerName, rewardType} or {error}
 **/
function parseLogin (login, pass) {
	if (typeof login !== 'string' || !login.length || login.length > 200) return {error: 'Invalid login'};

	let rewardData = utils.determineRewardData(login);
	let rest = rewardData.address;
	let workerName = null;

	let plus = rest.indexOf('+');
	if (plus === -1) plus = rest.indexOf('.');
	if (plus !== -1) {
		workerName = utils.cleanupSpecialChars(rest.substr(plus + 1)).substr(0, MAX_WORKERNAME) || null;
		rest = rest.substr(0, plus);
	}
	if (!workerName && typeof pass === 'string' && pass !== 'x' && pass.length) {
		workerName = utils.cleanupSpecialChars(pass).substr(0, MAX_WORKERNAME) || null;
	}

	let address = utils.canonicalMinerAddress(rest);
	if (!address) return {error: 'Invalid Scala address (expected a standard address, 98 characters)'};

	return {address: address, workerName: workerName, rewardType: rewardData.rewardType};
}

/**
 * Banning
 **/
let allowIPs = (poolConfig.allowIPs || []).map(String);

function isAllowedIp (ip) {
	if (!allowIPs.length) return true;
	let plain = ip.replace(/^::ffff:/, '');
	return allowIPs.indexOf(plain) !== -1 || allowIPs.indexOf(ip) !== -1;
}

function IsBannedIp (ip) {
	if (!banningEnabled || !bannedIPs[ip]) return false;
	let timeLeft = poolConfig.banning.time * 1000 - (Date.now() - bannedIPs[ip]);
	if (timeLeft > 0) return true;
	delete bannedIPs[ip];
	log('info', logSystem, 'Ban dropped for %s', [ip]);
	return false;
}

function checkBan (miner, validShare) {
	if (!banningEnabled) return;

	let stats = perIPStats[miner.ip];
	if (!stats) stats = perIPStats[miner.ip] = {validShares: 0, invalidShares: 0};
	if (validShare) stats.validShares++; else stats.invalidShares++;

	let total = stats.validShares + stats.invalidShares;
	if (total >= poolConfig.banning.checkThreshold) {
		let percent = stats.invalidShares / total * 100;
		if (percent >= poolConfig.banning.invalidPercent) {
			log('warn', logSystem, 'Banned %s@%s: %d%% invalid shares', [miner.address, miner.ip, Math.round(percent)]);
			bannedIPs[miner.ip] = Date.now();
			miner.destroy();
		}
		delete perIPStats[miner.ip];
	}
}

setInterval(function () {
	let now = Date.now();
	for (let ip in bannedIPs) {
		if (now - bannedIPs[ip] > poolConfig.banning.time * 1000) delete bannedIPs[ip];
	}
	perIPStats = {};
}, 60 * 1000);

/**
 * Limits against connection floods: per IP (total and not yet logged in), a login deadline, in total.
 * Settings in poolServer: maxConnectionsPerIp, maxUnauthenticatedPerIp, loginTimeout (s), maxConnections.
 **/
let MAX_PER_IP = poolConfig.maxConnectionsPerIp || 100;
let MAX_UNAUTH_PER_IP = poolConfig.maxUnauthenticatedPerIp || 10;
let LOGIN_TIMEOUT = (poolConfig.loginTimeout || 20) * 1000;
let MAX_TOTAL = poolConfig.maxConnections || 3000;
let connectionsByIp = {};
let totalConnections = 0;
let limitLogged = {};

function limitReason (ip) {
	let c = connectionsByIp[ip];
	if (totalConnections >= MAX_TOTAL) return 'the pool is full (' + MAX_TOTAL + ' connections)';
	if (c && c.total >= MAX_PER_IP) return 'more than ' + MAX_PER_IP + ' connections from one address';
	if (c && c.unauth >= MAX_UNAUTH_PER_IP) return 'more than ' + MAX_UNAUTH_PER_IP + ' connections from one address that did not log in';
	return null;
}

/**
 * Difficulty memory. A miner whose network drops long-lived connections (or a miner that renews its connection every
 * half minute) would start from the start difficulty every time and never live long enough for the variable difficulty to
 * act (it needs a minute and a few shares). The state of the variable difficulty is therefore kept per address and worker
 * for a while and handed to the next connection of the same worker.
 **/
const DIFF_MEMORY_TTL = (poolConfig.diffMemoryMinutes || 15) * 60 * 1000;
let diffMemory = new Map();      // "address~worker" -> {diff, shareTimes, lastRetarget, seen}

setInterval(function () {
	let now = Date.now();
	diffMemory.forEach(function (mem, key) {
		if (now - mem.seen > DIFF_MEMORY_TTL) diffMemory.delete(key);
	});
}, 60 * 1000);

/**
 * Job manager: polls the node for a block template, keeps recent jobs.
 **/
let jobs = new Map();          // job id -> job
let currentJob = null;
let currentKeyRaw = null;      // RandomX key in use by the hasher (raw bytes, hex)
let keyReady = false;
let jobCounter = 0;
let miners = new Set();
let refreshing = false;
let lastStaleLog = 0;
let lastTemplateError = null;
let lastTemplateErrorTime = 0;

function newJobFromTemplate (t) {
	let blob = t.blockhashing_blob;
	let template = t.blocktemplate_blob;
	if (typeof blob !== 'string' || typeof template !== 'string' || !/^[0-9a-f]+$/.test(blob) || !/^[0-9a-f]+$/.test(template)) {
		throw new Error('unexpected block template (no blockhashing_blob / blocktemplate_blob)');
	}
	if (typeof t.seed_hash !== 'string' || !/^[0-9a-f]{64}$/.test(t.seed_hash)) throw new Error('the template has no RandomX seed_hash');
	let difficulty = BigInt(t.wide_difficulty || t.difficulty);
	if (difficulty <= 0n) throw new Error('bad difficulty ' + (t.wide_difficulty || t.difficulty));
	let offset = nonceOffset(template);
	if (nonceOffset(blob) !== offset) throw new Error('the hashing blob and the template blob differ in their header');
	let major = parseInt(blob.substr(0, 2), 16);
	if (major >= 0x80) major = (major & 0x7f) | (parseInt(blob.substr(2, 2), 16) << 7);    // varint (small versions only)
	return {
		id: null,
		height: t.height,
		diardi: major >= 13 && t.height % 4 === 0,
		blob: blob,
		template: template,
		nonceHex: offset * 2,          // position of the nonce in the hex strings
		prevHash: t.prev_hash,
		keyRaw: t.seed_hash,
		difficulty: difficulty,
		blockHashes: Number(difficulty),
		created: Date.now(),
	};
}

let lastTip = null;
let lastTemplateAt = 0;

function refreshTemplate () {
	if (refreshing) return;
	refreshing = true;
	let fail = function (err) {
		refreshing = false;
		// the node is loading or not synchronised: one line per 30 seconds, not one per poll
		let text = err.message || JSON.stringify(err);
		if (text !== lastTemplateError || Date.now() - lastTemplateErrorTime > 30000) {
			lastTemplateError = text;
			lastTemplateErrorTime = Date.now();
			log('error', logSystem, 'get_block_template failed: %s', [text]);
		}
	};

	// cheap poll of the tip; a template is asked for when the tip moved (or now and then, to pick up new transactions)
	rpc.call('get_last_block_header', {}, function (err, last) {
		if (err) return fail(err);
		let tip = last && last.block_header && last.block_header.hash;
		if (!tip) return fail(new Error('the node did not tell its top block'));
		if (tip === lastTip && currentJob && Date.now() - lastTemplateAt < TEMPLATE_REFRESH) {
			refreshing = false;
			return;
		}
		rpc.call('get_block_template', {wallet_address: poolConfig.poolAddress, reserve_size: 8}, function (err, t) {
			refreshing = false;
			if (err) return fail(err);
			let job;
			try {
				job = newJobFromTemplate(t);
			} catch (e) {
				log('error', logSystem, 'Bad block template: %s', [e.message]);
				return;
			}
			if (job.prevHash !== tip) return;    // the tip moved while we asked: the next poll picks it up
			lastTip = tip;
			lastTemplateAt = Date.now();

			if (job.keyRaw !== currentKeyRaw) {
				// a new RandomX seed (every 2048 blocks): the helper rebuilds its dataset, jobs start when it is ready
				log('info', logSystem, 'New RandomX seed hash %s, initialising the hasher', [job.keyRaw.substr(0, 16)]);
				currentKeyRaw = job.keyRaw;
				keyReady = false;
				hasher.setKey(job.keyRaw, function (keyErr) {
					if (keyErr) {
						log('error', logSystem, 'Hasher could not set the key: %s', [keyErr.message]);
						currentKeyRaw = null;
						return;
					}
					keyReady = true;
					log('info', logSystem, 'Hasher is ready');
					lastTemplateAt = 0;
					refreshTemplate();
				});
				return;
			}
			if (!keyReady) return;

			job.id = String(++jobCounter);
			jobs.set(job.id, job);
			let previous = currentJob;
			currentJob = job;
			// forget jobs of earlier blocks and old ones of this block
			jobs.forEach(function (j, id) {
				if (j.height < job.height || job.created - j.created > 10 * 60 * 1000 || Number(id) < jobCounter - 20) jobs.delete(id);
			});

			if (!previous || previous.height !== job.height) {
				log('info', logSystem, 'New block to mine: height %d, network difficulty %s hashes', [job.height, Math.round(job.blockHashes)]);
				publishNetwork(job);
			}
			miners.forEach(function (miner) { miner.sendJob(); });
		});
	});
}

let lastPublished = {height: null, time: 0};

function publishNetwork (job) {
	let now = Date.now();
	if (lastPublished.height === job.height && now - lastPublished.time < 30000) return;
	lastPublished = {height: job.height, time: now};
	redisClient.hmset(config.coin + ':network', {
		height: job.height,
		algorithm: 'randomx',
		difficulties: JSON.stringify({randomx: job.blockHashes}),
		updated: now
	}, function (err) {
		if (err) log('error', logSystem, 'Failed to publish network data: %j', [err]);
	});
}

/**
 * One miner connection
 **/
function handleConnection (socket, portData) {
	let ip = socket.remoteAddress;
	if (!ip) return socket.destroy();

	if (!isAllowedIp(ip)) {
		log('info', logSystem, 'Rejected connection from %s: not in poolServer.allowIPs', [ip]);
		return socket.destroy();
	}

	if (IsBannedIp(ip)) {
		log('info', logSystem, 'Rejected connection from banned IP %s', [ip]);
		return socket.destroy();
	}

	let limited = limitReason(ip);
	if (limited) {
		if (!limitLogged[ip] || Date.now() - limitLogged[ip] > 60000) {
			limitLogged[ip] = Date.now();
			log('warn', logSystem, 'Rejected connection from %s: %s', [ip, limited]);
		}
		return socket.destroy();
	}
	let counter = connectionsByIp[ip] || (connectionsByIp[ip] = {total: 0, unauth: 0});
	counter.total++;
	counter.unauth++;
	totalConnections++;
	let authenticated = false;

	socket.setEncoding('utf8');
	socket.setNoDelay(true);

	let closed = false;
	let connectedAt = Date.now();
	let diff = Math.min(Math.max(portData.diff || varDiffConfig.startDiff, varDiffConfig.minDiff), varDiffConfig.maxDiff);
	let miner = {
		id: crypto.randomBytes(8).toString('hex'),
		ip: ip,
		address: null,
		workerName: null,
		rewardType: 'prop',
		diff: diff,
		fixedDiff: !!portData.fixedDiff,
		sent: new Map(),               // job id -> {target, diff, nonceStart}
		shareTimes: [],
		lastRetarget: Date.now(),
		sendJob: function () { sendJob(false); },
		destroy: function () {
			if (closed) return;
			closed = true;
			clearTimeout(loginTimer);
			miners.delete(miner);
			counter.total--;
			if (!authenticated) counter.unauth--;
			totalConnections--;
			if (counter.total <= 0) delete connectionsByIp[ip];
			let caller = (new Error().stack.split('\n')[2] || '').trim();
			log('info', logSystem, 'Closing connection of %s@%s after %ds, closed by: %s', [miner.address, ip, Math.round((Date.now() - connectedAt) / 1000), caller]);
			socket.destroy();
		}
	};

	let loginTimer = setTimeout(function () {
		if (authenticated) return;
		log('info', logSystem, 'No login from %s within %ds, closing', [ip, LOGIN_TIMEOUT / 1000]);
		miner.destroy();
	}, LOGIN_TIMEOUT);

	log('info', logSystem, 'Miner connected from %s on port %d', [ip, portData.port]);

	if (poolConfig.minerTimeout) {
		socket.setTimeout(poolConfig.minerTimeout * 1000, function () {
			log('info', logSystem, 'Miner %s@%s timed out', [miner.address, ip]);
			miner.destroy();
		});
	}

	function send (obj) {
		if (!closed && socket.writable) socket.write(JSON.stringify(obj) + '\n');
	}

	function reply (id, result, error) {
		send({id: id, jsonrpc: '2.0', error: error ? {code: error.code || -1, message: error.message} : null, result: result});
	}

	/** the job for this miner: the block header with its own start nonce and its share target **/
	function buildJob () {
		if (!currentJob || !keyReady) return null;
		let job = currentJob;
		let nonceStart = crypto.randomBytes(4).toString('hex');
		let target = targetHex(miner.diff);
		// the same job can be sent again with another share difficulty (vardiff): keep the nonces already used and
		// still accept shares that were found for the previous target
		let before = miner.sent.get(job.id);
		miner.sent.set(job.id, {
			target: target.value,
			diff: miner.diff,
			prev: before ? {target: before.target, diff: before.diff} : null,
			nonces: before ? before.nonces : new Set(),           // accepted nonces of this miner on this job
			pendingNonces: before ? before.pendingNonces : new Set(),
			nonceStart: nonceStart
		});
		if (miner.sent.size > 30) miner.sent.delete(miner.sent.keys().next().value);
		let message = {
			blob: job.blob.slice(0, job.nonceHex) + nonceStart + job.blob.slice(job.nonceHex + 8),
			job_id: job.id,
			target: target.hex,
			height: job.height,
			seed_hash: job.keyRaw,
			algo: ALGO_NAME
		};
		if (job.diardi) {
			// poolpayminer rests for such a job (it says so in its window); the pause must not look like a slow miner to the variable difficulty
			message.diardi = true;
			miner.shareTimes = [];
		}
		return message;
	}

	function sendJob () {
		let job = buildJob();
		if (job) send({jsonrpc: '2.0', method: 'job', params: job});
	}

	function onLine (line) {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch (e) {
			log('warn', logSystem, 'Malformed JSON from %s@%s', [miner.address, ip]);
			return miner.destroy();
		}
		if (!msg || typeof msg !== 'object') return miner.destroy();

		switch (msg.method) {
			case 'login':
				return onLogin(msg);
			case 'submit':
				return onSubmit(msg);
			case 'keepalived':
				return reply(msg.id, {status: 'KEEPALIVED'});
			default:
				return reply(msg.id, null, {code: -32601, message: 'Unknown method'});
		}
	}

	function onLogin (msg) {
		let params = msg.params || {};
		let parsed = parseLogin(params.login, params.pass);
		if (parsed.error) {
			log('warn', logSystem, 'Rejected login from %s: %s', [ip, parsed.error]);
			reply(msg.id, null, {code: -1, message: parsed.error});
			return setTimeout(miner.destroy, 100);
		}
		adoptRememberedDifficulty(parsed);
		let job = buildJob();
		if (!job) {
			reply(msg.id, null, {code: -1, message: 'The pool is starting (no block template yet), try again in a minute'});
			return setTimeout(miner.destroy, 100);
		}

		if (!authenticated) {
			authenticated = true;
			counter.unauth--;
			clearTimeout(loginTimer);
		}
		miner.address = parsed.address;
		miner.workerName = parsed.workerName;
		miner.rewardType = parsed.rewardType;
		miners.add(miner);

		reply(msg.id, {id: miner.id, job: job, status: 'OK', extensions: ['algo', 'keepalive']});
		log('info', logSystem, 'Miner logged in: %s worker=%s type=%s ip=%s agent=%s', [parsed.address, parsed.workerName, parsed.rewardType, ip, String(params.agent || '').substr(0, 60)]);
	}

	/** the same worker came back: continue with its difficulty and the share times of the earlier connection **/
	function adoptRememberedDifficulty (parsed) {
		if (miner.fixedDiff) return;
		let key = parsed.address + '~' + (parsed.workerName || '');
		let mem = diffMemory.get(key);
		if (mem && Date.now() - mem.seen <= DIFF_MEMORY_TTL) {
			miner.diff = Math.min(Math.max(mem.diff, varDiffConfig.minDiff), varDiffConfig.maxDiff);
			miner.shareTimes = mem.shareTimes;
			miner.lastRetarget = mem.lastRetarget;
		} else {
			mem = {diff: miner.diff, shareTimes: miner.shareTimes, lastRetarget: miner.lastRetarget, seen: Date.now()};
			diffMemory.set(key, mem);
		}
		miner.memory = mem;
	}

	function remember () {
		if (!miner.memory) return;
		miner.memory.diff = miner.diff;
		miner.memory.lastRetarget = miner.lastRetarget;
		miner.memory.seen = Date.now();
	}

	function reject (msg, message, code, count) {
		if (count !== false) checkBan(miner, false);
		log('info', logSystem, 'Rejected share from %s@%s: %s', [miner.address, ip, message]);
		reply(msg.id, null, {code: code || -1, message: message});
	}

	function onSubmit (msg) {
		if (!miner.address) return reply(msg.id, null, {code: -1, message: 'Login required'});

		let params = msg.params || {};
		let sent = miner.sent.get(String(params.job_id));
		let job = jobs.get(String(params.job_id));
		if (!sent || !job || !currentJob || job.height !== currentJob.height || job.keyRaw !== currentKeyRaw) {
			return reject(msg, 'Job expired', -1, false);
		}
		let nonce = String(params.nonce || '').toLowerCase();
		if (!/^[0-9a-f]{8}$/.test(nonce)) return reject(msg, 'Invalid nonce');
		// a nonce counts once, but only a nonce that produced a valid share is remembered
		// (a wrong answer must not use up a nonce)
		if (sent.nonces.has(nonce) || sent.pendingNonces.has(nonce)) return reject(msg, 'Duplicate share');
		sent.pendingNonces.add(nonce);

		let blob = job.blob.slice(0, job.nonceHex) + nonce + job.blob.slice(job.nonceHex + 8);
		hasher.hash(blob, function (err, hashHex) {
			sent.pendingNonces.delete(nonce);
			if (err) {
				log('error', logSystem, 'Cannot check a share from %s: %s', [miner.address, err.message]);
				return reply(msg.id, null, {code: -1, message: 'Try again'});
			}
			if (params.result && String(params.result).toLowerCase() !== hashHex) {
				return reject(msg, 'Bad hash');
			}
			// the miner compares the last 8 bytes of its hash, read as a little endian number, with the job target
			let value = Buffer.from(hashHex, 'hex').readBigUInt64LE(24);
			// the difficulty this share is credited with: the current one, or the previous one for a share found just before a retarget
			let credited = value < sent.target ? sent : (sent.prev && value < sent.prev.target ? sent.prev : null);
			if (!credited) return reject(msg, 'Low difficulty share');

			let isBlock = meetsDifficulty(hashHex, job.difficulty);
			sent.nonces.add(nonce);
			checkBan(miner, true);
			reply(msg.id, {status: 'OK'});
			acceptShare(job, credited, nonce, hashHex, isBlock);
		});
	}

	function acceptShare (job, sent, nonce, hashHex, isBlock) {
		let weight = shares.shareWeight(sent.diff, job.blockHashes);

		let record = function (blockHash) {
			shares.record({
				login: miner.address,
				workerName: miner.workerName,
				ip: ip,
				rewardType: miner.rewardType,
				algo: 'randomx',
				height: job.height,
				rawDifficulty: sent.diff,
				weight: weight,
				blockCandidate: !!blockHash,
				hash: blockHash || null
			});
		};

		if (!isBlock) {
			record(null);
			retarget();
			return;
		}

		if (job.diardi) {
			// a Diardi height: only the listed miners of the Scala team can produce a valid block here
			log('warn', logSystem, 'Solution at Diardi height %d (divisible by 4) from %s: not submitted, the node would refuse it', [job.height, miner.address]);
			record(null);
			return;
		}

		// full solution: the node takes the whole block blob with the nonce filled in
		log('info', logSystem, 'Block solution at height %d from %s (worker %s), submitting', [job.height, miner.address, miner.workerName || '-']);
		let block = job.template.slice(0, job.nonceHex) + nonce + job.template.slice(job.nonceHex + 8);
		rpc.call('submit_block', [block], function (err, result) {
			if (err) {
				log('error', logSystem, 'Node rejected the block at height %d: %s', [job.height, err.message || JSON.stringify(err)]);
				record(null);
				return;
			}
			if (!result || result.status !== 'OK') {
				log('warn', logSystem, 'Block at height %d not accepted: %j', [job.height, result]);
				record(null);
				return;
			}
			rpc.call('get_block_header_by_height', {height: job.height}, function (hashErr, header) {
				let blockHash = header && header.block_header && header.block_header.hash;
				if (hashErr || typeof blockHash !== 'string') {
					log('error', logSystem, 'Block accepted but its hash is unknown at height %d: %s', [job.height, hashErr && (hashErr.message || JSON.stringify(hashErr))]);
					return record(null);
				}
				log('info', logSystem, 'BLOCK FOUND at height %d by %s (worker %s), hash %s', [job.height, miner.address, miner.workerName || '-', blockHash]);
				record(blockHash);
				lastTemplateAt = 0;
				setTimeout(refreshTemplate, 100);
			});
		});
	}

	/** variable difficulty: aim at one share per targetTime seconds **/
	function retarget () {
		if (miner.fixedDiff) return;
		let now = Date.now();
		miner.shareTimes.push(now);
		if (miner.shareTimes.length > 30) miner.shareTimes.shift();
		remember();
		if (now - miner.lastRetarget < varDiffConfig.retargetTime * 1000 || miner.shareTimes.length < 4) return;
		miner.lastRetarget = now;

		let span = (miner.shareTimes[miner.shareTimes.length - 1] - miner.shareTimes[0]) / 1000 / (miner.shareTimes.length - 1);
		if (!(span > 0)) span = 0.1;
		let ratio = varDiffConfig.targetTime / span;
		if (Math.abs(1 - ratio) * 100 < varDiffConfig.variancePercent) return;
		let newDiff = miner.diff * ratio;
		let jump = varDiffConfig.maxJump / 100;
		newDiff = Math.min(Math.max(newDiff, miner.diff * (1 - jump / (1 + jump))), miner.diff * (1 + jump));
		let cap = currentJob ? Math.min(varDiffConfig.maxDiff, currentJob.blockHashes / 4) : varDiffConfig.maxDiff;
		newDiff = Math.round(Math.min(Math.max(newDiff, varDiffConfig.minDiff), Math.max(cap, varDiffConfig.minDiff)));
		if (newDiff === miner.diff) return;
		log('info', logSystem, 'Difficulty of %s@%s: %d -> %d (a share every %ss)', [miner.address, ip, miner.diff, newDiff, span.toFixed(1)]);
		miner.diff = newDiff;
		miner.shareTimes.length = 0;          // the same array is shared with the memory of this worker
		remember();
		sendJob();
	}

	socket.on('data', lineSplitter(MAX_CLIENT_LINE, onLine, function () {
		log('warn', logSystem, 'Oversized line from %s@%s', [miner.address, ip]);
		miner.destroy();
	}));

	socket.on('error', function (err) {
		if (err.code !== 'ECONNRESET') log('warn', logSystem, 'Socket error from %s@%s: %s', [miner.address, ip, err]);
	});

	socket.on('close', function () {
		if (!closed) log('info', logSystem, 'Miner disconnected %s@%s', [miner.address, ip]);
		miner.destroy();
	});
}

/**
 * Start
 **/
shares.init();
refreshTemplate();
setInterval(refreshTemplate, JOB_REFRESH);

poolConfig.ports.forEach(function (portData) {
	let onConnection = function (socket) {
		handleConnection(socket, portData);
	};

	let server;
	if (portData.tls) {
		// poolServer.sslCert = certificate chain, poolServer.sslKey = private key (PEM). Read at start: restart after renewing.
		let options;
		try {
			options = {
				cert: fs.readFileSync(poolConfig.sslCert),
				key: fs.readFileSync(poolConfig.sslKey),
				minVersion: 'TLSv1.2'
			};
		} catch (e) {
			log('error', logSystem, 'Cannot read the TLS certificate/key for port %d: %s', [portData.port, e.message]);
			return;
		}
		server = tls.createServer(options, onConnection);
		server.on('tlsClientError', function (err, socket) {
			log('info', logSystem, 'TLS handshake failed from %s: %s', [socket && socket.remoteAddress, err.message]);
		});
	} else {
		server = net.createServer(onConnection);
	}

	server.listen(portData.port, poolConfig.bindIp || '0.0.0.0', function (error) {
		if (error) {
			log('error', logSystem, 'Could not start server listening on port %d: %j', [portData.port, error]);
			return;
		}
		log('info', logSystem, 'Started %sserver listening on port %d (%s)', [portData.tls ? 'TLS ' : '', portData.port, portData.desc || '']);
	});
});
