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
import Ajv from 'ajv'
import pointer from 'json-pointer'
import pqueue from 'p-queue'
import debug from 'debug'

import oada from '@oada/oada-cache'
// const { getToken } = require('/code/winfield-shared/service-user')

import config from './config.js'

// Because import is not right
const { default: PQueue } = pqueue

const trace = debug('ainz:trace')
const info = debug('ainz:info')
const warn = debug('ainz:warn')
const error = debug('ainz:error')

// Stuff from config
const TOKEN = config.get('token') // TODO: Get token properly (multiple?)
const DOMAIN = config.get('domain')
const RULES_PATH = config.get('rules_path')
const RULES_TREE = config.get('rules_tree')
const LIST_TREE = config.get('list_tree')
const META_PATH = config.get('meta_path')

// ---------------------------------------------------------------------
// Setup:
// ---------------------------------------------------------------------

// TODO: Handle resuming properly from where we left off

const ajv = new Ajv()

// TODO: Hopefully this bug in oada-cache gets fixed
function fixBody (body) {
  return Object.prototype.hasOwnProperty.call(body, '_rev') ? body : body.data
}

async function initialize () {
  // Connect to oada
  const conn = await oada.default.connect({
    // Why do I have to say default??
    domain: 'https://' + DOMAIN,
    token: TOKEN,
    cache: false
  })
  // await conn.resetCache()

  // TODO: Better ensure relavent paths exist
  info('Ensuring rules resource exists')
  await conn.put({
    path: RULES_PATH,
    tree: RULES_TREE,
    data: {}
  })

  try {
    const { data } = await conn.get({
      path: RULES_PATH,
      tree: RULES_TREE,
      // Set up a watch for changes to rules
      watch: {
        payload: { conn, token: TOKEN },
        callback: rulesHandler
      }
    })
    trace('Registering initial rules: %O', data)
    // Register the pre-existing rules
    // TODO: Refactor this?
    const rules = Object.keys(data || {}).filter(r => !r.match(/^_/))
    await Promise.each(rules, id =>
      registerRule({ rule: data[id], id, conn, token: TOKEN })
    )
  } catch (err) {
    error(err)
    if (err.response.status === 404) {
    } else {
      throw err
    }
  }
}

// Run when there is a change to list of rules
async function rulesHandler ({ response: { change }, ...ctx }) {
  info('Running rules watch handler')
  trace(change)

  const { type, body } = change
  const data = fixBody(body)
  // Get new rules ignoring _ keys
  const rules = Object.keys(data || {}).filter(r => !r.match(/^_/))
  switch (type) {
    case 'merge':
      await Promise.each(rules, id =>
        registerRule({ rule: data[id], id, ...ctx })
      )
      break
    case 'delete':
      // TODO: Handle deleting rules
      break
    default:
      warn(`Ignoring uknown change type ${type} to rules`)
  }
}

// TODO: Check for unprocessed items when registering rule?
async function registerRule ({ rule, id, conn, token }) {
  info(`Registering new rule ${id}`)
  trace(rule)

  // TODO: Fix queue to be by rule/item and not just rule
  const queue = new PQueue({ concurrency: 1 })

  try {
    // const tree = {}
    // pointer.set(tree, rule.list, LIST_TREE)
    const { data } = await conn.get({
      path: rule.list,
      // tree,
      watch: {
        // TODO: precompile schema?
        payload: { rule, id, conn, token },
        callback: ctx => queue.add(() => ruleHandler(ctx))
      }
    })

    trace('NYI TODO Checking initial list items: %O', data)
    // Get new list items ignoring _ keys
    // TODO: Refactor this?
    // const items = Object.keys(data || {}).filter(i => !i.match(/^_/))
  } catch (err) {
    error(err)
    if (err.response.status === 404) {
    } else {
      throw err
    }
  }
}

// Run when there is a change to the list a rule applies to
async function ruleHandler ({
  response: { change },
  rule,
  id,
  mutex,
  conn,
  token
}) {
  info(`Handling rule ${id}`)
  trace('%O', rule)
  trace(change)

  const { type, body } = change
  const data = fixBody(body)
  // Get new list items ignoring _ keys
  const items = Object.keys(data || {}).filter(i => !i.match(/^_/))
  switch (type) {
    case 'merge':
      await Promise.each(items, async item => {
        return Promise.resolve(
          // Check if rule already ran on this resource
          // TODO: Run again if _rev has increased?
          conn.get({ path: `${rule.list}/${item}/_meta${META_PATH}/${id}` })
        ).catch(
          // Catch 404 errors only
          e => e.response && e.response.status === 404,
          async () => {
            // 404 Means this rule has not been run on item yet
            const { data } = await conn.get({ path: `${rule.list}/${item}` })
            return runRule({ data, item, rule, id, conn, token })
          }
        )
      })
      break
    case 'delete':
      // TODO: Handle deleting rules
      break
    default:
      warn(`Ignoring unknown change type ${type}`)
  }
}

async function runRule ({ data, item, rule, id, conn, token }) {
  info(`Running rule ${id} on ${item}`)
  trace(data)

  if (!ajv.validate(rule.schema, data)) {
    return
  }

  if (rule.meta) {
    // Add meta info to item if supplied
    trace('Adding to _meta %O', rule.meta)
    await conn.put({
      path: `/${data._id}/_meta`,
      headers: { 'Content-Type': 'application/json' },
      data: rule.meta
    })
  }

  // Perform the "move"
  // Use PUT not POST incase same item it matched multiple times
  // TODO: Content-Type??
  // TODO: How to use tree param to do deep PUT??
  await conn.put({
    path: `${rule.destination}/${item}`,
    headers: { 'Content-Type': 'application/json' },
    data: {
      _id: data._id,
      _rev: data._rev
    }
  })

  // Record in _meta that this rule ran on this item
  trace(`Marking rule ${id} completed`)
  await conn.put({
    path: `/${data._id}/_meta${META_PATH}/${id}`,
    headers: { 'Content-Type': 'application/json' },
    // Record what _rev was when we ran
    data: { _rev: data._rev }
  })
}

initialize()
