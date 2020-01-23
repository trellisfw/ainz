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

  // Set up a watch for changes to rules
  try {
    await conn.get({
      path: RULES_PATH,
      tree: RULES_TREE,
      watch: {
        payload: { conn, token: TOKEN },
        callback: rulesHandler
      }
    })
  } catch (err) {
    if (err.response.status === 404) {
    } else {
      error(err)
      throw err
    }
  }
}

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

async function registerRule ({ rule, id, conn, token }) {
  info(`Registering new rule ${id}`)
  trace(rule)

  try {
    await conn.get({
      path: rule.list,
      watch: {
        payload: { rule, id, conn, token },
        callback: ruleHandler
      }
    })
  } catch (err) {
    if (err.response.status === 404) {
    } else {
      error(err)
      throw err
    }
  }
}

async function ruleHandler ({ response: { change }, rule, id, conn, token }) {
  info(`Handling rule ${id}`)
  trace('%O', rule)
  trace(change)

  const { type, body } = change
  const data = fixBody(body)
  // Get new list items ignoring _ keys
  const items = Object.keys(data || {}).filter(i => !i.match(/^_/))
  switch (type) {
    case 'merge':
      // TODO: Check if rule already ran on this resource
      await Promise.each(items, async item => {
        const { data } = await conn.get({ path: `${rule.list}/${item}` })
        return runRule({ data, rule, id, conn, token })
      })
      break
    case 'delete':
      // TODO: Handle deleting rules
      break
    default:
      warn(`Ignoring unknown change type ${type}`)
  }
}

async function runRule ({ data, rule, id, conn, token }) {
  info(`Running rule ${id}`)

  if (!ajv.validate(rule.schema, data)) {
    return
  }

  // Perform the "move" (just put a link?)
  // TODO: Update status?
  // TODO: Content-Type??
  await conn.post({
    path: rule.destination,
    headers: { 'Content-Type': 'application/json' },
    data: {
      _id: data._id,
      _rev: data._rev
    }
  })
}

initialize()
