/**
 * @license
 *  Copyright 2021 Qlever LLC
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

/* eslint-disable sonarjs/no-duplicate-string */

import type Tree from '@oada/types/oada/tree/v1.js';

import convict from 'convict';
import { config as load } from 'dotenv';

load();

const config = convict({
  oada: {
    domain: {
      doc: 'OADA API domain',
      format: String,
      default: 'localhost',
      env: 'DOMAIN',
      arg: 'domain',
    },
    token: {
      doc: 'OADA API token',
      format: Array,
      default: ['god'],
      env: 'TOKEN',
      arg: 'token',
    },
  },
  ainz: {
    meta_path: {
      doc: 'JSONPath under _meta for storing our metadata',
      format: String,
      default: '/services/ainz/rules',
    },
    rules_path: {
      doc: "OADA path to a user's rules",
      format: String,
      default: '/bookmarks/services/ainz/rules',
    },
    rules_tree: {
      doc: 'OADA tree for rules_path',
      format: Object,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      default: {
        bookmarks: {
          _type: 'application/vnd.oada.bookmarks.1+json',
          services: {
            _type: 'application/vnd.oada.services.1+json',
            _rev: 0,
            ainz: {
              _type: 'application/vnd.oada.service.1+json',
              _rev: 0,
              rules: {
                '_type': 'application/vnd.oada.ainz.rules.1+json',
                '_rev': 0,
                '*': {
                  _type: 'application/vnd.oada.ainz.rule.1+json',
                  _rev: 0,
                },
              },
            },
          },
        },
      } as Tree,
    },
    // TODO: How to generalize this?? Include it in the rule??
    list_tree: {
      format: Object,
      default: {
        _type: 'application/json',
        _rev: 0,
        audits: {
          '_type': 'application/json',
          '_rev': 0,
          '*': {
            _type: 'application/json',
            _rev: 0,
          },
        },
        cois: {
          '_type': 'application/json',
          '_rev': 0,
          '*': {
            _type: 'application/json',
            _rev: 0,
          },
        },
      },
    },
  },
});

/**
 * Error if our options are invalid.
 * Warn if extra options found.
 */
config.validate({ allowed: 'warn' });

export default config;
