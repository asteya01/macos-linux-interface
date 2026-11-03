// Desktop Widgets (v2)
// A big clock and date, plus Weather, Calendar and System cards, drawn on
// the wallpaper behind all windows, like macOS Sonoma desktop widgets.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ================= settings you can change =================
const OFFSET_X = 80;          // distance from the left edge of the screen
const OFFSET_Y = 70;          // distance from the top edge of the screen
const USE_24_HOUR = false;

// Weather location. Find yours by searching "<your city> coordinates".
const CITY_NAME = 'Cupertino';
const LATITUDE = 37.323;
const LONGITUDE = -122.032;
const FAHRENHEIT = true;      // false for Celsius
const WEATHER_REFRESH_MINUTES = 15;
// ===========================================================

const VERTICAL = Clutter.Orientation.VERTICAL;
const BAR_WIDTH = 136;        // matches .dw-small width
const decoder = new TextDecoder();

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes).trim() : null;
    } catch (e) {
        return null;
    }
}

// Open-Meteo weather codes -> [description, day icon, night icon]
function describeWeather(code) {
    if (code === 0) return ['Clear', 'weather-clear-symbolic', 'weather-clear-night-symbolic'];
    if (code <= 2) return ['Partly Cloudy', 'weather-few-clouds-symbolic', 'weather-few-clouds-night-symbolic'];
    if (code === 3) return ['Cloudy', 'weather-overcast-symbolic', 'weather-overcast-symbolic'];
    if (code <= 48) return ['Fog', 'weather-fog-symbolic', 'weather-fog-symbolic'];
    if (code <= 57) return ['Drizzle', 'weather-showers-scattered-symbolic', 'weather-showers-scattered-symbolic'];
    if (code <= 67) return ['Rain', 'weather-showers-symbolic', 'weather-showers-symbolic'];
    if (code <= 77) return ['Snow', 'weather-snow-symbolic', 'weather-snow-symbolic'];
    if (code <= 82) return ['Showers', 'weather-showers-symbolic', 'weather-showers-symbolic'];
    if (code <= 86) return ['Snow Showers', 'weather-snow-symbolic', 'weather-snow-symbolic'];
    return ['Thunderstorm', 'weather-storm-symbolic', 'weather-storm-symbolic'];
}

function label(text, styleClass) {
    return new St.Label({text, style_class: styleClass});
}

export default class DesktopWidgetsExtension extends Extension {
    enable() {
        this._prevCpu = null;
        this._calendarDay = null;
        this._session = new Soup.Session({timeout: 20});
        this._cancellable = new Gio.Cancellable();

        // ---------- layout ----------
        this._root = new St.BoxLayout({style_class: 'dw-root', orientation: VERTICAL});

        this._date = label('', 'dw-date');
        this._clock = label('', 'dw-clock');
        this._root.add_child(this._date);
        this._root.add_child(this._clock);

        const cards = new St.BoxLayout({style_class: 'dw-cards', orientation: VERTICAL});
        cards.add_child(this._buildWeatherCard());
        const row = new St.BoxLayout({style_class: 'dw-cards-row'});
        row.add_child(this._buildCalendarCard());
        row.add_child(this._buildSystemCard());
        cards.add_child(row);
        this._root.add_child(cards);

        // ---------- put it on the wallpaper layer ----------
        this._bgGroup = Main.layoutManager._backgroundGroup;
        this._bgGroup.add_child(this._root);
        this._bgChildId = this._bgGroup.connect('child-added', () => this._raise());
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._place());
        this._place();

        // ---------- timers ----------
        this._tick();
        this._updateStats();
        this._fetchWeather();
        this._timers = [
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            }),
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                this._updateStats();
                return GLib.SOURCE_CONTINUE;
            }),
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, WEATHER_REFRESH_MINUTES * 60, () => {
                this._fetchWeather();
                return GLib.SOURCE_CONTINUE;
            }),
        ];
    }

    // ===================== Weather card =====================
    _buildWeatherCard() {
        const card = new St.BoxLayout({style_class: 'dw-card dw-wide', orientation: VERTICAL});

        const top = new St.BoxLayout({style_class: 'dw-w-top'});
        const left = new St.BoxLayout({orientation: VERTICAL, x_expand: true});
        left.add_child(label(CITY_NAME, 'dw-w-city'));
        this._wTemp = label('--°', 'dw-w-temp');
        left.add_child(this._wTemp);
        top.add_child(left);

        const right = new St.BoxLayout({orientation: VERTICAL, y_align: Clutter.ActorAlign.CENTER});
        this._wIcon = new St.Icon({
            icon_name: 'weather-few-clouds-symbolic',
            icon_size: 40,
            style_class: 'dw-w-icon',
            x_align: Clutter.ActorAlign.END,
        });
        this._wDesc = label('Loading…', 'dw-w-desc');
        this._wHiLo = label('', 'dw-w-hilo');
        this._wDesc.x_align = this._wHiLo.x_align = Clutter.ActorAlign.END;
        right.add_child(this._wIcon);
        right.add_child(this._wDesc);
        right.add_child(this._wHiLo);
        top.add_child(right);
        card.add_child(top);

        // 5-day forecast row
        const forecast = new St.BoxLayout({style_class: 'dw-forecast'});
        this._fc = [];
        for (let i = 0; i < 5; i++) {
            const col = new St.BoxLayout({style_class: 'dw-fc-col', orientation: VERTICAL});
            const day = label('—', 'dw-fc-day');
            const icon = new St.Icon({icon_name: 'weather-few-clouds-symbolic', icon_size: 18, style_class: 'dw-w-icon'});
            const temp = label('', 'dw-fc-temp');
            for (const a of [day, icon, temp]) {
                a.x_align = Clutter.ActorAlign.CENTER;
                col.add_child(a);
            }
            forecast.add_child(col);
            this._fc.push({day, icon, temp});
        }
        card.add_child(forecast);
        return card;
    }

    _fetchWeather() {
        const unit = FAHRENHEIT ? 'fahrenheit' : 'celsius';
        const url = 'https://api.open-meteo.com/v1/forecast' +
            `?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
            '&current=temperature_2m,weather_code,is_day' +
            '&daily=weather_code,temperature_2m_max,temperature_2m_min' +
            `&temperature_unit=${unit}&timezone=auto&forecast_days=5`;

        const message = Soup.Message.new('GET', url);
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                if (message.get_status() !== Soup.Status.OK)
                    throw new Error(`HTTP ${message.get_status()}`);
                this._showWeather(JSON.parse(decoder.decode(bytes.get_data())));
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;    // extension was turned off
                if (this._wDesc)
                    this._wDesc.text = 'Offline';
                console.log(`Desktop Widgets: weather failed: ${e.message}`);
            }
        });
    }

    _setWeatherIcon(icon, code, isDay) {
        const [, dayIcon, nightIcon] = describeWeather(code);
        icon.icon_name = isDay ? dayIcon : nightIcon;
        // Sunny icons in yellow, everything else white.
        icon.style_class = isDay && code <= 2 ? 'dw-w-icon dw-w-sun' : 'dw-w-icon';
    }

    _showWeather(data) {
        if (!this._wTemp)
            return;
        const cur = data.current;
        const daily = data.daily;

        this._wTemp.text = `${Math.round(cur.temperature_2m)}°`;
        this._wDesc.text = describeWeather(cur.weather_code)[0];
        this._wHiLo.text = `H:${Math.round(daily.temperature_2m_max[0])}°  L:${Math.round(daily.temperature_2m_min[0])}°`;
        this._setWeatherIcon(this._wIcon, cur.weather_code, cur.is_day === 1);

        daily.time.slice(0, 5).forEach((dateStr, i) => {
            const [y, m, d] = dateStr.split('-').map(Number);
            const date = GLib.DateTime.new_local(y, m, d, 12, 0, 0);
            this._fc[i].day.text = i === 0 ? 'Today' : date.format('%a');
            this._setWeatherIcon(this._fc[i].icon, daily.weather_code[i], true);
            this._fc[i].temp.text = `${Math.round(daily.temperature_2m_max[i])}°`;
        });
    }

    // ===================== Calendar card =====================
    _buildCalendarCard() {
        const card = new St.BoxLayout({style_class: 'dw-card dw-small', orientation: VERTICAL});
        this._calMonth = label('', 'dw-cal-month');
        this._calGrid = new St.BoxLayout({style_class: 'dw-cal-grid', orientation: VERTICAL});
        card.add_child(this._calMonth);
        card.add_child(this._calGrid);
        return card;
    }

    _buildCalendar(now) {
        this._calMonth.text = now.format('%B').toUpperCase();
        this._calGrid.destroy_all_children();

        const addRow = cells => {
            const row = new St.BoxLayout({style_class: 'dw-cal-row'});
            for (const cell of cells)
                row.add_child(cell);
            this._calGrid.add_child(row);
        };

        // Header: S M T W T F S
        addRow(['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(t => label(t, 'dw-cal-cell dw-cal-head')));

        const year = now.get_year();
        const month = now.get_month();
        const today = now.get_day_of_month();
        const first = GLib.DateTime.new_local(year, month, 1, 12, 0, 0);
        const startCol = first.get_day_of_week() % 7;   // GLib: Mon=1..Sun=7 -> Sun=0
        const daysInMonth = GLib.Date.get_days_in_month(month, year);

        let cells = [];
        for (let i = 0; i < startCol; i++)
            cells.push(label('', 'dw-cal-cell'));
        for (let d = 1; d <= daysInMonth; d++) {
            const col = cells.length;
            let style = 'dw-cal-cell';
            if (d === today)
                style += ' dw-cal-today';
            else if (col === 0 || col === 6)
                style += ' dw-cal-weekend';
            cells.push(label(String(d), style));
            if (cells.length === 7) {
                addRow(cells);
                cells = [];
            }
        }
        if (cells.length) {
            while (cells.length < 7)
                cells.push(label('', 'dw-cal-cell'));
            addRow(cells);
        }
    }

    // ===================== System card =====================
    _buildSystemCard() {
        const card = new St.BoxLayout({style_class: 'dw-card dw-small', orientation: VERTICAL});
        card.add_child(label('SYSTEM', 'dw-card-title'));
        [this._cpuLabel, this._cpuSub, this._cpuFill] = this._addBarRow(card, 'dw-bar-cpu');
        [this._memLabel, this._memSub, this._memFill] = this._addBarRow(card, 'dw-bar-mem');
        return card;
    }

    _addBarRow(card, fillClass) {
        const row = new St.BoxLayout({style_class: 'dw-row', orientation: VERTICAL});
        const main = label('…', 'dw-row-label');
        const sub = label('', 'dw-row-sub');
        const bg = new St.Widget({style_class: 'dw-bar-bg', width: BAR_WIDTH});
        const fill = new St.Widget({style_class: fillClass, width: 0});
        bg.add_child(fill);
        row.add_child(main);
        row.add_child(bg);
        row.add_child(sub);
        card.add_child(row);
        return [main, sub, fill];
    }

    _readCpu() {
        const line = readText('/proc/stat')?.split('\n')[0];
        if (!line)
            return null;
        const v = line.trim().split(/\s+/).slice(1, 9).map(Number);
        const idle = v[3] + v[4];
        const total = v.reduce((a, b) => a + b, 0);
        const prev = this._prevCpu;
        this._prevCpu = {idle, total};
        if (!prev || total === prev.total)
            return null;
        return Math.round(100 * (1 - (idle - prev.idle) / (total - prev.total)));
    }

    _readMemory() {
        const text = readText('/proc/meminfo');
        if (!text)
            return null;
        const get = key => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
        const total = get('MemTotal');
        if (!total)
            return null;
        const used = total - get('MemAvailable');
        return {percent: Math.round(100 * used / total), usedGB: used / 1048576, totalGB: total / 1048576};
    }

    _updateStats() {
        if (!this._cpuLabel)
            return;
        const cpu = this._readCpu();
        const mem = this._readMemory();
        if (cpu !== null) {
            this._cpuLabel.text = `CPU ${cpu}%`;
            this._cpuSub.text = `${GLib.get_num_processors()} cores`;
            this._cpuFill.width = Math.round(BAR_WIDTH * cpu / 100);
        }
        if (mem) {
            this._memLabel.text = `Memory ${mem.percent}%`;
            this._memSub.text = `${mem.usedGB.toFixed(1)} of ${mem.totalGB.toFixed(0)} GB`;
            this._memFill.width = Math.round(BAR_WIDTH * mem.percent / 100);
        }
    }

    // ===================== clock, placement =====================
    _tick() {
        if (!this._clock)
            return;
        const now = GLib.DateTime.new_now_local();
        this._clock.text = now.format(USE_24_HOUR ? '%H:%M' : '%-I:%M');
        this._date.text = now.format('%A, %B %-d');

        // Redraw the calendar when the day changes.
        const dayKey = now.format('%F');
        if (dayKey !== this._calendarDay) {
            this._calendarDay = dayKey;
            this._buildCalendar(now);
        }
    }

    _raise() {
        if (this._root && this._bgGroup)
            this._bgGroup.set_child_above_sibling(this._root, null);
    }

    _place() {
        if (!this._root)
            return;
        const mon = Main.layoutManager.primaryMonitor;
        if (mon)
            this._root.set_position(mon.x + OFFSET_X, mon.y + OFFSET_Y);
        this._raise();
    }

    disable() {
        for (const id of this._timers ?? [])
            GLib.Source.remove(id);
        this._timers = null;

        this._cancellable?.cancel();
        this._cancellable = null;
        this._session?.abort();
        this._session = null;

        if (this._bgChildId)
            this._bgGroup?.disconnect(this._bgChildId);
        if (this._monitorsId)
            Main.layoutManager.disconnect(this._monitorsId);
        this._bgChildId = this._monitorsId = null;

        this._root?.destroy();
        this._root = this._clock = this._date = null;
        this._wTemp = this._wIcon = this._wDesc = this._wHiLo = this._fc = null;
        this._calMonth = this._calGrid = null;
        this._cpuLabel = this._cpuSub = this._cpuFill = null;
        this._memLabel = this._memSub = this._memFill = null;
        this._bgGroup = null;
        this._prevCpu = this._calendarDay = null;
    }
}
