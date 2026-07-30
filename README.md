# Hexabot pgvector Helper

`hexabot-helper-pgvector` adds semantic Retrieval-Augmented Generation (RAG) to
[Hexabot](https://hexabot.ai) v3, backed by embeddings stored in PostgreSQL via
the [`pgvector`](https://github.com/pgvector/pgvector) extension. The helper is
installed as a standard npm package and is discovered by the API automatically.

This is an optional extension. Install it only when you run Hexabot on
PostgreSQL and want embedding-based semantic retrieval. Without it, Hexabot
falls back to the built-in lexical `fulltext-search` helper.

## Installation

Install the package in the same workspace or deployment that runs
`@hexabot-ai/api`:

```sh
npm add hexabot-helper-pgvector
```

Restart the API after installation. The helper is picked up by the
dynamic-provider loader (`node_modules/hexabot-helper-*/**/*.helper.js`) and
appears with the name `pgvector`, exposing a `pgvector` settings group. No
manual registration is required.

## Prerequisites

Before configuring the helper, make sure you have:

- a Hexabot deployment running `@hexabot-ai/api` v3.4.0 or later;
- a **PostgreSQL** database with the **`vector`** extension available. The
  official `pgvector/pgvector` Docker image ships it preinstalled. The helper is
  a no-op on SQLite — `isAvailable()` returns `false`;
- an embedding provider reachable from the API (OpenAI or any OpenAI-compatible
  endpoint), and a Hexabot credential holding its API key.

## What It Does

- Creates and self-heals its own schema on PostgreSQL —
  `rag_pgvector_documents`, `rag_pgvector_chunks`, `rag_pgvector_jobs`, an
  enqueue trigger, and the `vector` extension. See `src/pgvector.provisioning.ts`.
  Provisioning happens lazily at runtime (`PgvectorStore.assertInfrastructure`),
  so no core database migration is needed.
- Runs a durable, trigger-backed indexing queue that embeds content and answers
  retrieval queries via cosine similarity.
- On first bootstrap it performs a one-time migration of any legacy
  `rag_settings` (pre-v3.4.0 embedding configuration) into the `pgvector`
  settings group, converts a legacy embedding API key into a credential, and —
  when the legacy RAG was enabled in embedding mode — selects `pgvector` as the
  default RAG helper. The legacy `rag_settings` group is removed afterwards,
  making this a one-shot, idempotent step.

## Configuration

Configure the helper from the Hexabot admin UI under the **pgvector** settings
group:

- embedding `provider`, `model`, `credential`, base URL and `dimensions`;
- the chunking parameters used when indexing content.

Select it as the active RAG helper by setting
`global_settings:default_rag_helper` to `pgvector`.

## Development

```sh
npm install
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm test             # unit tests
npm run build        # tsc -> dist/
```

The real-PostgreSQL integration suite in `src/pgvector.integration.spec.ts` is
skipped unless `TEST_PGVECTOR_DATABASE_URL` is set:

```sh
docker run --rm -d -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=hexabot_test \
  pgvector/pgvector:pg17

TEST_PGVECTOR_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hexabot_test \
  npm test
```

## Release

Publishing is handled by the `Publish NPM Package` GitHub Actions workflow,
which runs on pushes to `main` and on `v*` tags. It publishes only when the
version in `package.json` is not already on npm, tagging pre-release versions
as `next` and everything else as `latest`. The workflow needs an `NPM_TOKEN`
repository secret.

To cut a release:

```sh
npm run release:patch   # or release:minor
```

## License

This extension is licensed under the Fair Core License (FCL-1.0-ALv2). See
[LICENSE.md](./LICENSE.md).
