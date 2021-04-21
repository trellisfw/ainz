/* Copyright 2020 Qlever LLC
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

import { join, dirname, extname } from 'path';
import { promises as fs } from 'fs';

import Bluebird from 'bluebird';
import Ajv, { ValidateFunction } from 'ajv';
import pointer from 'json-pointer';
import PQueue from 'p-queue';
import debug from 'debug';
import Handlebars from 'handlebars';

import { connect, OADAClient } from '@oada/client';
import { ListWatch } from '@oada/list-lib';
import Rule, { assert as assertRule } from '@oada/types/oada/ainz/rule';
import Resource, { assert as assertResource } from '@oada/types/oada/resource';

import config from './config';
import { Hash } from 'node:crypto';

const trace = debug('ainz:trace');
const info = debug('ainz:info');
const error = debug('ainz:error');

type OADATree = {
  _type?: string;
  _rev?: number;
} & Partial<{
  [key: string]: OADATree;
}>;

// Stuff from config
/**
 * @todo: Get token properly (multiple?)
 */
const TOKENS: string[] = config.get('token').split(',');
const DOMAIN: string = config.get('domain');
const RULES_PATH: string = config.get('rules_path');
const RULES_TREE: OADATree = config.get('rules_tree');
const META_PATH: string = config.get('meta_path');

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
        domain: 'https://' + DOMAIN,
        token,
      }));
  // await conn.resetCache()

  // TODO: Better ensure relavent paths exist
  info('Ensuring rules resource exists');
  await conn.put({
    path: RULES_PATH,
    tree: RULES_TREE,
    data: {},
  });

  let rulesWatch;
  try {
    // Watch to list of rules to register them
    rulesWatch = new ListWatch({
      assertItem: assertRule,
      name: 'ainz',
      conn,
      path: RULES_PATH,
      tree: RULES_TREE,
      // Load all rules every time
      resume: false,
      // Set up a watch for changes to rules
      onItem: (rule, id) => registerRule({ conn, token, rule, id }),
      // Stop deleted rules
      onRemoveItem: (id) => unregisterRule({ conn, token, id }),
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
type RuleCtx = RuleInfo & ConnInfo;
// Define "thing" a rule runs on
type RuleItem = {
  data: Resource;
  item: string;
};
// Define "context" rules are run with
type RuleRunCtx = RuleCtx & {
  validate: ValidateFunction;
  move?: HandlebarsTemplateDelegate;
};

// Keep track of registered watches
const ruleWatches: { [key: string]: ListWatch } = {};
async function unregisterRule({ id }: Omit<RuleCtx, 'rule'>) {
  info('Unregistering rule %s', id);
  const oldWatch = ruleWatches[id];
  await oldWatch?.stop();
  delete ruleWatches[id];
}
async function registerRule({ rule, id, conn, token }: RuleCtx) {
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
    ruleWatches[id] = new ListWatch({
      name: `ainz/rule/${id}`,
      //assertItem: validate,
      assertItem: assertResource,
      conn,
      path: rule.list,
      tree: rule.tree as object,
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
          (e: { status: number }) => e?.status === 404,
          async () => {
            // Fetch the whole item
            const data = await conn.get({ path: join(rule.list, item) });
            assertResource(data);
            await ruleHandler({ ...payload, data, item });
          }
        );
      },
      onAddItem: (data, item) =>
        queue.add(() => ruleHandler({ ...payload, data, item })),
    });
  } catch (err) {
    error(err);
    if (err?.response?.status === 404) {
    } else {
      throw err;
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
}: RuleRunCtx & RuleItem) {
  trace('Handling rule %s', id);
  trace('%O', rule);

  const path = join(rule.list, item);
  try {
    // TODO: Only fetch data/meta once
    const { data: meta } = await conn.get({
      path: `${path}/_meta`,
    });
    data._meta = meta as Resource;

    await runRule({ data, validate, move, item, rule, id, conn, token });
  } catch (err) {
    // Catch error so we can still try other items
    error(`Error running rule %s: %O`, id, err);
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
}: RuleRunCtx & RuleItem) {
  trace(`Testing rule %s on %s`, id, item);
  trace(data);

  try {
    if (!validate(data)) {
      return;
    }
  } catch (err) {
    error('schema %O', rule.schema);
    throw err;
  }

  info('Running rule %s on %s', id, item);
  const { _id, _rev } = data;

  switch (rule.type) {
    case 'reindex':
      if (rule.meta) {
        // Add meta info to item if supplied
        trace('Adding to _meta %O', rule.meta);
        await conn.put({
          path: `/${_id}/_meta`,
          contentType: 'application/json',
          data: rule.meta as any,
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
          tree: rule.tree as {},
          data: {},
        });
        await conn.put({
          path,
          data: {
            _id,
            _rev: rule.versioned ? 0 : undefined,
          } as {},
        });
      }
      break;

    case 'job':
      // Create new job
      const { job } = rule;
      // Link to resource in job config
      if (rule.pointer) {
        pointer.set(job as object, `/config${rule.pointer}`, { _id });
      }
      const { headers } = await conn.post({
        path: '/resources',
        data: rule.job as any,
      });
      // Put job is service's queue
      const jobid = headers['content-location'].substr(1);
      await conn.put({
        path: `/bookmarks/services/${job!.service}/jobs/${jobid}`,
        data: { _id: jobid },
      });
      break;
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
const dir = join(__dirname, 'helpers');
const files = fs.readdir(dir);
const exts = Object.keys(require.extensions);
const helpers = Bluebird.filter(files, (file) => exts.includes(extname(file)))
  .map((file) => join(dir, file))
  .map(async (file) => {
    const out = await import(file);
    trace('Loading helpers from %s: %O', file, out);
    return out;
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
      out[name] = true;
    }

    return out;
  });

// Run ainz for token(s)
Bluebird.map(TOKENS, (token) => initialize(token)).catch((err) => {
  error(err);
  process.exit(1);
});
