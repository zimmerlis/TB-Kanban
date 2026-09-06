/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import './i18n.js';
import { getTaskFromCalendarItem, findComponent, setPropertyValue } from './jcal.js';

// Maps iCal VTODO STATUS values to the board's four columns, and back.
const STATUS_COLUMNS = {
    'NEEDS-ACTION': 'needsAction',
    'IN-PROCESS': 'inProcess',
    'COMPLETED': 'completed',
    'CANCELLED': 'cancelled',
};
const COLUMN_STATUS = {
    needsAction: 'NEEDS-ACTION',
    inProcess: 'IN-PROCESS',
    completed: 'COMPLETED',
    cancelled: 'CANCELLED',
};

// Maps the click-to-edit fields to their VTODO property name/type.
const FIELD_PROPERTY_MAP = {
    title: { name: 'summary', type: 'text' },
    description: { name: 'description', type: 'text' },
    percentComplete: { name: 'percent-complete', type: 'integer' },
    priority: { name: 'priority', type: 'integer' },
    categories: { name: 'categories', type: 'text' },
};

// Raw calendar.items.query() results (with jCal payload), keyed by task id, needed to save drag & drop changes.
let calendarItemById = new Map();
// Parsed tasks, keyed by id, used to know the previous status/percent-complete during drag & drop.
let taskById = new Map();

// Categories configured in Thunderbird/Betterbird itself (name + original color), loaded once at startup.
let knownCategories = [];

async function loadCategories() {
    knownCategories = await browser.calendar.categories.query();
}

function getCategoryColor(name) {
    return knownCategories.find(category => category.name === name)?.color ?? null;
}

// Mirrors Thunderbird's own view.getContrastingTextColor() so category picker items stay readable on any color.
function getContrastingTextColor(hexColor) {
    const hex = hexColor.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
    return brightness < 144 ? 'white' : '#222';
}

// Swimlane grouping selected in the toolbar: 'none', 'category' or 'priority'.
let groupBy = 'none';

// Manual card order per column (task ids), since VTODO items have no native position field.
const ORDER_STORAGE_KEY = 'columnOrder';
let columnOrder = { needsAction: [], inProcess: [], completed: [], cancelled: [] };

async function loadOrder() {
    const stored = await browser.storage.local.get(ORDER_STORAGE_KEY);
    columnOrder = stored[ORDER_STORAGE_KEY] ?? columnOrder;
    for (const columnId of Object.keys(COLUMN_STATUS)) {
        columnOrder[columnId] ??= [];
    }
}

async function saveOrder() {
    await browser.storage.local.set({ [ORDER_STORAGE_KEY]: columnOrder });
}

// Removes the task from whichever column it was previously ordered in, then inserts it right before `beforeTaskId`
// (or at the end when null). Using a sibling id instead of a numeric index keeps this correct even when only a
// filtered subset of a column's cards is visible (e.g. inside a swimlane).
function moveTaskInOrder(targetColumnId, taskId, beforeTaskId) {
    for (const ids of Object.values(columnOrder)) {
        const existingIndex = ids.indexOf(taskId);
        if (existingIndex !== -1) {
            ids.splice(existingIndex, 1);
        }
    }
    const targetIds = columnOrder[targetColumnId];
    const insertIndex = beforeTaskId ? targetIds.indexOf(beforeTaskId) : -1;
    if (insertIndex === -1) {
        targetIds.push(taskId);
    } else {
        targetIds.splice(insertIndex, 0, taskId);
    }
}

// Tasks without a stored position keep their (stable) original order, appended after ordered ones.
function sortTasksByOrder(tasks, orderIds) {
    const rank = new Map(orderIds.map((id, index) => [id, index]));
    return [...tasks].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}

function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

// yyyy-mm-dd for <input type="date">, since editing always stores dates without a time component.
function toDateInputValue(value) {
    const date = new Date(value);
    return value && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

// A click-to-edit field (title/description) shown inline on a card, with a save (check) and cancel (cross) button.
// Disables the card's draggable attribute while editing so selecting text doesn't start a drag.
function renderEditableField(card, task, field, { wrapperClass, displayTag, displayClass, editTag, tooltip, placeholder }) {
    const wrapper = document.createElement('div');
    wrapper.className = wrapperClass;

    function showDisplay() {
        card.draggable = true;
        wrapper.replaceChildren();

        const display = document.createElement(displayTag);
        display.className = `${displayClass} editable-field`;
        display.textContent = task[field] || placeholder || '';
        if (tooltip && task[field]) {
            display.title = task[field];
        }
        display.addEventListener('click', showEdit);
        wrapper.append(display);
    }

    function showEdit() {
        card.draggable = false;
        wrapper.replaceChildren();

        const input = document.createElement(editTag);
        input.className = 'form-control form-control-sm';
        input.value = task[field];
        if (editTag === 'textarea') {
            input.rows = 2;
        }

        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.className = 'btn btn-sm btn-link text-success p-0';
        saveButton.innerHTML = '<i class="bi bi-check-lg"></i>';
        saveButton.addEventListener('click', () => saveTaskField(task.id, field, input.value));

        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'btn btn-sm btn-link text-danger p-0';
        cancelButton.innerHTML = '<i class="bi bi-x-lg"></i>';
        cancelButton.addEventListener('click', showDisplay);

        input.addEventListener('keydown', event => {
            if (event.key === 'Enter' && editTag !== 'textarea') {
                event.preventDefault();
                saveButton.click();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelButton.click();
            }
        });

        const editRow = document.createElement('div');
        editRow.className = 'd-flex align-items-start gap-1';

        const buttons = document.createElement('div');
        buttons.className = 'd-flex flex-column';
        buttons.append(saveButton, cancelButton);

        editRow.append(input, buttons);
        wrapper.append(editRow);
        input.focus();
        input.select();
    }

    showDisplay();
    return wrapper;
}

async function saveTaskField(taskId, field, value) {
    const calendarItem = calendarItemById.get(taskId);
    if (!calendarItem) {
        return;
    }

    const property = FIELD_PROPERTY_MAP[field];
    const vtodo = findComponent(calendarItem.item, 'vtodo');
    setPropertyValue(vtodo, property.name, property.type === 'integer' ? Number(value) : value, property.type);

    // Moving the progress slider implies a status change: 0% -> Needs action, 100% -> Completed,
    // anything in between -> In process.
    if (field === 'percentComplete') {
        const percent = Number(value);
        const status = percent === 0 ? 'NEEDS-ACTION' : percent === 100 ? 'COMPLETED' : 'IN-PROCESS';
        setPropertyValue(vtodo, 'status', status);
    }

    await browser.calendar.items.update(calendarItem.calendarId, taskId, {
        format: 'jcal',
        item: calendarItem.item,
    });

    await refreshBoard();
}

// value, soft-tone bg/text pair; "none" has no color since its card badge is hidden entirely (see renderPriorityField).
const PRIORITY_OPTIONS = [
    { value: 0, messageKey: 'nonePriority', bg: null, color: null },
    { value: 1, messageKey: 'highPriority', bg: '#fee2e2', color: '#991b1b' },
    { value: 5, messageKey: 'mediumPriority', bg: '#fef3c7', color: '#92400e' },
    { value: 9, messageKey: 'lowPriority', bg: '#e0f2fe', color: '#0369a1' },
];

function getPriorityOption(priority) {
    return PRIORITY_OPTIONS.find(option => option.value === priority)
        ?? (priority >= 1 && priority <= 4 ? PRIORITY_OPTIONS[1]
            : priority >= 6 && priority <= 9 ? PRIORITY_OPTIONS[3]
                : PRIORITY_OPTIONS[0]);
}

// Closes an open badge menu as soon as a click lands outside of it.
function closeMenuOnOutsideClick(wrapper, showBadge) {
    const handler = event => {
        if (!wrapper.contains(event.target)) {
            document.removeEventListener('click', handler, true);
            showBadge();
        }
    };
    setTimeout(() => document.addEventListener('click', handler, true));
}

// A badge that, on click, expands into a small menu of all priority options to pick from.
// Hidden entirely on the card when priority is "None" - use the edit dialog to assign one.
function renderPriorityField(card, task) {
    const wrapper = document.createElement('div');
    wrapper.className = 'position-relative';

    function showBadge() {
        wrapper.replaceChildren();

        const option = getPriorityOption(task.priority);
        if (!option.color) {
            return;
        }

        const badge = document.createElement('span');
        badge.className = 'badge badge-lg editable-field';
        badge.style.backgroundColor = option.bg;
        badge.style.color = option.color;
        badge.textContent = browser.i18n.getMessage(option.messageKey);
        badge.addEventListener('click', showMenu);
        wrapper.append(badge);
    }

    function showMenu() {
        wrapper.replaceChildren();

        const menu = document.createElement('div');
        menu.className = 'position-absolute top-100 end-0 d-flex flex-column gap-1 bg-body border rounded p-1 shadow-sm';
        menu.style.zIndex = 10;

        for (const option of PRIORITY_OPTIONS) {
            const item = document.createElement('span');
            item.className = 'badge badge-lg editable-field';
            if (option.color) {
                item.style.backgroundColor = option.bg;
                item.style.color = option.color;
            } else {
                item.classList.add('text-bg-light');
            }
            item.textContent = browser.i18n.getMessage(option.messageKey);
            item.addEventListener('click', () => saveTaskField(task.id, 'priority', option.value));
            menu.append(item);
        }

        wrapper.append(menu);
        closeMenuOnOutsideClick(wrapper, showBadge);
    }

    showBadge();
    return wrapper;
}

// Applies a category's Thunderbird color to a badge, falling back to a neutral style when unknown.
function styleCategoryBadge(badge, name) {
    const color = getCategoryColor(name);
    if (color) {
        badge.style.backgroundColor = color;
        badge.style.color = getContrastingTextColor(color);
    } else {
        badge.classList.add('text-bg-light');
    }
}

// A badge that, on click, expands into a menu of Thunderbird's configured categories plus a field to add a new one.
function renderCategoryField(card, task) {
    const wrapper = document.createElement('div');
    wrapper.className = 'position-relative';

    function showBadge() {
        wrapper.replaceChildren();

        const badge = document.createElement('span');
        badge.className = 'badge badge-lg editable-field';
        badge.textContent = task.categories || browser.i18n.getMessage('noCategoryLabel');
        styleCategoryBadge(badge, task.categories);
        badge.addEventListener('click', showMenu);
        wrapper.append(badge);
    }

    function showMenu() {
        wrapper.replaceChildren();

        const menu = document.createElement('div');
        menu.className = 'position-absolute top-100 end-0 d-flex flex-column gap-1 bg-body border rounded p-1 shadow-sm';
        menu.style.zIndex = 10;
        menu.style.minWidth = '8rem';
        menu.style.maxHeight = '16rem';
        menu.style.overflowY = 'auto';

        const noneItem = document.createElement('span');
        noneItem.className = 'badge badge-lg editable-field text-bg-light';
        noneItem.textContent = browser.i18n.getMessage('noCategoryLabel');
        noneItem.addEventListener('click', () => saveTaskField(task.id, 'categories', ''));
        menu.append(noneItem);

        for (const category of knownCategories) {
            const item = document.createElement('span');
            item.className = 'badge badge-lg editable-field';
            item.textContent = category.name;
            styleCategoryBadge(item, category.name);
            item.addEventListener('click', () => saveTaskField(task.id, 'categories', category.name));
            menu.append(item);
        }

        const addRow = document.createElement('div');
        addRow.className = 'd-flex gap-1';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'form-control form-control-sm';
        input.placeholder = browser.i18n.getMessage('categoriesField');

        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.className = 'btn btn-sm btn-link text-success p-0';
        addButton.innerHTML = '<i class="bi bi-check-lg"></i>';
        addButton.addEventListener('click', () => {
            if (input.value.trim()) {
                saveTaskField(task.id, 'categories', input.value.trim());
            }
        });
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                addButton.click();
            }
        });

        addRow.append(input, addButton);
        menu.append(addRow);

        wrapper.append(menu);
        closeMenuOnOutsideClick(wrapper, showBadge);
    }

    showBadge();
    return wrapper;
}

// A progress bar that, on click, turns into a range slider confirmed with a check/cross button.
function renderProgressField(card, task) {
    const wrapper = document.createElement('div');
    wrapper.className = 'mb-1';

    function showBar() {
        card.draggable = true;
        wrapper.replaceChildren();

        const progress = document.createElement('div');
        progress.className = 'progress editable-field';
        progress.style.height = '4px';
        progress.style.borderRadius = '2px';
        progress.title = `${task.percentComplete}%`;

        const bar = document.createElement('div');
        bar.className = `progress-bar${task.percentComplete === 0 ? ' bg-secondary' : ''}`;
        bar.style.width = `${task.percentComplete}%`;
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuenow', String(task.percentComplete));
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        progress.append(bar);

        progress.addEventListener('click', showSlider);
        wrapper.append(progress);
    }

    function showSlider() {
        card.draggable = false;
        wrapper.replaceChildren();

        const input = document.createElement('input');
        input.type = 'range';
        input.className = 'form-range';
        input.min = 0;
        input.max = 100;
        input.step = 5;
        input.value = task.percentComplete;

        const valueLabel = document.createElement('span');
        valueLabel.className = 'small text-muted';
        valueLabel.textContent = `${input.value}%`;
        input.addEventListener('input', () => {
            valueLabel.textContent = `${input.value}%`;
        });

        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.className = 'btn btn-sm btn-link text-success p-0';
        saveButton.innerHTML = '<i class="bi bi-check-lg"></i>';
        saveButton.addEventListener('click', () => saveTaskField(task.id, 'percentComplete', input.value));

        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'btn btn-sm btn-link text-danger p-0';
        cancelButton.innerHTML = '<i class="bi bi-x-lg"></i>';
        cancelButton.addEventListener('click', showBar);

        input.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                cancelButton.click();
            }
        });

        const editRow = document.createElement('div');
        editRow.className = 'd-flex align-items-center gap-1';
        editRow.append(input, valueLabel, saveButton, cancelButton);

        wrapper.append(editRow);
        input.focus();
    }

    showBar();
    return wrapper;
}

function renderTaskCard(task) {
    const card = document.createElement('div');
    card.className = 'card mb-2';
    card.draggable = true;
    card.dataset.taskId = task.id;

    // A colored left accent replaces the old full-card pastel tint, driven by priority (not category).
    const priorityOption = getPriorityOption(task.priority);
    if (priorityOption.color) {
        card.style.setProperty('--kanban-card-accent', priorityOption.color);
        card.style.setProperty('--kanban-card-accent-width', '3px');
    }

    const body = document.createElement('div');
    body.className = 'card-body d-flex flex-column';

    // Top: badges/categories (left) and hover-revealed edit/delete actions (right).
    const topRow = document.createElement('div');
    topRow.className = 'd-flex justify-content-between align-items-start gap-2 mb-2';

    const badgeRow = document.createElement('div');
    badgeRow.className = 'd-flex flex-wrap gap-1';
    badgeRow.append(renderPriorityField(card, task), renderCategoryField(card, task));
    topRow.append(badgeRow);

    // Hidden until the mouse hovers the card (see .card-actions in ui.css).
    const iconActions = document.createElement('div');
    iconActions.className = 'card-actions d-flex align-items-center gap-2 flex-shrink-0';

    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'btn btn-sm btn-link text-muted p-0';
    editButton.dataset.action = 'edit';
    editButton.innerHTML = '<i class="bi bi-pencil"></i>';
    iconActions.append(editButton);

    // Moves the task to "Cancelled" first; only deletes for good once it's already there.
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn btn-sm btn-link text-muted p-0';
    deleteButton.dataset.action = 'delete';
    deleteButton.innerHTML = '<i class="bi bi-trash"></i>';
    iconActions.append(deleteButton);

    topRow.append(iconActions);
    body.append(topRow);

    // Middle: the card's title.
    body.append(renderEditableField(card, task, 'title', {
        wrapperClass: 'mb-1',
        displayTag: 'h6',
        displayClass: 'card-title mb-0 text-truncate',
        editTag: 'input',
    }));

    // Only rendered when there is actual content - use the edit dialog to add a description.
    if (task.description) {
        body.append(renderEditableField(card, task, 'description', {
            wrapperClass: 'mb-1',
            displayTag: 'div',
            displayClass: 'card-description',
            editTag: 'textarea',
            tooltip: true,
        }));
    }

    // Bottom: due date and progress, pushed to the bottom of the card.
    const footer = document.createElement('div');
    footer.className = 'mt-auto pt-1';

    if (task.due) {
        const due = document.createElement('div');
        due.className = 'text-muted small mb-1 d-flex align-items-center gap-1';

        const icon = document.createElement('i');
        icon.className = 'bi bi-calendar-event';

        due.append(icon, formatDate(task.due));
        footer.append(due);
    }

    footer.append(renderProgressField(card, task));
    body.append(footer);

    card.append(body);
    return card;
}

const COLUMN_DEFINITIONS = [
    { id: 'needsAction', messageKey: 'needsActionStatus' },
    { id: 'inProcess', messageKey: 'inProcessStatus' },
    { id: 'completed', messageKey: 'completedStatus' },
    { id: 'cancelled', messageKey: 'cancelledStatus' },
];

function groupTasksByColumn(tasks) {
    const byColumn = { needsAction: [], inProcess: [], completed: [], cancelled: [] };
    for (const task of tasks) {
        byColumn[STATUS_COLUMNS[task.status] ?? 'needsAction'].push(task);
    }
    return byColumn;
}

// Builds one row of the four status columns, used both for the flat board and for each swimlane.
function createColumnsRow(tasksByColumn) {
    const row = document.createElement('div');
    row.className = 'row h-100 flex-nowrap';

    for (const { id, messageKey } of COLUMN_DEFINITIONS) {
        const col = document.createElement('div');
        col.className = 'col d-flex flex-column';

        // Dedicated slate surface (see .kanban-column in ui.css) distinct from the page background.
        const columnBox = document.createElement('div');
        columnBox.className = 'kanban-column d-flex flex-column flex-grow-1';

        const columnTasks = sortTasksByOrder(tasksByColumn[id] ?? [], columnOrder[id]);

        const heading = document.createElement('div');
        heading.className = 'column-header d-flex align-items-center justify-content-between';

        const title = document.createElement('span');
        title.textContent = browser.i18n.getMessage(messageKey);
        heading.append(title);

        const countBadge = document.createElement('span');
        countBadge.className = 'badge column-count-badge';
        countBadge.textContent = String(columnTasks.length);
        heading.append(countBadge);

        columnBox.append(heading);

        const columnBody = document.createElement('div');
        columnBody.className = 'flex-grow-1';
        columnBody.dataset.column = id;

        if (columnTasks.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'kanban-empty-column';
            emptyState.textContent = browser.i18n.getMessage('emptyColumnLabel');
            columnBody.append(emptyState);
        } else {
            for (const task of columnTasks) {
                columnBody.append(renderTaskCard(task));
            }
        }

        columnBox.append(columnBody);
        col.append(columnBox);
        row.append(col);
    }

    return row;
}

// Splits tasks into swimlane groups for the selected grouping, skipping groups with no tasks.
function getTaskGroups(tasks) {
    if (groupBy === 'priority') {
        // Most important first: high, medium, low, then tasks without a priority.
        return [PRIORITY_OPTIONS[1], PRIORITY_OPTIONS[2], PRIORITY_OPTIONS[3], PRIORITY_OPTIONS[0]]
            .map(option => ({
                label: browser.i18n.getMessage(option.messageKey),
                color: null,
                tasks: tasks.filter(task => getPriorityOption(task.priority).value === option.value),
            }))
            .filter(group => group.tasks.length > 0);
    }

    if (groupBy === 'category') {
        const groups = knownCategories
            .map(category => ({
                label: category.name,
                color: category.color,
                tasks: tasks.filter(task => task.categories === category.name),
            }))
            .filter(group => group.tasks.length > 0);

        const withoutCategory = tasks.filter(task => !task.categories);
        if (withoutCategory.length > 0) {
            groups.push({ label: browser.i18n.getMessage('noCategoryLabel'), color: null, tasks: withoutCategory });
        }
        return groups;
    }

    return [];
}

// An accordion where only one swimlane is expanded at a time (Bootstrap enforces this via data-bs-parent).
function createSwimlaneAccordion(groups) {
    const accordion = document.createElement('div');
    accordion.className = 'accordion';
    accordion.id = 'swimlaneAccordion';

    groups.forEach((group, index) => {
        const collapseId = `swimlane-collapse-${index}`;

        const item = document.createElement('div');
        item.className = 'accordion-item';

        const header = document.createElement('h2');
        header.className = 'accordion-header';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = `accordion-button${index === 0 ? '' : ' collapsed'}`;
        button.dataset.bsToggle = 'collapse';
        button.dataset.bsTarget = `#${collapseId}`;
        button.textContent = `${group.label} (${group.tasks.length})`;
        if (group.color) {
            button.style.borderLeft = `6px solid ${group.color}`;
        }
        header.append(button);

        const collapse = document.createElement('div');
        collapse.id = collapseId;
        collapse.className = `accordion-collapse collapse${index === 0 ? ' show' : ''}`;
        collapse.dataset.bsParent = '#swimlaneAccordion';

        const body = document.createElement('div');
        body.className = 'accordion-body';
        body.append(createColumnsRow(groupTasksByColumn(group.tasks)));
        collapse.append(body);

        item.append(header, collapse);
        accordion.append(item);
    });

    return accordion;
}

function renderBoard(tasks) {
    taskById = new Map(tasks.map(task => [task.id, task]));

    const boardElement = document.getElementById('board');
    boardElement.replaceChildren();

    if (groupBy === 'none') {
        boardElement.append(createColumnsRow(groupTasksByColumn(tasks)));
        return;
    }

    boardElement.append(createSwimlaneAccordion(getTaskGroups(tasks)));
}

async function loadTasks() {
    const items = await browser.calendar.items.query({ type: 'task', returnFormat: 'jcal' });
    calendarItemById = new Map(items.map(item => [item.id, item]));
    return items.map(getTaskFromCalendarItem);
}

async function refreshBoard() {
    renderBoard(await loadTasks());
}

async function moveTaskToStatus(taskId, newStatus) {
    const calendarItem = calendarItemById.get(taskId);
    const task = taskById.get(taskId);
    if (!calendarItem || !task || task.status === newStatus) {
        return;
    }

    const vtodo = findComponent(calendarItem.item, 'vtodo');
    setPropertyValue(vtodo, 'status', newStatus);
    if (newStatus === 'COMPLETED') {
        setPropertyValue(vtodo, 'percent-complete', 100, 'integer');
    } else if (task.percentComplete === 100) {
        setPropertyValue(vtodo, 'percent-complete', 0, 'integer');
    }

    await browser.calendar.items.update(calendarItem.calendarId, taskId, {
        format: 'jcal',
        item: calendarItem.item,
    });
}

async function handleDeleteAction(taskId) {
    const task = taskById.get(taskId);
    if (!task) {
        return;
    }

    // First click retires the task, second click (once it's already cancelled) removes it for good.
    if (task.status !== 'CANCELLED') {
        await moveTaskToStatus(taskId, 'CANCELLED');
        await refreshBoard();
        return;
    }

    if (!confirm(browser.i18n.getMessage('confirmDeletionMessage'))) {
        return;
    }

    const calendarItem = calendarItemById.get(taskId);
    await browser.calendar.items.remove(calendarItem.calendarId, taskId);
    await refreshBoard();
}

const editModalElement = document.getElementById('taskEditModal');
const editForm = document.getElementById('taskEditForm');
let editModal = null;
let editingTaskId = null;

function openEditModal(taskId) {
    const task = taskById.get(taskId);
    if (!task) {
        return;
    }

    editingTaskId = taskId;
    editForm.elements.title.value = task.title;
    editForm.elements.status.value = task.status;
    editForm.elements.priority.value = String(task.priority || 0);
    editForm.elements.start.value = toDateInputValue(task.start);
    editForm.elements.due.value = toDateInputValue(task.due);
    editForm.elements.percentComplete.value = task.percentComplete || 0;
    editForm.elements.categories.value = task.categories;
    editForm.elements.description.value = task.description;

    editModal ??= new bootstrap.Modal(editModalElement);
    editModal.show();
}

async function saveEditForm() {
    const calendarItem = calendarItemById.get(editingTaskId);
    if (!calendarItem) {
        return;
    }

    const vtodo = findComponent(calendarItem.item, 'vtodo');
    setPropertyValue(vtodo, 'summary', editForm.elements.title.value);
    setPropertyValue(vtodo, 'status', editForm.elements.status.value);
    setPropertyValue(vtodo, 'priority', Number(editForm.elements.priority.value), 'integer');
    setPropertyValue(vtodo, 'percent-complete', Number(editForm.elements.percentComplete.value) || 0, 'integer');
    setPropertyValue(vtodo, 'categories', editForm.elements.categories.value);
    setPropertyValue(vtodo, 'description', editForm.elements.description.value);
    if (editForm.elements.start.value) {
        setPropertyValue(vtodo, 'dtstart', editForm.elements.start.value, 'date');
    }
    if (editForm.elements.due.value) {
        setPropertyValue(vtodo, 'due', editForm.elements.due.value, 'date');
    }

    await browser.calendar.items.update(calendarItem.calendarId, editingTaskId, {
        format: 'jcal',
        item: calendarItem.item,
    });

    editModal.hide();
    editingTaskId = null;
    await refreshBoard();
}

function initTaskActions() {
    document.getElementById('board').addEventListener('click', event => {
        const button = event.target.closest('[data-action]');
        const taskId = button?.closest('.card')?.dataset.taskId;
        if (!taskId) {
            return;
        }

        if (button.dataset.action === 'edit') {
            openEditModal(taskId);
        } else if (button.dataset.action === 'delete') {
            handleDeleteAction(taskId);
        }
    });

    editForm.addEventListener('submit', event => {
        event.preventDefault();
        saveEditForm();
    });
}

// Shared insertion-line element, moved to the current drop position while dragging over a column.
let dropIndicator = null;

function getDropIndicator() {
    dropIndicator ??= document.createElement('div');
    dropIndicator.className = 'drop-indicator';
    return dropIndicator;
}

// Finds the first card (excluding the one being dragged) whose vertical midpoint is below `y`.
function getCardAfterPoint(column, y) {
    const cards = [...column.querySelectorAll('.card:not(.dragging)')];
    return cards.reduce((closest, card) => {
        const box = card.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        return offset < 0 && offset > closest.offset ? { offset, element: card } : closest;
    }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

function initDragAndDrop() {
    const board = document.getElementById('board');

    board.addEventListener('dragstart', event => {
        const card = event.target.closest('.card');
        if (!card) {
            return;
        }
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', card.dataset.taskId);
        card.classList.add('dragging');
    });

    board.addEventListener('dragend', event => {
        event.target.closest('.card')?.classList.remove('dragging');
        getDropIndicator().remove();
    });

    // Delegated (rather than bound per column) since columns are recreated on every render, and
    // grouped mode can have several instances of the same column spread across swimlanes.
    board.addEventListener('dragover', event => {
        const column = event.target.closest('[data-column]');
        if (!column) {
            return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';

        const indicator = getDropIndicator();
        const afterElement = getCardAfterPoint(column, event.clientY);
        if (afterElement) {
            column.insertBefore(indicator, afterElement);
        } else {
            column.append(indicator);
        }
    });

    board.addEventListener('drop', async event => {
        const column = event.target.closest('[data-column]');
        if (!column) {
            return;
        }
        event.preventDefault();

        const taskId = event.dataTransfer.getData('text/plain');
        const afterElement = getCardAfterPoint(column, event.clientY);
        const columnId = column.dataset.column;

        getDropIndicator().remove();

        moveTaskInOrder(columnId, taskId, afterElement?.dataset.taskId ?? null);
        await saveOrder();
        await moveTaskToStatus(taskId, COLUMN_STATUS[columnId]);
        await refreshBoard();
    });
}

function initGroupBySelect() {
    const select = document.getElementById('groupBySelect');
    select.value = groupBy;
    select.addEventListener('change', () => {
        groupBy = select.value;
        refreshBoard();
    });
}

// Defaults reproduce a modern, neutral card look, until the user overrides them in Settings.
const DEFAULT_APPEARANCE = {
    light: { background: '#ffffff', cardBackground: '#ffffff', cardTextColor: '#0f172a', cardBorderColor: '#e2e8f0', cardBorderWidth: 1, headerBackground: '#e2e8f0', headerTextColor: '#475569' },
    dark: { background: '#212529', cardBackground: '#2b3035', cardTextColor: '#dee2e6', cardBorderColor: '#495057', cardBorderWidth: 1, headerBackground: '#343a40', headerTextColor: '#f8f9fa' },
};
// Column surface background, not user-configurable (keeps the Settings dialog focused on card content).
const COLUMN_BACKGROUND = { light: '#f8fafc', dark: '#1e2530' };
const APPEARANCE_STORAGE_KEY = 'boardAppearance';
const THEME_STORAGE_KEY = 'boardTheme';

let appearance = structuredClone(DEFAULT_APPEARANCE);
// null = follow the system/Thunderbird color scheme; 'light'/'dark' = explicit user override.
let themePreference = null;

async function loadAppearance() {
    const stored = await browser.storage.local.get([APPEARANCE_STORAGE_KEY, THEME_STORAGE_KEY]);
    const storedAppearance = stored[APPEARANCE_STORAGE_KEY] ?? {};
    appearance = {
        light: { ...DEFAULT_APPEARANCE.light, ...storedAppearance.light },
        dark: { ...DEFAULT_APPEARANCE.dark, ...storedAppearance.dark },
    };
    themePreference = stored[THEME_STORAGE_KEY] ?? null;
}

function resolveTheme() {
    return themePreference ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

// Pushes the resolved theme's colors into Bootstrap's own variable (body bg) and our own
// (card border / column header), so plain `.card`/body styling picks them up automatically.
function applyTheme() {
    const theme = resolveTheme();
    const themeAppearance = appearance[theme];

    document.documentElement.setAttribute('data-bs-theme', theme);
    document.getElementById('themeToggleIcon').className = theme === 'dark' ? 'bi bi-sun' : 'bi bi-moon-stars';

    const root = document.documentElement.style;
    root.setProperty('--bs-body-bg', themeAppearance.background);
    root.setProperty('--kanban-column-bg', COLUMN_BACKGROUND[theme]);
    root.setProperty('--kanban-card-bg', themeAppearance.cardBackground);
    root.setProperty('--kanban-card-color', themeAppearance.cardTextColor);
    root.setProperty('--kanban-card-border-color', themeAppearance.cardBorderColor);
    root.setProperty('--kanban-card-border-width', `${themeAppearance.cardBorderWidth}px`);
    root.setProperty('--kanban-header-bg', themeAppearance.headerBackground);
    root.setProperty('--kanban-header-color', themeAppearance.headerTextColor);
}

function initThemeToggle() {
    document.getElementById('themeToggleButton').addEventListener('click', async () => {
        themePreference = resolveTheme() === 'dark' ? 'light' : 'dark';
        await browser.storage.local.set({ [THEME_STORAGE_KEY]: themePreference });
        applyTheme();
    });

    // Only react to system/OS theme changes while no explicit override has been chosen.
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (themePreference === null) {
            applyTheme();
        }
    });
}

const settingsForm = document.getElementById('settingsForm');
let settingsModal = null;

function fillSettingsForm() {
    for (const theme of ['light', 'dark']) {
        settingsForm.elements[`${theme}Background`].value = appearance[theme].background;
        settingsForm.elements[`${theme}CardBackground`].value = appearance[theme].cardBackground;
        settingsForm.elements[`${theme}TextColor`].value = appearance[theme].cardTextColor;
        settingsForm.elements[`${theme}BorderColor`].value = appearance[theme].cardBorderColor;
        settingsForm.elements[`${theme}BorderWidth`].value = appearance[theme].cardBorderWidth;
        settingsForm.elements[`${theme}HeaderBackground`].value = appearance[theme].headerBackground;
        settingsForm.elements[`${theme}HeaderTextColor`].value = appearance[theme].headerTextColor;
    }
}

function openSettingsModal() {
    fillSettingsForm();
    settingsModal ??= new bootstrap.Modal(document.getElementById('settingsModal'));
    settingsModal.show();
}

async function saveSettingsForm() {
    appearance = Object.fromEntries(['light', 'dark'].map(theme => [theme, {
        background: settingsForm.elements[`${theme}Background`].value,
        cardBackground: settingsForm.elements[`${theme}CardBackground`].value,
        cardTextColor: settingsForm.elements[`${theme}TextColor`].value,
        cardBorderColor: settingsForm.elements[`${theme}BorderColor`].value,
        cardBorderWidth: Number(settingsForm.elements[`${theme}BorderWidth`].value) || 0,
        headerBackground: settingsForm.elements[`${theme}HeaderBackground`].value,
        headerTextColor: settingsForm.elements[`${theme}HeaderTextColor`].value,
    }]));

    await browser.storage.local.set({ [APPEARANCE_STORAGE_KEY]: appearance });
    applyTheme();
    settingsModal.hide();
}

function initSettings() {
    document.getElementById('settingsButton').addEventListener('click', openSettingsModal);
    document.getElementById('settingsResetButton').addEventListener('click', () => {
        appearance = structuredClone(DEFAULT_APPEARANCE);
        fillSettingsForm();
    });
    settingsForm.addEventListener('submit', event => {
        event.preventDefault();
        saveSettingsForm();
    });
}

// Lets a modal be moved by dragging its header, since Bootstrap modals are centered/fixed by default.
function makeModalDraggable(modalElement) {
    const dialog = modalElement.querySelector('.modal-dialog');
    const header = modalElement.querySelector('.modal-header');
    if (!dialog || !header) {
        return;
    }

    header.style.cursor = 'move';
    let drag = null;

    header.addEventListener('mousedown', event => {
        if (event.target.closest('.btn-close')) {
            return;
        }
        const rect = dialog.getBoundingClientRect();
        drag = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
        dialog.style.position = 'fixed';
        dialog.style.margin = '0';
        dialog.style.left = `${rect.left}px`;
        dialog.style.top = `${rect.top}px`;
        event.preventDefault();
    });

    document.addEventListener('mousemove', event => {
        if (!drag) {
            return;
        }
        dialog.style.left = `${event.clientX - drag.offsetX}px`;
        dialog.style.top = `${event.clientY - drag.offsetY}px`;
    });

    document.addEventListener('mouseup', () => {
        drag = null;
    });

    // Reset to Bootstrap's default centered position each time the modal is reopened.
    modalElement.addEventListener('show.bs.modal', () => {
        dialog.style.position = '';
        dialog.style.margin = '';
        dialog.style.left = '';
        dialog.style.top = '';
    });
}

const DONATE_URL = 'https://buymeacoffee.com/oxekklfcg';
const HOMEPAGE_URL = 'https://github.com/zimmerlis/TB-Kanban';
const ABOUT_PROMPT_STORAGE_KEY = 'aboutPromptState';

function initAbout() {
    const manifest = browser.runtime.getManifest();
    document.getElementById('aboutName').textContent = manifest.name;
    document.getElementById('aboutVersion').textContent = `v${manifest.version}`;

    const homepageLink = document.getElementById('aboutHomepageLink');
    homepageLink.href = HOMEPAGE_URL || '#';
    homepageLink.addEventListener('click', event => {
        event.preventDefault();
        if (HOMEPAGE_URL) {
            browser.tabs.create({ url: HOMEPAGE_URL });
        }
    });

    const donateLink = document.getElementById('aboutDonateLink');
    donateLink.href = DONATE_URL || '#';
    donateLink.addEventListener('click', event => {
        event.preventDefault();
        if (DONATE_URL) {
            browser.tabs.create({ url: DONATE_URL });
        }
    });

    // The checkbox is the single source of truth for permanently disabling the daily prompt -
    // this is an honor system, not a verified purchase (the extension is open source anyway).
    const donatedCheckbox = document.getElementById('aboutDonatedCheckbox');
    browser.storage.local.get(ABOUT_PROMPT_STORAGE_KEY).then(stored => {
        donatedCheckbox.checked = Boolean(stored[ABOUT_PROMPT_STORAGE_KEY]?.dismissedForGood);
    });
    donatedCheckbox.addEventListener('change', async () => {
        const stored = await browser.storage.local.get(ABOUT_PROMPT_STORAGE_KEY);
        await browser.storage.local.set({
            [ABOUT_PROMPT_STORAGE_KEY]: { ...stored[ABOUT_PROMPT_STORAGE_KEY], dismissedForGood: donatedCheckbox.checked },
        });
    });

    document.getElementById('aboutButton').addEventListener('click', () => {
        (bootstrap.Modal.getOrCreateInstance(document.getElementById('aboutModal'))).show();
    });
}

// Shows the About dialog (with its donate nudge) once per calendar day, unless the user has
// already clicked through to the donation page once (see initAbout's donate click handler).
async function maybeAutoShowAbout() {
    const stored = await browser.storage.local.get(ABOUT_PROMPT_STORAGE_KEY);
    const state = stored[ABOUT_PROMPT_STORAGE_KEY] ?? {};
    if (state.dismissedForGood) {
        return;
    }

    const today = new Date().toISOString().slice(0, 10);
    if (state.lastShownDate === today) {
        return;
    }

    await browser.storage.local.set({ [ABOUT_PROMPT_STORAGE_KEY]: { ...state, lastShownDate: today } });
    bootstrap.Modal.getOrCreateInstance(document.getElementById('aboutModal')).show();
}

async function init() {
    await loadOrder();
    await loadCategories();
    await loadAppearance();
    initDragAndDrop();
    initTaskActions();
    initGroupBySelect();
    initThemeToggle();
    initSettings();
    initAbout();
    for (const modalId of ['taskEditModal', 'settingsModal', 'aboutModal']) {
        makeModalDraggable(document.getElementById(modalId));
    }
    applyTheme();
    await refreshBoard();
    await maybeAutoShowAbout();
}

browser.calendar.items.onCreated.addListener(refreshBoard);
browser.calendar.items.onUpdated.addListener(refreshBoard);
browser.calendar.items.onRemoved.addListener(refreshBoard);

init();
