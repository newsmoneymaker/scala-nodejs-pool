# Changes

## 1.0.0

* First release: Scala (XLA) pool derived from qwc-nodejs-pool (Monero based node, `get_block_template` / `submit_block`, wallet `transfer`) and its relatives. Stratum for `rx/xla`
  (XMRig protocol with the `algo` extension), share checking with the helper `hasher/rxhash`, which links the node's own Panthera library (blake2b + yespower + K12 in front of
  a RandomX variant), Scala addresses (prefix 0x9b, subaddress 0x5c1a; 2 decimal places), the unlocker reads the pool's real coinbase share from the wallet, payouts with the wallet's
  `transfer` (one transaction for all due miners, fee taken from the payouts), variable difficulty remembered per address and worker across reconnects.
* Diardi heights (blocks whose height is divisible by 4 belong to the allow-listed miners of the Scala team): the pool marks such jobs (`job.diardi`, `"diardi": true` in the job message, poolpayminer rests) and never submits a solution there.
* Tested: the hashing against real Scala mainnet blocks (`test/test-real-blocks.js`), a simulated node and wallet (`test/test-scala-pool.js`, `test/test-scala-payments.js`) and a real miner
  (poolpayminer `rx/xla`) against the pool and a mock node that verifies the blocks with the node's own library (`test/test-scala-miner.js`).
* Not yet checked on a real block found by the pool on the mainnet: the exact answer of the wallet's `get_transfer_by_txid` for a coinbase (the code expects `transfer.amount`), and a
  real payout with `subtract_fee_from_outputs`.
