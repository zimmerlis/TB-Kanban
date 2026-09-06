/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { ExtensionCommon: { ExtensionAPI } } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");

const KANBAN_VALUE = "kanban";
const STANDARD_VALUE = "standard";
const TOGGLE_ID = "kanban-task-view-toggle";
const PANEL_ID = "kanban-task-view-panel";

// Adds a "Standard"/"Kanban" view switch above the task pane's search/add-task bar
// (#task-addition-box), showing our board in place of the native list+details while selected.
async function injectKanbanView(win, extension) {
  const doc = win.document;
  const taskBox = doc.getElementById("calendar-task-box");
  if (!taskBox || doc.getElementById(TOGGLE_ID)) {
    return;
  }

  const { setupE10sBrowser } = ChromeUtils.importESModule("resource://kanban-thunderbird-calendar/thunderbird/calendar/ext-calendar-utils.sys.mjs");

  // Everything Thunderbird normally shows in the task pane (notifications, search/add-task bar,
  // tree + details) is hidden while our board is visible.
  const nativePanels = [...taskBox.children];

  const toggleBar = doc.createXULElement("hbox");
  toggleBar.id = TOGGLE_ID;
  toggleBar.setAttribute("align", "center");
  toggleBar.setAttribute("pack", "start");
  toggleBar.style.cssText = "background-color: light-dark(#e9ecef, #38383b); padding: 4px 6px;";

  // Reuses Thunderbird's own "calview-toggle" tab styling (see the Day/Week/Month/Multiweek
  // switcher), instead of inventing custom CSS, so it fits right in.
  const tablist = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  tablist.setAttribute("role", "tablist");
  tablist.className = "calview-toggle";

  function makeTab(value, label, selected) {
    const button = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
    button.className = "calview-toggle-item";
    button.setAttribute("role", "tab");
    button.setAttribute("value", value);
    button.setAttribute("aria-selected", String(selected));
    button.textContent = label;
    return button;
  }

  const standardTab = makeTab(STANDARD_VALUE, "Standard", true);
  const kanbanTab = makeTab(KANBAN_VALUE, "Kanban", false);
  tablist.append(standardTab, kanbanTab);
  toggleBar.append(tablist);
  taskBox.prepend(toggleBar);

  const panel = doc.createXULElement("vbox");
  panel.id = PANEL_ID;
  panel.setAttribute("flex", "1");
  panel.hidden = true;
  taskBox.append(panel);

  // A plain html:iframe can't load a moz-extension:// page inside this privileged chrome document;
  // a XUL <browser> set up the same way WebExtension popups are (see ext-calendarItemDetails.js) can.
  const browserElement = doc.createXULElement("browser");
  browserElement.setAttribute("flex", "1");
  await setupE10sBrowser(extension, browserElement, panel, { maxWidth: null, maxHeight: null });
  browserElement.fixupAndLoadURIString(extension.getURL("ui/board.html"), { triggeringPrincipal: extension.principal });

  function selectTab(value) {
    const showKanban = value === KANBAN_VALUE;
    standardTab.setAttribute("aria-selected", String(!showKanban));
    kanbanTab.setAttribute("aria-selected", String(showKanban));
    panel.hidden = !showKanban;
    for (const nativePanel of nativePanels) {
      nativePanel.hidden = showKanban;
    }
  }

  standardTab.addEventListener("click", () => selectTab(STANDARD_VALUE));
  kanbanTab.addEventListener("click", () => selectTab(KANBAN_VALUE));
}


function removeKanbanView(win) {
  const doc = win.document;
  doc.getElementById(TOGGLE_ID)?.remove();
  doc.getElementById(PANEL_ID)?.remove();
}


this.calendarTaskView = class extends ExtensionAPI {
  onStartup() {
    const { extension } = this;
    this.listenerId = `ext-calendar-task-view-${extension.id}`;

    ExtensionSupport.registerWindowListener(this.listenerId, {
      chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
      onLoadWindow: win => injectKanbanView(win, extension),
      onUnloadWindow: removeKanbanView,
    });
  }

  onShutdown() {
    ExtensionSupport.unregisterWindowListener(this.listenerId);
    for (const win of Services.wm.getEnumerator("mail:3pane")) {
      removeKanbanView(win);
    }
  }
};

