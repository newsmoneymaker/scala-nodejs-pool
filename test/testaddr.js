// Valid Scala mainnet addresses for the tests (random keys, real prefix and Keccak checksum): makeAddress(n) is stable per n.
const path = require('path');
global.config = global.config || {};
const utils = require(path.join(__dirname, '..', 'lib', 'utils.js'));
const crypto = require('crypto');

exports.makeAddress = function (n, prefix) {
	const keys = crypto.createHash('sha512').update('scala-test-address-' + n).digest();       // 64 bytes: "spend key" and "view key"
	let p = prefix === undefined ? 0x9b : prefix, out = [];
	while (p >= 0x80) { out.push((p & 0x7f) | 0x80); p = Math.floor(p / 128); }
	out.push(p);
	const body = Buffer.concat([Buffer.from(out), keys]);
	return utils.base58Encode(Buffer.concat([body, utils.keccak256(body).slice(0, 4)]));
};
