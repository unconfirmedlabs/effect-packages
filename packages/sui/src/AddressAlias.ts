/**
 * Address aliases (`0x2::address_alias`). An address `A` that has enabled
 * aliases owns an `AddressAliases` object, derived from the shared
 * `AddressAliasState` (`0xa`), holding up to eight addresses. From then on the
 * chain accepts a transaction from `A` signed by any address in that set
 * instead of by `A`'s own key (and `A`'s own key only while `A` is in it).
 *
 *   const aliases = yield* AddressAlias.get(A)              // { enabled, aliases, objectId }
 *   yield* Tx.run(AddressAlias.add(A, B), { signer: a })     // a recipe step, signed by A
 *   const asA = yield* AddressAlias.checkedSigner(A, b)      // B's key, signing for A
 *   yield* Tx.run(recipe, { signer: asA })                    // sender A, signature by B
 *
 * Adding an alias gives that key full control of the address, so treat these
 * steps like exporting a key. (`@mysten/sui` refuses `0x2::address_alias`
 * calls by default, so a dapp can't slip one into a wallet's transaction.)
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Bcs from "@unconfirmed/bcs/Bcs"
import { type Address, normalize } from "./Address.ts"
import { deriveObjectId } from "./DynamicFields.ts"
import { decode, type ObjectDecodeError, Objects } from "./Objects.ts"
import * as Ptb from "./Ptb.ts"
import type { RpcError } from "./RpcError.ts"
import type { Signer } from "./Signer.ts"
import type * as T from "./TransactionData.ts"

/** The shared `0x2::address_alias::AddressAliasState`, parent of every alias set. */
export const STATE_ID: Address = /* @__PURE__ */ normalize("0xa")

/** The most addresses an alias set holds (`add` and `replaceAll` abort beyond it). */
export const MAX_ALIASES = 8

const KEY_TYPE = "0x2::address_alias::AliasKey"

/** `0x2::address_alias::AddressAliases`: its id and a `VecSet<address>`. */
export const AddressAliases = /* @__PURE__ */ Bcs.struct({
  id: Bcs.Address,
  aliases: /* @__PURE__ */ Bcs.struct({ contents: /* @__PURE__ */ Bcs.vector(Bcs.Address) })
})

const encodeAddress = /* @__PURE__ */ Bcs.encodeSync(Bcs.Address)

/**
 * The id of `address`'s `AddressAliases` object, whether or not it exists yet:
 * `derived_object` of `AliasKey(address)` under `0xa`. Throws on an invalid
 * address, like `Address.normalize`.
 */
export const aliasesId = (address: string): Address => deriveObjectId(STATE_ID, KEY_TYPE, encodeAddress(normalize(address)))

export interface Aliases {
  readonly address: Address
  /** Whether `address` has enabled aliases (its `AddressAliases` object exists). */
  readonly enabled: boolean
  /** The addresses whose signatures the chain accepts for `address`: its alias set, or only itself when not enabled. */
  readonly aliases: ReadonlyArray<Address>
  readonly objectId: Address
}

const decodeAliases = /* @__PURE__ */ decode(AddressAliases)

/** Read `address`'s alias set. An address that never enabled aliases is its own only alias, as on chain. */
export const get = (address: Address): Effect.Effect<Aliases, ObjectDecodeError | RpcError, Objects> =>
  Effect.suspend(() => {
    const objectId = aliasesId(address)
    return Effect.flatMap(Effect.service(Objects), (o) => o.get(objectId)).pipe(
      Effect.flatMap(decodeAliases),
      Effect.map((a): Aliases => ({ address, enabled: true, aliases: a.aliases.contents, objectId })),
      Effect.catchTag("ObjectNotFound", () => Effect.succeed<Aliases>({ address, enabled: false, aliases: [address], objectId }))
    )
  })

/** Whether the chain accepts `signer`'s signature for transactions from `address`. */
export const allows = (address: Address, signer: Address): Effect.Effect<boolean, ObjectDecodeError | RpcError, Objects> =>
  Effect.map(get(address), (a) => a.aliases.includes(signer))

// -----------------------------------------------------------------------------
// Recipe steps
// -----------------------------------------------------------------------------

const attempt = <A>(f: () => A) =>
  Effect.try({ try: f, catch: (e) => new Ptb.InvalidPureValue({ issue: e instanceof Error ? e.message : String(e) }) })

const call = (fn: string, args: ReadonlyArray<T.Argument>) =>
  Ptb.moveCall({ target: `0x2::address_alias::${fn}`, arguments: args })

/** `owner`'s `AddressAliases` (consensus-owned by `owner`), looked up by the resolver. */
const aliasesOf = (owner: string) => Effect.flatMap(attempt(() => aliasesId(owner)), (id) => Ptb.object(id))

/** `enable`: create the sender's alias set, holding only the sender. Aborts if the sender already has one. */
export const enable = /* @__PURE__ */ Effect.flatMap(/* @__PURE__ */ Ptb.object(STATE_ID), (state) => call("enable", [state]))

/** `add`: add `alias` to `owner`'s set (signed by `owner` or an alias). Aborts if present or past `MAX_ALIASES`. */
export const add = (owner: string, alias: string) =>
  Effect.gen(function*() {
    const aliases = yield* aliasesOf(owner)
    return yield* call("add", [aliases, yield* Ptb.address(alias)])
  })

/** `remove`: remove `alias` from `owner`'s set. Aborts if absent or the last one. */
export const remove = (owner: string, alias: string) =>
  Effect.gen(function*() {
    const aliases = yield* aliasesOf(owner)
    return yield* call("remove", [aliases, yield* Ptb.address(alias)])
  })

/**
 * `replace_all`: make `owner`'s set exactly `aliases`. One to `MAX_ALIASES`
 * distinct addresses, checked here (`InvalidPureValue`) as the chain would.
 */
export const replaceAll = (owner: string, aliases: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const set = yield* attempt(() => aliases.map(normalize))
    if (set.length === 0 || set.length > MAX_ALIASES || new Set(set).size !== set.length) {
      return yield* new Ptb.InvalidPureValue({ issue: `an alias set holds 1 to ${MAX_ALIASES} distinct addresses, got ${aliases.length}` })
    }
    const target = yield* aliasesOf(owner)
    return yield* call("replace_all", [target, yield* Ptb.pure(Bcs.vector(Bcs.Address), set)])
  })

// -----------------------------------------------------------------------------
// Signing as an alias
// -----------------------------------------------------------------------------

/** A key signing for another address: `address` is the address it signs for, `keyAddress` the key's own. */
export interface AliasSigner extends Signer {
  readonly keyAddress: Address
}

/**
 * `key` signing for `address` through `address`'s alias set: transactions it
 * runs have sender `address` and carry `key`'s signature. Unchecked: the node
 * refuses the signature if `key` isn't in the set (see `checkedSigner`).
 */
export const signer = (address: string, key: Signer): AliasSigner => ({
  ...key,
  address: normalize(address),
  keyAddress: key.address
})

/** `key` is not in `address`'s alias set. */
export class AliasNotAllowed extends /* @__PURE__ */ Schema.TaggedError<AliasNotAllowed>()("AliasNotAllowed", {
  address: Schema.String,
  signer: Schema.String,
  aliases: Schema.Array(Schema.String)
}) {
  override get message(): string {
    return `${this.signer} is not in the alias set of ${this.address} (${this.aliases.join(", ")})`
  }
}

/** `signer`, after reading `address`'s alias set: `AliasNotAllowed` if `key` isn't in it. */
export const checkedSigner = (
  address: Address,
  key: Signer
): Effect.Effect<AliasSigner, AliasNotAllowed | ObjectDecodeError | RpcError, Objects> =>
  Effect.flatMap(get(address), (a) =>
    a.aliases.includes(key.address)
      ? Effect.succeed(signer(address, key))
      : Effect.fail(new AliasNotAllowed({ address, signer: key.address, aliases: a.aliases })))
