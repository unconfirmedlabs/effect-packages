/**
 * Names the README examples use without defining them (a signer, a recipe,
 * an endpoint). Declarations only: the examples are compiled, never run.
 */
import * as Effect from "effect/Effect"
import type { PtbBuilder } from "@unconfirmed/effect-sui/Ptb"
import * as SignatureScheme from "@unconfirmed/effect-sui/SignatureScheme"
import type * as Signer from "@unconfirmed/effect-sui/Signer"

export declare const signer: Signer.Signer
export declare const url: string
export declare const to: string
export declare const recipe: Effect.Effect<void, never, PtbBuilder>
export const SignatureSchemes = SignatureScheme.SignatureSchemes
