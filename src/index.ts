/**
 * @license
 * Copyright 2020 Qlever LLC
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import config from './config.js';

import '@oada/pino-debug';

import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';

import _Ajv, { type ValidateFunction } from 'ajv';
import Handlebars from 'handlebars';
import { JsonPointer } from 'json-ptr';
import PQueue from 'p-queue';
import debug from 'debug';

import { ChangeType, ListWatch } from '@oada/list-lib';
import { Counter, Gauge } from '@oada/lib-prom';
import { type OADAClient, connect } from '@oada/client';
import type Resource from '@oada/types/oada/resource.js';
import type Rule from '@oada/types/oada/ainz/rule.js';
import type Tree from '@oada/types/oada/tree/v1.js';
import { assert as assertResource } from '@oada/types/oada/resource.js';
import { assert as assertRule } from '@oada/types/oada/ainz/rule.js';

// HACK: ajv types don't like esm
// eslint-disable-next-line @typescript-eslint/naming-convention
const Ajv = _Ajv as unknown as typeof _Ajv.default;

const log = {
  trace: debug('ainz:trace'),
  info: debug('ainz:info'),
  error: debug('ainz:error'),
};

// Stuff from config
/**
 * @todo: Get token properly (multiple?)
 */
const TOKENS = config.get('oada.token');
const DOMAIN = config.get('oada.domain');
const RULES_PATH = config.get('ainz.rules_path');
const RULES_TREE = config.get('ainz.rules_tree');
const META_PATH = config.get('ainz.meta_path');

// TODO: Handle resuming properly from where we left off

const ajv = new Ajv();

// Shared OADA client instance
let oada: OADAClient;

const totalRules = new Gauge({
  name: 'ainz_rules_total',
  help: 'Total number of registered rules',
});
const ruleRuns = new Counter({
  name: `ainz_rule_runs_total`,
  help: `Total number of runs for rules`,
  labelNames: ['rule'] as const,
});

/**
 * Start-up for a given user (token)
 */
async function initialize(token: string) {
  // Connect to oada
  const conn = oada
    ? oada.clone(token)
    : (oada = await connect({
        domain: `https://${DOMAIN}`,
        token,
      }));
  // Await conn.resetCache()

  // TODO: Better ensure relevant paths exist
  log.info('Ensuring rules resource exists');
  await conn.put({
    path: RULES_PATH,
    tree: RULES_TREE,
    data: {},
  });

  // Watch to list of rules to register them
  const rulesWatch = new ListWatch({
    assertItem: assertRule,
    conn,
    path: RULES_PATH,
    // Load all rules every time
    resume: false,
  });
  try {
    rulesWatch.on(ChangeType.ItemAny, async ({ item, pointer: id }) => {
      const rule = await item;
      await registerRule({ conn, token, rule, id });
      totalRules.inc();
    });
    rulesWatch.on(ChangeType.ItemRemoved, async ({ pointer: id }) => {
      await unregisterRule({ conn, token, id });
      totalRules.dec();
    });
  } catch {
    // Be sure to close everything?
    await rulesWatch.stop();
  }
}

interface RuleInfo {
  id: string;
  rule: Rule;
}
interface ConnInfo {
  conn: OADAClient;
  token: string;
}
// Define "context" rules are registered with
interface RuleContext extends RuleInfo, ConnInfo {}
// Define "thing" a rule runs on
interface RuleItem {
  data: Resource;
  item: string;
}
// Define "context" rules are run with
interface RuleRunContext extends RuleContext {
  validate: ValidateFunction;
  move?: HandlebarsTemplateDelegate;
  ptr?: JsonPointer;
}

// Keep track of registered watches
const ruleWatches = new Map<string, ListWatch>();
async function unregisterRule({ id }: Omit<RuleContext, 'rule'>) {
  log.info('Unregistering rule %s', id);
  const oldWatch = ruleWatches.get(id);
  await oldWatch?.stop();
  return ruleWatches.delete(id);
}

async function registerRule({ rule, id, conn, token }: RuleContext) {
  log.trace({ rule, id }, 'Registering rule');

  // TODO: Fix queue to be by rule/item and not just rule
  const queue = new PQueue({ concurrency: 1 });

  try {
    // Precompile schema and destination template
    const validate = ajv.compile(rule.schema);
    const move = rule.destination
      ? Handlebars.compile(rule.destination, {
          data: false,
          compat: false,
          knownHelpers: helpers,
          knownHelpersOnly: true,
          noEscape: true,
          strict: true,
        })
      : undefined;
    const ptr = rule.pointer
      ? JsonPointer.create('/config').concat(
          JsonPointer.create(rule.pointer as string)
        )
      : undefined;

    const payload = { rule, validate, move, ptr, id, conn, token };
    const watch = new ListWatch({
      name: `ainz/rule/${id}`,
      // AssertItem: validate,
      assertItem: assertResource,
      conn,
      path: rule.list,
      itemsPath: rule.itemsPath as string,
    });
    watch.on(ChangeType.ItemAdded, async ({ pointer: item, item: data }) =>
      queue.add(async () => ruleHandler({ ...payload, data: await data, item }))
    );
    watch.on(ChangeType.ItemChanged, async ({ pointer: item }) => {
      const path = join(rule.list, item);
      try {
        // Check if this rule already ran on this resource
        // TODO: Run again if _rev has increased?
        await conn.head({
          path: join(path, '_meta', META_PATH, id),
        });
      } catch (error: unknown) {
        // @ts-expect-error stupid error stuff
        if (error.code !== '404') {
          // Catch 404 errors only
          throw error;
        }

        // Fetch the whole item
        const data = await conn.get({ path });
        assertResource(data);
        await queue.add(async () => ruleHandler({ ...payload, data, item }));
      }
    });
    ruleWatches.set(id, watch);
    log.info('Registered new rule %s', id);
  } catch (error: unknown) {
    log.error(error);
    // @ts-expect-error TODO: Fix this
    if (error?.response?.status !== 404) {
      throw error;
    }
  }
}

// Run when there is a change to the list a rule applies to
async function ruleHandler({
  rule,
  validate,
  move,
  ptr,
  id,
  item,
  conn,
  token,
  data,
}: RuleRunContext & RuleItem) {
  log.trace({ rule, id }, 'Handling rule');

  const path = join(rule.list, item);
  try {
    // TODO: Only fetch data/meta once
    const { data: meta } = await conn.get({
      path: `${path}/_meta`,
    });
    data._meta = meta as Resource;

    await runRule({ data, validate, move, ptr, item, rule, id, conn, token });
    ruleRuns.inc({ rule: id });
    log.trace('Handled rule %s', id);
  } catch (error: unknown) {
    // Catch error so we can still try other items
    log.error(error, `Error running rule ${id}`);
  }
}

async function runRule({
  data,
  validate,
  move,
  ptr,
  item,
  rule,
  id,
  conn,
}: RuleRunContext & RuleItem) {
  log.trace('Testing rule %s on %s', id, item);
  log.trace(data);

  try {
    if (!validate(data)) {
      return;
    }
  } catch (error: unknown) {
    log.error('schema %O', rule.schema);
    throw error;
  }

  log.info('Running rule %s on %s', id, item);
  const { _id, _rev } = data;

  const { type, meta, tree, versioned } = rule;
  switch (type) {
    case 'reindex': {
      if (meta) {
        // Add meta info to item if supplied
        log.trace(meta, 'Adding to _meta');
        await conn.put({
          path: `/${_id}/_meta`,
          contentType: 'application/json',
          data: meta,
        });
      }

      if (move) {
        const path = join(move(data), item);

        // Perform the "move"
        // Use PUT not POST to keep same id in both lists
        await conn.put({
          // Hack around client not working with PUTing links
          path: dirname(path),
          // TODO: Should trees for source and destination be separate?
          tree: tree as Tree,
          data: {},
        });
        await conn.put({
          path,
          data: {
            _id,
            _rev: versioned ? 0 : undefined,
          },
        });
      }

      break;
    }

    case 'job': {
      // Create new job
      const { job } = rule as { job: { service: string } };
      // Link to resource in job config
      ptr?.set(job, { _id }, true);

      const { headers } = await conn.post({
        path: '/resources',
        data: job,
      });
      // Put job is service's queue
      const jobid = headers['content-location']!.slice(1);
      await conn.put({
        path: `/bookmarks/services/${job.service}/jobs/${jobid}`,
        data: { _id: jobid },
      });
      break;
    }

    default: {
      throw new Error(`Unknown rule type ${type}`);
    }
  }

  // Record in _meta that this rule ran on this item
  log.trace('Marking rule %s completed', id);
  await conn.put({
    path: join(_id, '_meta', META_PATH, id),
    contentType: 'application/json',
    // Record what _rev was when we ran
    data: { _rev },
  });
}

// Load all template helpers?
// The idea was to allow mapping extra helpers into ainz?
const directory = join(dirname(fileURLToPath(import.meta.url)), 'helpers');
const files = await readdir(directory);
const requireHelper = createRequire(import.meta.url);
const helpers: Record<string, boolean> = {};
await Promise.all(
  files.map(async (f) => {
    const file = join(directory, f);
    try {
      log.info('Loading helper module %s', file);
      // FIXME: Don't use require to load helpers
      const out = requireHelper(file) as Record<
        string,
        (_: typeof Handlebars) => Handlebars.HelperDelegate
      >;
      log.trace('Loaded helpers from %s: %O', file, out);

      for (const [name, helper] of Object.entries(out)) {
        log.info('Registering helper %s', name);
        Handlebars.registerHelper(name, helper(Handlebars));
        // eslint-disable-next-line security/detect-object-injection
        helpers[name] = true;
      }
    } catch (error: unknown) {
      log.error(error, 'Error loading helper module');
    }
  })
);

// Run ainz for token(s)
await Promise.all(TOKENS.map(async (token) => initialize(token)));
