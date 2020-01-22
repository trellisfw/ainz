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

/* eslint import/no-absolute-path: [2, { commonjs: false, esmodule: false }] */

import Promise from 'bluebird'
import debug from 'debug'

import oada from '@oada/oada-cache'
// const { getToken } = require('/code/winfield-shared/service-user')

import config from './config.js'

const trace = debug('ainz:trace')
const info = debug('ainz:info')
const warn = debug('ainz:warn')
const error = debug('ainz:error')

// Stuff from config
const TOKEN = config.get('token') // TODO: Get token properly
const DOMAIN = config.get('domain')
const RULES_PATH = config.get('rules_path')
const RULES_TREE = config.get('rules_tree')

// ---------------------------------------------------------------------
// Setup:
// ---------------------------------------------------------------------

async function initialize () {
  // Connect to oada
  let conn = await oada.default.connect({
    // Why do I have to say default??
    domain: 'https://' + DOMAIN,
    token: TOKEN
    // cache: { name: 'ds-mirror' }
  })
  await conn.resetCache()

  // TODO: Better ensure relavent paths exist
  info('Ensuring rules resource exists')
  await conn.put({
    path: RULES_PATH,
    tree: RULES_TREE,
    data: {}
  })

  // Set up a watch for changes to rules
  try {
    await conn.get({
      path: RULES_PATH,
      tree: RULES_TREE,
      watch: {
        payload: { token: TOKEN },
        callback: rulesHandler
      }
    })
  } catch (err) {
    if (err.response.status === 404) {
      await conn.put({
        path: SERVICE_PATH + `/mirror`,
        tree: sinceTree,
        data: {}
      })
      await conn.get({
        path: SERVICE_PATH + `/mirror`,
        tree: sinceTree,
        watch: {
          payload: {},
          callback: function () {
            console.log('IT RAN THE CALLBACK')
          }
        }
      })
    } else throw err
  }
}

async function rulesHandler ({ token, response }) {
  info('Running rules watch handler')
}

initialize()
