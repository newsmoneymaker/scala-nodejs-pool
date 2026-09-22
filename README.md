# scala-nodejs-pool

Mining pool software for **Scala (XLA)** written in Node.js: a stratum server for Scala's RandomX variant (Panthera / DefyX, `rx/xla`) with share
checking, block accounting through the pool wallet, and batch payouts. It is a fork of [cryptonote-nodejs-pool](https://github.com/dvandal/cryptonote-nodejs-pool)
by Dvandal (GNU GPL v2) and of its adaptations [epic-nodejs-pool](https://github.com/newsmoneymaker/epic-nodejs-pool) and
[veil-nodejs-pool](https://github.com/newsmoneymaker/veil-nodejs-pool), [scash-nodejs-pool](https://github.com/newsmoneymaker/scash-nodejs-pool), written for the Monero-style daemon and wallet RPC of Scala (v8.x).
Live example: <https://scala.pool-pay.com>.

## What it does

* **Stratum server** (plain TCP and TLS ports, XMRig protocol with the `algo` extension): the pool asks the node for a block template
  (`get_block_template`), gives every miner the hashing blob and a share target that follows the miner's hashrate (vardiff), and checks every share itself
  with a small C++ helper (`hasher/rxhash`) that links **the node's own Panthera library** (blake2b, yespower and K12 in front of a RandomX variant with its own
  parameters): the hash of the hashing blob with the seed hash as key. A share that meets the network difficulty is submitted to the node with `submit_block`.
  The jobs announce the algorithm `rx/xla`, so **a miner that knows `rx/xla` is needed** ([poolpayminer](https://github.com/newsmoneymaker/poolpayminer) 1.1.6 or newer).
* **Accounts** are Scala addresses (`Ss...` / `Sv...`, 97 characters, prefix 0x9b, Keccak checksum verified; subaddresses are fine, integrated addresses are not),
  optionally `+worker`, with a reward mode prefix `prop:` (shared, default) or `solo:`.
* **Rewards:** PROP with time weighting (slush) or SOLO.
* **Block unlocker:** a block is settled after `depth` blocks (the coinbase unlocks after 60). The reward is what the pool wallet received in the block's
  coinbase transaction (wallet `get_transfer_by_txid` on the block's `miner_tx_hash`; the coinbase also carries the share of the Diardi maintainer, which is not the
  pool's); a block that is no longer on the chain is marked orphaned and nothing is credited.
* **Payment processor:** everyone who is due is paid in **one wallet `transfer` per round** (the network fee is shared by the paid miners or paid by
  the pool). The balance is debited before sending; a batch whose outcome is unknown (crash, timeout) is found again among the wallet's transfers by its
  destinations and never sent twice; refused or failed batches go back to the balances. Dry-run mode, a whitelist for rehearsals and an emergency brake
  (`deployment/pause-payments.sh`).
* **Website and API:** a ready website (`website_example/`) with the dashboard and its four graphs, blocks, payments, top miners, worker statistics, a
  "Getting started" page with a config generator, and the public read-only JSON API.
* **Diardi heights.** Since hard fork 13 every block whose height is divisible by 4 belongs to the allow-listed "Diardi" miners of the Scala team (a different proof of work and a
  signature of a listed key are required; the list is in the node's source). Nobody else can mine those heights, so an ordinary pool works on 3 of 4 blocks. The pool still
  hands out jobs there (the shares are real work and count in the round like any other) but never submits a "block" found at such a height (`job.diardi`). The job message carries `"diardi": true`: poolpayminer 1.1.6
  rests while such a block is found (and says why in its window); other miners keep hashing for nothing. The variable difficulty forgets the share times at such a job, so a rest does not look like a slow miner.
* **Protection against connection floods:** limits per IP, a login deadline, an optional IP allow list, banning of miners with many invalid shares.
* **Tests** (`test/`): the hashing method is checked against real Scala mainnet blocks (`test/test-real-blocks.js`: the hash equals the `pow_hash`
  reported by `scalad`), and a simulated node and wallet let a real miner (`rx/xla`) find shares and blocks against the pool code (`test/test-scala-miner.js`).

## Developer donation (please read)

The pool takes a **developer donation** from the reward of every block it finds, before the miners' shares are computed. It is configured in
`config.json` (see `config_examples/scala.json`):

```json
"blockUnlocker": {
  "poolFee": 1,
  "donations": { "SvmAKFuyc285iVGsiZvbZq9ER8KX7JwYpHDqGR6qciV7dLnyPPT1SESZoE7z6aoSBa5yMVMHqNbsnA8Ftci6FGW437HFMcLxn": 0.5 }
}
```

* `poolFee` is the fee of the pool operator (percent). `donations` is a table `Scala address -> percent` (up to 10% per entry) for the developers of
  this software; **the default is 0.5% to the address of the project's own pool**. The donation is paid like any other balance.
* It is included in the "Pool Fee" figure that the pool's website and API show to the miners (as in the original software).
* You are free to change the percentage, the address or to empty the table (`"donations": {}`): it is your pool and the license is the GPL.
  Please tell your miners the truth about the fees of your pool.
* This has nothing to do with the miner poolpayminer (a separate project with its own fee).

## Installation

See [docs/INSTALL.md](docs/INSTALL.md): the Scala node and wallet (build from source), the RandomX helper, Redis, the pool services (systemd
templates in `deployment/`), the website and the first payout rehearsal.

Requirements: Linux, Node.js 18 or newer, Redis, a Scala node (`scalad` v8.x) synchronised with the network and `scala-wallet-rpc`
with the pool wallet, a C++ compiler and the node's Panthera library for the helper, a web server for the website and a TLS certificate for the TLS stratum ports.

## Miners

[poolpayminer](https://github.com/newsmoneymaker/poolpayminer) (Windows and Linux, free, has its own fee) knows the algorithm `rx/xla` since version 1.1.6.
Example: `poolpayminer -a rx/xla --tls -o scala.pool-pay.com:9701 -u SsYourAddress+rigname -p x -k`. The stock XMRig does not know this algorithm; [XLArig](https://github.com/scala-network/XLArig)
is the Scala project's own miner (not tested with this pool).

## Tests

```
npm install
node test/test-account.js                 # address handling, needs nothing else
make -C hasher RANDOMX=/path/to/randomx-prefix
node test/test-real-blocks.js             # the hash of real mainnet blocks, needs only the helper
# The others use test/config.test.json and a THROWAWAY Redis on port 16379 (they flush it, never point them at a real database):
redis-server --port 16379 --requirepass CHANGE_ME_REDIS_PASSWORD --save "" --appendonly no &
node test/test-scala-pool.js                # simulated node + pool + a miner that really mines
MINER_BIN=/path/to/poolpayminer node test/test-scala-miner.js   # the same with the real miner (rx/xla)
node test/test-scala-payments.js            # unlocker and payments against a simulated node and wallet
```

## Money warning

The payment processor moves real coins. Rehearse first: `"dryRun": true`, then a whitelist (`onlyAccounts`) with a few small payouts of your own,
then enable it. A transaction that has been sent to the network can not be cancelled. Keep the wallet backup (the 25 word seed) and the wallet password private.

## License and credits

GNU GPL v2 (see [LICENSE](LICENSE)). Based on cryptonote-nodejs-pool, Copyright (c) Dvandal and contributors. Scala and RandomX are separate programs and are
not included.
