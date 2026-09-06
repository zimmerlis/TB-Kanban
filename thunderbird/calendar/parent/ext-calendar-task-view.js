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

  const toggleRow = doc.createXULElement("hbox");
  toggleRow.id = TOGGLE_ID;
  toggleRow.setAttribute("align", "center");
  toggleRow.setAttribute("pack", "center");
  toggleRow.style.padding = "2px";

  const radiogroup = doc.createXULElement("radiogroup");
  radiogroup.setAttribute("orient", "horizontal");

  const standardRadio = doc.createXULElement("radio");
  standardRadio.id = "kanban-task-view-standard-radio";
  standardRadio.setAttribute("label", "Standard");
  standardRadio.setAttribute("value", STANDARD_VALUE);
  standardRadio.setAttribute("selected", "true");

  const kanbanRadio = doc.createXULElement("radio");
  kanbanRadio.id = "kanban-task-view-kanban-radio";
  kanbanRadio.setAttribute("label", "Kanban");
  kanbanRadio.setAttribute("value", KANBAN_VALUE);

  radiogroup.append(standardRadio, kanbanRadio);
  toggleRow.append(radiogroup);
  taskBox.prepend(toggleRow);

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

  radiogroup.addEventListener("command", () => {
    const showKanban = radiogroup.value === KANBAN_VALUE;
    panel.hidden = !showKanban;
    for (const nativePanel of nativePanels) {
      nativePanel.hidden = showKanban;
    }
  });
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

