/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { ExtensionCommon: { ExtensionAPI } } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionSupport } = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs");

const KANBAN_VALUE = "kanban";
const KANBAN_RADIO_ID = "kanban-task-filter-radio";
const KANBAN_PANEL_ID = "kanban-task-view-panel";

// Adds a "Kanban" entry to the native task pane's "Anzeigen"/display filter list (#task-tree-filtergroup),
// and shows our board in place of the native task list/details while it is selected.
function injectKanbanView(win, extension) {
  const doc = win.document;
  const filterGroup = doc.getElementById("task-tree-filtergroup");
  const taskBox = doc.getElementById("calendar-task-box");
  if (!filterGroup || !taskBox || doc.getElementById(KANBAN_RADIO_ID)) {
    return;
  }

  const radio = doc.createXULElement("radio");
  radio.id = KANBAN_RADIO_ID;
  radio.setAttribute("label", "Kanban");
  radio.setAttribute("value", KANBAN_VALUE);
  filterGroup.appendChild(radio);

  // Everything Thunderbird normally shows in the task pane (toolbar, tree, details) is hidden while ours is visible.
  const nativePanels = [...taskBox.children];

  const panel = doc.createXULElement("vbox");
  panel.id = KANBAN_PANEL_ID;
  panel.setAttribute("flex", "1");
  panel.hidden = true;

  const frame = doc.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
  frame.setAttribute("src", extension.getURL("ui/board.html"));
  frame.style.cssText = "width: 100%; height: 100%; border: none;";
  panel.appendChild(frame);
  taskBox.appendChild(panel);

  // Runs in the capturing phase so it can veto Thunderbird's own handler (bound in the bubbling phase),
  // since that one doesn't know what to do with our custom filter value.
  filterGroup.addEventListener(
    "command",
    event => {
      if (!event.target.matches("radio")) {
        return;
      }
      const showKanban = event.target.getAttribute("value") === KANBAN_VALUE;
      panel.hidden = !showKanban;
      for (const nativePanel of nativePanels) {
        nativePanel.hidden = showKanban;
      }
      if (showKanban) {
        event.stopImmediatePropagation();
      }
    },
    true
  );
}

function removeKanbanView(win) {
  const doc = win.document;
  doc.getElementById(KANBAN_RADIO_ID)?.remove();
  doc.getElementById(KANBAN_PANEL_ID)?.remove();
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

