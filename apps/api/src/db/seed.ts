#!/usr/bin/env node
/**
 * `npm run seed` - a small, clearly-labelled local development dataset.
 *
 * Nothing here is production logic: accounts come from the identity service,
 * games from the project service, publication from the publish service, and the
 * artifact build from the *worker* pipeline, which is loaded dynamically. A
 * deployment that ships only the API still gets a usable dataset (drafts plus
 * social activity) and says so, rather than failing or pretending to have
 * published something.
 *
 * The seed is idempotent: re-running it reuses the same creators and games.
 */

import { createStorageDriver } from '@moydan/storage';
import { loadConfig } from '../config.ts';
import { Db } from './client.ts';
import { createLogger } from '../lib/logger.ts';
import { BlobStore } from '../storage/blobs.ts';
import {
  authenticate,
  registerUser,
  setFollow,
  type AuthenticatedUser,
} from '../services/identity.ts';
import { createGame, findGameBySlug, findGameRow, type GameRow, type ProjectDeps } from '../services/projects.ts';
import type { PublishDeps } from '../services/publish.ts';
import { createComment, setReaction, setSaved, type ReactionType, type SocialDeps } from '../services/social.ts';
import { rebuildAllMetrics } from '../services/play.ts';
import { listTemplates } from '../services/templates.ts';

const DEV_PASSWORD = 'moydan-dev-password';
const DEV_PASSWORD_NOTE = 'every seeded account shares one development-only password';

/** The build pipeline belongs to the worker app and may not be installed. */
const PIPELINE_MODULE = new URL('../../../worker/src/pipeline.ts', import.meta.url).href;

interface PipelineModule {
  runLocalBuild?: (
    deps: PublishDeps,
    input: { gameId: string; userId: string; note?: string },
  ) => Promise<{ releaseId?: string; jobId?: string }>;
}

interface SeedCreator {
  handle: string;
  displayName: string;
  email: string;
  userId: string;
}

const SEED_CREATORS = [
  { handle: 'nova', displayName: 'Nova (seed)', email: 'nova@seed.moydan.local' },
  { handle: 'kai', displayName: 'Kai (seed)', email: 'kai@seed.moydan.local' },
  { handle: 'mira', displayName: 'Mira (seed)', email: 'mira@seed.moydan.local' },
];

/** One game per example template, owned by a different seeded creator. */
const SEED_GAMES = [
  { template: 'bounce-dodge', slug: 'seed-bounce-dodge', title: 'Bounce Dodge (seed)', ownerIndex: 0 },
  { template: 'pulse-tap', slug: 'seed-pulse-tap', title: 'Pulse Tap (seed)', ownerIndex: 1 },
  { template: 'pattern-grid', slug: 'seed-pattern-grid', title: 'Pattern Grid (seed)', ownerIndex: 2 },
];

const SEED_COMMENTS = [
  'Instantly playable - nice one.',
  'The second round is much better than the first.',
  'Would love a harder difficulty setting.',
];

const SEED_REACTIONS: ReactionType[] = ['like', 'fire', 'love', 'wow'];

function tablesReady(db: Db): boolean {
  return Boolean(db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'games'"));
}

function ensureCreator(db: Db, seed: { handle: string; displayName: string; email: string }): SeedCreator {
  const existing = db.get<{ user_id: string }>('SELECT user_id FROM profiles WHERE handle = ?', [seed.handle]);
  if (existing) return { ...seed, userId: existing.user_id };
  const created = registerUser({ db, adminEmails: [] }, {
    email: seed.email,
    password: DEV_PASSWORD,
    handle: seed.handle,
    displayName: seed.displayName,
  });
  return { ...seed, userId: created.user.id };
}

function asUser(creator: SeedCreator): AuthenticatedUser {
  return {
    id: creator.userId,
    email: creator.email,
    role: 'user',
    handle: creator.handle,
    displayName: creator.displayName,
    avatarUrl: null,
  };
}

function gameOrThrow(db: Db, gameId: string): GameRow {
  const game = findGameRow(db, gameId);
  if (!game) throw new Error(`seeded game ${gameId} disappeared`);
  return game;
}

/**
 * Build through the worker pipeline. `runLocalBuild` already performs the
 * publish step itself and reports the release it produced, so the seed only has
 * to verify the outcome rather than duplicating pipeline logic.
 */
async function publishThroughPipeline(
  deps: PublishDeps,
  pipeline: PipelineModule | null,
  input: { gameId: string; userId: string },
): Promise<boolean> {
  if (!pipeline || typeof pipeline.runLocalBuild !== 'function') return false;
  const built = await pipeline.runLocalBuild(deps, input);
  const releaseId = typeof built?.releaseId === 'string' ? built.releaseId : '';
  if (!releaseId) return false;
  const release = deps.db.get<{ status: string }>('SELECT status FROM releases WHERE id = ?', [releaseId]);
  return release?.status === 'published';
}

async function seed(): Promise<void> {
  const config = loadConfig();
  // Human-facing progress goes to stdout, structured logs to stderr, so the
  // summary stays readable when the output is piped into a file.
  const logger = createLogger({ name: 'seed', sink: (line) => process.stderr.write(`${line}\n`) });
  const db = new Db(config.databaseFile);
  try {
    if (!tablesReady(db)) {
      console.error('[seed] This database has no schema. Run `npm run migrate` first.');
      process.exitCode = 1;
      return;
    }

    const driver = createStorageDriver(
      config.storage.driver === 'fs'
        ? { driver: 'fs', fsRoot: config.storage.root }
        : { driver: 's3', s3: config.storage.s3 },
    );
    const blobs = new BlobStore(db, driver);
    const projects: ProjectDeps = { db, blobs, limits: config.limits, repoRoot: config.repoRoot };
    const publish: PublishDeps = { ...projects, config };
    const social: SocialDeps = { db, limits: config.limits };

    const creators = SEED_CREATORS.map((seedCreator) => ensureCreator(db, seedCreator));
    // A re-run must not leave accounts whose documented password no longer works.
    for (const creator of creators) authenticate({ db, adminEmails: [] }, creator.email, DEV_PASSWORD);
    logger.info('seed.creators', { count: creators.length });

    // Everybody follows everybody else, so the following feed is not empty for
    // any of the seeded accounts.
    for (const follower of creators) {
      for (const followee of creators) {
        if (follower.userId !== followee.userId) setFollow(db, follower.userId, followee.userId, true);
      }
    }

    let pipeline: PipelineModule | null = null;
    try {
      pipeline = (await import(PIPELINE_MODULE)) as PipelineModule;
    } catch (error) {
      console.warn(
        `[seed] WARNING: the build pipeline is unavailable (${error instanceof Error ? error.message : String(error)}).`,
      );
      console.warn('[seed]          Games were created as drafts and NOT published; run the worker to publish them.');
    }

    const templates = new Set(listTemplates(config.repoRoot).map((template) => template.id));
    const games: { gameId: string; title: string; published: boolean }[] = [];
    for (const spec of SEED_GAMES) {
      const owner = creators[spec.ownerIndex % creators.length];
      if (!owner) continue;
      if (!templates.has(spec.template)) {
        console.warn(`[seed] WARNING: template "${spec.template}" is missing; its example game was skipped.`);
        continue;
      }
      let game = findGameBySlug(db, owner.userId, spec.slug);
      if (!game) {
        const created = await createGame(projects, {
          ownerId: owner.userId,
          title: spec.title,
          slug: spec.slug,
          description: `Local development example seeded by "npm run seed" (${DEV_PASSWORD_NOTE}).`,
          licenseSpdx: 'MIT',
          template: spec.template,
        });
        game = created.game;
      }
      let published = game.status === 'published';
      if (!published) {
        try {
          published = await publishThroughPipeline(publish, pipeline, { gameId: game.id, userId: owner.userId });
        } catch (error) {
          console.warn(
            `[seed] WARNING: could not build "${spec.slug}" (${error instanceof Error ? error.message : String(error)}); it stays a draft.`,
          );
        }
      }
      games.push({ gameId: game.id, title: spec.title, published });
    }

    // Enough social activity for the feed, the counters and the comment
    // threads to render something real in development.
    let comments = 0;
    for (const [index, seeded] of games.entries()) {
      const actor = creators[(index + 1) % creators.length];
      if (!actor) continue;
      const viewer = asUser(actor);
      const game = gameOrThrow(db, seeded.gameId);
      const reaction = SEED_REACTIONS[index % SEED_REACTIONS.length];
      if (reaction) setReaction(social, viewer, game, reaction);
      setSaved(social, viewer, game, true);
      const body = SEED_COMMENTS[index % SEED_COMMENTS.length];
      if (body) {
        createComment(social, viewer, { gameId: game.id, body });
        comments += 1;
      }
    }

    rebuildAllMetrics(db);

    const publishedCount = games.filter((game) => game.published).length;
    console.log('');
    console.log('Moydan development seed complete.');
    console.log('');
    console.log('Sign in with POST /api/auth/login using any of:');
    for (const creator of creators) {
      console.log(`  ${creator.email.padEnd(28)} password: ${DEV_PASSWORD}   (@${creator.handle})`);
    }
    console.log('');
    console.log(`Games: ${games.length} total - ${publishedCount} published, ${games.length - publishedCount} draft.`);
    for (const game of games) {
      console.log(`  ${game.published ? 'published' : 'draft    '}  /games/${game.gameId}  ${game.title}`);
    }
    console.log(`Comments added: ${comments}.`);
    console.log('');
    console.log(`Seeded development data only - ${DEV_PASSWORD_NOTE}. Never reuse these accounts in production.`);
    logger.info('seed.done', { creators: creators.length, games: games.length, published: publishedCount });
  } finally {
    db.close();
  }
}

await seed();