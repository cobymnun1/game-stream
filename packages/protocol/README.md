# @basehack/protocol

Browser-facing TypeScript wrapper plus Emscripten build scaffold for
[`moonlight-common-c`](https://github.com/moonlight-stream/moonlight-common-c).

## Fetch upstream sources

```sh
pnpm --filter @basehack/protocol fetch:moonlight
```

This checks out `moonlight-common-c` at the pinned revision in
`scripts/fetch-moonlight-common-c.mjs` and initializes its required submodules,
including the bundled ENet fork.

`moonlight-common-c` is GPL-3.0. Distributing a client that vendors or links the
resulting WASM build must comply with GPL-3.0 obligations for the combined work.

## Build

Install and activate Emscripten first, then run:

```sh
pnpm --filter @basehack/protocol configure
pnpm --filter @basehack/protocol build:wasm
```

The generated `moonlight.js` and `moonlight.wasm` are written to `dist/`. The
TypeScript wrapper can be typechecked independently with:

```sh
pnpm --filter @basehack/protocol typecheck
```

## Runtime boundary

The generated module expects the TypeScript wrapper to pass:

- `moonlightTransport`: a Direct Sockets backed transport registry.
- `moonlightCallbacks`: browser callbacks for connection state, encoded video,
  audio packets, and errors.

The Emscripten JS library must stay package-local and must not import IWA source
files directly.
