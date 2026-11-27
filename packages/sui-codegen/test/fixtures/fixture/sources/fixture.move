/// A small package that exercises the code generator.
module fixture::fixture;

use std::ascii;
use std::string::String;
use std::type_name::TypeName;
use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::Coin;
use sui::deny_list::DenyList;
use sui::random::Random;
use sui::sui::SUI;
use sui::table::Table;
use sui::vec_map::VecMap;
use sui::versioned::Versioned;
use sui_system::sui_system::SuiSystemState;

/// A generic struct: `T` is phantom, `A` and `B` shape the layout.
public struct Pair<phantom T, A: copy + drop + store, B: copy + drop + store> has copy, drop, store {
    first: A,
    second: B,
}

/// A marker type, only ever used as a phantom argument.
public struct Marker has drop {}

/// A positional struct.
public struct Point(u32, u32) has copy, drop, store;

public enum Status has copy, drop, store {
    Active,
    Paused { reason: String, until_ms: u64 },
    Scored(u32, bool),
    Wrapped(Option<u8>),
}

/// The main object.
public struct Thing has key, store {
    id: UID,
    /// The id of a related object.
    owner_ref: ID,
    name: String,
    label: ascii::String,
    tags: vector<String>,
    nums: vector<u64>,
    maybe: Option<u64>,
    pair: Pair<Marker, u8, u64>,
    point: Point,
    status: Status,
    created_ms: u64,
}

/// A generic object.
public struct Box<T: store> has key, store {
    id: UID,
    value: T,
}

/// Framework types as fields: some are built in, others are generated into deps.
public struct Vault has key {
    id: UID,
    balance: Balance<SUI>,
    ledger: Table<address, u64>,
    meta: VecMap<String, u64>,
    kind: TypeName,
    versioned: Versioned,
}

const EBadAmount: u64 = 1;

public fun new_thing(
    name: String,
    label: ascii::String,
    tags: vector<String>,
    nums: vector<u64>,
    maybe: Option<u64>,
    clock: &Clock,
    ctx: &mut TxContext,
): Thing {
    let id = object::new(ctx);
    let owner_ref = id.to_inner();
    Thing {
        id,
        owner_ref,
        name,
        label,
        tags,
        nums,
        maybe,
        pair: Pair { first: 7, second: 1_000_000_000_000 },
        point: Point(3, 4),
        status: Status::Active,
        created_ms: clock.timestamp_ms(),
    }
}

/// Entry functions are generated even when private; `TxContext` is filled in.
entry fun create(name: String, clock: &Clock, ctx: &mut TxContext) {
    let thing = new_thing(name, ascii::string(b"entry"), vector[], vector[], option::none(), clock, ctx);
    transfer::public_transfer(thing, ctx.sender());
}

public fun rename(thing: &mut Thing, name: String) {
    thing.name = name;
}

public fun pause(thing: &mut Thing, reason: String, until_ms: u64) {
    thing.status = Status::Paused { reason, until_ms };
}

public fun score(thing: &mut Thing, points: u32, ok: bool) {
    thing.status = Status::Scored(points, ok);
}

public fun wrap(thing: &mut Thing, value: Option<u8>) {
    thing.status = Status::Wrapped(value);
}

/// Multiple return values.
public fun stats(thing: &Thing): (u64, u64, bool) {
    (thing.nums.length(), thing.created_ms, thing.maybe.is_some())
}

public fun name(thing: &Thing): String {
    thing.name
}

public fun destroy(thing: Thing) {
    let Thing { id, .. } = thing;
    id.delete();
}

/// Type parameters: `T` is a phantom marker in the result, `A` and `B` are values.
public fun make_pair<T, A: copy + drop + store, B: copy + drop + store>(first: A, second: B): Pair<T, A, B> {
    Pair { first, second }
}

public fun set_pair(thing: &mut Thing, pair: Pair<Marker, u8, u64>) {
    thing.pair = pair;
}

public fun boxed<T: store>(value: T, ctx: &mut TxContext): Box<T> {
    Box { id: object::new(ctx), value }
}

#[allow(unused_variable)]
public fun all_pure(
    flag: bool,
    small: u8,
    mid: u16,
    big: u32,
    large: u64,
    huge: u128,
    giant: u256,
    who: address,
    id: ID,
    bytes: vector<u8>,
    nested: vector<vector<u64>>,
    names: vector<String>,
    maybe_name: Option<String>,
): u64 {
    large
}

public fun deposit(vault: &mut Vault, coin: Coin<SUI>) {
    vault.balance.join(coin.into_balance());
}

public fun new_vault(ctx: &mut TxContext) {
    let vault = Vault {
        id: object::new(ctx),
        balance: sui::balance::zero(),
        ledger: sui::table::new(ctx),
        meta: sui::vec_map::empty(),
        kind: std::type_name::with_defining_ids<SUI>(),
        versioned: sui::versioned::create(1, 0u64, ctx),
    };
    transfer::share_object(vault);
}

/// `&Random` is filled in.
entry fun roll(thing: &mut Thing, random: &Random, ctx: &mut TxContext) {
    let mut generator = random.new_generator(ctx);
    thing.created_ms = generator.generate_u64();
}

/// `&mut SuiSystemState` and `&DenyList` are filled in.
#[allow(lint(unused_object_with_fields))]
public fun touch_system(_state: &mut SuiSystemState, _deny_list: &DenyList, _unused: u8): u64 {
    0
}

public fun check(amount: u64) {
    assert!(amount > 0, EBadAmount);
}

/// Not generated: `public(package)`.
public(package) fun internal(thing: &Thing): u64 {
    thing.created_ms
}

/// Not generated: private.
#[allow(unused_function)]
fun helper(): u64 { 1 }
