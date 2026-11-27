# Spike: a ground-up Effect Sui SDK

Proof of the risky parts of [`../EXPLORATION.md`](../EXPLORATION.md). Not a library.

| File | What it shows |
|---|---|
| `src/bcs/Bcs.ts` | BCS declared as Effect Schemas (layout as an annotation), compiled reader/writer |
| `src/sui/Types.ts` | The transaction data model as BCS Schemas, type tag parsing |
| `src/grpc/GrpcWeb.ts` | gRPC-web over `HttpClient` + `effect/protobuf`, unary and server streaming |
| `src/sui/SuiClient.ts` | Typed client; `getObject` batched via `RequestResolver`, cached function metadata, checkpoints as `Stream` |
| `src/tx/Ptb.ts` | PTB builder where a recipe is an `Effect<A, E, PtbBuilder \| ...>` |
| `src/tx/Tx.ts` | Resolver (batched lookups, mutability inference, gas), execute |
| `src/crypto/Signer.ts` | Signer as a value; Ed25519 via `effect/crypto` |

```sh
bun install
bun test                 # offline: parity with @mysten/sui (BCS bytes, built tx bytes, signatures)
SUI_LIVE=1 bun test      # + live testnet reads and a devnet faucet->execute run
bun run proto            # regenerate the descriptor set from proto-src/ (sui-apis)
```

`@mysten/sui` is a devDependency used only as the reference in parity tests.
