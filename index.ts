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
import PQueue from 'p-queue'
import debug from 'debug'
// prettier-ignore
import type { JSONSchema8 as Schema } from 'jsonschema8'

import oada, {
  OADAChangeResponse,
  OADAConnection,
  OADAResponse,
  OADATree
} from '@oada/oada-cache'
// const { getToken } = require('/code/winfield-shared/service-user')

// @ts-ignore
import config from './config.js'

const trace = debug('ainz:trace')
const info = debug('ainz:info')
const warn = debug('ainz:warn')
const error = debug('ainz:error')

// Stuff from config
const TOKEN: string = config.get('token') // TODO: Get token properly (multiple?)
const DOMAIN: string = config.get('domain')
const RULES_PATH: string = config.get('rules_path')
const RULES_TREE: OADATree = config.get('rules_tree')
const LIST_TREE: OADATree = config.get('list_tree')
const META_PATH: string = config.get('meta_path')

// ---------------------------------------------------------------------
// Setup:
// ---------------------------------------------------------------------

// TODO: Handle resuming properly from where we left off

const ajv = new Ajv()

// TODO: Hopefully this bug in oada-cache gets fixed
type Body<T> = { _rev: string; _id: string } & T
type WeirdBody<T> = { data: Body<T> }
type ReturnBody<T> = Body<T> | WeirdBody<T>
function isWeird<T> (body: ReturnBody<T>): body is WeirdBody<T> {
  return (body as Body<T>)._rev === undefined
}
function fixBody<T> (body: ReturnBody<T>): Body<T> {
  return isWeird(body) ? body.data : body
}

async function initialize () {
  // Connect to oada
  const conn = await oada.connect({
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
        // TODO: Actually handle changes to rules when watch/unwatch works
        callback: async () => {
          await conn.disconnect()
          await initialize()
        }
        // callback: rulesHandler
      }
    })
    trace('Registering initial rules: %O', data)
    // Register the pre-existing rules
    // TODO: Refactor this?
    const rules = Object.keys(data ?? {}).filter(r => !r.match(/^_/))
    await Promise.map(rules, id =>
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

type Rule = {
  list: string
  destination: string
  schema: Schema
  meta?: object
}
// Define "context" rules are registered with
type RuleCtx = {
  rule: Rule | null
  id: string
  conn: OADAConnection
  token: string
}
// Define "thing" a rule runs on
type RuleItem = {
  data: OADAResponse['data']
  item: string
}
// Define "context" rules are run with
interface RuleRunCtx extends RuleCtx {
  rule: Rule
  validate: Ajv.ValidateFunction
}
// Run when there is a change to list of rules
async function rulesHandler ({
  response: { change },
  ...ctx
}: OADAChangeResponse & RuleCtx) {
  info('Running rules watch handler')
  trace(change)

  const { type, body } = change
  const data = fixBody(body)
  // Get new rules ignoring _ keys
  const rules = Object.keys(data ?? {}).filter(r => !r.match(/^_/))
  switch (type) {
    case 'merge':
      await Promise.map(rules, async id => {
        try {
          // Fetch entire rule (not just changed part)
          const path = `${RULES_PATH}/${id}`
          const { data } = await ctx.conn.get({ path })
          const rule = fixBody(data)

          registerRule({ rule, id, ...ctx })
        } catch (err) {
          error(`Error registering rule ${id}: %O`, err)
        }
      })
      break
    case 'delete':
      // Unregister the deleted rule
      await Promise.map(rules, id => registerRule({ rule: null, id, ...ctx }))
      break
    default:
      warn(`Ignoring uknown change type ${type} to rules`)
  }
}

async function registerRule ({ rule, id, conn, token }: RuleCtx) {
  // TODO: Remove previous version of this rule if it existed already
  if (!rule) {
    // No new rule to register
    return
  }

  info(`Registering new rule ${id}`)
  trace(rule)

  // TODO: Fix queue to be by rule/item and not just rule
  const queue = new PQueue({ concurrency: 1 })

  try {
    const validate = ajv.compile(rule.schema)
    const payload = { rule, validate, id, conn, token }
    const { data } = await conn.get({
      path: rule.list,
      watch: {
        payload,
        callback: ctx => queue.add(() => ruleHandler(ctx))
      }
    })

    // TODO: How to make OADA cache resume from given rev?
    trace('Checking initial list items: %O', data)
    // Just send fake change for now
    const change = { type: <const>'merge', body: data }
    queue.add(() => ruleHandler({ response: { change }, ...payload }))
  } catch (err) {
    error(err)
    if (err?.response?.status === 404) {
    } else {
      throw err
    }
  }
}

// Run when there is a change to the list a rule applies to
async function ruleHandler ({
  response: { change },
  rule,
  validate,
  id,
  conn,
  token
}: OADAChangeResponse & Exclude<RuleRunCtx, RuleItem>) {
  trace(`Handling rule ${id}`)
  trace('%O', rule)
  trace(change)

  const { type, body } = change
  const data = fixBody(body)
  // Get new list items ignoring _ keys
  const items = Object.keys(data ?? {}).filter(i => !i.match(/^_/))
  switch (type) {
    case 'merge':
      await Promise.map(items, async item => {
        const path = `${rule.list}/${item}`
        // TODO: Get body and meta at once?
        return Promise.resolve(
          // Check if rule already ran on this resource
          // TODO: Run again if _rev has increased?
          conn.get({ path: `${path}/_meta${META_PATH}/${id}` })
        ).catch(
          // Catch 404 errors only
          (e: { response: OADAResponse }) => e?.response?.status === 404,
          async () => {
            // 404 Means this rule has not been run on item yet
            const tree = {}
            pointer.set(tree, path, LIST_TREE)
            const { data } = await conn.get({ path, tree })
            // TODO: Only fetch data/meta once
            const { data: meta } = await conn.get({ path: `${path}/_meta` })
            data._meta = meta

            try {
              await runRule({ data, validate, item, rule, id, conn, token })
            } catch (err) {
              // Catch error so we can still try other items
              error(`Error running rule ${id}: %O`, err)
            }
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

async function runRule ({
  data,
  validate,
  item,
  rule,
  id,
  conn,
  token
}: RuleRunCtx & RuleItem) {
  trace(`Testing rule ${id} on ${item}`)
  trace(data)

  try {
    if (!validate(data)) {
      return
    }
  } catch (err) {
    error('schema %O', rule.schema)
    throw err
  }

  info(`Running rule ${id} on ${item}`)

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
      _id: data._id
      // _rev: data._rev
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
