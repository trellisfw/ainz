import { resolve } from 'path';

import Bluebird from 'bluebird';
import parse from 'minimist';

import { connect } from '@oada/client';
import Rule, { assert as assertRule } from '@oada/types/oada/ainz/rule';

import config from './config';

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
  ...flags
} = parse(process.argv.slice(2));

async function run() {
  if (files.length === 0) {
    // Print usage info
    console.log('ainz add [-t token] [-d domain] FILES...');
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
      try {
        // Load rule
        const { default: out } = await import(resolve(file));
        const rule = typeof out === 'function' ? out(flags) : out;
        assertRule(rule);

        // Register in OADA
        await addRule(rule);
      } catch (err: unknown) {
        console.error('Error adding rule %s: %O', file, err);
      }
    }

    async function addRule(rule: Rule) {
      await Bluebird.map(conns, (conn) =>
        conn.post({ path, tree, data: rule as any })
      );
    }
  } finally {
    await Bluebird.map(conns, (conn) => conn.disconnect());
  }
}

run().catch(console.error);
