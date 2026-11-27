/**
 * BFT thresholds over shards (T1–T5). `n` is the number of shards; weight is
 * always counted in shards, never in nodes.
 *
 * `quorum(n)` (`2f + 1`) and `minCorrect(n)` (`n − f`) coincide only when
 * `n ≡ 1 (mod 3)` (T4). Writes and certificates use `minCorrect`: the chain
 * accepts a certificate at `3·weight ≥ 2n + 1`, which is `weight ≥ n − f` (T2).
 */

/** `f = ⌊(n − 1) / 3⌋`. */
export const maxFaulty = (n: number): number => Math.floor((n - 1) / 3)

/** `n − f`: the write and certificate threshold. */
export const minCorrect = (n: number): number => n - maxFaulty(n)

/** `2f + 1`: read-side sampling. */
export const quorum = (n: number): number => 2 * maxFaulty(n) + 1

/** `f + 1`: at least one honest answer. */
export const validity = (n: number): number => maxFaulty(n) + 1
