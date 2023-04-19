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

/* eslint-disable no-console, no-process-exit, unicorn/no-process-exit */

import { basename, resolve } from 'node:path';

import debug from 'debug';
import parse from 'minimist';

import type Rule from '@oada/types/oada/ainz/rule.js';
import { assert as assertRule } from '@oada/types/oada/ainz/rule.js';
import { connect } from '@oada/client';

import config from './config.js';

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

if (files.length === 0) {
  // Print usage info
  console.log('ainz add [-t token] [-d domain] [-s] FILES...');
  console.log('Add all the rules from files FILES');

  process.exit(0);
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
        ? // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
          conn.put({ path: `${path}/${id}`, tree, data: rule as any })
        : // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
          conn.post({ path, tree, data: rule as any })
    )
  );
}

try {
  for await (const file of files) {
    info('Adding rule from file %s', file);
    try {
      // Load rule
      const { default: out } = (await import(resolve(file))) as {
        default: unknown;
      };
      const rule: unknown = typeof out === 'function' ? out(flags) : out;
      assertRule(rule);

      // Register in OADA
      await addRule(rule, s ? basename(file) : undefined);
    } catch (cError: unknown) {
      error({ error: cError, file }, 'Error adding rule');
    }
  }
} finally {
  await Promise.all(conns.map(async (conn) => conn.disconnect()));
}
