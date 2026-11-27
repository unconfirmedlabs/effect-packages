/**
 * Dev-only oracle: `@mysten/seal` 2.0.1 internals, loaded from its shipped
 * build (untyped; only what the parity tests call is declared).
 */
const dist = "../../../node_modules/@mysten/seal/dist"

interface PointLike {
  toBytes(): Uint8Array
}
export interface MystenG1 extends PointLike {
  multiply(s: MystenScalar): MystenG1
  pairing(other: MystenG2): MystenGT
}
export interface MystenG2 extends PointLike {
  multiply(s: MystenScalar): MystenG2
}
export interface MystenGT extends PointLike {}
export interface MystenScalar extends PointLike {
  readonly scalar: bigint
}

export const mystenBls = (await import(`${dist}/bls12381.mjs`)) as {
  G1Element: {
    fromBytes(bytes: Uint8Array): MystenG1
    generator(): MystenG1
    hashToCurve(data: Uint8Array): MystenG1
  }
  G2Element: {
    fromBytes(bytes: Uint8Array): MystenG2
    generator(): MystenG2
  }
  Scalar: {
    fromBigint(n: bigint): MystenScalar
    fromBytes(bytes: Uint8Array): MystenScalar
  }
}

export const mystenKdf = (await import(`${dist}/kdf.mjs`)) as {
  KeyPurpose: { EncryptedRandomness: 0; DEM: 1 }
  hashToG1(id: Uint8Array): MystenG1
  kdf(element: MystenGT, nonce: MystenG2, id: Uint8Array, objectId: string, index: number): Uint8Array
  deriveKey(purpose: 0 | 1, baseKey: Uint8Array, encryptedShares: Array<Uint8Array>, threshold: number, keyServers: Array<string>): Uint8Array
}

export const mystenIbe = (await import(`${dist}/ibe.mjs`)) as {
  DST_POP: Uint8Array
  BonehFranklinBLS12381Services: {
    new (services: Array<{ objectId: string; pk: Uint8Array }>): {
      encryptBatched(
        id: Uint8Array,
        shares: Array<{ index: number; share: Uint8Array }>,
        baseKey: Uint8Array,
        threshold: number
      ): { BonehFranklinBLS12381: { nonce: Uint8Array; encryptedShares: Array<Uint8Array>; encryptedRandomness: Uint8Array } }
    }
    verifyUserSecretKey(usk: MystenG1, id: string, publicKey: MystenG2): boolean
    decrypt(nonce: MystenG2, sk: MystenG1, ciphertext: Uint8Array, id: Uint8Array, service: [string, number]): Uint8Array
  }
}

export const mystenElGamal = (await import(`${dist}/elgamal.mjs`)) as {
  elgamalDecrypt(sk: Uint8Array, ciphertext: [Uint8Array, Uint8Array]): Uint8Array
  toPublicKey(sk: Uint8Array): Uint8Array
  toVerificationKey(sk: Uint8Array): Uint8Array
}

type MystenCiphertext =
  | { Aes256Gcm: { blob: Uint8Array | Array<number>; aad: Uint8Array | Array<number> | null } }
  | { Hmac256Ctr: { blob: Uint8Array | Array<number>; aad: Uint8Array | Array<number> | null; mac: Uint8Array | Array<number> } }

export const mystenDem = (await import(`${dist}/dem.mjs`)) as {
  AesGcm256: {
    new (msg: Uint8Array, aad: Uint8Array): { encrypt(key: Uint8Array): Promise<MystenCiphertext> }
    decrypt(key: Uint8Array, ciphertext: MystenCiphertext): Promise<Uint8Array>
  }
  Hmac256Ctr: {
    new (msg: Uint8Array, aad: Uint8Array): { encrypt(key: Uint8Array): Promise<MystenCiphertext> }
    decrypt(key: Uint8Array, ciphertext: MystenCiphertext): Promise<Uint8Array>
  }
}

export const mystenShamir = (await import(`${dist}/shamir.mjs`)) as {
  split(secret: Uint8Array, threshold: number, total: number): Array<{ index: number; share: Uint8Array }>
  combine(shares: Array<{ index: number; share: Uint8Array }>): Uint8Array
  interpolate(shares: Array<{ index: number; share: Uint8Array }>): (x: number) => Uint8Array
}

export const mystenUtils = (await import(`${dist}/utils.mjs`)) as {
  createFullId(packageId: string, innerId: string): string
}

export const mystenBcs = (await import(`${dist}/bcs.mjs`)) as {
  EncryptedObject: { parse(bytes: Uint8Array): any }
}

/** Run `f` with `crypto.getRandomValues` answering from `source`, recording every draw. */
export const withRandomValues = <A>(source: (length: number) => Uint8Array, f: () => A): { result: A; draws: Array<Uint8Array> } => {
  const original = crypto.getRandomValues
  const draws: Array<Uint8Array> = []
  crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
    if (array === null) return array
    const bytes = source(array.byteLength)
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes)
    draws.push(bytes)
    return array
  }) as typeof crypto.getRandomValues
  try {
    return { result: f(), draws }
  } finally {
    crypto.getRandomValues = original
  }
}
