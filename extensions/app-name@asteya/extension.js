// App Name in Top Bar (v4)
// Shows the focused app's name next to the Apple logo, like macOS.
// Click it for a menu with New Window, Hide and Quit.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// What to show when no window is focused (macOS shows "Finder" here).
const DESKTOP_NAME = 'Finder';

export default class AppNameExtension extends Extension {
    enable() {
        // A top-bar button WITH a dropdown menu this time.
        this._button = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._label = new St.Label({
            text: '',
            style_class: 'app-name-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._button.add_child(this._label);

        // If GNOME destroys the button (e.g. while logging out), forget it,
        // so we never touch a label that no longer exists.
        this._button.connect('destroy', () => {
            this._button = null;
            this._label = null;
        });

        // Left side of the top bar, right after the logo.
        Main.panel.addToStatusArea(this.uuid, this._button, 1, 'left');

        this._tracker = Shell.WindowTracker.get_default();
        this._app = null;

        // Update whenever focus changes or the overview opens/closes.
        this._signals = [
            [global.display, global.display.connect('notify::focus-window', () => this._update())],
            [this._tracker, this._tracker.connect('notify::focus-app', () => this._update())],
            [Main.overview, Main.overview.connect('showing', () => this._update())],
            [Main.overview, Main.overview.connect('hidden', () => this._update())],
        ];

        this._update();
    }

    _update() {
        if (!this._label)
            return;

        const win = global.display.focus_window;
        let app = null;
        let name = null;

        // Background helpers (desktop icons, video wallpaper) run as "gjs"
        // windows. Treat them like the desktop, so the bar says "Finder".
        const isBackground = win && (
            win.get_window_type() === Meta.WindowType.DESKTOP ||
            win.skip_taskbar ||
            (win.get_wm_class() ?? '').toLowerCase() === 'gjs');

        if (win && !isBackground && !Main.overview.visible) {
            app = this._tracker.get_window_app(win);
            name = app?.get_name() ?? win.get_wm_class();
            if (name?.toLowerCase() === 'gjs') {
                app = null;
                name = null;
            }
        }

        this._app = app;
        this._label.text = name || DESKTOP_NAME;

        // Rebuild the menu now. GNOME won't open an empty menu,
        // so it has to be filled in before you click.
        this._buildMenu();
    }

    _addItem(text, onClick, enabled = true) {
        const item = new PopupMenu.PopupMenuItem(text);
        item.connect('activate', onClick);
        item.setSensitive(enabled);
        this._button.menu.addMenuItem(item);
    }

    _buildMenu() {
        if (!this._button)
            return;
        const menu = this._button.menu;
        menu.removeAll();

        const app = this._app;
        const name = app?.get_name() ?? DESKTOP_NAME;

        if (!app) {
            // Nothing focused: show the items, but greyed out.
            this._addItem('New Window', () => {}, false);
            this._addItem(`Hide ${name}`, () => {}, false);
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._addItem(`Quit ${name}`, () => {}, false);
            return;
        }

        // New Window: ask the app to open another window on this workspace.
        this._addItem('New Window', () => {
            app.open_new_window(-1);
        }, app.can_open_new_window());

        // Hide: minimize every window this app has open (macOS-style hide).
        this._addItem(`Hide ${name}`, () => {
            for (const w of app.get_windows())
                w.minimize();
        });

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Quit: politely ask the app to close (it can still ask to save files).
        this._addItem(`Quit ${name}`, () => {
            app.request_quit();
        });
    }

    disable() {
        for (const [obj, id] of this._signals ?? [])
            obj.disconnect(id);
        this._signals = null;

        this._button?.destroy();
        this._button = null;
        this._label = null;
        this._tracker = null;
        this._app = null;
    }
}
