// Unit checks of the Scala address handling (Monero style base58 + Keccak checksum). Run: node test/test-account.js
const path = require('path');
global.config = {};
const u = require(path.join(__dirname, '../lib/utils.js'));
const {makeAddress} = require('./testaddr.js');

const OK = makeAddress(1);
let failed = 0;
function check (name, cond) { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) failed++; }

check('Keccak-256 of the empty string (the original Keccak, not SHA3)', u.keccak256(Buffer.alloc(0)).toString('hex') === 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
check('Keccak-256 of "abc"', u.keccak256(Buffer.from('abc')).toString('hex') === '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
const XMR = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';   // a real Monero address, checks base58 and the checksum against an independent implementation
check('a real Monero address passes with the Monero prefix', !!u.parseAddress(XMR, {standard: 0x12, integrated: 0x13, subaddress: 0x2a}));
check('base58 round trip', u.base58Encode(u.base58Decode(XMR)) === XMR);

check('valid standard address', u.validateMinerAddress(OK) && OK.length === 97 && OK.startsWith('S'), OK.slice(0, 8));
const REAL = 'SvjVucMW4PA968WJP7rXRr1fkRVch5q6rLnh86LkZCWFPJiDEB2vizX6VjMezJaKiCN2K1kVvAHDbUmiB1tPjZJP2hety4dnf';   // a real Scala mainnet address (one of the Diardi miners in the node's source): checks prefix 0x9b and the checksum
check('a real Scala mainnet address is valid', u.validateMinerAddress(REAL) && REAL.length === 97);
check('canonical form is the address itself', u.canonicalMinerAddress(OK) === OK);
check('a subaddress is accepted', u.validateMinerAddress(makeAddress(2, 0x5c1a)));
check('an integrated address is not accepted for mining', !u.validateMinerAddress(makeAddress(3, 0x6599)));
check('a Monero address is not a Scala address', !u.validateMinerAddress(XMR));
check('bad checksum rejected', !u.validateMinerAddress(OK.slice(0, -1) + (OK.slice(-1) === '2' ? '3' : '2')));
check('other character rejected', !u.validateMinerAddress(OK.slice(0, -1) + '0'));
check('too short rejected', !u.validateMinerAddress(OK.slice(0, 60)));
check('too long rejected', !u.validateMinerAddress(OK + '1'));
check('empty and non-string rejected', !u.validateMinerAddress('') && !u.validateMinerAddress(null) && !u.validateMinerAddress(42));
check('account = address, no note', u.parseMinerAccount(OK).account === OK && u.parseMinerAccount(OK).note === null);
check('split back', u.splitMinerAccount(OK).address === OK && u.splitMinerAccount(OK).note === null);
check('reward mode prefix', u.determineRewardData('solo:' + OK).rewardType === 'solo' && u.determineRewardData('solo:' + OK).address === OK);

const dev = u.donationTable({donations: {[OK]: 0.5, 'nonsense': 1, [makeAddress(4)]: 50}});
check('donation table keeps valid entries only', Object.keys(dev).length === 1 && dev[OK] === 0.5);

console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall checks passed');
process.exit(failed ? 1 : 0);
