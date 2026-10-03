# Vendored demoparser (CS2 demo parser core)

- Upstream: https://github.com/LaihoE/demoparser (MIT)
- Commit: c8f79275f30132696abaa22796f7234300b005af (2026-09-30)
- Crates: `src/parser` -> `parser/`, `src/csgoproto` -> `csgoproto/`

Local changes:
- `csgoproto/build.rs` is a no-op (upstream clones protobufs from the network at build time;
  the generated `src/protobuf.rs` is already committed upstream).
- Removed `parser/src/bin/parse_bench.rs`.
- Removed csgoproto codegen tool (`src/main.rs`, `src/parser.rs`, `update_protos.py`).
- `#![allow(warnings)]` added to both crate roots (upstream warnings drowned out ours).
