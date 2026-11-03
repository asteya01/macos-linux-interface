// Menu Bar Stats
// Shows CPU, memory, temperature (and battery, if available) in the top bar.
// Click it for more detail.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const REFRESH_SECONDS = 2;
const decoder = new TextDecoder();

// ---------- small helpers for reading Linux system files ----------

// Read a text file and return its contents, or null if it can't be read.
function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes).trim() : null;
    } catch (e) {
        return null;
    }
}

// List the names of the entries inside a folder.
function listDir(path) {
    const names = [];
    try {
        const files = Gio.File.new_for_path(path).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = files.next_file(null)) !== null)
            names.push(info.get_name());
        files.close(null);
    } catch (e) {
        // Folder missing: just return an empty list.
    }
    return names;
}

// Find every temperature sensor the kernel exposes in /sys/class/hwmon.
function findTempSensors() {
    const sensors = [];
    for (const hw of listDir('/sys/class/hwmon')) {
        const dir = `/sys/class/hwmon/${hw}`;
        const chip = readText(`${dir}/name`) ?? hw;
        for (const file of listDir(dir)) {
            const match = file.match(/^temp(\d+)_input$/);
            if (!match)
                continue;
            const label = readText(`${dir}/temp${match[1]}_label`) ?? `temp${match[1]}`;
            sensors.push({path: `${dir}/${file}`, name: `${chip} ${label}`});
        }
    }
    // Prefer sensors that look like the CPU/chip; otherwise use all of them.
    const chipSensors = sensors.filter(s => /cpu|soc|die|core|pmu/i.test(s.name));
    return chipSensors.length ? chipSensors : sensors;
}

// Find a battery in /sys/class/power_supply, or null if there isn't one.
function findBattery() {
    for (const ps of listDir('/sys/class/power_supply')) {
        const dir = `/sys/class/power_supply/${ps}`;
        if (readText(`${dir}/type`) === 'Battery' && readText(`${dir}/capacity`) !== null)
            return dir;
    }
    return null;
}

// ---------- the extension ----------

export default class MenuBarStatsExtension extends Extension {
    enable() {
        this._button = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._label = new St.Label({
            text: '…',
            style_class: 'menubar-stats-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._button.add_child(this._label);
        this._button.connect('destroy', () => {
            this._button = null;
            this._label = null;
        });

        // Dropdown with details (not clickable, just information).
        const menu = this._button.menu;
        this._cpuItem = new PopupMenu.PopupMenuItem('CPU', {reactive: false});
        this._memItem = new PopupMenu.PopupMenuItem('Memory', {reactive: false});
        this._tempItem = new PopupMenu.PopupMenuItem('Temperature', {reactive: false});
        this._batItem = new PopupMenu.PopupMenuItem('Battery', {reactive: false});
        for (const item of [this._cpuItem, this._memItem, this._tempItem, this._batItem])
            menu.addMenuItem(item);

        // Right side of the top bar, before the Wi-Fi/volume icons.
        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'right');

        // Look for sensors once at startup.
        this._prevCpu = null;
        this._tempSensors = findTempSensors();
        this._batteryDir = findBattery();

        this._refresh();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // CPU usage = how much of the time since the last check was NOT idle.
    _readCpu() {
        const line = readText('/proc/stat')?.split('\n')[0];
        if (!line)
            return null;
        const v = line.trim().split(/\s+/).slice(1, 9).map(Number);
        const idle = v[3] + v[4];                  // idle + waiting for disk
        const total = v.reduce((a, b) => a + b, 0);
        const prev = this._prevCpu;
        this._prevCpu = {idle, total};
        if (!prev || total === prev.total)
            return null;                           // need two readings to compare
        return Math.round(100 * (1 - (idle - prev.idle) / (total - prev.total)));
    }

    _readMemory() {
        const text = readText('/proc/meminfo');
        if (!text)
            return null;
        const get = key => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
        const total = get('MemTotal');            // in kB
        const used = total - get('MemAvailable');
        if (!total)
            return null;
        return {
            percent: Math.round(100 * used / total),
            usedGB: used / 1048576,
            totalGB: total / 1048576,
        };
    }

    // Report the hottest sensor.
    _readTemperature() {
        let hottest = null;
        for (const sensor of this._tempSensors) {
            const celsius = Number(readText(sensor.path)) / 1000;
            if (!(celsius > 0 && celsius < 125))
                continue;                          // skip broken or missing readings
            if (!hottest || celsius > hottest.celsius)
                hottest = {celsius, name: sensor.name};
        }
        return hottest;
    }

    _readBattery() {
        if (!this._batteryDir)
            return null;
        const percent = Number(readText(`${this._batteryDir}/capacity`));
        if (!Number.isFinite(percent))
            return null;
        return {percent, status: readText(`${this._batteryDir}/status`) ?? 'Unknown'};
    }

    _refresh() {
        if (!this._label)
            return;

        const cpu = this._readCpu();
        const mem = this._readMemory();
        const temp = this._readTemperature();
        const bat = this._readBattery();

        // Short version for the top bar.
        const parts = [`CPU ${cpu ?? '–'}%`];
        if (mem)
            parts.push(`MEM ${mem.percent}%`);
        if (temp)
            parts.push(`${Math.round(temp.celsius)}°C`);
        if (bat)
            parts.push(`BAT ${bat.percent}%${bat.status === 'Charging' ? ' ⚡' : ''}`);
        this._label.text = parts.join('   ');

        // Detailed version for the dropdown.
        this._cpuItem.label.text = `CPU usage: ${cpu ?? '–'}%`;
        this._memItem.label.text = mem
            ? `Memory: ${mem.usedGB.toFixed(1)} GB of ${mem.totalGB.toFixed(1)} GB`
            : 'Memory: unavailable';
        this._tempItem.label.text = temp
            ? `Hottest sensor: ${temp.celsius.toFixed(1)}°C (${temp.name})`
            : 'Temperature: no sensors found';
        this._batItem.label.text = bat
            ? `Battery: ${bat.percent}% (${bat.status})`
            : 'Battery: not available';
    }

    disable() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        this._button?.destroy();
        this._button = null;
        this._label = null;
        this._cpuItem = this._memItem = this._tempItem = this._batItem = null;
        this._tempSensors = null;
        this._batteryDir = null;
        this._prevCpu = null;
    }
}
