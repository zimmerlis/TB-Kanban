/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Minimal reader for jCal (RFC 7265) component/property arrays:
// component := [name, properties[], subcomponents[]], property := [name, params, type, value].
const COMPONENT_NAME = 0;
const COMPONENT_PROPERTIES = 1;
const COMPONENT_SUBCOMPONENTS = 2;

const PROPERTY_NAME = 0;
const PROPERTY_VALUE = 3;

// Depth-first search since query() wraps the requested item in a vcalendar (with vtimezone siblings).
export function findComponent(jcalComponent, name) {
    if (!Array.isArray(jcalComponent)) {
        return null;
    }
    if (jcalComponent[COMPONENT_NAME] === name) {
        return jcalComponent;
    }
    for (const subComponent of jcalComponent[COMPONENT_SUBCOMPONENTS] ?? []) {
        const found = findComponent(subComponent, name);
        if (found) {
            return found;
        }
    }
    return null;
}

export function getPropertyValue(jcalComponent, name) {
    const property = jcalComponent?.[COMPONENT_PROPERTIES]?.find(
        entry => entry[PROPERTY_NAME] === name
    );
    return property?.[PROPERTY_VALUE];
}

// Mutates the property in place (or appends it) so the jCal tree can be sent back to calendar.items.update().
export function setPropertyValue(jcalComponent, name, value, type = 'text') {
    const properties = jcalComponent[COMPONENT_PROPERTIES];
    const property = properties.find(entry => entry[PROPERTY_NAME] === name);
    if (property) {
        property[PROPERTY_VALUE] = value;
    } else {
        properties.push([name, {}, type, value]);
    }
}

// Extracts the fields the board needs from a `calendar.items.query` result (returnFormat: "jcal").
export function getTaskFromCalendarItem(calendarItem) {
    const vtodo = findComponent(calendarItem.item, 'vtodo');

    return {
        id: calendarItem.id,
        calendarId: calendarItem.calendarId,
        title: getPropertyValue(vtodo, 'summary') ?? '',
        status: getPropertyValue(vtodo, 'status') ?? 'NEEDS-ACTION',
        priority: getPropertyValue(vtodo, 'priority') ?? 0,
        percentComplete: getPropertyValue(vtodo, 'percent-complete') ?? 0,
        due: getPropertyValue(vtodo, 'due') ?? null,
        start: getPropertyValue(vtodo, 'dtstart') ?? null,
        parentId: getPropertyValue(vtodo, 'related-to') ?? null,
        description: getPropertyValue(vtodo, 'description') ?? '',
        categories: getPropertyValue(vtodo, 'categories') ?? '',
    };
}
