/*
 * Hexabot — Fair Core License (FCL-1.0-ALv2)
 * Copyright (c) 2026 Hexastack.
 * Full terms: see LICENSE.md.
 */

import { createHash, randomUUID } from 'node:crypto';

import {
  qualifiedName as table,
  SettingOrmEntity,
  vercelAiSdkProviders,
} from '@hexabot-ai/api';
import { DataSource, In, QueryRunner } from 'typeorm';

import { PGVECTOR_RAG_HELPER_NAME } from './pgvector.settings';

const FULLTEXT_HELPER = 'fulltext-search';
const PGVECTOR_HELPER = PGVECTOR_RAG_HELPER_NAME;
const RAG_SETTINGS_GROUP = 'rag_settings';

type SettingValue = string | number | boolean;

export interface LegacyMigrationLogger {
  warn(message: string, ...args: unknown[]): void;
}

/**
 * One-time, idempotent migration of the pre-v3.4.0 embedding RAG configuration
 * into this helper's own settings.
 *
 * Before the pgvector helper was extracted into its own package, the core
 * v3.4.0 migration carried this logic. Extension packages cannot ship database
 * migrations, so it now runs from the helper's `onApplicationBootstrap`, only
 * when the helper is installed and PostgreSQL is in use.
 *
 * It reads the legacy `rag_settings` group, seeds the `pgvector` settings group
 * (defaults + legacy overrides), converts a legacy embedding API key into a
 * credential, and — when the legacy RAG was enabled in embedding mode — selects
 * `pgvector` as the default RAG helper. The legacy `rag_settings` group is then
 * removed, which makes this a one-shot step (later boots find nothing and skip)
 * and clears the last llamaindex-era settings footprint.
 */
export async function migratePgvectorLegacySettings(
  dataSource: DataSource,
  logger?: LegacyMigrationLogger,
): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  try {
    if (!(await queryRunner.hasTable('settings'))) {
      return;
    }

    const repository = queryRunner.manager.getRepository(SettingOrmEntity);
    const settings = await repository.find({
      where: {
        group: In(['global_settings', RAG_SETTINGS_GROUP, PGVECTOR_HELPER]),
      },
    });
    const settingByKey = new Map(
      settings.map((setting) => [`${setting.group}:${setting.label}`, setting]),
    );
    // Nothing legacy to migrate: this is a fresh install or a subsequent boot
    // where `rag_settings` was already consumed. The pgvector group defaults are
    // seeded through the normal setting-group registration, so skip.
    const hasLegacySettings = settings.some(
      (setting) => setting.group === RAG_SETTINGS_GROUP,
    );
    if (!hasLegacySettings) {
      return;
    }

    await queryRunner.startTransaction();
    try {
      const getLegacyValue = (label: string): unknown =>
        settingByKey.get(`${RAG_SETTINGS_GROUP}:${label}`)?.value;
      const legacyApiKey = asNonEmptyString(
        getLegacyValue('embedding_api_key'),
      );
      const embeddingCredentialId = legacyApiKey
        ? await migrateLegacyEmbeddingCredential(queryRunner, legacyApiKey)
        : undefined;
      if (legacyApiKey && !embeddingCredentialId) {
        logger?.warn(
          'The legacy RAG embedding API key could not be converted to a credential because no credential owner was available. Lexical RAG remains selected; the pgvector helper starts without a credential.',
        );
      }

      const pgvectorBaseDefaults: Record<string, SettingValue> = {
        embedding_provider: 'openai',
        embedding_model: 'text-embedding-3-small',
        embedding_api_key: '',
        embedding_base_url: '',
        embedding_dimensions: 1536,
        chunk_size: 2000,
        chunk_overlap: 200,
        index_only_active_content: true,
      };
      const legacyOverrides: Partial<Record<string, SettingValue>> = {
        ...(asEmbeddingProvider(getLegacyValue('embedding_provider'))
          ? {
              embedding_provider: asEmbeddingProvider(
                getLegacyValue('embedding_provider'),
              ),
            }
          : {}),
        ...(asNonEmptyString(getLegacyValue('embedding_model'))
          ? {
              embedding_model: asNonEmptyString(
                getLegacyValue('embedding_model'),
              ),
            }
          : {}),
        ...(embeddingCredentialId
          ? {
              embedding_api_key: embeddingCredentialId,
            }
          : {}),
        ...(asString(getLegacyValue('embedding_base_url')) !== undefined
          ? {
              embedding_base_url: asString(
                getLegacyValue('embedding_base_url'),
              ),
            }
          : {}),
        ...(asPositiveInteger(getLegacyValue('embedding_dimensions'))
          ? {
              embedding_dimensions: asPositiveInteger(
                getLegacyValue('embedding_dimensions'),
              ),
            }
          : {}),
        ...(asBoolean(getLegacyValue('index_only_active_content')) !== undefined
          ? {
              index_only_active_content: asBoolean(
                getLegacyValue('index_only_active_content'),
              ),
            }
          : {}),
      };

      for (const [label, defaultValue] of Object.entries(
        pgvectorBaseDefaults,
      )) {
        const key = `${PGVECTOR_HELPER}:${label}`;
        const existing = settingByKey.get(key);
        const legacyValue = legacyOverrides[label];
        const value = legacyValue ?? defaultValue;
        if (!existing) {
          const setting = repository.create({
            group: PGVECTOR_HELPER,
            subgroup: 'helper',
            label,
            value,
          });
          await repository.save(setting);
          settingByKey.set(key, setting);
        } else if (
          legacyValue !== undefined &&
          (existing.value === defaultValue ||
            (label === 'embedding_api_key' &&
              existing.value === legacyApiKey)) &&
          existing.value !== legacyValue
        ) {
          existing.value = legacyValue;
          await repository.save(existing);
        }
      }

      const defaultHelperKey = 'global_settings:default_rag_helper';
      const legacyMode = asString(getLegacyValue('default_mode'));
      const legacyEnabled = asBoolean(getLegacyValue('enabled')) === true;
      const hasApiKey = Boolean(embeddingCredentialId);
      // Only auto-select pgvector when the legacy RAG was actually enabled and in
      // embedding mode with a usable key. Ignoring `enabled` would activate
      // embedding-based indexing on upgrade for installations that deliberately
      // disabled RAG, silently sending content to the external provider.
      const defaultHelper =
        legacyEnabled && legacyMode === 'embedding' && hasApiKey
          ? PGVECTOR_HELPER
          : FULLTEXT_HELPER;
      const existingDefault = settingByKey.get(defaultHelperKey);
      if (!existingDefault) {
        await repository.save(
          repository.create({
            group: 'global_settings',
            label: 'default_rag_helper',
            value: defaultHelper,
          }),
        );
      } else if (
        legacyMode !== undefined &&
        [FULLTEXT_HELPER, PGVECTOR_HELPER].includes(existingDefault.value) &&
        existingDefault.value !== defaultHelper
      ) {
        // Replace only known built-in defaults; preserve custom helpers a user
        // may have selected.
        existingDefault.value = defaultHelper;
        await repository.save(existingDefault);
      }

      // Consume the legacy group so this migration runs exactly once.
      await repository.delete({ group: RAG_SETTINGS_GROUP });

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    }
  } finally {
    await queryRunner.release();
  }
}

async function migrateLegacyEmbeddingCredential(
  queryRunner: QueryRunner,
  apiKey: string,
): Promise<string | undefined> {
  if (
    !(await queryRunner.hasTable('credentials')) ||
    !(await queryRunner.hasTable('users'))
  ) {
    return undefined;
  }

  const credentials = table(queryRunner, 'credentials');
  const users = table(queryRunner, 'users');
  const placeholder = (index: number) =>
    queryRunner.connection.options.type === 'postgres' ? `$${index}` : '?';
  const existingById = (await queryRunner.query(
    `SELECT "id" FROM ${credentials} WHERE "id" = ${placeholder(1)} LIMIT 1`,
    [apiKey],
  )) as Array<{ id: string }>;
  if (existingById[0]?.id) {
    return existingById[0].id;
  }

  const fingerprint = createHash('sha256')
    .update(apiKey)
    .digest('hex')
    .slice(0, 12);
  const name = `Legacy RAG embedding API key (${fingerprint})`;
  const existingByName = (await queryRunner.query(
    `SELECT "id" FROM ${credentials} WHERE "name" = ${placeholder(1)} LIMIT 1`,
    [name],
  )) as Array<{ id: string }>;
  if (existingByName[0]?.id) {
    return existingByName[0].id;
  }

  const owners = (await queryRunner.query(
    `SELECT "id" FROM ${users} WHERE "type" = ${placeholder(1)} ORDER BY "id" LIMIT 1`,
    ['UserOrmEntity'],
  )) as Array<{ id: string }>;
  const ownerId = owners[0]?.id;
  if (!ownerId) {
    return undefined;
  }

  const id = randomUUID();
  await queryRunner.query(
    `INSERT INTO ${credentials} ("id", "name", "value", "owner_id") ` +
      `VALUES (${placeholder(1)}, ${placeholder(2)}, ${placeholder(
        3,
      )}, ${placeholder(4)})`,
    [id, name, apiKey, ownerId],
  );

  return id;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true' || value === 'false') {
    return value === 'true';
  }

  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  const stringValue = asString(value)?.trim();

  return stringValue || undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function asEmbeddingProvider(
  value: unknown,
): (typeof vercelAiSdkProviders)[number] | undefined {
  const provider = asNonEmptyString(value);

  return vercelAiSdkProviders.find((candidate) => candidate === provider);
}
