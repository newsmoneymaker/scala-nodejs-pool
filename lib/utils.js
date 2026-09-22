/**
 * Scala Pool (based on cryptonote-nodejs-pool, GPL-2.0)
 * https://github.com/dvandal/cryptonote-nodejs-pool
 *
 * Utilities functions
 **/

// Load required module
let crypto = require('crypto');

let dateFormat = require('dateformat');
exports.dateFormat = dateFormat;

/**
 * Generate random instance id
 **/
exports.instanceId = function () {
	return crypto.randomBytes(4);
}

/**
 * Scala addresses (CryptoNote, Monero style): Monero base58 of  varint(prefix) | spend key (32) | view key (32) |
 * checksum (first 4 bytes of Keccak-256 of everything before). See cryptonote_config.h of the Scala node, mainnet:
 * 0x9b (address, "Ss..."), 0x6599 (integrated), 0x5c1a (subaddress).
 * A miner logs in with a standard address or a subaddress; integrated addresses are not accepted. Payouts are sent to it.
 **/
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_ENCODED_BLOCK = [0, 2, 3, 5, 6, 7, 9, 10, 11];     // characters for a block of 0..8 bytes
const ADDRESS_PREFIXES = {standard: 0x9b, integrated: 0x6599, subaddress: 0x5c1a};

// Keccak-256 (the original Keccak padding as used by CryptoNote, not the NIST SHA3)
const KECCAK_MASK = (1n << 64n) - 1n;
const KECCAK_RC = [
	0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
	0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
	0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
	0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
const KECCAK_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];

function rotl64 (x, n) {
	if (!n) return x;
	let b = BigInt(n);
	return ((x << b) | (x >> (64n - b))) & KECCAK_MASK;
}

function keccakF (s) {
	for (let round = 0; round < 24; round++) {
		let c = [];
		for (let x = 0; x < 5; x++) c.push(s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
		for (let x = 0; x < 5; x++) {
			let d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
			for (let y = 0; y < 5; y++) s[x + 5 * y] ^= d;
		}
		let b = new Array(25);
		for (let x = 0; x < 5; x++) {
			for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(s[x + 5 * y], KECCAK_ROT[x][y]);
		}
		for (let x = 0; x < 5; x++) {
			for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y] ^ ((~b[(x + 1) % 5 + 5 * y] & KECCAK_MASK) & b[(x + 2) % 5 + 5 * y]);
		}
		s[0] ^= KECCAK_RC[round];
	}
}

function keccak256 (data) {
	const rate = 136;
	let padded = Buffer.alloc(Math.ceil((data.length + 1) / rate) * rate);
	data.copy(padded);
	padded[data.length] ^= 0x01;
	padded[padded.length - 1] ^= 0x80;
	let state = new Array(25).fill(0n);
	for (let offset = 0; offset < padded.length; offset += rate) {
		for (let i = 0; i < rate / 8; i++) state[i] ^= padded.readBigUInt64LE(offset + i * 8);
		keccakF(state);
	}
	let out = Buffer.alloc(32);
	for (let i = 0; i < 4; i++) out.writeBigUInt64LE(state[i], i * 8);
	return out;
}
exports.keccak256 = keccak256;

// Monero base58 -> bytes (null if it is not valid)
function base58Decode (text) {
	let out = [];
	let fullBlocks = Math.floor(text.length / 11);
	let lastChars = text.length % 11;
	let lastBytes = B58_ENCODED_BLOCK.indexOf(lastChars);
	if (lastBytes < 0) return null;
	for (let i = 0; i <= fullBlocks; i++) {
		let chars = i < fullBlocks ? 11 : lastChars;
		let bytes = i < fullBlocks ? 8 : lastBytes;
		if (!chars) continue;
		let value = 0n;
		for (let ch of text.substr(i * 11, chars)) {
			let idx = B58_ALPHABET.indexOf(ch);
			if (idx < 0) return null;
			value = value * 58n + BigInt(idx);
		}
		if (bytes < 8 && value >= (1n << BigInt(8 * bytes))) return null;
		if (bytes === 8 && value >= (1n << 64n)) return null;
		for (let b = bytes - 1; b >= 0; b--) out.push(Number((value >> BigInt(8 * b)) & 0xffn));
	}
	return Buffer.from(out);
}
exports.base58Decode = base58Decode;

function base58Encode (bytes) {
	let out = '';
	let fullBlocks = Math.floor(bytes.length / 8);
	for (let i = 0; i <= fullBlocks; i++) {
		let size = i < fullBlocks ? 8 : bytes.length % 8;
		if (!size) continue;
		let value = 0n;
		for (let b = 0; b < size; b++) value = (value << 8n) | BigInt(bytes[i * 8 + b]);
		let chars = '';
		for (let c = 0; c < B58_ENCODED_BLOCK[size]; c++) {
			chars = B58_ALPHABET[Number(value % 58n)] + chars;
			value /= 58n;
		}
		out += chars;
	}
	return out;
}
exports.base58Encode = base58Encode;

function varintBytes (n) {
	let out = [];
	while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
	out.push(n);
	return Buffer.from(out);
}

/**
 * Validate an address. Returns {address, kind: 'standard'|'subaddress'|'integrated'} or null. `prefixes` can be given for tests.
 **/
function parseAddress (address, prefixes) {
	if (typeof address !== 'string' || address.length < 90 || address.length > 120) return null;
	let bytes = base58Decode(address);
	if (!bytes || bytes.length < 4 + 64) return null;
	let table = prefixes || ADDRESS_PREFIXES;
	let kind = null;
	let prefixLength = 0;
	for (let k of Object.keys(table)) {
		let pv = varintBytes(table[k]);
		if (bytes.length === pv.length + 64 + 4 + (k === 'integrated' ? 8 : 0) && bytes.slice(0, pv.length).equals(pv)) {
			kind = k;
			prefixLength = pv.length;
			break;
		}
	}
	if (!kind) return null;
	let body = bytes.slice(0, bytes.length - 4);
	if (!keccak256(body).slice(0, 4).equals(bytes.slice(bytes.length - 4))) return null;
	return {address: address, kind: kind};
}
exports.parseAddress = parseAddress;

function parseMinerAddress (address) {
	let parsed = parseAddress(address);
	if (!parsed || parsed.kind === 'integrated') return null;
	return parsed;
}
exports.parseMinerAddress = parseMinerAddress;

// Validate miner address
exports.validateMinerAddress = function (address) {
	return parseMinerAddress(address) !== null;
}

// Canonical form of a valid address, or null
exports.canonicalMinerAddress = function (address) {
	let parsed = parseMinerAddress(address);
	return parsed ? parsed.address : null;
}

/**
 * Miner account. Kept for the code shared with the other pools of this family (no deposit notes here):
 * account = address, note = null.
 **/
function parseMinerAccount (input) {
	let parsed = parseMinerAddress(input);
	if (!parsed) return null;
	return {publicKey: parsed.address, domain: null, address: parsed.address, note: null, account: parsed.address};
}
exports.parseMinerAccount = parseMinerAccount;

exports.canonicalMinerAccount = function (input) {
	let parsed = parseMinerAccount(input);
	return parsed ? parsed.account : null;
}

// Split a stored account back into {address, note}
exports.splitMinerAccount = function (account) {
	return {address: account, note: null};
}

/**
 * Developer donation table of the config: blockUnlocker.donations = {"<Scala address>": percent of the block reward}.
 * Returns {canonical account: percent} of the valid entries (percent above 0 up to 10); onInvalid(address) is called for the others.
 **/
exports.donationTable = function (unlockerConfig, onInvalid) {
	let table = {};
	let entries = (unlockerConfig && unlockerConfig.donations) || {};
	Object.keys(entries).forEach(function (address) {
		let account = exports.canonicalMinerAccount(address);
		let percent = parseFloat(entries[address]);
		if (!account || !(percent > 0) || percent > 10) {
			if (onInvalid) onInvalid(address);
			return;
		}
		table[account] = percent;
	});
	return table;
};

function characterCount (string, char) {
	let re = new RegExp(char, "gi")
	let matches = string.match(re)
	return matches === null ? 0 : matches.length;
}
exports.characterCount = characterCount;

exports.determineRewardData = (value) => {
	let calculatedData = {
		'address': value,
		'rewardType': 'prop'
	}
	if (/^solo:/i.test(value)) {
		calculatedData['address'] = value.substr(5)
		calculatedData['rewardType'] = 'solo'
		return calculatedData
	}
	if (/^prop:/i.test(value)) {
		calculatedData['address'] = value.substr(5)
		calculatedData['rewardType'] = 'prop'
		return calculatedData
	}
	return calculatedData
}

/**
 * Cleanup special characters (fix for non latin characters)
 **/
function cleanupSpecialChars (str) {
	str = str.replace(/[ÀÁÂÃÄÅ]/g, "A");
	str = str.replace(/[àáâãäå]/g, "a");
	str = str.replace(/[ÈÉÊË]/g, "E");
	str = str.replace(/[èéêë]/g, "e");
	str = str.replace(/[ÌÎÏ]/g, "I");
	str = str.replace(/[ìîï]/g, "i");
	str = str.replace(/[ÒÔÖ]/g, "O");
	str = str.replace(/[òôö]/g, "o");
	str = str.replace(/[ÙÛÜ]/g, "U");
	str = str.replace(/[ùûü]/g, "u");
	return str.replace(/[^A-Za-z0-9\-\_+]/gi, '');
}
exports.cleanupSpecialChars = cleanupSpecialChars;

/**
 * Get readable hashrate
 **/
exports.getReadableHashRate = function (hashrate) {
	let i = 0;
	let byteUnits = [' H', ' KH', ' MH', ' GH', ' TH', ' PH'];
	while (hashrate > 1000) {
		hashrate = hashrate / 1000;
		i++;
	}
	return hashrate.toFixed(2) + byteUnits[i] + '/sec';
}

/**
 * Get readable coins
 **/
exports.getReadableCoins = function (coins, digits, withoutSymbol) {
	let coinDecimalPlaces = config.coinDecimalPlaces || config.coinUnits.toString().length - 1;
	let amount = (parseInt(coins || 0) / config.coinUnits).toFixed(digits || coinDecimalPlaces);
	return amount + (withoutSymbol ? '' : (' ' + config.symbol));
}

/**
 * Generate unique id
 **/
exports.uid = function () {
	let min = 100000000000000;
	let max = 999999999999999;
	let id = Math.floor(Math.random() * (max - min + 1)) + min;
	return id.toString();
};

/**
 * Ring buffer
 **/
exports.ringBuffer = function (maxSize) {
	let data = [];
	let cursor = 0;
	let isFull = false;

	return {
		append: function (x) {
			if (isFull) {
				data[cursor] = x;
				cursor = (cursor + 1) % maxSize;
			} else {
				data.push(x);
				cursor++;
				if (data.length === maxSize) {
					cursor = 0;
					isFull = true;
				}
			}
		},
		avg: function (plusOne) {
			let sum = data.reduce(function (a, b) {
				return a + b
			}, plusOne || 0);
			return sum / ((isFull ? maxSize : cursor) + (plusOne ? 1 : 0));
		},
		size: function () {
			return isFull ? maxSize : cursor;
		},
		clear: function () {
			data = [];
			cursor = 0;
			isFull = false;
		}
	};
};
