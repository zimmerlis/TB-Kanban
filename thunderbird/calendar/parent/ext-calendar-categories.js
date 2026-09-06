/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { ExtensionCommon: { ExtensionAPI } } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");

var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");

this.calendar_categories = class extends ExtensionAPI {
  getAPI(context) {
    return {
      calendar: {
        categories: {
          async query() {
            // Names come from "calendar.categories.names", colors from the "calendar.category.color.*" branch,
            // falling back to the same hash-based color Thunderbird assigns to categories without one.
            return cal.category.fromPrefs().map(name => {
              const cssName = cal.view.formatStringForCSSRule(name);
              const color = Services.prefs.getStringPref(`calendar.category.color.${cssName}`, "") || cal.view.hashColor(name);
              return { name, color };
            });
          },
        },
      },
    };
  }
};
