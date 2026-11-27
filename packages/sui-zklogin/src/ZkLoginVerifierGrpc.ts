/**
 * `ZkLoginVerifier` over gRPC: `SignatureVerificationService.VerifySignature`
 * on a full node, which checks the proof against on-chain JWKs and the
 * current epoch.
 *
 *   ZkLoginVerifierGrpc.layer.pipe(Layer.provide(GrpcWeb.GrpcWeb.layer({ baseUrl })))
 */
import * as GrpcWeb from "@unconfirmed/sui/grpc/GrpcWeb"
import * as Rpc from "@unconfirmed/sui/grpc/generated/rpc"
import * as Hash from "@unconfirmed/sui/Hash"
import * as SignatureScheme from "@unconfirmed/sui/SignatureScheme"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ZkLoginVerifier } from "./ZkLoginVerifier.ts"

const invalid = (reason: string) => new SignatureScheme.InvalidSignature({ scheme: "ZkLogin", reason })

/** The node takes the message by name; the value is the intent message minus its 3-byte intent. */
const messageName = (scope: number | undefined) =>
  scope === Hash.IntentScope.TransactionData
    ? "TransactionData"
    : scope === Hash.IntentScope.PersonalMessage
    ? "PersonalMessage"
    : undefined

export const layer: Layer.Layer<ZkLoginVerifier, never, GrpcWeb.GrpcWeb> = Layer.effect(
  ZkLoginVerifier,
  Effect.gen(function*() {
    const grpc = yield* GrpcWeb.GrpcWeb
    return ZkLoginVerifier.of({
      verify: ({ address, intentMessage, signature }) => {
        const name = messageName(intentMessage[0])
        if (name === undefined || intentMessage.length < 3) {
          return Effect.fail(invalid("zkLogin signatures verify only over transactions and personal messages"))
        }
        // The node is sent the message without its intent, so the intent must be exactly
        // `[scope, version 0, app Sui 0]`: anything else would verify a message that was never signed.
        if (intentMessage[1] !== 0 || intentMessage[2] !== 0) {
          return Effect.fail(invalid(`unsupported intent version ${intentMessage[1]} / app id ${intentMessage[2]}`))
        }
        return grpc.unary(Rpc.SignatureVerificationService_VerifySignature, {
          message: { name, value: intentMessage.subarray(3) },
          signature: { bcs: { value: signature } },
          address,
          check_address_aliases: false
        }).pipe(
          Effect.mapError((e) =>
            // The request is well-formed by construction, so a rejected argument is the node's
            // verdict on the signature (unparseable, bad proof, unknown JWK). Anything else is no verdict.
            e.code === "INVALID_ARGUMENT"
              ? invalid(e.message)
              : new SignatureScheme.VerificationUnavailable({
                scheme: "ZkLogin",
                reason: `${e.code}: ${e.message}`,
                retryable: e.retryable
              })
          ),
          Effect.flatMap((res) =>
            res.is_valid === true ? Effect.void : Effect.fail(invalid(res.reason ?? "rejected by the node"))
          ),
          Effect.withSpan("ZkLoginVerifierGrpc.verify")
        )
      }
    })
  })
)
