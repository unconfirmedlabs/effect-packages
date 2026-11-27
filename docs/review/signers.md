# Review: signing and authentication packages

Scope: `sui-multisig`, `sui-secp256k1`, `sui-secp256r1`, `sui-mldsa65`, `sui-mnemonic`, `sui-passkey`, `sui-zklogin`, `sui-enoki`, `sui-wallet`, plus the core pieces they lean on (`Tx.ts` `checkChange`, `SignatureScheme.ts`, `Verify.ts`).

## Summary

No high-severity defect: I found no way to forge, replay or substitute a signature, and no key material in errors or logs. The cryptographic core holds up under adversarial probing (see "Checked and sound" at the end).

What is wrong sits at the edges:

- **Address derivation accepts invalid input** in multisig (member keys of the wrong length) and zkLogin (negative, oversized or non-decimal seeds), and answers an address nobody can sign for.
- **Outcomes that may have reached the chain are reported as plain signing failures**, in the wallet's `signAndExecuteTransaction` and in Enoki's sponsored execute. A caller that retries can execute twice.
- **Wallet adapter robustness**: multi-chain wallets, rejection wording heuristics, and rejection values that can't be stringified.
- **Bundle size**: any zkLogin nonce or address computation ships all sixteen Poseidon arities, 589 KB minified / 421 KB gzip, of which about 90% is unused.

Counts: 0 high, 6 medium, 12 low, 5 nit.

Every CONFIRMED finding was reproduced with a throwaway script (in the session scratch dir, not kept in the repo) or is certain from the code. PLAUSIBLE means the local behaviour is reproduced but the consequence depends on something I could not run (a browser, a validator, a real wallet).

## Findings

### SIGN-1: zkLogin ships all 16 Poseidon arities (589 KB min / 421 KB gzip)

- **Severity** medium · **Category** bundle · **CONFIRMED** (measured) · **Effort** S–M
- **Where** `packages/sui-zklogin/src/Poseidon.ts:7-44`
- **What** `Poseidon.ts` imports `poseidon1..16` from the `poseidon-lite` index and holds them in `BY_ARITY`. `poseidon-lite` is CommonJS, so no bundler can drop an arity. The round constants are base64 and barely compress.
- **Measurement** (bun / esbuild / rolldown, KB min/gzip):

  | Program | bun | esbuild | rolldown |
  |---|---|---|---|
  | `Nonce.generate` only | 667.6 / 448.1 | 669.1 / 449.0 | 648.1 / 447.0 |
  | `ZkLoginAddress.fromJwt` | 687.8 / 455.4 | 686.7 / 455.4 | 673.8 / 456.6 |
  | `ZkLogin.signer` (no Poseidon) | 137.1 / 48.0 | 135.6 / 48.0 | 142.5 / 47.9 |

  `poseidon-lite` alone: all 16 via the index 590 / 421; subpath imports (`poseidon-lite/poseidon4`) of arities 1, 2, 4, 5 are 56 / 40; arity 4 alone is 19 / 13.6.
- **Why those arities** the default paths use only them: nonce (4), salt (1), claim name of 32 bytes (2 chunks), claim value of 115 bytes (4), `aud` of 145 bytes (5), address seed (4). Other arities are reachable only through `AddressSeedOptions` overrides and the generic `Poseidon.hash`.
- **Impact** `ZkLoginFlow.start` (Enoki) imports `Nonce`, so every Enoki login page pays this. `@mysten/sui` has the same import, so this is a chance to beat it, not a regression against it.
- **Fix** import per arity from subpaths; have `Nonce.ts` and the default `AddressSeed` path use a module with only 1, 2, 4, 5; keep the generic 1..64 `Poseidon.hash` in its own module. Add a zkLogin row to `scripts/bundle-report.ts`, which covers none of passkey, zkLogin, Enoki, wallet, mnemonic or ML-DSA today.
- **Resolution** Fixed. `Nonce` imports `poseidon-lite/poseidon4` only and the default `AddressSeed` path arities 1, 2, 4, 5 (per-arity subpaths, `src/internal/poseidon.ts`); `Poseidon.ts` keeps all 16 for the generic hash. Other claim lengths fail with a typed error naming `poseidon: Poseidon.hashUnsafe` (new `AddressSeedOptions.poseidon`, `hashASCIIStrToField(..., { poseidon })`). Measured (bun / esbuild / rolldown, KB min/gzip): `Nonce.generate` 667.6/448.1, 669.1/449.0, 648.1/447.0 -> 97.1/40.3, 98.4/41.1, 98.1/41.2; `ZkLoginAddress.fromJwt` 687.8/455.4, 686.7/455.4, 673.8/456.6 -> 154.7/73.8, 153.5/73.8, 159.8/76.1; `ZkLogin.signer` unchanged (137.7/48.7). zkLogin rows added to `scripts/bundle-report.ts` (plus `--only`).

### SIGN-2: `MultiSig.publicKey` accepts member keys of the wrong length; `address` answers anyway, `signer` throws

- **Severity** medium · **Category** correctness · **CONFIRMED** · **Effort** S
- **Where** `packages/sui-multisig/src/index.ts:80-96` (validation), `:112-116` (`address`), `:119-122` (`toPublicKey`), `:243-245` (`signer`)
- **What** `publicKey()` checks flag, weight, duplicates and threshold, but never the key bytes. `PublicKey` is a structural `{ flag, bytes }`, so nothing upstream checks either (Mysten's key classes do, in their constructors). `address()` hashes whatever it is given.
- **Failure scenario** a member `{ flag: 0x00, bytes: <31 bytes> }` (or a 65-byte uncompressed secp key, or a 32-byte key under the secp flag):
  - `MultiSig.publicKey(...)` succeeds.
  - `MultiSig.address(pk)` returns an address. No encodable `MultiSigPublicKey` hashes to it, so funds sent there are stuck.
  - `MultiSig.toPublicKey(pk)` and `MultiSig.signer(pk, [a])` throw a raw `SchemaError(expected 32 bytes at ["pkMap"][0]["pubKey"]["value"])` synchronously, from a function typed as returning `Effect<…, InvalidMultiSig>`.
  - The same throw happens for any hand-built `MultiSigPublicKey` that skipped `publicKey()` (weight 300, for instance), since the validated type is not branded.
- **Fix** check each member's byte length per variant in `publicKey()` (and the `len || iss || seed` shape for zkLogin members). Brand the validated type, or have `address` / `toPublicKey` / `signer` / `combine` validate. Wrap `signer`'s body in `Effect.suspend`.
- **Resolution** Fixed. `publicKey` checks each member's key length per variant (zkLogin: `len(iss) || iss || 1..32-byte seed`). `MultiSigPublicKey` is now branded (input type `MultiSigPublicKeyInput`), so `address` / `toPublicKey` take only a validated key; `signer` and `combine` re-validate and fail with `InvalidMultiSig` instead of throwing.

### SIGN-3: a failed `signAndExecuteTransaction` is a `SigningError`, though the wallet may have submitted

- **Severity** medium · **Category** correctness · **CONFIRMED** (mapping) / PLAUSIBLE (wallet behaviour) · **Effort** S
- **Where** `packages/sui-wallet/src/Wallet.ts:337-341`
- **What** `ExecutionUnconfirmed` is raised only when the wallet *resolves* with a malformed answer. When the wallet's promise *rejects*, the error is `SigningError`, reason `"failed"` or `"rejected"`. A wallet signs, submits, then waits for effects; a timeout or RPC error in that last step rejects the promise after the transaction is on its way.
- **Failure scenario** the wallet rejects with `Error("Request timed out waiting for transaction effects")`. Result: `SigningError { reason: "failed" }`. The caller reads "nothing was signed", retries, and the transfer executes twice.
- **Fix** for this one feature, map every rejection that is not a coded user refusal (4001000 / 4001) to `ExecutionUnconfirmed` without a digest, and say so in the README line that describes it (`README.md:274`).
- **Resolution** Fixed. A rejected `signAndExecuteTransaction` promise is `ExecutionUnconfirmed` (no digest) unless it is a coded refusal (4001000 / 4001), which stays `SigningError("rejected")`. README updated.

### SIGN-4: `isRejection` wording heuristics read validator and RPC failures as a user's refusal

- **Severity** medium · **Category** correctness · **CONFIRMED** (regex behaviour) · **Effort** S
- **Where** `packages/sui-wallet/src/Wallet.ts:95-106`
- **What** the third alternative of `USER_WORDING` matches any message that *starts* with an optional "request / transaction / signature" and then "rejected / denied / declined / cancelled". The first matches any message where "user" precedes one of those words. `REJECTION_NAME` matches any error class whose name contains "rejected" or "cancelled". The existing test passes only because its samples have a word in between ("Transaction **is** rejected…", "Transaction **execution** cancelled…").
- **Failure scenario** all of these classify as `"rejected"`:
  - `"Transaction rejected by validators"`
  - `"Transaction rejected: insufficient gas"`
  - `"Transaction cancelled due to shared object congestion"`
  - `"Rejected: object 0x2 is locked by another transaction"`
  - `"Request denied: rate limit exceeded"`
  - `"The user's gas coin was rejected by the validator"`
  - any error named `TransactionRejectedError`

  Apps dismiss `"rejected"` silently, so a real failure (or, with SIGN-3, a submitted transaction) disappears. In the other direction, `"Popup closed"`, `"User closed the modal"` and `"Approval denied"` are *not* recognised.
- **Fix** trust the codes first. Keep wording only for the sign-only features, require the user to be the grammatical agent ("by (the) user", "user (rejected|denied|declined|cancelled)") and drop the start-anchored alternative and the bare name regex.
- **Resolution** Fixed. Codes first; wording now needs the user as the agent (`user rejected|denied|declined|cancelled|closed|refused`, `... by (the) user`); the start-anchored alternative is gone and the name regex needs `user`. All the listed samples now read as failures; `signAndExecuteTransaction` ignores wording entirely (SIGN-3).

### SIGN-5: Enoki sponsored execute failure drops the signed transaction; a retry sponsors a second one

- **Severity** medium · **Category** correctness · **CONFIRMED** · **Effort** S–M
- **Where** `packages/sui-enoki/src/Sponsor.ts:166-167`
- **What** `sponsorAndExecute` signs the sponsored bytes and posts the signature. If that post fails, the caller gets a bare `EnokiError` and loses `bytes`, `signature` and the sponsored `digest`. Enoki may have executed it. Retrying `Sponsor.run` asks Enoki for a *new* sponsored transaction (new gas, new digest), which is not idempotent with the first.
- **Failure scenario** execute returns 504 from a gateway: `EnokiError { status: 504, code: "unknown_error", message: "Request to Enoki API failed (status: 504)" }`, with no digest anywhere. On a transport error the digest survives only by accident, inside the URL in the message.
- **Also** the header says "each step is exported for flows that stop in between", but the bytes check (`check`) and the sponsor step are private. A caller who wants to sponsor, check, sign and execute separately has to re-implement the check.
- **Fix** fail the execute step with a typed error carrying `{ digest, bytes, signature, cause }` (the wallet package's `ExecutionUnconfirmed` is the model). Export `sponsor` (create + check) and `execute` as steps so a retry re-posts the same signature.
- **Resolution** Fixed. Execute failures are `Sponsor.ExecutionUnconfirmed { digest, bytes, signature, message, cause: EnokiError }` (`retryable` from the cause). New exported steps: `Sponsor.sponsor` (create + check) and `Sponsor.execute` (re-posting the same signature is safe).

### SIGN-6: wallet accounts are not filtered by chain; a multi-chain wallet's first account may not be a Sui account

- **Severity** medium · **Category** correctness · **CONFIRMED** · **Effort** S
- **Where** `packages/sui-wallet/src/Wallet.ts:178-187` (`toAccount`, `accounts`), `:242-255` (`pick`)
- **What** `isSuiWallet` filters wallets, but nothing filters accounts. `Address.normalize` pads short hex, so a 20-byte EVM address becomes a "valid" Sui address. `pick` defaults to `all[0]`.
- **Failure scenario** a wallet with accounts `[ { address: "0x5290…9EE7", chains: ["eip155:1"] }, { address: <sui>, chains: ["sui:mainnet", "sui:testnet"] } ]`:
  - `Wallet.accounts(wallet)` lists the EVM account as `0x000000000000000000000000529084…9ee7`.
  - `Wallet.signer(wallet, { chain: "sui:testnet" })` fails with `UnsupportedChain`, although a Sui account for that chain exists.
  - `Wallet.signPersonalMessage(wallet, {}, msg)` asks the wallet to sign with the EVM account.
- **Fix** keep only accounts with a `sui:` chain (dapp-kit does the same), parse addresses with `Address.Strict` rather than `normalize`, and have `account()` default to the first account that lists the requested chain.
- **Resolution** Fixed. Accounts without a `sui:` chain (or with no chains, the wallet's apply) are skipped; addresses are parsed with `Address.Strict`; `account()` / `signer()` default to the first account listing the requested chain.

### SIGN-7: wallet failures that can't be stringified, and malformed wallet answers, escape as defects

- **Severity** low · **Category** correctness · **CONFIRMED** · **Effort** S
- **Where** `packages/sui-wallet/src/Wallet.ts:108` (`describe`), `:196-200` (`connect`), `:187` (`accounts`)
- **What / scenario**
  - `describe` calls `JSON.stringify(e)` inside the `catch` mapper. A wallet rejecting with a circular object or one holding a `bigint` makes the mapper throw: `signTransaction`, `signAndExecuteTransaction`, `signPersonalMessage` and `connect` all end in `Die` instead of `SigningError` / `ConnectionError`.
  - An error-like object that is not `instanceof Error` (cross-realm) is described as `"{}"`, losing its message.
  - `connect` resolving with `{}` or `undefined` dies on `r.accounts.flatMap`.
  - `Wallet.accounts(wallet)` throws if `wallet.accounts` is missing.
- **Fix** a total `describe` (prefer a string `message`, then `try { JSON.stringify } catch { String(e) }`), and validate the `connect` answer into `ConnectionError("failed")`.
- **Resolution** Fixed. `describe` is total (string `message` first, guarded `JSON.stringify`, then `String`); a malformed `connect` answer is `ConnectionError("failed")`; `accounts` survives a missing `wallet.accounts`.

### SIGN-8: zkLogin accepts address seeds and epochs the chain cannot represent, and derives an address from them

- **Severity** low · **Category** correctness · **CONFIRMED** · **Effort** S
- **Where** `packages/sui-zklogin/src/PublicIdentifier.ts:25-26, 42-51`; `ZkLoginAddress.ts:25-33`; `ZkLogin.ts:33, 117, 121`; `Signature.ts:52`
- **What** seeds go through `BigInt(...)` and `toPaddedBigEndianBytes`, which truncates to 32 bytes and never checks sign or range.
- **Scenarios** (all succeed where `InvalidZkLoginInput` / `InvalidKey` is promised):
  - `ZkLoginAddress.fromSeed(2n ** 300n + 7n, iss)` equals `fromSeed(7n, iss)`.
  - `fromSeed(-5n, iss)` and `fromSeed(<BN254 field size>, iss)` return addresses.
  - `ZkLogin.signer({ inputs: { addressSeed: "" } })` builds a signer for seed 0; `"0x10"`, `" 16 "` and `"-1"` are accepted too. Validators parse the seed as a decimal BN254 element.
  - `maxEpoch: ""` becomes 0 and `"0x10"` becomes 16. Out-of-range values (−1, 2^64) pass `signer` and fail only later at `sign`, as a `SigningError`.
- **Fix** one `parseSeed`: decimal digits only, `0 <= seed < BN254_FIELD_SIZE`, used by `encode`, `signer` and `identifierOf`. Validate `maxEpoch` as a u64 once, in `signer`.
- **Resolution** Fixed. Seeds must be canonical decimal (no sign, `0x`, whitespace or leading zeros) and in the BN254 field; bigint seeds are range-checked in `PublicIdentifier.encode` / `parse` (so `fromSeed` refuses instead of truncating). `maxEpoch` must be a u64 (bigint, safe integer or decimal string) in `ZkLogin.signer`, `Signature.serialize` and `Nonce.generate`.

### SIGN-9: `hashASCIIStrToField` hashes UTF-16 code units, so a non-ASCII claim derives a different address than its UTF-8 bytes

- **Severity** low · **Category** correctness · **CONFIRMED** (local behaviour) / PLAUSIBLE (on-chain consequence) · **Effort** S
- **Where** `packages/sui-zklogin/src/AddressSeed.ts:26-30`
- **What** the string is split into `charCodeAt` values. `"é"` is hashed as the single byte `0xE9`, not UTF-8 `C3 A9`. A code unit above 255 prints as 3–4 hex digits and shifts every byte after it. The circuit hashes raw JWT bytes. The module already refuses JSON escapes for exactly this reason (`assertNoJsonEscape`), but lets non-ASCII through.
- **Scenario** `genAddressSeed(1n, "sub", "é", "aud")` differs from the seed of the same claim taken as UTF-8 bytes. `ZkLoginAddress.fromJwt` for a provider with non-ASCII `sub` or `aud` then names an address the proof cannot sign for. `@mysten/sui` behaves the same, so parity tests don't see it.
- **Fix** refuse code units above 0x7F in `assertNoJsonEscape` (the function is named ASCII), unless the circuit's handling is confirmed and UTF-8 bytes are hashed instead.
- **Resolution** Fixed, as a refusal. Checked: `@mysten/sui` hashes `charCodeAt` like us; Sui's Rust `hash_ascii_str_to_field` (fastcrypto `zk_login.rs`) hashes each `char` in 8 bits and returns `InvalidInput` above 0xFF; on chain it only hashes the base64 `iss` and header, and the address seed itself comes from the circuit, which hashes raw JWT (UTF-8) bytes. So `hashASCIIStrToField` now refuses characters above 0xFF (as the Rust does) and `genAddressSeed` / `fromJwt` / `compute` refuse non-ASCII claims with `InvalidZkLoginInput` (use the prover's seed with `fromSeed`).

### SIGN-10: member signers and key signers are asked concurrently; two passkeys overlap their prompts

- **Severity** low · **Category** correctness · **CONFIRMED** (overlap) / PLAUSIBLE (browser outcome) · **Effort** S
- **Where** `packages/sui-multisig/src/index.ts:247-255`; `packages/sui/src/Tx.ts:126-133`; `packages/sui-passkey/src/BrowserProvider.ts:34-42`
- **What** `MultiSig.signer` and `Tx.sign` run every `Signer.sign` with `concurrency: "unbounded"`. For in-memory keys that is right. For interactive signers it issues overlapping prompts, and WebAuthn allows one pending request.
- **Scenario** a 2-of-2 multisig of two passkeys, with a provider that allows one request at a time: both `provider.get` calls are in flight together (max concurrent 2), and the second fails. In a browser that failure is a `NotAllowedError`, which `toSigningError` reports as `"rejected"`, so the user appears to have cancelled.
- **Fix** serialise inside `browserProvider` (a one-permit semaphore around `ask`), which fixes both call sites. Alternatively give `MultiSig.signer` a `concurrency` option.
- **Resolution** Fixed in `browserProvider`: a one-permit semaphore per provider serialises `create` / `get`, which covers both `MultiSig.signer` and `Tx.sign` without touching core.

### SIGN-11: multisig verification refuses a bitmap with more bits than signatures, which `@mysten/sui` accepts

- **Severity** low · **Category** correctness (protocol parity) · **CONFIRMED** against `@mysten/sui` / PLAUSIBLE against validators · **Effort** S
- **Where** `packages/sui-multisig/src/index.ts:145-146`
- **What** we require `popcount(bitmap) === sigs.length`. `@mysten/sui` walks the signatures and takes the i-th set bit for each. From memory, validators zip signatures with bitmap indices the same way; I could not check the Rust source here.
- **Scenario** one valid signature from member 0, bitmap `0b11`, threshold 1: `MultiSigPublicKey.verifyPersonalMessage` returns `true`, ours fails with "bitmap does not match the signature count". Off-chain verification then rejects something the chain may execute.
- **Fix** confirm against `sui-types/src/multisig.rs`, then either match it or record the stricter rule as a decision next to the code.
- **Resolution** Not changed (kept strict), documented next to the check. Sui's `verify_claims` zips signatures with `as_indices(bitmap)` through `zip_debug_eq`, which is a `debug_fatal!` (panic in debug builds) and a silent truncation in release, so release validators would accept extra bits, but Sui treats the mismatch as an invariant violation and no combiner produces it. Off-chain we keep refusing.

### SIGN-12: `checkChange` lets a wallet sponsor change the expiration a key sender then signs

- **Severity** low · **Category** security · **CONFIRMED** · **Effort** S
- **Where** `packages/sui/src/Tx.ts:77-90` (core, exercised through the wallet signer)
- **What** gas data and expiration are treated as one bundle that only a key *gas owner* protects (`:88`). Expiration is the sender's term, not the payer's.
- **Scenario** key sender `K`, wallet sponsor `W`, transaction with `expiration: Epoch(5)`. `W` returns bytes with `expiration: None`. `checkChange` accepts, `K` signs bytes it never saw, and they are submitted. The reverse case (wallet sender, key sponsor) is correctly refused, as are sender, command, input and gas owner changes.
- **Fix** refuse an expiration change whenever a key signer is the sender; keep the gas-terms rule for the gas owner.

### SIGN-13: low-S and prehash rules rest on noble's defaults, with no k1/r1 test

- **Severity** low · **Category** security, tests · **CONFIRMED** (currently enforced) · **Effort** S
- **Where** `packages/sui-secp256k1/src/index.ts:24`; `packages/sui-secp256r1/src/index.ts:24`; `packages/sui-passkey/src/Passkey.ts:192`
- **What** `verify(signature, hash, publicKey)` passes no options. Rejecting high-S and applying SHA-256 are noble 2.x defaults; the dependency is `^2.3.0`. I flipped S on valid signatures: all three schemes refuse them today, while `verify(..., { lowS: false })` accepts the same bytes. Only the passkey package has a test for it.
- **Fix** pass `{ lowS: true, prehash: true }` explicitly at the three call sites, and add a high-S rejection test to the k1 and r1 suites.
- **Resolution** Fixed. `{ lowS: true, prehash: true }` passed explicitly at the k1, r1 and passkey verify sites (and the k1/r1 sign sites); high-S rejection tests added to the k1 and r1 suites (they also show noble accepts the same bytes with `lowS: false`).

### SIGN-14: test gaps

- **Severity** low · **Category** tests · **CONFIRMED** · **Effort** S–M
- **Missing**
  - The personal-message bytes check (`Wallet.ts:377-379`). It works: a wallet answering other bytes gives `SigningError("failed", "…signed a different message…")`. No test covers it.
  - A rejected `signAndExecuteTransaction` promise (SIGN-3), and rejection wording at the start of a message (SIGN-4).
  - A multi-chain wallet (SIGN-6) and a non-serialisable rejection value (SIGN-7).
  - Multisig members with malformed keys (SIGN-2), and `combine` below threshold (it succeeds; the result fails verification).
  - zkLogin seed and epoch validation (SIGN-8).
  - Enoki execute failing after the signature was made (SIGN-5).
- **Stability** the nine packages' suites ran twice: 124 pass, 11 skipped (live), about 2 s, no flakes.
- **Resolution** Fixed. Added: personal-message bytes mismatch; rejected `signAndExecuteTransaction` (timeout, word-only and coded refusals); start-of-message wording; multi-chain wallet, short addresses, chain-aware default account; non-serialisable rejection values (circular, bigint, cross-realm, symbol); malformed connect answers; multisig malformed member keys, forged unvalidated keys, `combine` below threshold (now refused); zkLogin seed / epoch / non-ASCII / arity tests (`sui-zklogin/test/validation.test.ts`); Enoki execute failure after signing and re-execute.

### SIGN-15: public functions that throw instead of failing

- **Severity** low · **Category** correctness, api · **CONFIRMED** · **Effort** S
- **Where / scenario**
  - `packages/sui-multisig/src/index.ts:135`: `scheme.address` uses `Bcs.decodeSync`. `SignatureScheme.addressOf({ flag: 3, bytes: Uint8Array.of(1, 2, 3) })` dies with `BcsDecodeError`.
  - `packages/sui-passkey/src/Passkey.ts:113-118`: `spkiFromPublicKey(new Uint8Array(33))` throws "bad point".
- **Fix** make `SignatureScheme.address` able to fail (or have `addressOf` catch into `InvalidKey`), and return an `Effect` from `spkiFromPublicKey`, as `publicKeyFromSpki` does.
- **Resolution** Partly fixed. `spkiFromPublicKey` now returns `Effect<Uint8Array, InvalidKey>`. The multisig half is not changed: `SignatureScheme.address` / `addressOf` are core (`packages/sui`, out of scope) and can't fail, so `MultiSig.scheme.address` still throws on non-BCS bytes; documented at the call site. It is only reached with keys a verification answered.

### SIGN-16: `Sponsor` asks Enoki for the app on every transaction, and pins no sponsor when `network` is omitted

- **Severity** low · **Category** performance, security · **CONFIRMED** (extra calls) / PLAUSIBLE (default network) · **Effort** S
- **Where** `packages/sui-enoki/src/Sponsor.ts:125-137`
- **What** `sponsorFor` calls `getApp` per `sponsorAndExecute`: three sponsored transactions made three `GET /v1/app` calls. They run alongside the sponsor call, so latency is unaffected, but the request count doubles against Enoki's rate limits. With `network` undefined (or devnet) no sponsor address is pinned, and only "gas owner is not the sender" is checked. If the API defaults to mainnet, the default call path gets the weaker check.
- **Fix** cache `getApp` in the layer (`Effect.cached`, with a TTL), and treat an omitted network as the API's default when looking up the sponsor.
- **Resolution** Fixed. `EnokiHttp.layer` caches a successful `getApp` for 5 minutes (failures not cached) and drops it on `invalid_gas_owner` / `invalid_gas_price`, as `@mysten/enoki` does. An omitted network is treated as mainnet (Enoki's default; `@mysten/enoki` assumes the same) when pinning the sponsor.

### SIGN-17: `ZkLoginFlow.complete` spends a prover call before checking the JWT; `Session` can't be persisted as is

- **Severity** low · **Category** api, performance · **CONFIRMED** (from code) · **Effort** S
- **Where** `packages/sui-enoki/src/ZkLoginFlow.ts:82-97`, `:22-30`
- **What**
  - `complete` sends the JWT to `zklogin/zkp` without first comparing its `nonce` claim to `session.nonce`. A stale or foreign token costs a round trip to the slowest, most rate-limited endpoint and comes back as an opaque `EnokiError`. `Jwt.decode` is already a dependency.
  - `Session` holds a `Signer` (functions), yet the header says persisting it across the redirect is the app's job. Every app has to split it by hand.
- **Fix** decode the JWT and compare the nonce locally, failing with a typed error. Split `Session` into Schema-encodable data (`nonce`, `randomness`, `maxEpoch`, `estimatedExpiration`, `network`) and the ephemeral signer passed to `complete`.
- **Resolution** Fixed. `complete` decodes the JWT and compares its `nonce` to the session's first (`JwtNonceMismatch` / `InvalidJwt`, no Enoki call). `ZkLoginFlow.SessionData` is a Schema for the persistable part; `Session` is `SessionData & { ephemeral }`.

### SIGN-18: `EnokiError` drops the cause and carries no `retryable`

- **Severity** low · **Category** api · **CONFIRMED** (from code) · **Effort** S
- **Where** `packages/sui-enoki/src/EnokiHttp.ts:107, 114-116`; `EnokiClient.ts:32-44`
- **What** transport and decode failures keep only `e.message`. `RpcError` and `VerificationUnavailable` elsewhere in the repo carry `retryable`; here callers must infer it from `status` 0 / 429 / 5xx.
- **Fix** add `retryable` (status 0, 429, 5xx) and keep the underlying error as `cause`.
- **Resolution** Fixed. `EnokiError.retryable` (status 0, 429, 5xx) and an optional `cause`. HTTP client errors are kept as name + message only, since they hold the request with the API key and JWT headers; Schema errors are kept as is.

### SIGN-19: duplicated code across the scheme packages

- **Severity** nit · **Category** simplification · **CONFIRMED** · **Effort** S
- **What**
  - `sui-secp256k1/src/index.ts` and `sui-secp256r1/src/index.ts` are 76-line copies that differ in 6 lines (curve, flag, name). A core `ecdsaScheme(curve, flag, name)` taking the curve as an argument removes one of them without adding noble curves to the core bundle.
  - `sameBytes` is defined four times in these packages (`sui-multisig`, `sui-passkey`, `sui-zklogin`, `sui-enoki`), written inline in `sui-wallet`, and defined five more times elsewhere in the repo (`sui/Tx.ts`, `sui/grpc/scan.ts`, three in `walrus`).
  - "Prefix the flag byte" is written out about eight times.
  - Only `Sponsor.sponsorAndExecute` uses `Effect.fn`; the other effectful entry points (`Wallet.*`, `ZkLoginFlow.*`, `Passkey.create` / `recover`, `MultiSig.signer`) have no span.

### SIGN-20: unused dependencies

- **Severity** nit · **Category** bundle · **CONFIRMED** · **Effort** S
- **What** `@noble/hashes` is declared but never imported in `sui-secp256k1`, `sui-secp256r1` and `sui-zklogin`.
- **Resolution** Fixed. `@noble/hashes` removed from `sui-secp256k1`, `sui-secp256r1` and `sui-zklogin` (lockfile updated).

### SIGN-21: secret hygiene is uneven

- **Severity** nit · **Category** security · **CONFIRMED** · **Effort** S
- **What**
  - `fromSecretKey` puts `String(e)` from noble into `InvalidKey.reason` (`sui-secp256k1/src/index.ts:54`, `sui-secp256r1/src/index.ts:54`, `sui-passkey/src/SoftwareProvider.ts:50`). With noble 2.4.0 the messages carry no key bytes ("invalid scalar: out of range", "expected 32 bytes, got 31"). A fixed reason would not depend on that staying true.
  - `sui-mnemonic` zeroes its SLIP-0010 intermediates but leaves the BIP32 `HDKey` nodes alone (`src/index.ts:174`); `wipePrivateData()` would match.
- **Resolution** Fixed. `fromSecretKey` (k1, r1) and `softwareProvider` use a fixed `InvalidKey` reason; `sui-mnemonic` calls `wipePrivateData()` on the master and derived BIP32 nodes (the intermediates `derive` makes are out of reach).

### SIGN-22: `Signature.MAX_SIZE` is described as a Sui rule

- **Severity** nit · **Category** docs · PLAUSIBLE · **Effort** S
- **Where** `packages/sui-zklogin/src/Signature.ts:34-35`
- **What** the comment says "Sui refuses zkLogin signatures over this size". In `@mysten/sui` the 2048 is the BCS serializer's buffer cap (`zklogin/signature.ts`, `{ maxSize: 2048 }`). I could not confirm a validator limit.
- **Resolution** Fixed (comment only): `MAX_SIZE` is described as `@mysten/sui`'s serializer cap, with no confirmed validator limit. Behaviour unchanged.

### SIGN-23: two more `clientDataJSON` differences from `serde_json`

- **Severity** nit · **Category** correctness · PLAUSIBLE · **Effort** S
- **Where** `packages/sui-passkey/src/Passkey.ts:150-174`
- **What** beyond the two accepted gaps (duplicate keys, lone surrogates), `JSON.parse` accepts a number such as `1e999` and nesting deeper than 128 in an unknown key; both verify here. `serde_json` refuses out-of-range numbers and has a recursion limit of 128, so validators should reject them. Same class as the accepted gaps: a signature we accept that the chain would not, and no forgery.
- **Resolution** Fixed. After `JSON.parse`, a number out of f64 range or nesting at serde_json's recursion limit (depth 128) is refused. PLAUSIBLE as the review says: based on `CollectedClientData` flattening unknown keys into `serde_json::Value`, not run against a validator.

## Optimizations

- **Poseidon (SIGN-1)** saves about 530 KB min / 380 KB gzip on every zkLogin nonce or address bundle.
- **Other signer bundles are in line** (esbuild, KB min/gzip; the Effect + `Schema.TaggedError` baseline is 74.8 / 25.6):

  | Program | Size | Largest non-Effect parts |
  |---|---|---|
  | Passkey verify | 141.8 / 50.4 | noble curves 31, hashes 15 |
  | Passkey browser signer | 146.9 / 51.7 | same; barrel and subpath imports are equal |
  | Wallet signer | 130.7 / 45.0 | `sui` 10 (transaction JSON) |
  | Wallet `signPersonalMessage` only | 99.6 / 34.3 | — |
  | ML-DSA-65 sign | 112.7 / 39.9 | post-quantum 13, hashes 13 |
  | Multisig verify with Ed25519 | 152.4 / 53.9 | curves 23 |
  | Enoki `getApp` | 151.7 / 51.9 | `HttpClient` |
  | Mnemonic `ed25519Signer` | 143.6 / 54.5 | bip39 wordlist 14.5; no bip32 |
  | Mnemonic `secp256k1SecretKey` | 149.5 / 56.5 | bip32 5.6, curves 32 |

  The mnemonic comment's claim holds under all three bundlers: SLIP-0010-only use ships no `@scure/bip32`.
- **Round trips** `Sponsor` makes one `getApp` per transaction (SIGN-16). `ZkLoginFlow.complete` can skip the prover call for a mismatched JWT (SIGN-17). Multisig verification asks the node once per zkLogin member, sequentially (`sui-multisig/src/index.ts:148-156`); `Effect.forEach` with concurrency would make it one wait.
- **Blocking work** is small: `Mnemonic.toSeed` 11 ms (synchronous PBKDF2), secp256k1 derivation from a seed 1.4 ms, ML-DSA-65 keygen 2.8 ms, sign 11.9 ms, verify 2.5 ms, secp256k1 sign 0.3 ms.
- **Redundant work** `MultiSig.scheme.verify` re-encodes the public key, and `Verify.signature` immediately decodes it again through `scheme.address`. Negligible.

## Checked and sound

- **Malleability** high-S signatures are refused by secp256k1, secp256r1 and passkey verification. Signers produce low-S, and the passkey signer normalises the authenticator's signature.
- **Passkey parsing** refused: non-canonical and padded base64url challenges, invalid UTF-8 in `clientDataJSON`, trailing bytes, a `__proto__` wrapper, a wrong `type`, a non-boolean `crossOrigin`, a member signature from another passkey.
- **Bytes-substitution guard** `Tx.sign` + `checkChange` refuse a changed sender, changed commands or inputs, gas changes a key sponsor pays for, and a second wallet changing what the first signed. The only gap is SIGN-12.
- **Canonical decoding** `T.decode` accepted 131,277 single-byte and non-minimal-ULEB mutants of a 585-byte transaction, and every one re-encoded to the same bytes, so the guard cannot be fed two byte strings for one transaction. `Sponsor.check` refuses trailing bytes.
- **Enoki** the JWT and API key are redacted from spans, and neither appears in `EnokiError`. Sponsored bytes are checked for digest, sender, kind, gas owner and caps before signing. The nonce is recomputed locally.
- **zkLogin** the gRPC verifier sends personal messages as BCS `vector<u8>` and transactions as is, matching `@mysten/sui`'s client, and refuses a non-zero intent version or app id. A member signature from another identity is refused locally before the node is asked.
- **Key material** no secret reaches an error message or a log in any of the nine packages.
- **Conventions** no `"effect"` barrel import in library code.
