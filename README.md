# Hexabot pgvector Helper

Semantic Retrieval-Augmented Generation (RAG) helper for [Hexabot](https://hexabot.ai)
v3, backed by embeddings stored in PostgreSQL via the
[`pgvector`](https://github.com/pgvector/pgvector) extension.

This is an optional, separately installable extension. Install it only when you
run Hexabot on PostgreSQL and want embedding-based semantic retrieval. Without
it, Hexabot falls back to the built-in lexical `fulltext-search` helper.

## Requirements

- A Hexabot deployment running `@hexabot-ai/api` (v3.4.0+).
- A **PostgreSQL** database with the **`vector`** extension available. The
  official `pgvector/pgvector` Docker image ships it preinstalled. The helper is
  a no-op on SQLite (`isAvailable()` returns `false`).

## Installation

Add the package to the same workspace/deployment that runs `@hexabot-ai/api`:

```bash
npm add hexabot-helper-pgvector
```

Restart the API. The helper is auto-discovered by the dynamic-provider loader
(`node_modules/hexabot-helper-*/**/*.helper.js`) and appears under the name
`pgvector`, exposing a `pgvector` settings group. No manual registration is
required.

## What it does

- Creates and self-heals its own schema on PostgreSQL (`rag_pgvector_documents`,
  `rag_pgvector_chunks`, `rag_pgvector_jobs`, an enqueue trigger, and the
  `vector` extension) — see `pgvector.provisioning.ts`. Provisioning happens
  lazily at runtime (`PgvectorStore.assertInfrastructure`), so no core database
  migration is needed.
- Runs a durable, trigger-backed indexing queue that embeds content and answers
  retrieval queries via cosine similarity.
- On first bootstrap it performs a one-time migration of any legacy `rag_settings`
  (pre-v3.4.0 embedding configuration) into the `pgvector` settings group,
  converts a legacy embedding API key into a credential, and — when the legacy
  RAG was enabled in embedding mode — selects `pgvector` as the default RAG
  helper. The legacy `rag_settings` group is removed afterwards, making this a
  one-shot, idempotent step.

## Configuration

Configure the helper from the Hexabot admin UI under the **pgvector** settings
group: embedding provider/model/credential/base URL/dimensions and the chunking
parameters. Select it as the active RAG helper via
`global_settings:default_rag_helper = pgvector`.

## Development

```bash
pnpm --filter hexabot-helper-pgvector build      # tsc -> dist/
pnpm --filter hexabot-helper-pgvector test       # unit tests
```

The real-PostgreSQL integration suite is skipped unless
`TEST_PGVECTOR_DATABASE_URL` is set:

```bash
TEST_PGVECTOR_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/hexabot_test \
  pnpm --filter hexabot-helper-pgvector test
```
