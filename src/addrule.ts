/**
 * @license
 * Copyright 2021 Qlever LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint-disable no-console */

import { basename, resolve } from 'node:path';

import debug from 'debug';
import parse from 'minimist';

import Rule, { assert as assertRule } from '@oada/types/oada/ainz/rule';
import { connect } from '@oada/client';

import config from './config';

const info = debug('ainz:add:info');
const error = debug('ainz:add:error');

const TOKENS = config.get('oada.token');
const DOMAIN = config.get('oada.domain');
const path = config.get('ainz.rules_path');
const tree = config.get('ainz.rules_tree');

const {
  // One rule per file
  _: files,
  // Token(s) for which to add rules
  t,
  // OADA API domain
  d,
  // Keep the same rule IDs (uses filenames)?
  s,
  ...flags
} = parse(process.argv.slice(2), { boolean: ['s'] });

async function run() {
  if (files.length === 0) {
    // Print usage info
    console.log('ainz add [-t token] [-d domain] [-s] FILES...');
    console.log('Add all the rules from files FILES');

    return;
  }

  const domain = (d as string) ?? DOMAIN;
  const tokens: string[] = typeof t === 'string' ? t.split(',') : TOKENS;
  const conns = await Promise.all(
    tokens.map(async (token) => connect({ domain, token, connection: 'http' }))
  );

  async function addRule(rule: Rule, id?: string) {
    await Promise.all(
      conns.map(async (conn) =>
        id
          ? // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            conn.put({ path: `${path}/${id}`, tree, data: rule as any })
          : // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            conn.post({ path, tree, data: rule as any })
      )
    );
  }

  try {
    for (const file of files) {
      info('Adding rule from file %s', file);
      try {
        // Load rule
        // eslint-disable-next-line no-await-in-loop
        const { default: out } = (await import(resolve(file))) as {
          default: unknown;
        };
        const rule: unknown = typeof out === 'function' ? out(flags) : out;
        assertRule(rule);

        // Register in OADA
        // eslint-disable-next-line no-await-in-loop
        await addRule(rule, s && basename(file));
      } catch (cError: unknown) {
        error('Error adding rule %s: %O', file, cError);
      }
    }
  } finally {
    await Promise.all(conns.map(async (conn) => conn.disconnect()));
  }
}

await run();
