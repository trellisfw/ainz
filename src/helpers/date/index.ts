/**
 * @license
 * Copyright 2021 Qlever LLC
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

/**
 * Handlebars helpers for handling dates
 *
 * @packageDocumentation
 */

import type Handlebars from 'handlebars';

import { DateTime, DateTimeOptions } from 'luxon';

/**
 * Helper for parsing/formatting dates using luxon
 */
export const date: Handlebars.HelperDelegate =
  (
    // Pass handlebars to helpers incase they need it?
    // eslint-disable-next-line @typescript-eslint/naming-convention
    _Handlebars: typeof Handlebars
  ) =>
  (
    format: string,
    dateString: string,
    {
      hash: {
        // Default format for Trellis?
        toformat = 'yyyy-MM-dd',
        ...options
      },
    }: { hash: { toformat: string } & DateTimeOptions } // eslint-disable-next-line unicorn/consistent-function-scoping
  ) => {
    // Parse date
    const dt = DateTime.fromFormat(dateString, format, options);

    // Format date
    return dt.toFormat(toformat, options);
  };
