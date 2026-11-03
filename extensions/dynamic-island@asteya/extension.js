// Dynamic Island
// An iPhone-style black pill at the top center of the screen.
//  - Idle: a small pill, like a notch.
//  - Music playing: wider, with album art and dancing equalizer bars.
//  - Hover: springs open into a mini player (title, artist, prev/play/next).
//  - New song: pops open by itself for a few seconds.
// Music info comes from MPRIS, the standard Linux media-control system that
// Spotify, Chrome, Brave, Firefox and most players support.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ================= settings you can change =================
const IDLE_WIDTH = 140;          // pill width when nothing is playing
const MEDIA_WIDTH = 240;         // pill width while music plays
const EXPANDED_WIDTH = 420;      // mini player size
const EXPANDED_HEIGHT = 124;
const TOP_GAP = 2;               // gap above the pill
const PEEK_SECONDS = 3;          // how long it pops open on a new song
const BAR_COLOR_PLAYING = true;  // dancing bars while playing
// ===========================================================

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const VERTICAL = Clutter.Orientation.VERTICAL;

export default class DynamicIslandExtension extends Extension {
    enable() {
        this._players = new Map();      // bus name -> {proxy, signalId, lastChange}
        this._timers = new Set();
        this._cancellable = new Gio.Cancellable();
        this._session = new Soup.Session({timeout: 20});
        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'dynamic-island']);
        GLib.mkdir_with_parents(this._cacheDir, 0o755);

        this._state = 'idle';           // idle | media | expanded
        this._current = null;           // info about the song showing now
        this._trackKey = null;
        this._artUrl = null;
        this._peeking = false;

        this._buildUi();
        this._watchPlayers();
    }

    // ===================================================================
    //  User interface
    // ===================================================================
    _buildUi() {
        this._compactHeight = Math.max(22, Main.panel.height - TOP_GAP * 2);

        this._island = new St.Widget({
            style_class: 'di-island',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            width: IDLE_WIDTH,
            height: this._compactHeight,
        });

        // ---- compact content: small art on the left, bars on the right ----
        this._compact = new St.BoxLayout({style_class: 'di-compact', x_expand: true, y_expand: true});
        this._artSmall = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._compact.add_child(this._artSmall);
        this._compact.add_child(new St.Widget({x_expand: true}));   // spacer
        this._bars = new St.BoxLayout({style_class: 'di-bars', y_align: Clutter.ActorAlign.CENTER});
        this._barList = [];
        for (let i = 0; i < 4; i++) {
            const bar = new St.Widget({style_class: 'di-bar', height: 3, y_align: Clutter.ActorAlign.CENTER});
            this._bars.add_child(bar);
            this._barList.push(bar);
        }
        this._compact.add_child(this._bars);

        // ---- expanded content: big art, title/artist, controls ----
        this._expanded = new St.BoxLayout({style_class: 'di-expanded', x_expand: true, y_expand: true, visible: false});
        this._artBig = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 84,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._expanded.add_child(this._artBig);

        const info = new St.BoxLayout({orientation: VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = new St.Label({style_class: 'di-title', text: ''});
        this._artist = new St.Label({style_class: 'di-artist', text: ''});
        for (const l of [this._title, this._artist])
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        info.add_child(this._title);
        info.add_child(this._artist);

        const controls = new St.BoxLayout({style_class: 'di-controls'});
        this._prevBtn = this._makeButton('media-skip-backward-symbolic', 'Previous');
        this._playBtn = this._makeButton('media-playback-start-symbolic', 'PlayPause');
        this._nextBtn = this._makeButton('media-skip-forward-symbolic', 'Next');
        for (const b of [this._prevBtn, this._playBtn, this._nextBtn])
            controls.add_child(b);
        info.add_child(controls);
        this._expanded.add_child(info);

        this._island.add_child(this._compact);
        this._island.add_child(this._expanded);

        // Above windows and the top bar (added after it, so it sits on top);
        // hidden when an app is fullscreen.
        // No options: GNOME 50 rejects the older option names, and the
        // defaults already let the island receive the mouse.
        Main.layoutManager.addChrome(this._island);

        // Keep it centered while it grows and shrinks.
        this._island.connect('notify::width', () => this._place());
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._place());
        this._island.connect('notify::hover', () => this._onHover());

        this._applyShape('idle');
        this._place();
        this._showCompactContent(false);
    }

    _makeButton(iconName, method) {
        const button = new St.Button({
            style_class: 'di-control',
            can_focus: false,
            child: new St.Icon({icon_name: iconName, icon_size: 22}),
        });
        button.connect('clicked', () => this._callPlayer(method));
        return button;
    }

    _place() {
        if (!this._island)
            return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        this._island.set_position(
            Math.round(mon.x + (mon.width - this._island.width) / 2),
            mon.y + TOP_GAP);
    }

    // Rounded corners + shadow for each shape.
    _applyShape(state) {
        const radius = state === 'expanded' ? 34 : Math.floor(this._compactHeight / 2);
        const shadow = state === 'expanded' ? 'box-shadow: 0 10px 30px rgba(0,0,0,0.55);' : '';
        this._island.set_style(`border-radius: ${radius}px; ${shadow}`);
    }

    _showCompactContent(hasMedia) {
        this._artSmall.visible = hasMedia;
        this._bars.visible = hasMedia;
    }

    // Move between idle / media / expanded with a springy animation.
    _setState(state) {
        if (!this._island || state === this._state)
            return;
        const wasExpanded = this._state === 'expanded';
        this._state = state;

        let width = IDLE_WIDTH, height = this._compactHeight;
        if (state === 'media')
            width = MEDIA_WIDTH;
        if (state === 'expanded') {
            width = EXPANDED_WIDTH;
            height = EXPANDED_HEIGHT;
        }

        if (state === 'expanded') {
            // Grow first, then fade the player in.
            this._compact.visible = false;
            this._applyShape('expanded');
            this._expanded.opacity = 0;
            this._expanded.visible = true;
            this._island.remove_all_transitions();
            this._island.ease({
                width, height,
                duration: 380,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
            this._expanded.ease({opacity: 255, duration: 220, delay: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            // Hide the player, shrink, then show the compact content.
            this._expanded.remove_all_transitions();
            this._expanded.visible = false;
            this._compact.visible = true;
            this._compact.opacity = wasExpanded ? 0 : 255;
            this._showCompactContent(state === 'media');
            this._island.remove_all_transitions();
            this._island.ease({
                width, height,
                duration: wasExpanded ? 320 : 260,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (this._island)
                        this._applyShape(this._state);
                },
            });
            if (wasExpanded)
                this._compact.ease({opacity: 255, duration: 200, delay: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    _restingState() {
        return this._current ? 'media' : 'idle';
    }

    // ---------- hover and "peek" on new songs ----------
    _onHover() {
        if (!this._island)
            return;
        this._clearTimer('collapse');
        if (this._island.hover) {
            if (this._current)
                this._setState('expanded');
        } else if (!this._peeking) {
            this._addTimer('collapse', 450, () => this._setState(this._restingState()));
        }
    }

    _peek() {
        this._peeking = true;
        this._setState('expanded');
        this._clearTimer('peek');
        this._addTimer('peek', PEEK_SECONDS * 1000, () => {
            this._peeking = false;
            if (this._island && !this._island.hover)
                this._setState(this._restingState());
        });
    }

    // ---------- equalizer bars ----------
    _setBarsDancing(dancing) {
        if (dancing && BAR_COLOR_PLAYING) {
            if (this._timerIds?.bars)
                return;
            this._addTimer('bars', 300, () => {
                for (const bar of this._barList)
                    bar.ease({height: 4 + Math.round(Math.random() * 10), duration: 280, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD});
                return GLib.SOURCE_CONTINUE;
            }, true);
        } else {
            this._clearTimer('bars');
            for (const bar of this._barList ?? [])
                bar.ease({height: 3, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    // ---------- timer helpers ----------
    _addTimer(name, ms, fn, repeat = false) {
        this._timerIds ??= {};
        this._clearTimer(name);
        this._timerIds[name] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            const result = fn();
            if (repeat && result === GLib.SOURCE_CONTINUE)
                return GLib.SOURCE_CONTINUE;
            delete this._timerIds[name];
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimer(name) {
        const id = this._timerIds?.[name];
        if (id) {
            GLib.Source.remove(id);
            delete this._timerIds[name];
        }
    }

    // ===================================================================
    //  Music players (MPRIS over D-Bus)
    // ===================================================================
    _watchPlayers() {
        // Players that are already running...
        Gio.DBus.session.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    for (const name of names) {
                        if (name.startsWith(MPRIS_PREFIX))
                            this._addPlayer(name);
                    }
                } catch (e) {
                    this._logError('list players', e);
                }
            });

        // ...and ones that start or quit later.
        this._nameSub = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus',
            null, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (newOwner && !oldOwner)
                    this._addPlayer(name);
                else if (!newOwner)
                    this._removePlayer(name);
            });
    }

    _addPlayer(name) {
        if (!this._players || this._players.has(name))
            return;
        const entry = {proxy: null, signalId: 0, lastChange: Date.now()};
        this._players.set(name, entry);

        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
            name, MPRIS_PATH, PLAYER_IFACE, this._cancellable,
            (_src, res) => {
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(res);
                    if (this._players?.get(name) !== entry)
                        return;
                    entry.proxy = proxy;
                    entry.signalId = proxy.connect('g-properties-changed', () => {
                        entry.lastChange = Date.now();
                        this._refresh();
                    });
                    this._refresh();
                } catch (e) {
                    this._logError(`connect to ${name}`, e);
                }
            });
    }

    _removePlayer(name) {
        const entry = this._players?.get(name);
        if (!entry)
            return;
        if (entry.proxy && entry.signalId)
            entry.proxy.disconnect(entry.signalId);
        this._players.delete(name);
        this._refresh();
    }

    _readPlayer(proxy) {
        const status = proxy.get_cached_property('PlaybackStatus')?.unpack() ?? 'Stopped';
        const meta = proxy.get_cached_property('Metadata')?.recursiveUnpack() ?? {};
        let artist = meta['xesam:artist'] ?? '';
        if (Array.isArray(artist))
            artist = artist.join(', ');
        return {
            status,
            title: meta['xesam:title'] ?? '',
            artist,
            artUrl: meta['mpris:artUrl'] ?? '',
        };
    }

    // Pick what to show: the player that's playing (most recent first),
    // otherwise the most recently paused one.
    _pickPlayer() {
        let best = null;
        for (const [name, entry] of this._players) {
            if (!entry.proxy)
                continue;
            const info = this._readPlayer(entry.proxy);
            if (info.status === 'Stopped' || !info.title)
                continue;
            const score = (info.status === 'Playing' ? 1e15 : 0) + entry.lastChange;
            if (!best || score > best.score)
                best = {name, proxy: entry.proxy, info, score};
        }
        return best;
    }

    _refresh() {
        if (!this._island)
            return;
        const picked = this._pickPlayer();
        this._current = picked;

        if (!picked) {
            this._trackKey = null;
            this._setBarsDancing(false);
            if (this._state !== 'expanded' || !this._island.hover)
                this._setState('idle');
            return;
        }

        const {info} = picked;
        const playing = info.status === 'Playing';
        this._title.text = info.title;
        this._artist.text = info.artist;
        this._playBtn.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._setArt(info.artUrl);
        this._setBarsDancing(playing);

        const key = `${picked.name}|${info.title}|${info.artist}`;
        const newSong = key !== this._trackKey;
        this._trackKey = key;

        if (newSong && playing)
            this._peek();
        else if (this._state === 'idle')
            this._setState('media');
    }

    _callPlayer(method) {
        this._current?.proxy.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    // ---------- album art ----------
    _setArt(url) {
        if (url === this._artUrl)
            return;
        this._artUrl = url;

        if (!url) {
            this._applyArt(null);
            return;
        }
        if (url.startsWith('file://')) {
            this._applyArt(Gio.File.new_for_uri(url));
            return;
        }
        if (!url.startsWith('http'))
            return;

        // Download web images once and keep them in ~/.cache/dynamic-island
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, url, -1);
        const file = Gio.File.new_for_path(GLib.build_filenamev([this._cacheDir, `${hash}.img`]));
        if (file.query_exists(null)) {
            this._applyArt(file);
            return;
        }
        const message = Soup.Message.new('GET', url);
        if (!message)
            return;
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                if (message.get_status() !== Soup.Status.OK)
                    return;
                file.replace_contents(bytes.get_data(), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                if (this._artUrl === url)
                    this._applyArt(file);
            } catch (e) {
                this._logError('album art', e);
            }
        });
    }

    _applyArt(file) {
        if (!this._artSmall)
            return;
        for (const icon of [this._artSmall, this._artBig]) {
            if (file)
                icon.gicon = new Gio.FileIcon({file});
            else
                icon.icon_name = 'audio-x-generic-symbolic';
        }
    }

    _logError(what, e) {
        if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;
        console.log(`Dynamic Island: ${what} failed: ${e?.message ?? e}`);
    }

    // ===================================================================
    disable() {
        for (const name of Object.keys(this._timerIds ?? {}))
            this._clearTimer(name);
        this._timerIds = null;

        this._cancellable?.cancel();
        this._cancellable = null;
        this._session?.abort();
        this._session = null;

        if (this._nameSub) {
            Gio.DBus.session.signal_unsubscribe(this._nameSub);
            this._nameSub = null;
        }
        for (const entry of this._players?.values() ?? []) {
            if (entry.proxy && entry.signalId)
                entry.proxy.disconnect(entry.signalId);
        }
        this._players = null;

        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = null;
        }

        if (this._island) {
            Main.layoutManager.removeChrome(this._island);
            this._island.destroy();
        }
        this._island = this._compact = this._expanded = null;
        this._artSmall = this._artBig = this._title = this._artist = null;
        this._prevBtn = this._playBtn = this._nextBtn = null;
        this._bars = this._barList = null;
        this._current = this._trackKey = this._artUrl = null;
    }
}
