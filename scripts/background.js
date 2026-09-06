let kanbanContext = await browser.contextualIdentities.create({
    "name": "tbkanban",
    "color": "blue",
    "icon": "tree"
});

// Adds a dedicated icon to Thunderbird's Spaces Toolbar; Thunderbird then takes care of
// opening/reusing/switching to its tab on its own (see browser.spaces.open()).
let kanbanSpace = await browser.spaces.create(
    "kanban",
    {
        "url": "ui/board.html",
        "cookieStoreId": kanbanContext.cookieStoreId,
    },
    {
        "title": browser.i18n.getMessage("extensionName"),
        "defaultIcons": {
            "16": "images/tb-kanban_16x16.png",
            "32": "images/tb-kanban_32x32.png"
        }
    }
);

async function openKanbanBoard() {
    await browser.spaces.open(kanbanSpace.id);
}

let kanbanMenuItem = await browser.menus.create({
        "id" : "kanbanMenuItem",
        "title": browser.i18n.getMessage("menuItem"),
        "contexts": ["tools_menu"],
        "visible": true,
        "icons": {
            "16": "images/tb-kanban_16x16.png",
            "32": "images/tb-kanban_32x32.png"
        }
    }
);


if (kanbanMenuItem === null) {
    console.log(browser.runtime.lastError);

};

browser.menus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === kanbanMenuItem) {
        openKanbanBoard();
    }
});

// Resets the daily about/donate prompt on a genuine fresh install (not on updates/reloads), so
// it always shows once even when testing repeated installs on the same day.
browser.runtime.onInstalled.addListener(details => {
    if (details.reason === 'install') {
        browser.storage.local.remove('aboutPromptState');
    }
});

// Also shows it again on every Thunderbird restart, not just once per calendar day: clears
// only "last shown" (keeps the "I've donated" opt-out, set via the about dialog's checkbox).
browser.runtime.onStartup.addListener(async () => {
    const stored = await browser.storage.local.get('aboutPromptState');
    const state = stored.aboutPromptState ?? {};
    delete state.lastShownDate;
    await browser.storage.local.set({ aboutPromptState: state });
});

browser.action.onClicked.addListener(async (...args) => {
    openKanbanBoard();
 });
