# Installing a Scala pool

Paths below are examples: the pool in `/opt/scala-nodejs-pool`, the node and wallet in `/opt/scala`, all run by the user `scalapool`
(the systemd templates in `deployment/systemd/` use these paths).

## 1. Scala node and wallet

Scala is a Monero code base (node `scalad` v8.x, "Menger"). Build the node and the wallet from source (<https://github.com/scala-network/Scala>, branch `master`; there are no
recent binary releases). The node contains a Go library (libipfs), so **Go 1.26 or newer is needed for the build**:

```
git clone --depth 1 https://github.com/scala-network/Scala && cd Scala && git submodule update --init --recursive --depth 1
# Debian/Ubuntu: build-essential cmake pkg-config git python3 libboost-all-dev libssl-dev libzmq3-dev libpgm-dev libunbound-dev libsodium-dev
#   libhidapi-dev libusb-1.0-0-dev libunwind-dev liblzma-dev libreadline-dev libexpat1-dev   + Go from https://go.dev/dl/ in the PATH
mkdir build && cd build && cmake -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTS=OFF -DBUILD_GUI_DEPS=OFF ..
make -j4 daemon simplewallet wallet_rpc_server        # binaries in build/bin: scalad, scala-wallet-cli, scala-wallet-rpc
```

Two problems that were met with GCC 8 and Boost 1.67 (Debian 10): `src/device/device_ledger.cpp` line 321 does not compile with `boost::lock` on a recursive and a plain mutex:
use `std::lock` there (and `#include <mutex>`); and the IPFS snapshot importer is currently broken (see below). Newer distributions may build without changes.

Run the node (`deployment/systemd/scala-node.service`): `scalad --data-dir /opt/scala/data --non-interactive --rpc-bind-ip 127.0.0.1 --rpc-bind-port 11812 --p2p-bind-port 11811`.
The DNS seeds of the project (`seed-1.scala.network`, `seed-2.scala.network`) may be down; then give the node a live peer with `--add-priority-node HOST:11811` (the pool
`pool.scalaproject.io` answers on 95.217.44.235:11811). The chain (1.6 million blocks) takes some hours to synchronise; the blocks are not checked by RandomX up to the checkpoints.
The official snapshot `blockchain.raw` (IPFS, `scala-blockchain-import --ipfs-import`) needs the DNSLink `blockchain.raw.scala.network`, which does not exist at the moment, and the
importer expects capitalised JSON keys where the library answers with lowercase ones (`Status` / `Data`): fix the keys in `blockchain_import.cpp` if you want to use a snapshot.
`curl -s 127.0.0.1:11812/json_rpc -d '{"jsonrpc":"2.0","id":"0","method":"get_info"}'` shows `"synchronized": true` when the node is ready.
Open the P2P port 11811 in your firewall if you want incoming peers.

Create the pool wallet **after** the node is synchronised (a wallet made earlier starts to scan at height 0). The 25 words are printed once: **write them down and keep them
offline**, do not let the output land in a log:

```
scala-wallet-cli --generate-new-wallet /opt/scala/wallet/pool --password-file /opt/scala/wallet/password --daemon-address 127.0.0.1:11812
```

Then run the wallet RPC (`deployment/systemd/scala-wallet-rpc.service`): `scala-wallet-rpc --wallet-file /opt/scala/wallet/pool --password-file /opt/scala/wallet/password
--rpc-bind-ip 127.0.0.1 --rpc-bind-port 11820 --disable-rpc-login --daemon-address 127.0.0.1:11812 --trusted-daemon`. It listens on the local machine only and pays
without a password: keep only the coins that are about to be paid out in this wallet. The wallet's main address (`Ss...`) is the pool address (`poolServer.poolAddress`):
every block template pays its coinbase there. (The default ZMQ port of the node is 11813: the wallet RPC must not use it.)

## 2. RandomX helper

The helper must use the node's own RandomX variant (Panthera): use the library the node build made (`build/external/randomx/librandomx.a`, it contains yespower and K12
as well) with its header `external/randomx/src/randomx.h`. (The header of Panthera has an extra `bool` argument in `randomx_calculate_hash`: the helper passes `false`, as the node does.)

```
mkdir -p /opt/randomx/include /opt/randomx/lib
cp /path/to/Scala/external/randomx/src/randomx.h /opt/randomx/include && cp /path/to/Scala/build/external/randomx/librandomx.a /opt/randomx/lib
cd /opt/scala-nodejs-pool/hasher && make RANDOMX=/opt/randomx
```

The dataset of this RandomX variant is small (64 MiB), the helper needs a few hundred MB of RAM. Check it against the chain: `node test/test-real-blocks.js`.

## 3. Redis

Use a dedicated instance with a password and AOF (`deployment/redis-pool.conf.example`, unit `scala-pool-redis`, port 6385).

## 4. The pool

```
cd /opt/scala-nodejs-pool && npm install --production
cp config_examples/scala.json config.json      # then edit it
```

Edit `config.json`: `poolHost`, `poolServer.poolAddress`, the ports and the certificate for TLS (`poolServer.sslCert/sslKey`), `redis`, `api.password`,
`blockUnlocker.poolFee` and `donations`, `payments`. **Keep `payments.dryRun: true` until the rehearsal below.**

```
cp deployment/systemd/*.service /etc/systemd/system/ && systemctl daemon-reload
systemctl enable --now scala-pool-redis scala-node scala-wallet-rpc
systemctl enable --now scala-pool scala-pool-api scala-pool-unlocker scala-pool-payments scala-pool-charts
```

The pool runs as separate modules (`init.js -module=pool|api|unlocker|payments|chartsDataCollector`), each in its own unit. The pool module keeps one hasher process
(and its RandomX dataset), so run it as one process. Until payouts are proven, restrict the stratum ports with `poolServer.allowIPs`.

## 5. Website

Copy `website_example/` to the web root, set `poolHost`, the contact and links in `config.js`, and proxy `/api` to the pool API on 127.0.0.1:8123
(`deployment/apache-vhost.conf.example` exposes only the read-only methods).

## 6. Rehearse the payments

1. `payments.dryRun: true`: the log of `scala-pool-payments` shows what would be paid.
2. Fund the pool wallet with a few coins (or wait for the first block), credit a small balance in Redis to your own test addresses
   (`<coin>:workers:<address>`, field `balance`), set `payments.onlyAccounts` to them, `dryRun: false`, and watch the payout confirm.
3. Remove the test accounts from Redis and set `onlyAccounts` to `[]`.

Good to know: block rewards can be spent after 60 blocks (plus the wallet's usual 10 confirmations for change); `deployment/pause-payments.sh` stops new payouts
at once; a wallet cannot abandon a transaction, so a payout that stays unconfirmed for `pendingTimeoutHours` is only reported in the log and must be checked by hand.
