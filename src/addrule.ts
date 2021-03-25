import { resolve, basename } from 'path';

import Bluebird from 'bluebird';
import parse from 'minimist';
import debug from 'debug';

import { connect } from '@oada/client';
import Rule, { assert as assertRule } from '@oada/types/oada/ainz/rule';

import config from './config';

const info = debug('ainz:add:info');
const error = debug('ainz:add:error');

const TOKENS: string[] = config.get('token').split(',');
const DOMAIN: string = config.get('domain');
const path: string = config.get('rules_path');
const tree = config.get('rules_tree');

const {
  // One rule per file
  _: files,
  // token(s) for which to add rules
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

  const domain = d ?? DOMAIN;
  const tokens: string[] = t ? t.split(',') : TOKENS;
  const conns = await Bluebird.map(tokens, (token) =>
    connect({ domain, token, connection: 'http' })
  );

  try {
    for (const file of files) {
      info('Adding rule from file %s', file);
      try {
        // Load rule
        const { default: out } = await import(resolve(file));
        const rule = typeof out === 'function' ? out(flags) : out;
        assertRule(rule);

        // Register in OADA
        await addRule(rule, s && basename(file));
      } catch (err: unknown) {
        error('Error adding rule %s: %O', file, err);
      }
    }

    async function addRule(rule: Rule, id?: string) {
      await Bluebird.map(conns, (conn) =>
        id
          ? conn.put({ path: path + '/' + id, tree, data: rule as any })
          : conn.post({ path, tree, data: rule as any })
      );
    }
  } finally {
    await Bluebird.map(conns, (conn) => conn.disconnect());
  }
}

run().catch(console.error);
