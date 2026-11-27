# Review: core (`packages/sui`, `packages/bcs`)

Scope: BCS, transaction data, Ptb, Resolve, Tx, signing, TransactionJson, Move runtime, the gRPC-web transport and services.
Baseline: `bun test packages/sui packages/bcs` passes (362 pass, 52 skipped live). Nothing under `packages/` was changed.
Every CONFIRMED item was reproduced with a throwaway script or test in the reviewer's scratch directory, or is certain from the code as quoted.

## Summary

- **One high-severity bug.** When a transaction spends from the gas coin, gas payment selection stops at the budget, so the gas coin can hold less than the transaction spends. `Ptb.coin({ amount })` for SUI (the README default) fails on chain with gas charged whenever the largest coin is smaller than the amount. Reproduced on devnet.
- **The default `Tx.run` / `Tx.resolve` error type omits `InsufficientGas`**, the most likely failure of the default path.
- **Streams can end short without an error.** The transport does not require the gRPC trailers frame and `resumable` does not require `QueryEnd`, so a `list` cut mid-way completes normally.
- **Several places turn bad input or unexpected node output into defects** where typed errors are promised: Ptb and Move builders, `Transactions.execute` on an unknown owner kind, protobuf request encoding.
- **Bundle: the README row grew from 355 to 389 KB for two reasons**, both measured: `SuiGrpc.layer` now links four services `Tx.run` never uses (+27.5 KB), and allowance resolution is always linked through `Resolve.balances` (+5.8 KB). Without them the Bun number is 355.4 KB.
- **Largest optimizations.** Pruning protobuf messages the SDK never reads saves 48 KB minified on the same program. `Tx.build` does 4 sequential round trips where 2 suffice.

Counts: 1 high, 5 medium, 13 low, 6 nit.

## Findings

### CORE-1: gas payment covers only the budget when the gas coin is spent
- **Severity** high · **Category** correctness · **CONFIRMED** (devnet)
- **Where** `packages/sui/src/Resolve.ts:859-873` (`pickCoins`), `:882-907` (`auto`), `:925-934` (`coins`), `:847-857` (`addressBalance`), `:607` (no balance check on the gas path)
- **What is wrong.** `pickCoins` takes coins until their total reaches the gas budget. When commands use `GasCoin` (`Ptb.splitCoins(Ptb.gas, …)`, or a SUI `Ptb.coin` / `Ptb.balance` intent that falls back to the gas coin), the gas coin must also hold what those commands spend. `@mysten/sui` passes every SUI coin as payment (`core-resolver.ts:218-248`). The budget dry run uses a mocked gas coin, so nothing fails before execution.
- **Failure scenario.** Fresh devnet key, one faucet coin split into 6 SUI + 3.998 SUI, no address balance. `Tx.build(Ptb.coin({ amount: 8 SUI }) → transferObjects)` resolves to `SplitCoins(GasCoin)` with a payment of one coin (6 SUI). `Tx.execute` returns `ExecutionFailed: InsufficientCoinBalance in command 0` (digest `HotB4cY4GFa5wTKNbwY3PmQnz2ze1pxArERoi9ucMGiv`), gas charged. The wallet held 9.998 SUI.
  - The same happens with an address balance: `auto` returns `[reservation]` plus coins for `budget − available` only.
  - Related: the gas path of `coinIntents` never compares the amount with what the sender owns (`if (key === GAS || ab >= t.total) return`), so `Ptb.coin({ amount: 100 SUI })` from a 1 SUI wallet builds and then fails on chain instead of raising `InsufficientBalance`.
- **Fix.** When `usesGasCoin(draft)`, pay with every SUI coin not used as an input (255 with a reservation, else 256), as Mysten does. Add a typed `InsufficientBalance` check on the gas path (`balance.total − reserved < t.total`). The test "reservation first, coins only for the rest" in `balances.test.ts` encodes the current behaviour and needs updating.
- **Effort** S

### CORE-2: `InsufficientGas` is missing from the error type of the default pipeline
- **Severity** medium · **Category** api / error typing · **CONFIRMED** (`tsc`)
- **Where** `packages/sui/src/Tx.ts:34-47` (`Resolve.auto as unknown as Resolve.PaymentStrategy<E, R>`), inherited by `Tx.build`, `Tx.run` and `TransactionJson.resolve` (`TransactionJson.ts:955`)
- **What is wrong.** With no `payment` option, `E` defaults to `never`, and the cast hides `Resolve.auto`'s own errors. `Incomplete` and `RpcError` still appear because other steps raise them; `InsufficientGas` does not.
- **Failure scenario.** `Extract<Effect.Error<typeof Tx.run(recipe, { signer })>, { _tag: "InsufficientGas" }>` is `never`, so `Effect.catchTag("InsufficientGas", …)` does not compile and exhaustive handlers treat it as impossible, yet the effect fails with it at run time. With `payment: Resolve.auto` written out, the type is correct.
- **Fix.** Default the type parameters to the default strategy's: `<E = RpcError | InsufficientGas | Incomplete, R = Chain | Coins>`, and drop the cast. Add a type-level test.
- **Effort** S

### CORE-3: a stream cut mid-way completes normally
- **Severity** medium · **Category** correctness · **CONFIRMED** (logic, with fakes); PLAUSIBLE in the field (needs a proxy that ends the body cleanly)
- **Where** `packages/sui/src/grpc/GrpcWeb.ts:60-74` (`toFrames`), `packages/sui/src/grpc/scan.ts:57`
- **What is wrong.** Two independent end-of-stream signals are ignored.
  - `toFrames` drops a partial frame left in the buffer and does not require a trailers frame. A body with two data frames and no trailers yields two messages and a clean end; a body cut inside a frame does the same.
  - `resumable` treats a stream that ends without a `QueryEnd` frame as finished. `query_options.proto:201-216` says every successful stream sets `QueryEnd` on exactly one frame and a failed one does not.
- **Failure scenario.** `Events.list({ start: 1n, end: 100n })` against a stream that stops after checkpoint 2 with no `QueryEnd` returns 2 events and succeeds. An indexer records the range as fully scanned. `CheckpointData.follow` recovers through its gap fill; plain `list` callers do not.
- **Fix.** In `call`, fail with `UNAVAILABLE` (retryable) when the body ends with leftover bytes or without a trailers frame. In `resumable`, fail with `DATA_LOSS` when the stream ends and no frame carried `end`.
- **Effort** S

### CORE-4: a BCS vector length is trusted before any element is read
- **Severity** medium · **Category** security (denial of service) · **CONFIRMED** (Bun 1.4.4)
- **Where** `packages/bcs/src/Bcs.ts:422-428` (`new Array(n)` then fill)
- **What is wrong.** The length prefix (up to 2³²−1) sizes an array before the reader checks that the input can hold that many elements.
- **Measurements.**
  - `Bcs.decode(Bcs.vector(Bcs.u64))` on the 5 bytes `uleb(100_000_000)`: 848 MB RSS and 384 ms before `unexpected end of input`. JavaScriptCore allocates eagerly up to somewhere between 100M and 200M entries; Node 24 does not.
  - Zero-size elements (`Bcs.tuple([])`, `Bcs.struct({})`, `Bcs.bytes(0)`): 5M entries take 1.2 GB and 0.8 s; 30M abort the process under a 6 GB cap; `2³²−1` reached 31 GB RSS before it was killed. The loop never touches the input, so nothing stops it.
- **Who is exposed.** Anything decoding bytes it did not produce: `TransactionData.decode` on wallet-returned bytes (`Tx.ts:114`), object and event contents, and parsers in other packages that use `Bcs.vector` on outside bytes (for example `packages/seal/src/EncryptedObject.ts:28,54`; read, not run).
- **Fix.** Do not preallocate: `push` in the loop so the first missing element fails. Reject a length greater than the remaining bytes when the element has a non-zero minimum size, and cap lengths of zero-size elements (Rust `bcs` caps sequences at 2³¹−1 and container depth at 500; neither limit exists here).
- **Effort** S

### CORE-5: `Transactions.execute` can die, or invent a failure, after the transaction ran
- **Severity** medium · **Category** error handling · **CONFIRMED** (fake `GrpcWeb`)
- **Where** `packages/sui/src/grpc/convert.ts:25` (`owner` throws), `:74-79` (`effects`), `packages/sui/src/grpc/TransactionsGrpc.ts:25,39,42`
- **What is wrong.**
  - `owner()` throws on an owner kind it does not know, and `effects()` runs inside a plain `Effect.map`. An effects message with `output_owner.kind = 6` makes `execute` (and `simulate`, `get`) die with `Error: unknown owner kind 6`. For `execute` the transaction has already been submitted, and the caller gets a defect with no digest. `ConsensusAddressOwner` (kind 5) arrived this way once already.
  - A response without `transaction` becomes `{ digest: "", status: Failure("unknown execution failure") }`. `Tx.execute` then raises `ExecutionFailed` ("reached the chain and Move aborted, gas was charged") with an empty digest for what is a malformed response.
- **Fix.** Wrap the conversions with `scan.convert` (already used by `DynamicFieldsGrpc`) so a throw is `RpcError DATA_LOSS`. Map an unknown owner kind to a value (`{ _tag: "Unknown", kind }`) rather than throwing. Treat a missing `transaction`, `digest` or `effects.status` as `DATA_LOSS`.
- **Effort** S

### CORE-6: any per-object error in `BatchGetObjects` is reported as `ObjectNotFound`
- **Severity** medium · **Category** error typing · **CONFIRMED** (fake `GrpcWeb`)
- **Where** `packages/sui/src/grpc/ObjectsGrpc.ts:47-52`
- **What is wrong.** `GetObjectResult` is `object | error (google.rpc.Status)`. Everything that is not `object`, including a missing array entry, becomes `ObjectNotFound`.
- **Failure scenario.** The node answers one entry with `{ code: 13, message: "storage error" }`. `Objects.get` fails with `ObjectNotFound`. Callers that act on absence (`AllowanceNotFound`, `DynamicFieldNotFound`, lifecycle reconciliation from on-chain evidence) take a transient node fault for a deleted object.
- **Fix.** `ObjectNotFound` only for `error.code === 5`; other statuses become `RpcError` with the mapped code and message; a missing entry is `DATA_LOSS`.
- **Effort** S

### CORE-7: Ptb and Move builders throw on bad addresses and type strings
- **Severity** low · **Category** error handling · **CONFIRMED**
- **Where** `packages/sui/src/Ptb.ts:142` (`address`), `:147` (`object`), `:171-177` (`moveCall`), `:194` (`makeMoveVec`), `:231`, `:323`, `:340`; `packages/sui/src/Move.ts:166` (`obj`), `:229` (`param`)
- **What is wrong.** `Address.normalize` and `TypeTag.parse` throw. Inside a recipe that is a defect, although a recipe's failures are "in its type" and `InvalidPureValue` exists for exactly this.
- **Failure scenario.** `Ptb.address(userTypedRecipient)` with `"nope"` dies with `Error: invalid Sui address: nope`; `Ptb.address` throws at call time, before any Effect exists. Also dying: `Ptb.object("nope")`, `Ptb.moveCall({ typeArguments: ["0x2::sui"] })`, `Ptb.coin({ type: "SUI" })`, `Move.obj("nope")`, `Move.param("0x2::sui", 1n)`. `Move.pure(Move.address, "nope")` is correctly a typed `InvalidPureValue`.
- **Fix.** Fail with `InvalidPureValue` (or a new `InvalidArgument`) from these builders; `Ptb.address` can go through `Move.address`.
- **Effort** S

### CORE-8: other defects where a typed error is expected
- **Severity** low · **Category** error handling · **CONFIRMED**
- **Where and scenario.**
  - `packages/sui/src/Resolve.ts:309,719`: `Ptb.nested(intentResult, 1)` makes `Resolve.balances` die (`a coin/balance intent has a single result`). `InvalidBalanceIntent` exists. A forward `Result` reference in a hand-built draft dies at `results.get(...)!` (`:498`, `:639`).
  - `packages/sui/src/Resolve.ts:778`, `packages/sui/src/Tx.ts:101`: `T.encode` throws inside the generators. `Tx.build(recipe, { sender: "0x2" as Address })` dies with a `SchemaError`, and so does a draft with more than 65,535 inputs.
  - `packages/sui/src/grpc/GrpcWeb.ts:112` with `Rpc.ts:81`: the request is encoded eagerly with `getOrThrow`. `CheckpointData.get(-1n)` and `Objects.listOwned(owner, { pageSize: 1.5 })` die with `ProtobufMessageError`.
  - `packages/sui/src/grpc/ObjectsGrpc.ts:79`, `packages/sui/src/grpc/CoinsGrpc.ts:36`: `listOwned` and `Coins.list` convert inside `map`, so a malformed object is a defect; `get` on the same data is `DATA_LOSS`.
- **Fix.** `InvalidBalanceIntent` for the intent cases; validate the plan once in `Resolve.finish` / `budget` and fail with a typed error; encode the request inside the effect and map failure to `RpcError INVALID_ARGUMENT`; use `scan.convert` in the listings.
- **Effort** M

### CORE-9: `Tx.build` runs its lookups one after another
- **Severity** low · **Category** performance · **CONFIRMED** (testnet trace)
- **Where** `packages/sui/src/Tx.ts:42-48`, `packages/sui/src/Resolve.ts:730-793`
- **Measurement.** `splitCoins(gas) + transfer`, cold: 347 ms, in order `GetEpoch` (price) → `GetServiceInfo` + `GetEpoch` (the dry run's `ValidDuring`) → `SimulateTransaction` → `GetBalance` (payment). With `Ptb.coin` and one object: `GetFunction` + `BatchGetObjects` → `GetBalance` → `Simulate` → `GetBalance` (SUI again), 328 ms. Each phase is one round trip of about 85 ms.
- **What is wrong.** Only the dry run depends on the others. Gas price, chain info and the gas owner's balance are independent of inputs and of the budget, so 4 phases can be 2. The SUI balance is read twice (intents, then payment). `GetEpoch` is called twice with different masks (`ChainGrpc.ts:16,30`).
- **Fix.** Start gas price, `Chain.info` and the SUI balance alongside `Resolve.inputs`; pass the balance from `balances` to the payment step; fetch `reference_gas_price` in the same `GetEpoch` as `first_checkpoint`. `@mysten/sui` does the equivalent with one `Promise.all`.
- **Effort** M

### CORE-10: one `GetFunction` per MoveCall, and no in-flight sharing in the caches
- **Severity** low · **Category** performance · **CONFIRMED**
- **Where** `packages/sui/src/Resolve.ts:216-224`, `packages/sui/src/grpc/cache.ts:11-32`, `packages/sui/src/grpc/PackagesGrpc.ts:63-70`
- **What is wrong.**
  - `Resolve.inputs` asks for the signature of every MoveCall once any object input is unresolved, including calls that take no unresolved input.
  - `successByKey` and `successFor` store only finished results. Five concurrent identical `getFunction` calls on a cold cache make five RPCs; four concurrent `Chain.info` reads make eight.
- **Failure scenario.** A PTB with 200 calls to one function sends 200 concurrent `GetFunction` requests the first time it is built.
- **Fix.** In `Resolve.inputs`, fetch only for calls with an unresolved object argument, unique by target. In the caches, keep the in-flight effect (a `Deferred`) and drop it on failure.
- **Effort** S

### CORE-11: `Objects.get` does not deduplicate, though three comments say so
- **Severity** low · **Category** docs / performance · **CONFIRMED**
- **Where** `packages/sui/src/Objects.ts:2`, `packages/sui/src/grpc/ObjectsGrpc.ts:28-29,36-55`
- **What is wrong.** Four concurrent gets of two ids send a `BatchGetObjects` with four entries. 120 gets with 20 repeats send batches of 50, 50 and 20, the last one all repeats. The live test asks for `0x6` twice and only checks that one request was made.
- **Fix.** Group entries by id inside the resolver and complete every entry of a group from one result, or correct the comments.
- **Effort** S

### CORE-12: gRPC-web frame reassembly is quadratic in message size
- **Severity** low · **Category** performance · **CONFIRMED** (fake `HttpClient`)
- **Where** `packages/sui/src/grpc/GrpcWeb.ts:62-73`
- **What is wrong.** Every body chunk is concatenated onto the buffered remainder, so a message of size M arriving in chunks of size c is copied M²/2c bytes.
- **Measurement.** One message in 16 KiB chunks: 1 MiB 30 ms, 4 MiB 199 ms, 16 MiB 2,699 ms (809 ms in 64 KiB chunks). Checkpoints with contents are the large case.
- **Fix.** Keep a chunk list and the frame length read from the first 5 bytes; concatenate once per frame.
- **Effort** S

### CORE-13: `TransactionJson` misses `Validity` in its ambiguous-variant guard
- **Severity** low · **Category** correctness · **CONFIRMED** (against `Transaction.from`)
- **Where** `packages/sui/src/TransactionJson.ts:507-512` (`VARIANT_KEYS`)
- **What is wrong.** The guard exists to refuse objects carrying two enum variants, because parsers disagree on which one counts. `Validity` is not in the list.
- **Failure scenario.** `expiration: { Validity: { …, maxEpoch: "999", allowedProposers: null }, ValidDuring: { …, maxEpoch: "2" } }` decodes here as `ValidDuring` with `maxEpoch` 2, and in `@mysten/sui` as `Validity` with `maxEpoch` 999. `{ None: true, Epoch: "5" }` is refused, as intended.
- **Fix.** Add `"Validity"`, and derive the set from the schemas so it cannot drift again.
- **Effort** S

### CORE-14: `Ptb.object` ignores `mutable` on a repeat, and `Ptb.objectArg` is not deduplicated
- **Severity** low · **Category** correctness · **CONFIRMED**
- **Where** `packages/sui/src/Ptb.ts:145-160`
- **Failure scenario.**
  - `Ptb.object(id, { mutable: false })` then `Ptb.object(id, { mutable: true })` leaves the input forced immutable; a later `&mut` use fails on chain. `sharedObject` widens on a repeat, `object` does not.
  - `Ptb.objectArg(ref)` then `Ptb.object(sameId)` produces two inputs for one object, which validators reject as a duplicate input.
- **Fix.** Widen `mutable` on a repeat (true wins) and register `objectArg` ids in `objectIndex`.
- **Effort** S

### CORE-15: missing response fields are replaced with plausible values
- **Severity** low · **Category** error handling · **CONFIRMED** (code)
- **Where** `packages/sui/src/grpc/ChainGrpc.ts:21,31`, `packages/sui/src/grpc/convert.ts:28-37`
- **What is wrong.** `reference_gas_price ?? 1000n` guesses a gas price; `epoch ?? 0n` feeds `ValidDuring` and coin reservations; `chain_id` is cast without a check; `object()` asserts `version!`, `digest!` and `object_type!`.
- **Failure scenario.** A node or proxy that drops `reference_gas_price` gives every transaction a price of 1000, and the node rejects it later with an unrelated message.
- **Fix.** Fail with `DATA_LOSS` when a field the caller depends on is absent.
- **Effort** S

### CORE-16: BCS decoding validates twice and is 3 to 14 times slower than `@mysten/bcs`
- **Severity** low · **Category** performance · **CONFIRMED** (Bun 1.4.4)
- **Where** `packages/bcs/src/Bcs.ts:488-505` (reader, then `Schema.decodeUnknownResult` over the result); `encode` at `:471-480`
- **Measurement.**

  | Case | Ours | `@mysten/bcs` |
  |---|---|---|
  | `TransactionData` decode ×2000 | 84 ms | 16 ms |
  | `TransactionData` encode ×2000 | 54 ms | 20 ms |
  | `Coin` decode ×20,000 | 75 ms | 9 ms |
  | `vector<u64>`, 100k items | 44 ms | 7.6 ms |
  | `vector<u8>`, 1 MB | 142 ms | 10 ms |

- **What is wrong.** The reader already guarantees ranges, lengths, UTF-8 and variant indexes. The schema pass re-checks every element, including a regex per address and a base58 decode per digest.
- **Fix.** Compile a per-layout flag "the reader's output is already the decoded type" and skip the schema pass for it; only `Bcs.transform` nodes need the schema. Use `getBigUint64` for `u64`.
- **Effort** M

### CORE-17: a sponsor wallet may change an expiration that a key sender then signs
- **Severity** low · **Category** security (policy) · **CONFIRMED** (scripted wallet)
- **Where** `packages/sui/src/Tx.ts:77-90`
- **What is wrong.** `checkChange` refuses gas and expiration changes only when a key signer is the gas owner. With a wallet as gas owner and a key as sender, the wallet's bytes win, including a different `expiration`. The key signs it unseen. The comment and README promise only "gas terms it pays for".
- **Failure scenario.** The sender sets `Epoch(10)` to bound the transaction's life; the sponsoring wallet returns bytes with `None`. `Tx.execute(data, [key, wallet])` succeeds and submits the `None` bytes, signed by the sender's key.
- **Fix.** When any key signer exists, allow the wallet to change `expiration` only from unset (`None`) to `ValidDuring`, or refuse expiration changes outright.
- **Effort** S

### CORE-18: `GasEstimationFailed` and `ExecutionFailed` drop what the node reported
- **Severity** low · **Category** error typing · **CONFIRMED** (code)
- **Where** `packages/sui/src/Resolve.ts:51-53,786-788`, `packages/sui/src/Tx.ts:62-67`, `packages/sui/src/grpc/convert.ts:46-55`
- **What is wrong.** `GasEstimationFailed` keeps only `description`, although the simulation status has `command` and `abortCode`. Neither error carries the Move abort location (package, module, function) or the clever-error fields the node returns in `ExecutionError`.
- **Fix.** Carry the `Status` failure fields in both errors and add the abort location to `Status`.
- **Effort** S

### CORE-19: HTTP failures map to `UNKNOWN`
- **Severity** low · **Category** error typing · **CONFIRMED**
- **Where** `packages/sui/src/grpc/GrpcWeb.ts:119-121`
- **What is wrong.** Measured: 401, 403 and 404 give `UNKNOWN`. The gRPC HTTP mapping is 401 → `UNAUTHENTICATED`, 403 → `PERMISSION_DENIED`, 404 → `UNIMPLEMENTED`, 429 / 502 / 503 / 504 → `UNAVAILABLE`. A wrong API key or base URL is indistinguishable from an unknown fault.
- **Fix.** Apply the standard table.
- **Effort** S

### Nits

- **CORE-20 (docs, CONFIRMED).** `CheckpointData.ts:47` and `Events.ts:120` say `subscribe` "never ends successfully". It ends cleanly when the server closes the stream, which `follow` handles and a direct caller does not expect.
- **CORE-21 (correctness, CONFIRMED).** `Bcs.string` encodes a lone surrogate as U+FFFD (`"\ud800"` gives `ef bf bd`), so the encoder changes data it is documented to validate. `Bcs.encode` of a 50,000-deep `TypeTag` throws (`Result adapter can only return schema issues`) instead of returning a failure.
- **CORE-22 (api, CONFIRMED).** `Move.datatype` and `Move.withGet` (`Move.ts:102,106`) mutate the schema they are given. Generated code passes a fresh schema; `Move.datatype(type, () => Move.Table)` by hand would rewrite `.type` on the shared `Table`, which is also `Bag`, `ObjectTable` and `ObjectBag`.
- **CORE-23 (api).** `Packages.Parameter` now has `typeName` plus `typeArguments`, absent for vectors and whenever a type parameter appears. `PackagesGrpc.typeString` already builds the full closed type string; exposing that as one `type?: string` would cover vectors and drop a field. "Absent" also cannot be told apart from "the transport does not report it".
- **CORE-24 (correctness, CONFIRMED).** A unary call stops at the first message and cancels the body (`GrpcWeb.ts:146`), so an error status in the trailers after a message is ignored. No latency cost: head and drain both took 74 ms median against testnet.
- **CORE-25 (tests).** `packages/bcs/test` is empty; canonical ULEB, bool and option tags, trailing bytes and length limits are tested only through other packages. There are no offline tests for gRPC-web framing (trailers, split frames, HTTP status mapping), for `ObjectsGrpc` batching, or for the error type of the default `Tx.run`.

## Checked and found sound

- **Allowance checks** against `0x2::allowance` Move source: spender (`None` means nobody), app binding, start inclusive and expiration exclusive, lifetime cap, periodic window index.
- **Budget formula and `ValidDuring` window** match `@mysten/sui` 3.0.1. An explicit `None` or `Epoch` expiration does not break the dry run on testnet.
- **ULEB128** canonical form and overflow; bool and option tags; trailing bytes; deep nesting on decode (a typed failure).
- **`checkChange`** for sender, gas owner, commands and inputs, and the "second wallet may not change" rule.
- **`Packages.Parameter.typeArguments`**: enum values match `move_package.proto`, and closed and open instantiations are covered by a regression test.
- **Batches** run in parallel, and an interrupted caller does not disturb the others in its batch.

## Optimizations

### Bundle: why "build + resolve + sign + execute" went from 355 to 389 KB (Bun)

| Program (Bun / esbuild / Rolldown, KB minified) | Bun | esbuild | Rolldown |
|---|---|---|---|
| README program (`SuiGrpc.layer`) | 388.7 | 383.9 | 392.3 |
| Only the five layers `Tx.run` needs (Chain, Objects, Coins, Packages, Transactions) | 361.2 | 356.6 | 363.9 |
| The same, with allowance resolution removed from `Resolve.ts` | 355.4 | 350.9 | not run |

- **`SuiGrpc.layer` links four services the program never calls: +27.5 KB** (5 KB gzip). Added alone to the five: Checkpoints +13.5, Events +10.2, CheckpointData +15.7, DynamicFields +5.3. 19.2 KB of it is protobuf descriptors, the rest `scan.ts` and Stream code.
- **Allowances are always linked: +5.8 KB** (1.8 KB gzip). `Resolve.balances` calls `allowances` statically (`Resolve.ts:571`), bringing seven error classes and the `Allowance` BCS schemas into every program that resolves a transaction. `Resolve.ts` is 15.7 KB of the bundle, 10.3 KB without them.
- 355.4 + 5.8 + 27.5 = 388.7. There is no git history to date the changes, but the composition matches the old figure to 0.4 KB.
- **Options.** State next to `SuiGrpc.layer` that it links every service and show the five-layer composition in the README row, or split it into a transaction layer and an indexing layer. Make allowance resolution a step the caller adds, or attach its resolver to the intent so only `Ptb.coin({ allowance })` users ship it.

**Resolution.** Added `SuiGrpc.layerCore({ baseUrl })` (Chain, Objects, Coins, Packages, Transactions, plus `GrpcWeb` for stacking more `*Grpc.layer`s); `SuiGrpc.layer` is unchanged and documented as linking all nine. README and the bundle report use `layerCore`: with descriptor pruning the program is 310.9 / 101.0 KB (Bun), 337.8 / 105.6 with `SuiGrpc.layer` (was 388.3 / 112.3, comments stripped). Allowance resolution is still linked (+5.8 KB): making it lazy needs a caller-added step (API change) or a resolver attached to `AllowanceIntent` in `Ptb.ts`.

### Bundle: prune protobuf messages the SDK never reads (−48 KB)

- Descriptors are the largest part of our own code: 104.9 KB of 383.9 in the README program, 85.7 KB with five layers. Sui core is 26.5 KB and BCS 5.8 KB.
- Every RPC ships the full descriptor closure of its response, although the read masks ask for a few fields.
  - `ExecutedTransaction` brings 100 messages (66.9 KB of source) for `digest`, `effects.status`, `effects.gas_used` and `effects.changed_objects`.
  - `GetEpoch` alone adds 19.4 KB (`SystemState`, `Validator`, `StakingPool`, `ProtocolConfig`) for `epoch`, `first_checkpoint` and `reference_gas_price`.
- **Measured.** Replacing every message the five services never read with an empty stub (43 kept): esbuild 356.6 → 308.5 KB minified, 107.4 → 101.3 KB gzip. The stubbed build returned the same results as the full one on testnet for `Objects.get`, `listOwned`, `getBalance`, `getFunction`, `Chain.info`, `referenceGasPrice`, `Tx.build` and `simulate`, because the decoder skips unknown fields.
- **Fix.** Let `scripts/codegen-grpc.ts` take, per service, the fields it reads, and emit trimmed descriptors for responses. Dropping unused fields and the stubs themselves would save more than the 48 KB measured.
- **Effort** M

**Resolution.** `codegen-grpc.ts` emits `src/grpc/generated/lean.ts` from `scripts/grpc-lean.ts` (per method: read-mask root and paths, extra kept fields, request fields). Each handle keeps only those fields (mask paths keep their subtree), requests included; chunks are shared by content. Services import `lean.ts`; `SuiGrpc.Rpc` keeps full handles. Lean handles skip unknown fields and check every request (mask path outside the table, missing mask, unknown request field: defect). Descriptors in the `Tx.run` program 104.9 → 34.7 KB (esbuild). `test/grpc-lean.test.ts` shows identical results for pruned and full decoding; live suites pass.

### Runtime

- **Round trips per `Tx.build`: 4 sequential phases to 2** (CORE-9). About 170 ms of 330 to 350 ms on an 85 ms link.
- **BCS decode without the second schema pass** (CORE-16): up to 8× on structs and 14× on `vector<u8>`.
- **Linear frame reassembly** (CORE-12): 199 ms to roughly 10 ms for a 4 MiB message.
- **Signature fetches** (CORE-10): one `GetFunction` per distinct target instead of one per MoveCall.
- **Codec and layer build cost is negligible**: `SuiGrpc.layer` builds in 14.5 ms; the largest codec (`ExecuteTransaction`) takes 2.1 ms cold.
