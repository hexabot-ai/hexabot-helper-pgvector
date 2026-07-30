/*
 * Hexabot — Fair Core License (FCL-1.0-ALv2)
 * Copyright (c) 2026 Hexastack.
 * Full terms: see LICENSE.md.
 */

import { SettingOrmEntity } from '@hexabot-ai/api';
import { DataSource, Repository } from 'typeorm';

import { migratePgvectorLegacySettings } from './pgvector.legacy-migration';

describe('migratePgvectorLegacySettings', () => {
  let dataSource: DataSource;
  let settings: Repository<SettingOrmEntity>;

  beforeEach(async () => {
    dataSource = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [SettingOrmEntity],
      synchronize: true,
    }).initialize();
    settings = dataSource.getRepository(SettingOrmEntity);
    await dataSource.query(
      `CREATE TABLE "users" ("id" varchar PRIMARY KEY, "type" varchar NOT NULL)`,
    );
    await dataSource.query(
      `INSERT INTO "users" ("id", "type") VALUES ('owner-1', 'UserOrmEntity')`,
    );
    await dataSource.query(
      `CREATE TABLE "credentials" (` +
        `"id" varchar PRIMARY KEY, "name" varchar NOT NULL UNIQUE, ` +
        `"value" text NOT NULL, "owner_id" varchar NOT NULL` +
        `)`,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  const seedLegacyEmbeddingSettings = async (
    apiKey = 'legacy-key',
    enabled = true,
  ) => {
    await settings.save([
      settings.create({
        group: 'rag_settings',
        label: 'enabled',
        value: enabled,
      }),
      settings.create({
        group: 'rag_settings',
        label: 'default_mode',
        value: 'embedding',
      }),
      settings.create({
        group: 'rag_settings',
        label: 'embedding_provider',
        value: 'openai',
      }),
      settings.create({
        group: 'rag_settings',
        label: 'embedding_model',
        value: 'legacy-model',
      }),
      settings.create({
        group: 'rag_settings',
        label: 'embedding_api_key',
        value: apiKey,
      }),
      settings.create({
        group: 'rag_settings',
        label: 'embedding_base_url',
        value: 'https://embeddings.example/v1',
      }),
      settings.create({
        group: 'rag_settings',
        label: 'embedding_dimensions',
        value: 768,
      }),
      settings.create({
        group: 'rag_settings',
        label: 'index_only_active_content',
        value: false,
      }),
    ]);
  };
  const getValue = async (group: string, label: string) =>
    (await settings.findOneByOrFail({ group, label })).value;

  it('migrates legacy embedding settings into the pgvector group and creates a credential', async () => {
    await seedLegacyEmbeddingSettings();

    await migratePgvectorLegacySettings(dataSource);

    await expect(getValue('pgvector', 'embedding_model')).resolves.toBe(
      'legacy-model',
    );
    await expect(getValue('pgvector', 'embedding_provider')).resolves.toBe(
      'openai',
    );
    await expect(getValue('pgvector', 'embedding_base_url')).resolves.toBe(
      'https://embeddings.example/v1',
    );
    await expect(getValue('pgvector', 'embedding_dimensions')).resolves.toBe(
      768,
    );
    await expect(
      getValue('pgvector', 'index_only_active_content'),
    ).resolves.toBe(false);

    const credentialId = await getValue('pgvector', 'embedding_api_key');
    expect(credentialId).toEqual(expect.any(String));
    await expect(
      dataSource.query(
        `SELECT "value", "owner_id" AS "ownerId" FROM "credentials" WHERE "id" = ?`,
        [credentialId],
      ),
    ).resolves.toEqual([{ value: 'legacy-key', ownerId: 'owner-1' }]);
  });

  it('selects pgvector as the default when the legacy RAG was enabled in embedding mode with a key', async () => {
    await seedLegacyEmbeddingSettings();

    await migratePgvectorLegacySettings(dataSource);

    await expect(
      getValue('global_settings', 'default_rag_helper'),
    ).resolves.toBe('pgvector');
  });

  it('keeps lexical as the default when the legacy RAG was disabled', async () => {
    await seedLegacyEmbeddingSettings('legacy-key', false);

    await migratePgvectorLegacySettings(dataSource);

    await expect(
      getValue('global_settings', 'default_rag_helper'),
    ).resolves.toBe('fulltext-search');
  });

  it('keeps lexical as the default when no embedding API key exists', async () => {
    await seedLegacyEmbeddingSettings('');

    await migratePgvectorLegacySettings(dataSource);

    await expect(
      getValue('global_settings', 'default_rag_helper'),
    ).resolves.toBe('fulltext-search');
  });

  it('is a one-shot: it consumes rag_settings and a second run is a no-op', async () => {
    await seedLegacyEmbeddingSettings();

    await migratePgvectorLegacySettings(dataSource);
    // The legacy group is removed so the migration never runs twice.
    expect(await settings.countBy({ group: 'rag_settings' })).toBe(0);

    await migratePgvectorLegacySettings(dataSource);
    expect(
      await dataSource.query(`SELECT COUNT(*) AS count FROM "credentials"`),
    ).toEqual([{ count: 1 }]);
    expect(
      await settings.countBy({ group: 'pgvector', label: 'embedding_model' }),
    ).toBe(1);
  });

  it('does nothing when there is no legacy configuration', async () => {
    await migratePgvectorLegacySettings(dataSource);

    expect(await settings.countBy({ group: 'pgvector' })).toBe(0);
    expect(await settings.countBy({ group: 'global_settings' })).toBe(0);
  });
});
