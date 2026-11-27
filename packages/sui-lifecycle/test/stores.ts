/**
 * The `KeyValueStore`s the durable-journal suite runs against: Effect's
 * memory store, IndexedDB (over `fake-indexeddb`) and OPFS (over the fake in
 * `@unconfirmed/test-support/opfs`). Each `layer()` call is a fresh, empty store.
 */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import * as Layer from "effect/Layer"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import { makeFakeOpfs } from "@unconfirmed/test-support/opfs"
import * as KeyValueStoreIndexedDb from "../src/KeyValueStoreIndexedDb.ts"
import * as KeyValueStoreOpfs from "../src/KeyValueStoreOpfs.ts"

// The module reads IDBKeyRange from the global scope, as in a browser.
;(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= IDBKeyRange

export interface StoreCase {
  readonly name: string
  readonly layer: () => Layer.Layer<KeyValueStore.KeyValueStore, KeyValueStore.KeyValueStoreError>
}

export const stores: ReadonlyArray<StoreCase> = [
  { name: "memory", layer: () => KeyValueStore.layerMemory },
  { name: "IndexedDB", layer: () => KeyValueStoreIndexedDb.layer({ indexedDB: new IDBFactory() }) },
  { name: "OPFS", layer: () => KeyValueStoreOpfs.layer({ root: makeFakeOpfs().getDirectory }) }
]
