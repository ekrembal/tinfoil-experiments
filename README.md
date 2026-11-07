# tinfoil-experiments: attestai enclave

> **Research code, not for production.** Local development signatures are NOT hardware attestations. Agent-generated code is untrusted. No enclave deployment is claimed by this repository.

Source: [ekrembal/tinfoil-experiments](https://github.com/ekrembal/tinfoil-experiments).

A thin, offline build service for a **real Pi coding-agent CLI**, inside a Tinfoil Container. Inspired by the prompt/provenance chain in [ekrembal/attestai](https://github.com/ekrembal/attestai): verify the entire parent chain before extending it, retain exact prompts and hashes, and authenticate the resulting artifact. This is a new implementation, not a copy of that project's GPL workflow.

```
POST /jobs → copy offline starter → pnpm install --offline → pi -p → vite build
                                                       ↓
                            localhost:3301 → official Tinfoil Proxy → attested inference
dist/ → deterministic tar.gz + file manifest + UnixFS CIDv1 → Ed25519 signature
                                                           + nonce-bound V3 attestation
```

There is **no custom agent/tool loop**. Pi owns read/write/edit/bash/ls execution. The job wrapper only launches the CLI and the build. Pi `1.5.0` (`@earendil-works/pi-coding-agent`, the current package name of the Pi project) and official `tinfoil-proxy 0.2.9` are pinned; proxy release binaries are SHA-256 checked during image build. Both identities are recorded in the signed statement. Pi natively supports `openai-completions`, avoiding an API translation layer. The default is **`deepseek-v4-1-flash` (DeepSeek V4.1 Flash)**, the available DeepSeek Flash model returned by the attested `/v1/models` endpoint, with tool calling and a 1M-token context window. Listed prices are $0.60/M input and $1.45/M output tokens. No Kimi/Pro model is used. An authenticated streaming `/v1/responses` probe returned function-call items and argument deltas, but the final response changed the call/item IDs relative to the streaming items; nanocodex compatibility is not established or integrated.

## Build and test

Requires Docker, and Node 24.22.2+ for running the local verifier/tests outside Docker. Image build uses the network; **jobs do not need a package registry**.

```sh
docker build -f harness/Dockerfile -t attestai-enclave:dev .
mkdir -p evidence
# Mock inference runs on loopback INSIDE the same networkless container.
# This executes the real Pi CLI against streamed OpenAI tool calls, not a fake agent.
docker run --rm --network none \
  -v "$PWD/tests:/opt/app/tests:ro" -v "$PWD/evidence:/evidence" \
  attestai-enclave:dev node tests/integration.mjs

npm ci --ignore-scripts
npm run build:verifier
npm test
node verifier/cli.mjs evidence/statement.json evidence/artifact.tar.gz --allow-dev
# Must fail: one changed byte
node verifier/cli.mjs evidence/statement.json evidence/tampered.tar.gz --allow-dev

# Real Kubo, no daemon or network, default CIDv1 raw leaves:
docker run --rm --network none --entrypoint /bin/sh \
  -v "$PWD/tests:/tests:ro" -v "$PWD/evidence:/evidence:ro" \
  ipfs/kubo:v0.34.1@sha256:1cf421fbd881d01144c0da39aa1511c05f1ef3fd5eebee6ba7487ecc0f915a44 /tests/kubo.sh
# Compare that output with statement.predicate.artifact.cid.

# Real upstream verification, no inference API key required. A CONNECT gate
# refuses any HTTPS host except inference.tinfoil.sh:443.
docker run --rm -v "$PWD/tests:/opt/app/tests:ro" \
  -v "$PWD/evidence:/evidence" attestai-enclave:dev node tests/proxy-hosts.mjs
```

`evidence/` is ignored by git and retains the full returned statement, original/tampered archives, extracted dist, job log and live proxy verification document. The integration mock asks Pi to write a React counter using the vendored shadcn Button and lucide icon, then run offline pnpm install and a PWA build. API authentication, invalid/empty requests, concurrency rejection, invalid parent signatures, verifier opt-in and artifact tamper rejection are checked too. This is a functional, not visual, UI check.

## API

Set `JOBS_BEARER_TOKEN` (at least 16 characters) as a Tinfoil secret. Every route requires `Authorization: Bearer <token>`; no public artifact URLs.

* `POST /jobs` with `{"prompt":"...","parent_statement":{...optional full envelope...}}` → HTTP 202 `{"id":"uuid"}`. Prompt is exact UTF-8 input, not whitespace-normalized. Invalid parents are rejected before running any agent.
* `GET /jobs/:id` → `{id,status,logs}`. States: queued/running/completed/failed.
* `GET /jobs/:id/artifact` → gzip tar containing `dist/` (409 before completed).
* `GET /jobs/:id/statement` → signed envelope (409 before completed).
* `GET /jobs/:id/log` → streamed raw Pi JSON events, including thinking and tool contents, with the same bearer authentication. Available during execution and after failures (409 until the file exists). Running downloads are partial snapshots; the signed hash applies to the completed log.
* `GET /jobs/:id/source` → gzip tar of the job's source workspace (no `node_modules`/`dist`), bearer-authenticated, 409 before completed. Its sha256 is signed as `predicate.source.sha256` (online profile).
* `POST /jobs` (online profile) also accepts `"parent_source": "<base64 gzip tar>"` next to `parent_statement`. It is accepted only after the parent chain verifies and only if its sha256 equals `parent_statement.statement.predicate.source.sha256`; the job then starts from that source instead of the starter template. Unsafe archives (absolute paths, `..`, links, special files) and oversized bodies are rejected.

Example (use an attestation-verifying client or `tinfoil http` for a real enclave, rather than trusting ordinary HTTPS alone):

```sh
curl -H "Authorization: Bearer $JOBS_BEARER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Build an offline encrypted notes PWA"}' http://localhost:8080/jobs
```

The service intentionally runs one job at a time (409 while busy), limits input size, and has an in-memory status index. `JOB_TIMEOUT_SECONDS` is caller policy for the process wall-clock budget (default 900 seconds, shared by install, Pi and build). Log volume never terminates Pi. Raw stdout streams byte-for-byte to a root-owned `0600` per-job `.pi.jsonl` beside its workspace under `/workspaces`; JSON event parsing is streaming, including large strings. Only a bounded human-readable assistant/tool summary tail is retained for job status; thinking deltas are omitted. Results, workspaces and logs remain on local storage until the container is removed; optionally mount a suitably sized tmpfs at `/workspaces`. Disk/write errors fail the job rather than silently losing the transcript. No retention service or restart recovery is implemented. Do not expose this to untrusted users.

## Offline toolchain

`templates/react/` is a Vite + React + TypeScript + Tailwind 3 + shadcn-style starter, including PWA service-worker generation and a local SVG icon. Button, Card and Input component sources are vendored/adapted from shadcn patterns; upstream MIT notice is retained. No `npx shadcn` or runtime registry access is needed.

The image bakes **pnpm 10.11.0**, a frozen starter lockfile and `/opt/store` containing all 465 resolved Linux packages: Vite, React, TS, Tailwind, Radix dialog/label/separator/slot, class-variance-authority, clsx, tailwind-merge, lucide-react, libsodium-wrappers, @noble/ciphers/curves/hashes, **ollama** (the official ollama-js npm package), simple-peer, nostr-tools and vite-plugin-pwa. `pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir=/opt/store` works without network. Arbitrary new package names/versions are not supported; update the template and lockfile and rebuild the image to extend the catalog. Network-capable libraries are available as build inputs, not as permission to contact their services inside the enclave. PWA/browser network access is a separate deployment concern.

## Inference verification and exact egress allowlist

The only allowed hostname is **`inference.tinfoil.sh`**, for TCP/443 HTTPS:

| Request | Why |
| --- | --- |
| `/.well-known/tinfoil-attestation?nonce=...` | Official Go SDK retrieves the fresh V3 report, endorsements and collateral; verifies hardware evidence, provenance, nonce and transport keys locally. |
| `/v1/chat/completions` | Proxy encrypts request/response bodies to the endorsed HPKE key (EHBP); Pi talks only to the loopback proxy. |

This is specific to pinned **proxy 0.2.9 → tinfoil-go 0.16.2**, with explicit `-e inference.tinfoil.sh -r tinfoilsh/confidential-model-router`. No router discovery occurs. Source references: proxy `buildUpstream` calls `NewClientWithOptions` with the fixed host/repo; SDK `verifier/client/verify.go` calls `document.FetchVia` directly; `verifier/document/fetch.go` builds the host's nonce URL; the core verifier performs no network I/O. Complete V3 collateral and trust roots are supplied/embedded. Therefore **no GitHub, Sigstore, AMD KDS, ATC, registry, CDN or npm endpoints belong in this runtime allowlist**. These are not omitted accidentally: the included `tests/proxy-hosts.mjs` successfully initializes the official proxy through a CONNECT gate allowing only this host. GitHub release downloads and npm/Debian registries are **build-time only**. SDK/proxy upgrades may change this contract; rerun the gate test before updating the allowlist. Tinfoil only enforces IPv4 hostname resolution today.

`harness/start.mjs` starts the official proxy and waits for `/verification-document` (the proxy only listens after successful verification), then starts the API. Production has no unverified direct API fallback. The proxy refreshes verification on key changes/expiry. Job statements retain its verification document; this is diagnostic metadata, not a substitute for independently checking the job's own attestation.

## Online profile network policy

`tinfoil-config.online.yml` (identical to the root `tinfoil-config.yml` on branch `profile/online`) is used for `-online` releases.

| Container | Networks | Egress | Holds |
| --- | --- | --- | --- |
| `signer` | `internal` only | **closed** | `job-signing` key, attestation socket, `JOBS_BEARER_TOKEN` |
| `worker` (Pi agent + npm build) | `internet`, `internal` | **open** (no allowlist) | `TINFOIL_API_KEY` only |

The worker and the build may reach any host, registry or CDN. The signer never runs npm, the build or job code; it pulls the worker's dist/source/transcript over the internal network and recomputes the file manifest, UnixFS CID, tarball and source SHA-256 itself (the starter's `npm run manifest` CID output is never trusted). It refuses to sign if `dist/app.json` is missing or invalid (name ≤30, tagline ≤80, description ≤400, category in the store list, PascalCase lucide icon) or if `dist/index.html` or a bundled web manifest uses `/`- or `//`-rooted paths. The prompt is passed to Pi exactly as received; the harness adds no system prompt (Pi's own built-in prompt still applies).

The statement records `predicate.profile: "online"`, `predicate.worker_egress: {"mode":"open"}` and `predicate.network: {"signer":"closed","worker":"open"}`; the verifier prints that the build had unrestricted internet access.

> **Caveat:** online builds are **not reproducible and not network-isolated**. The agent and build can download and execute arbitrary code from the internet, and dependency versions may differ between runs. The attestation proves which measured harness, model and prompt produced the signed bytes, not that those bytes are safe or that their remote inputs were trustworthy.

## Statements and verification

The signed `predicate.transcript.sha256` commits to every byte of Pi's full stdout JSON event stream. Optional verifier `--log pi.jsonl` recomputes this hash without loading the log into memory. Stderr and wrapper build output are summarized separately, not part of this commitment. Transcript contents are untrusted and may be sensitive; the hash does not certify the truth of agent narration.

The envelope contains `statement`, SPKI PEM `public_key`, base64 Ed25519 `signature`, `attestation`, and optionally the full recursive `parent` envelope. The signed in-toto-like statement records image digest, expected config repository (not a self-reported commit), agent/version, model, exact prompt and SHA-256, parent statement SHA-256, tarball SHA-256, per-file SHA-256/size and the root UnixFS CIDv1 of `dist/`.

Canonicalization is this project's recursively sorted-key compact JSON (`canonical` in `harness/provenance.mjs`), UTF-8, no newline; it is not a claim of RFC 8785 interoperability for arbitrary JSON numbers. The Ed25519 signature covers exactly those bytes. The nonce is `sha256(canonical(statement))` as 64 lowercase hex characters, requested via `/tinfoil/attestation.sock` at the documented `/.well-known/tinfoil-attestation` path. This binds a fresh quote to output content; it is **not** a verifier-chosen random freshness challenge and does not prove a wall-clock build time.

The signer loads `/run/tinfoil/keys/job-signing/private_key.pem`. The verifier checks the signature, nonce-bound V3 quote against the caller's **expected** config repo, and that `crypto_material` endorses exactly the signing key's SPKI DER. It also verifies every parent signature/attestation/hash recursively (max 32 ancestors), tarball SHA-256, extracted per-file manifest and UnixFS CID. Symlinks/special files and unsafe archives are rejected. The CID uses SHA-256, CIDv1, raw leaves, fixed 256-KiB chunks and UnixFS balanced layout, matching `ipfs add --cid-version=1 -r dist` defaults. No IPFS upload or daemon is involved. Empty directories are included.

```sh
node verifier/cli.mjs statement.json artifact.tar.gz --repo ekrembal/tinfoil-experiments --log pi.jsonl
```

The official V3 JavaScript verifier source is vendored unmodified at a pinned upstream commit because npm `tinfoil`/`@tinfoilsh/verifier 1.4.0` cannot verify the socket's nonce-bound V3 attested-key documents. See `verifier/vendor/PROVENANCE.md` (Apache-2.0). It verifies AMD/Intel hardware signatures, authenticated workload/config provenance and measurement/key binding with embedded trust roots and document collateral, without network calls. Do not replace this with signature-only checking.

Dev mode (`DEV_MODE=1`) generates an ephemeral in-memory key and marks both statement and attestation as `dev/none`. Only dev mode accepts `MOCK_INFERENCE_URL`. The verifier rejects dev documents unless explicitly given `--allow-dev`; dev chains provide tamper detection **but no trusted authorship**. A real Tinfoil deployment and real job attested-key/socket verification still require deployment credentials and are not exercised by the local mock test.

A parent links **prompts/provenance**, not workspace state. Each job starts from the measured starter; the API does not accept parent source/artifacts or prove incremental source continuity. Parent artifacts are not downloaded or rehashed by the server; the offline verifier checks the supplied latest artifact and the signed ancestry. The config/image fields are declared metadata from deployment environment, not values the container can discover securely itself; the authoritative workload identity is the verified quote. For rollback resistance, independently pin/review the expected deployed config and SDK trust policy rather than accepting a repo name alone.

## Deployment and limitations

Each prompt-chain entry prints `attestation_verification` from the SDK's verified result, or `null` in development. For config-based V3 documents, `config.name`, `config.digest` and endorsement metadata identify the authenticated configuration; `runtime.repo/tag/commit/digest` identify the separately authenticated runtime. For release-based documents, `configRepo/codeTag/codeDigest` identify the verified release. **A runtime commit is not a config-repository commit.** The SDK does not expose a config Git SHA for every document format, so the verifier does not invent one or trust a statement/env-provided SHA. To identify a config Git commit, additionally resolve the authenticated config revision/digest or release tag through trusted signed release provenance for the expected repository; this repository does not implement that extra lookup. The authoritative binding here is the SDK-verified config/release identity plus the nonce-bound quote and endorsed signing key, not self-referential YAML metadata. The caller must still choose the trusted `--repo`; accepting the signer's choice of repository would not establish the intended workload.

`tinfoil-config.yml` declares the attested signing key, attestation socket, four CPUs/8 GiB, the one-host allowlist, secrets and shim `/jobs` paths. **Replace the image digest placeholders before deployment**; do not deploy the zero digest. Publish the image and configure a Tinfoil measured release for the public config repository using Tinfoil's current release workflow/template. The public source repository is `ekrembal/tinfoil-experiments`; no container deployment has been performed. Set `TINFOIL_API_KEY` and `JOBS_BEARER_TOKEN` as Tinfoil secrets. Keep `DEV_MODE` and `MOCK_INFERENCE_URL` unset in production. `CONFIG_REPO` is an expected verification policy, not proof by itself. There is no `CONFIG_COMMIT` environment variable or statement field. The image digest is pinned in the measured configuration.

Pi and build scripts run as UID/GID 1001, with a job-local HOME/cwd and a sanitized environment; bearer token and signing key are not passed to children, and `/data` and the mounted private key are root-only. This is **not a hostile-code sandbox**: the CLI has bash and can access readable filesystem paths, its inference API key and the allowed inference host; it may spawn processes. cwd is not a security boundary. No custom execution sandbox is provided. Do not submit hostile prompts or run multi-tenant workloads. Strong per-job isolation, resource quotas, descendant process containment, disk retention, dependency audits and reproducible application builds are future work. The enclave protects against its host, not against code you choose to run inside it.

## License

MIT, copyright **the attestai-enclave contributors**. Vendored official Tinfoil verifier source remains Apache-2.0; shadcn-derived components retain their upstream MIT notice. See `LICENSE`, `verifier/vendor/LICENSE` and `templates/react/SHADCN-LICENSE`.
