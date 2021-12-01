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

import { dirname, join } from 'node:path';
import { promises as fs } from 'node:fs';
import url from 'node:url';

import config from './config';

import Ajv, { ValidateFunction } from 'ajv';
import Bluebird from 'bluebird';
import Handlebars from 'handlebars';
import PQueue from 'p-queue';
import debug from 'debug';
import pointer from 'json-pointer';

import { OADAClient, connect } from '@oada/client';
import Resource, { assert as assertResource } from '@oada/types/oada/resource';
import Rule, { assert as assertRule } from '@oada/types/oada/ainz/rule';
import { ListWatch } from '@oada/list-lib';

const trace = debug('ainz:trace');
const info = debug('ainz:info');
const error = debug('ainz:error');

// Stuff from config
/**
 * @todo: Get token properly (multiple?)
 */
const TOKENS = config.get('oada.token');
const DOMAIN = config.get('oada.domain');
const RULES_PATH = config.get('ainz.rules_path');
const RULES_TREE: Record<string, unknown> = config.get('ainz.rules_tree');
const META_PATH = config.get('ainz.meta_path');

// TODO: Handle resuming properly from where we left off

const ajv = new Ajv();

// Shared OADA client instance
let oada: OADAClient;

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
  info('Ensuring rules resource exists');
  await conn.put({
    path: RULES_PATH,
    tree: RULES_TREE,
    data: {},
  });

  let rulesWatch;
  try {
    // Watch to list of rules to register them
    rulesWatch = new ListWatch<Rule>({
      assertItem: assertRule,
      name: 'ainz',
      conn,
      path: RULES_PATH,
      tree: RULES_TREE,
      // Load all rules every time
      resume: false,
      // Set up a watch for changes to rules
      onItem: async (rule, id) => registerRule({ conn, token, rule, id }),
      // Stop deleted rules
      onRemoveItem: async (id) => unregisterRule({ conn, token, id }),
    });
  } catch {
    // Be sure to close everything?
    await rulesWatch?.stop();
  }
}

type RuleInfo = {
  id: string;
  rule: Rule;
};
type ConnInfo = {
  conn: OADAClient;
  token: string;
};
// Define "context" rules are registered with
type RuleContext = RuleInfo & ConnInfo;
// Define "thing" a rule runs on
type RuleItem = {
  data: Resource;
  item: string;
};
// Define "context" rules are run with
type RuleRunContext = RuleContext & {
  validate: ValidateFunction;
  move?: HandlebarsTemplateDelegate;
};

// Keep track of registered watches
const ruleWatches: Map<string, ListWatch> = new Map();
async function unregisterRule({ id }: Omit<RuleContext, 'rule'>) {
  info('Unregistering rule %s', id);
  const oldWatch = ruleWatches.get(id);
  await oldWatch?.stop();
  ruleWatches.delete(id);
}

async function registerRule({ rule, id, conn, token }: RuleContext) {
  info('Registering new rule %s', id);
  trace(rule);

  // TODO: Fix queue to be by rule/item and not just rule
  const queue = new PQueue({ concurrency: 1 });

  try {
    // Precompile schema and destination template
    const validate = ajv.compile(rule.schema);
    const move = rule.destination
      ? Handlebars.compile(rule.destination, {
          data: false,
          compat: false,
          knownHelpers: await helpers,
          knownHelpersOnly: true,
          noEscape: true,
          strict: true,
        })
      : undefined;

    const payload = { rule, validate, move, id, conn, token };
    ruleWatches.set(
      id,
      new ListWatch<Resource>({
        name: `ainz/rule/${id}`,
        // AssertItem: validate,
        assertItem: assertResource,
        conn,
        path: rule.list,
        tree: rule.tree as Record<string, unknown>,
        itemsPath: rule.itemsPath as string,
        onChangeItem: async (_change, item) => {
          const path = join(rule.list, item);
          await Bluebird.resolve(
            // Check if this rule already ran on this resource
            // TODO: Run again if _rev has increased?
            conn.get({
              path: join(path, '_meta', META_PATH, id),
            })
          ).catch(
            // Catch 404 errors only
            (cError: { status: number }) => cError?.status === 404,
            async () => {
              // Fetch the whole item
              const data = await conn.get({ path: join(rule.list, item) });
              assertResource(data);
              await ruleHandler({ ...payload, data, item });
            }
          );
        },
        onAddItem: async (data, item) =>
          queue.add(async () => ruleHandler({ ...payload, data, item })),
      })
    );
  } catch (cError: unknown) {
    error(cError);
    // @ts-expect-error TODO: Fix this
    if (cError?.response?.status !== 404) {
      throw cError;
    }
  }
}

// Run when there is a change to the list a rule applies to
async function ruleHandler({
  rule,
  validate,
  move,
  id,
  item,
  conn,
  token,
  data,
}: RuleRunContext & RuleItem) {
  trace('Handling rule %s', id);
  trace(rule);

  const path = join(rule.list, item);
  try {
    // TODO: Only fetch data/meta once
    const { data: meta } = await conn.get({
      path: `${path}/_meta`,
    });
    data._meta = meta as Resource;

    await runRule({ data, validate, move, item, rule, id, conn, token });
  } catch (cError: unknown) {
    // Catch error so we can still try other items
    error(cError, `Error running rule ${id}`);
  }
}

async function runRule({
  data,
  validate,
  move,
  item,
  rule,
  id,
  conn,
}: RuleRunContext & RuleItem) {
  trace('Testing rule %s on %s', id, item);
  trace(data);

  try {
    if (!validate(data)) {
      return;
    }
  } catch (cError: unknown) {
    error('schema %O', rule.schema);
    throw cError;
  }

  info('Running rule %s on %s', id, item);
  const { _id, _rev } = data;

  const { type, meta, tree, versioned } = rule;
  switch (type) {
    case 'reindex':
      if (meta) {
        // Add meta info to item if supplied
        trace('Adding to _meta %O', meta);
        await conn.put({
          path: `/${_id}/_meta`,
          contentType: 'application/json',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: meta as any,
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
          tree: tree as Record<string, unknown>,
          data: {},
        });
        await conn.put({
          path,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: {
            _id,
            _rev: versioned ? 0 : undefined,
          } as any,
        });
      }

      break;

    case 'job': {
      // Create new job
      const { job } = rule;
      // Link to resource in job config
      if (rule.pointer) {
        pointer.set(job as Record<string, unknown>, `/config${rule.pointer}`, {
          _id,
        });
      }

      const { headers } = await conn.post({
        path: '/resources',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: job as any,
      });
      // Put job is service's queue
      const jobid = headers['content-location']!.slice(1);
      await conn.put({
        path: `/bookmarks/services/${job!.service}/jobs/${jobid}`,
        data: { _id: jobid },
      });
      break;
    }

    default:
      throw new Error(`Unknown rule type ${type}`);
  }

  // Record in _meta that this rule ran on this item
  trace('Marking rule %s completed', id);
  await conn.put({
    path: join(_id, '_meta', META_PATH, id),
    contentType: 'application/json',
    // Record what _rev was when we ran
    data: { _rev },
  });
}

// Load all template helpers?
// The idea was to allow mapping extra helpers into ainz?
const directory = join(dirname(url.fileURLToPath(import.meta.url)), 'helpers');
const files = await fs.readdir(directory);
const helpers = Bluebird.resolve(files)
  .map((file) => join(directory, file))
  .map(async (file) => {
    try {
      info('Loading helper module %s', file);
      const out = (await import(file)) as (
        _: typeof Handlebars
      ) => Handlebars.HelperDelegate;
      trace('Loaded helpers from %s: %O', file, out);
      return out;
    } catch (cError: unknown) {
      error(cError, 'Error loading helper module');
      return {};
    }
  })
  .reduce(
    (a, b) => ({ ...a, ...b }),
    {} as Record<
      string,
      (_Handlebars: typeof Handlebars) => Handlebars.HelperDelegate
    >
  )
  .then((helpers) => {
    const out: Record<string, boolean> = {};

    for (const [name, helper] of Object.entries(helpers)) {
      info('Registering helper %s', name);
      Handlebars.registerHelper(name, helper(Handlebars));
      // eslint-disable-next-line security/detect-object-injection
      out[name] = true;
    }

    return out;
  });

// Run ainz for token(s)
await Promise.all(TOKENS.map(async (token) => initialize(token)));
