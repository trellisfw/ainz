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

import { Promise } from 'bluebird'
import Ajv from 'ajv'
import pointer from 'json-pointer'
import PQueue from 'p-queue'
import debug from 'debug'
// prettier-ignore

import { connect, OADAClient } from '@oada/client'
import Rule, { assert as assertRule } from '@oada/types/oada/ainz/rule'
import { assert as assertResource } from '@oada/types/oada/resource'
import Change from '@oada/types/oada/change/v2'
// const { getToken } = require('/code/winfield-shared/service-user')

// @ts-ignore
import config from './config'

const trace = debug('ainz:trace')
const info = debug('ainz:info')
const warn = debug('ainz:warn')
const error = debug('ainz:error')

type OADATree = {
  _type?: string
  _rev?: number
} & Partial<{
  [key: string]: OADATree
}>

// Stuff from config
/**
 * @todo: Get token properly (multiple?)
 */
const TOKENS: string[] = config.get('token').split(',')
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

let oada: OADAClient

/**
 * Start-up for a given user (token)
 */
async function initialize (token: string) {
  // Connect to oada
  const conn = oada
    ? oada.clone(token)
    : (oada = await connect({
        domain: 'https://' + DOMAIN,
        token
      }))
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
      watchCallback: change =>
        rulesHandler({ conn, token, change: change as Change[0] })
    })
    trace('Registering initial rules: %O', data)
    // Register the pre-existing rules
    // TODO: Refactor this?
    const rules = Object.keys(data ?? {}).filter(r => !r.match(/^_/))
    await Promise.map(rules, id => {
      try {
        const rule = (data as any)?.[id]
        assertRule(rule)
        registerRule({ rule, id, conn, token: token })
      } catch (err) {
        warn(`Invalid rule ${id}: %O`, err)
      }
    })
  } catch (err) {
    error(err)
    if (err?.response?.status === 404) {
    } else {
      throw err
    }
  }
}
type RuleInfo = {
  id: string
  rule: Rule
}
type ConnInfo = {
  conn: OADAClient
  token: string
}
// Define "context" rules are registered with
type RuleCtx = RuleInfo & ConnInfo
// Define "thing" a rule runs on
type RuleItem = {
  data: unknown
  item: string
}
// Define "context" rules are run with
type RuleRunCtx = RuleCtx & { validate: Ajv.ValidateFunction }

// Run when there is a change to list of rules
async function rulesHandler ({
  change,
  conn,
  token,
  ...ctx
}: { change: Change[0] } & ConnInfo) {
  info('Running rules watch handler')
  trace(change)

  const { type, body: data } = change
  // Get new rules ignoring _ keys
  const rules = Object.keys(data ?? {}).filter(r => !r.match(/^_/))
  switch (type) {
    case 'merge':
      await Promise.map(rules, async id => {
        try {
          // Fetch entire rule (not just changed part)
          const path = `${RULES_PATH}/${id}`
          const { data: rule } = await conn.get({ path })

          assertRule(rule)
          registerRule({ rule, id, conn, token, ...ctx })
        } catch (err) {
          error(`Error registering rule ${id}: %O`, err)
        }
      })
      break
    case 'delete':
      // Unregister the deleted rule
      await Promise.map(rules, id =>
        unregisterRule({ id, conn, token, ...ctx })
      )
      break
    default:
      warn(`Ignoring uknown change type ${type} to rules`)
  }
}

// Keep track of registered watches
const ruleWatches: { [key: string]: string } = {}
async function unregisterRule ({ id, conn }: Omit<RuleCtx, 'rule'>) {
  info(`Unregistering rule ${id}`)
  const oldWatch = ruleWatches[id]
  await conn.unwatch(oldWatch)
  delete ruleWatches[id]
}
async function registerRule ({ rule, id, conn, token }: RuleCtx) {
  info(`Registering new rule ${id}`)
  trace(rule)

  // TODO: Fix queue to be by rule/item and not just rule
  const queue = new PQueue({ concurrency: 1 })

  try {
    const validate = ajv.compile(rule.schema)
    const payload = { rule, validate, id, conn, token }
    ruleWatches[id] = await conn.watch({
      path: rule.list,
      watchCallback: change =>
        queue.add(() =>
          ruleHandler({ ...payload, change: change as Change[0] })
        )
    })
    const { data } = await conn.get({
      path: rule.list
    })

    // TODO: How to make OADA cache resume from given rev?
    trace('Checking initial list items: %O', data)
    // Just send fake change for now
    const change = {
      type: <const>'merge',
      path: '',
      resource_id: '',
      body: data as any
    }
    queue.add(() => ruleHandler({ change, ...payload }))
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
  change,
  rule,
  validate,
  id,
  conn,
  token
}: { change: Change[0] } & Exclude<RuleRunCtx, RuleItem>) {
  trace(`Handling rule ${id}`)
  trace('%O', rule)
  trace(change)

  const { type, body: data } = change
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
          conn.get({
            path: `${path}/_meta${META_PATH}/${id}`
          })
        ).catch(
          // Catch 404 errors only
          (e: { status: number }) => e?.status === 404,
          async () => {
            try {
              // 404 Means this rule has not been run on item yet
              const tree = {}
              pointer.set(tree, path, LIST_TREE)
              const { data } = await conn.get({
                path,
                tree
              })
              assertResource(data)
              // TODO: Only fetch data/meta once
              const { data: meta } = await conn.get({
                path: `${path}/_meta`
              })
              assertResource(meta)
              data._meta = meta

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
  conn
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
  // @ts-ignore
  const { _id, _rev } = data

  if (rule.meta) {
    // Add meta info to item if supplied
    trace('Adding to _meta %O', rule.meta)
    await conn.put({
      path: `/${_id}/_meta`,
      contentType: 'application/json',
      data: rule.meta as any
    })
  }

  // Perform the "move"
  // Use PUT not POST incase same item it matched multiple times
  // TODO: Content-Type??
  // TODO: How to use tree param to do deep PUT??
  await conn.put({
    path: `${rule.destination}/${item}`,
    contentType: 'application/json',
    data: {
      _id
      // _rev: data._rev
    }
  })

  // Record in _meta that this rule ran on this item
  trace(`Marking rule ${id} completed`)
  await conn.put({
    path: `/${_id}/_meta${META_PATH}/${id}`,
    contentType: 'application/json',
    // Record what _rev was when we ran
    data: { _rev }
  })
}

TOKENS.map(token => initialize(token))
