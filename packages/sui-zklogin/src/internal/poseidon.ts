/**
 * @internal Poseidon over BN254 from a table of per-arity functions.
 *
 * `poseidon-lite` is CommonJS: importing its index ships all sixteen arities
 * (about 590 KB of round constants), and no bundler can drop the unused ones.
 * Each caller therefore imports only the arities it needs from the package's
 * subpaths (`poseidon-lite/poseidon4`) and builds its hasher here.
 */

export const BN254_FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

export type Input = number | bigint | string

/** A Poseidon hash of field elements that throws on inputs it can't hash. */
export type Hasher = (inputs: ReadonlyArray<Input>) => bigint

type Arity = (inputs: Array<bigint>) => bigint

/**
 * A hasher over the given arities. Up to 16 inputs hash directly; 17 to 64
 * are hashed in chunks of 16 and the chunk hashes hashed again (which needs
 * arity 16 and 2 to 4 in the table).
 */
export const make = (table: Readonly<Record<number, Arity>>): Hasher => {
  const hash: Hasher = (inputs) => {
    const values = inputs.map((x) => {
      const b = BigInt(x)
      if (b < 0n || b >= BN254_FIELD_SIZE) throw new Error(`Element ${b} not in the BN254 field`)
      return b
    })
    const f = table[values.length]
    if (f) return f(values)
    if (values.length > 16 && values.length <= 64) {
      const chunks: Array<bigint> = []
      for (let i = 0; i < values.length; i += 16) chunks.push(hash(values.slice(i, i + 16)))
      return hash(chunks)
    }
    if (values.length >= 1 && values.length <= 16) {
      throw new Error(
        `Poseidon over ${values.length} inputs is not loaded on this path (it ships only the arities the zkLogin ` +
          `circuit uses); pass \`poseidon: Poseidon.hashUnsafe\` to use every arity`
      )
    }
    throw new Error(`cannot hash ${values.length} elements (1 to 64 supported)`)
  }
  return hash
}
