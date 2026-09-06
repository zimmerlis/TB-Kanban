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

browser.action.onClicked.addListener(async (...args) => {
    openKanbanBoard();
 });
