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

export default {
  domain: 'proxy',
  token: 'def',
  meta_path: '/services/ainz/rules',
  rules_path: '/bookmarks/services/ainz/rules',
  rules_tree: {
    bookmarks: {
      _type: 'application/vnd.oada.bookmarks.1+json',
      services: {
        _type: 'application/vnd.oada.services.1+json',
        _rev: 0,
        ainz: {
          _type: 'application/vnd.oada.service.1+json',
          _rev: 0,
          rules: {
            _type: 'application/vnd.oada.ainz.rules.1+json',
            _rev: 0,
            '*': {
              _type: 'application/vnd.oada.ainz.rule.1+json',
              _rev: 0
            }
          }
        }
      }
    }
  },
  list_tree: {
    '*': {
      _rev: 0
    }
  }
}
