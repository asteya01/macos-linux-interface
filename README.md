# macOS Linux Interface

How I made Ubuntu 26.04 on my M1 Max MacBook Pro (Asahi Linux) look and feel like macOS,
including four GNOME extensions I wrote myself.

<!-- Add a screenshot: put it in the screenshots folder and change the file name below. -->
<!-- ![My desktop](screenshots/desktop.png) -->

## My extensions

These are in the [`extensions`](extensions) folder. They're written in JavaScript for GNOME Shell 49–51.

| Extension | What it does |
| --- | --- |
| **Dynamic Island** | A black pill at the top of the screen that turns into a mini music player when Spotify or a browser is playing. Hover over it for play/pause and skip buttons. |
| **App Name Menu** | Shows the current app's name in bold next to the logo, like macOS. Click it for New Window, Hide and Quit. |
| **Menu Bar Stats** | CPU, memory and temperature in the top bar, with details when you click it. |
| **Desktop Widgets** | The date, a big calligraphy clock, weather with a 5-day forecast, a calendar and system stats on the wallpaper. |

### Install them

```bash
git clone https://github.com/YOUR-USERNAME/macos-linux-interface.git
cd macos-linux-interface
./install.sh
```

Log out and back in, then turn on the ones you want:

```bash
gnome-extensions enable dynamic-island@asteya
gnome-extensions enable app-name@asteya
gnome-extensions enable menubar-stats@asteya
gnome-extensions enable desktop-widgets@asteya
```

**Desktop Widgets** needs the Great Vibes font for the clock:

```bash
mkdir -p ~/.local/share/fonts
curl -L -o ~/.local/share/fonts/GreatVibes-Regular.ttf https://github.com/google/fonts/raw/main/ofl/greatvibes/GreatVibes-Regular.ttf
fc-cache -f
```

To show your own weather, change `CITY_NAME`, `LATITUDE` and `LONGITUDE` at the top of
`extensions/desktop-widgets@asteya/extension.js`, then run `./install.sh` again.

## The full setup

These are the other pieces, made by other people, that complete the macOS look.

### Theme, icons and cursors

```bash
sudo apt install gnome-tweaks gnome-shell-extension-manager git sassc

git clone https://github.com/vinceliuice/WhiteSur-gtk-theme.git --depth=1
cd WhiteSur-gtk-theme && ./install.sh -c dark -l && cd ..

git clone https://github.com/vinceliuice/WhiteSur-icon-theme.git --depth=1
cd WhiteSur-icon-theme && ./install.sh && cd ..

git clone https://github.com/vinceliuice/WhiteSur-cursors.git --depth=1
cd WhiteSur-cursors && ./install.sh && cd ..

gsettings set org.gnome.desktop.interface gtk-theme 'WhiteSur-Dark'
gsettings set org.gnome.desktop.interface icon-theme 'WhiteSur-dark'
gsettings set org.gnome.desktop.interface cursor-theme 'WhiteSur-cursors'
```

### Window buttons on the left

```bash
gsettings set org.gnome.desktop.wm.preferences button-layout 'close,minimize,maximize:'
```

### Fonts

```bash
sudo apt install fonts-inter fonts-jetbrains-mono
```

Set **Inter** for interface and document text and **JetBrains Mono** for monospace in GNOME Tweaks → Fonts.

### Extensions from Extension Manager

| Extension | Used for |
| --- | --- |
| User Themes | applying the WhiteSur shell theme |
| Dash to Dock | the floating dock (Panel mode off, bottom, intelligent autohide); turn off Ubuntu Dock |
| Blur my Shell | frosted glass |
| Logo Menu | the Apple logo in the corner, using **Use Custom Icon** with an Apple logo file from WhiteSur |
| Compiz alike magic lamp effect | the genie minimize animation |
| Top Bar Organizer | moving the clock to the right |
| Hanabi | live video wallpaper (build it from [source](https://github.com/jeffshee/gnome-ext-hanabi) for GNOME 50) |

### Mac keyboard shortcuts

[Toshy](https://github.com/RedBearAK/toshy) makes Command + C, Command + V and Command + Tab work like on a Mac.
On GNOME it also needs the **Xremap** extension.

### Use the notch (Asahi Linux)

Asahi hides the area beside the notch by default. Add `apple_dcp.show_notch=1` to
`GRUB_CMDLINE_LINUX_DEFAULT` in `/etc/default/grub`, then:

```bash
sudo update-grub
```

and reboot.

### Apple logo in the terminal

```bash
fastfetch --gen-config
```

Add `"logo": "macos",` near the top of `~/.config/fastfetch/config.jsonc`.

## Credits

The theme, icons and cursors are [WhiteSur](https://github.com/vinceliuice) by vinceliuice.
The live wallpaper is [Hanabi](https://github.com/jeffshee/gnome-ext-hanabi) by jeffshee.
Keyboard remapping is [Toshy](https://github.com/RedBearAK/toshy) by RedBearAK.
Weather data comes from [Open-Meteo](https://open-meteo.com).
