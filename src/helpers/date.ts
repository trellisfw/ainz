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
export const date: Handlebars.HelperDelegate = function (
  // Pass handlebars to helpers incase they need it?
  _Handlebars: typeof Handlebars
) {
  return function date(
    format: string,
    date: string,
    {
      hash: {
        // Default format for Trellis?
        toformat = 'yyyy-MM-dd',
        ...opts
      },
    }: { hash: { toformat: string } & DateTimeOptions }
  ) {
    // Parse date
    const dt = DateTime.fromFormat(date, format, opts);

    // Format date
    return dt.toFormat(toformat, opts);
  };
};
