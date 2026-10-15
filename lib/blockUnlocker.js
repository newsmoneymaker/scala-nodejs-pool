/**
 * Block unlocker for Scala (adapted from cryptonote-nodejs-pool, GPL-2.0).
 *
 * A block candidate (redis zset <coin>:blocks:candidates, score = height, member
 * rewardType:login:hash:time:difficulty:shares:score, written by shares.js when the node accepted a block) is settled
 * once the chain is `depth` blocks past it (coinbase maturity is 60 blocks: keep depth a bit above):
 *  - the hash of the block at that height is not the candidate's (or the node calls it orphaned) -> orphaned;
 *  - otherwise the reward is what the pool wallet received in the block's coinbase transaction (wallet get_transfer_by_txid
 *    on the block's miner_tx_hash: the coinbase also pays the Diardi maintainer's share, the wallet knows only its own);
 *  - a block that is on the chain but whose coinbase the wallet does not know (yet): cannot tell, try again later, credit nothing.
 * The reward, minus the pool fee and the developer donation, is split by the round scores into the balances of the
 * miners (redis <coin>:workers:<address>, field `balance`); the payment processor pays them out.
 **/

let async = require('async');

let rpc = require('./scalaRpc.js');
let notifications = require('./notifications.js');
let utils = require('./utils.js');

let slushMiningEnabled = config.poolServer.slushMining && config.poolServer.slushMining.enabled;
let unlockerConfig = config.blockUnlocker;
let depth = unlockerConfig.depth || 70;
let UNITS = config.coinUnits || 100000000;

// Initialize log system
let logSystem = 'unlocker';
require('./exceptionWriter.js')(logSystem);

// Developer donation: {"<Scala address>": percent of the block reward}. It is paid like any other balance (same minimum,
// same payment processor), shown by the API and by the website, and taken before the miners' shares are computed.
let donations = utils.donationTable(unlockerConfig, function (address) {
	log('error', logSystem, 'Donation entry %s ignored: it needs a valid Scala address and a percent above 0 up to 10', [address]);
});
let donationPercent = Object.keys(donations).reduce(function (sum, account) { return sum + donations[account]; }, 0);

log('info', logSystem, 'Started (depth %d blocks, pool fee %s%%, developer donation %s%%)', [depth, unlockerConfig.poolFee || 0, donationPercent]);

/**
 * What the wallet received in the coinbase of the block with this hash: callback(error, atoms | null).
 * null = the block is not on the main chain (orphaned).
 **/
function blockReward (height, hash, callback) {
	rpc.call('get_block_header_by_height', {height: height}, function (error, result) {
		if (error) return callback(error);
		let header = result && result.block_header;
		if (!header || header.hash !== hash || header.orphan_status) return callback(null, null);
		if (!header.miner_tx_hash) return callback(new Error('the node did not give the coinbase transaction of block ' + height));
		rpc.call('get_transfer_by_txid', {txid: header.miner_tx_hash}, function (error, tx) {
			if (error) return callback(new Error('the wallet does not know the coinbase of block ' + height + ': ' + (error.message || JSON.stringify(error))));
			let received = tx && tx.transfer && parseInt(tx.transfer.amount);
			if (!(received > 0)) return callback(new Error('the coinbase of block ' + height + ' pays nothing to the wallet (is the pool address the wallet\'s?)'));
			callback(null, received);
		}, {wallet: true});
	});
}

function feePercentOf (block) {
	if (block.rewardType === 'solo') {
		return (unlockerConfig.soloFee >= 0 ? unlockerConfig.soloFee : (unlockerConfig.poolFee > 0 ? unlockerConfig.poolFee : 0)) / 100;
	}
	return (unlockerConfig.poolFee > 0 ? unlockerConfig.poolFee : 0) / 100;
}

/**
 * Run block unlocker
 **/
function runInterval () {
	async.waterfall([

		// All block candidates in redis
		function (callback) {
			redisClient.zrange(config.coin + ':blocks:candidates', 0, -1, 'WITHSCORES', function (error, results) {
				if (error) {
					log('error', logSystem, 'Error trying to get pending blocks from redis %j', [error]);
					callback(true);
					return;
				}
				if (results.length === 0) {
					log('info', logSystem, 'No blocks candidates in redis');
					callback(true);
					return;
				}

				let blocks = [];
				let seenHashes = {};
				let dupeMembers = [];
				for (let i = 0; i < results.length; i += 2) {
					let parts = results[i].split(':');
					let hash = parts[2];
					// A block-solving share can end up recorded as a candidate more than once (e.g. resubmitted), each
					// time with a slightly different `shares` snapshot of the round -- zadd's own dedup is by the WHOLE
					// member string, so these are NOT deduplicated by redis and each one would otherwise be credited
					// separately (real incident on QWC: 19 blocks double-credited this way, ~6433 QWC overpaid). Keep
					// only the first sighting of a given block hash; remove the rest from candidates without crediting them.
					if (seenHashes[hash]) {
						dupeMembers.push(results[i]);
						continue;
					}
					seenHashes[hash] = true;
					blocks.push({
						serialized: results[i],
						height: parseInt(results[i + 1]),
						rewardType: parts[0],
						login: parts[1],
						hash: hash,
						time: parts[3],
						difficulty: parts[4],
						shares: parts[5],
						score: parts.length >= 7 ? parts[6] : parts[5]
					});
				}
				if (dupeMembers.length) {
					log('warn', logSystem, 'Removed %d duplicate block candidate(s) (same block hash seen more than once): %j', [dupeMembers.length, dupeMembers]);
					redisClient.zrem(config.coin + ':blocks:candidates', dupeMembers, function (error) {
						if (error) log('error', logSystem, 'Failed to remove duplicate candidates %j', [error]);
					});
				}
				callback(null, blocks);
			});
		},

		// Which of them are `depth` blocks behind the tip
		function (blocks, callback) {
			rpc.call('get_last_block_header', {}, function (error, last) {
				let height = last && last.block_header && last.block_header.height;
				if (error || typeof height !== 'number') {
					log('error', logSystem, 'Error getting the chain height %j', [error ? (error.message || JSON.stringify(error)) : 'bad reply']);
					callback(true);
					return;
				}
				let ripe = blocks.filter(function (block) { return height - block.height >= depth; });
				if (ripe.length === 0) {
					log('info', logSystem, 'No pending blocks are unlocked yet (%d pending, chain height %d, first one due at %d)',
						[blocks.length, height, Math.min.apply(null, blocks.map(function (b) { return b.height; })) + depth]);
					callback(true);
					return;
				}
				callback(null, ripe);
			});
		},

		// Decide for each: ours (reward from the wallet), orphaned, or not decidable yet
		function (blocks, callback) {
			async.filter(blocks, function (block, mapCback) {
				blockReward(block.height, block.hash, function (error, reward) {
					if (error) {
						log('error', logSystem, 'Block %d (%s): %s, waiting', [block.height, block.hash, error.message || JSON.stringify(error)]);
						return mapCback(false);
					}
					if (reward === null) {
						block.orphaned = 1;
						block.reward = 0;
					} else {
						block.orphaned = 0;
						block.reward = reward;
					}
					mapCback(true);
				});
			}, function (decided) {
				if (decided.length === 0) {
					callback(true);
					return;
				}
				callback(null, decided);
			});
		},

		// Round scores of the decided blocks
		function (blocks, callback) {
			let redisCommands = blocks.map(function (block) {
				return ['hgetall', config.coin + ':scores:' + (block.rewardType === 'prop' ? 'prop' : 'solo') + ':round' + block.height];
			});

			redisClient.multi(redisCommands).exec(function (error, replies) {
				if (error) {
					log('error', logSystem, 'Error with getting round shares from redis %j', [error]);
					callback(true);
					return;
				}
				for (let i = 0; i < replies.length; i++) {
					blocks[i].workerScores = replies[i];
				}
				callback(null, blocks);
			});
		},

		// Orphaned blocks: forget the round
		function (blocks, callback) {
			let orphanCommands = [];
			blocks.forEach(function (block) {
				if (!block.orphaned) return;
				orphanCommands.push(['del', config.coin + ':scores:solo:round' + block.height]);
				orphanCommands.push(['del', config.coin + ':scores:prop:round' + block.height]);
				orphanCommands.push(['del', config.coin + ':shares_actual:solo:round' + block.height]);
				orphanCommands.push(['del', config.coin + ':shares_actual:prop:round' + block.height]);
				orphanCommands.push(['zrem', config.coin + ':blocks:candidates', block.serialized]);
				orphanCommands.push(['zadd', config.coin + ':blocks:matured', block.height, [
					block.rewardType, block.login, block.hash, block.time, block.difficulty, block.shares, block.orphaned
				].join(':')]);

				// without slush weighting the scores of the lost round go back into the current one
				if (block.workerScores && !slushMiningEnabled && block.rewardType === 'prop') {
					Object.keys(block.workerScores).forEach(function (worker) {
						orphanCommands.push(['hincrbyfloat', config.coin + ':scores:prop:roundCurrent', worker, block.workerScores[worker]]);
					});
				}

				log('warn', logSystem, 'Block %d (%s) is orphaned', [block.height, block.hash]);
				notifications.sendToAll('blockOrphaned', {'HEIGHT': block.height, 'HASH': block.hash});
			});

			if (orphanCommands.length === 0) return callback(null, blocks);

			redisClient.multi(orphanCommands).exec(function (error) {
				if (error) {
					log('error', logSystem, 'Error with cleaning up data in redis for orphan block(s) %j', [error]);
					callback(true);
					return;
				}
				callback(null, blocks);
			});
		},

		// Our blocks: credit the miners
		function (blocks, callback) {
			let commands = [];
			let payments = {};
			let unlocked = 0;

			blocks.forEach(function (block) {
				if (block.orphaned) return;
				unlocked++;

				commands.push(['del', config.coin + ':scores:solo:round' + block.height]);
				commands.push(['del', config.coin + ':scores:prop:round' + block.height]);
				commands.push(['del', config.coin + ':shares_actual:solo:round' + block.height]);
				commands.push(['del', config.coin + ':shares_actual:prop:round' + block.height]);
				commands.push(['zrem', config.coin + ':blocks:candidates', block.serialized]);
				commands.push(['zadd', config.coin + ':blocks:matured', block.height, [
					block.rewardType, block.login, block.hash, block.time, block.difficulty, block.shares, block.orphaned, block.reward
				].join(':')]);

				let networkFee = unlockerConfig.networkFee > 0 ? block.reward * unlockerConfig.networkFee / 100 : 0;
				let distributable = block.reward - networkFee;
				let feePercent = feePercentOf(block);
				let finderPercent = block.rewardType === 'prop' && unlockerConfig.finderReward > 0 ? unlockerConfig.finderReward / 100 : 0;
				let finderReward = Math.floor(distributable * finderPercent);
				let reward = Math.floor(distributable - distributable * (feePercent + finderPercent + donationPercent / 100));

				Object.keys(donations).forEach(function (account) {
					let amount = Math.floor(distributable * donations[account] / 100);
					payments[account] = (payments[account] || 0) + amount;
					log('info', logSystem, 'Block %d: developer donation %s%% = %d to %s', [block.height, donations[account], amount, account]);
				});

				log('info', logSystem, 'Unlocked %s block %d: reward %d, pool fee %d%%, miners get %d, finder bonus %d',
					[block.rewardType.toUpperCase(), block.height, block.reward, feePercent * 100, reward, finderReward]);

				if (block.rewardType === 'solo') {
					payments[block.login] = (payments[block.login] || 0) + reward;
				} else if (block.workerScores) {
					let totalScore = parseFloat(block.score);
					Object.keys(block.workerScores).forEach(function (worker) {
						let part = Math.floor(reward * (parseFloat(block.workerScores[worker]) / totalScore));
						payments[worker] = (payments[worker] || 0) + part + (block.login === worker ? finderReward : 0);
					});
				}

				notifications.sendToAll('blockUnlocked', {'HEIGHT': block.height, 'HASH': block.hash, 'REWARD': utils.getReadableCoins(block.reward)});
			});

			Object.keys(payments).forEach(function (worker) {
				let amount = Math.floor(payments[worker]);
				if (amount > 0) commands.push(['hincrby', config.coin + ':workers:' + worker, 'balance', amount]);
			});

			if (commands.length === 0) {
				callback(true);
				return;
			}

			// one transaction: the candidate leaves the list in the same step in which the balances grow
			redisClient.multi(commands).exec(function (error) {
				if (error) {
					log('error', logSystem, 'Error with unlocking blocks %j', [error]);
					callback(true);
					return;
				}
				log('info', logSystem, 'Unlocked %d blocks and updated balances of %d accounts', [unlocked, Object.keys(payments).length]);
				callback(null);
			});
		}
	], function () {
		setTimeout(runInterval, unlockerConfig.interval * 1000);
	});
}

runInterval();
