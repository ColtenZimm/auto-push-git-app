#!/usr/bin/env python3
"""Tray helper for auto-push-git-app (Linux), using GTK3 + (Ayatana)AppIndicator.

Protocol (one JSON object per line):
  stdin  <- {"type":"init","pause":[{"minutes":60,"label":"..."}]}
            {"type":"state","icon":"ok|pending|paused","tooltip":"...","paused":false}
  stdout -> {"type":"ready"} | {"type":"action","name":"open|check|pause|resume|open-log|quit","minutes":60}
            {"type":"unavailable","reason":"..."}
Exits when stdin closes, so it can never outlive the engine.
With AUTOPUSH_TRAY_TEST=1 it also accepts {"type":"test-click","name":..,"minutes":..}.

Needs: python3, python3-gi, gir1.2-gtk-3.0 and gir1.2-ayatanaappindicator3-0.1 (or gir1.2-appindicator3-0.1).
GNOME needs the "AppIndicator and KStatusNotifierItem Support" extension to show tray icons.
"""
import json
import os
import signal
import sys


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def unavailable(reason):
    send({"type": "unavailable", "reason": reason})
    sys.exit(0)


if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
    unavailable("no graphical session (DISPLAY/WAYLAND_DISPLAY not set)")

try:
    import gi

    gi.require_version("Gtk", "3.0")
    from gi.repository import GLib, Gtk

    try:
        gi.require_version("AyatanaAppIndicator3", "0.1")
        from gi.repository import AyatanaAppIndicator3 as AppIndicator
    except (ValueError, ImportError):
        gi.require_version("AppIndicator3", "0.1")
        from gi.repository import AppIndicator3 as AppIndicator
except Exception as exc:  # missing bindings are the common case on minimal installs
    unavailable("GTK / AppIndicator bindings not installed: %s" % exc)

TEST_MODE = os.environ.get("AUTOPUSH_TRAY_TEST") == "1"
ICONS = {
    "ok": "emblem-default",
    "pending": "dialog-warning",
    "paused": "media-playback-pause",
}

indicator = AppIndicator.Indicator.new(
    "auto-push-git-app", ICONS["ok"], AppIndicator.IndicatorCategory.APPLICATION_STATUS
)
indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)
indicator.set_title("auto-push-git-app")

menu = None
status_item = None
pause_items = []
resume_item = None
is_paused = False
all_items = []


def make_item(label, name, minutes=0):
    item = Gtk.MenuItem(label=label)

    def on_activate(_widget):
        msg = {"type": "action", "name": name}
        if name == "pause":
            msg["minutes"] = minutes
        send(msg)

    item.connect("activate", on_activate)
    item._ap_name = name
    item._ap_minutes = minutes
    all_items.append(item)
    return item


def build_menu(pause_options):
    global menu, status_item, pause_items, resume_item
    del all_items[:]
    pause_items = []
    menu = Gtk.Menu()
    status_item = Gtk.MenuItem(label="auto-push-git-app")
    status_item.set_sensitive(False)
    menu.append(status_item)
    menu.append(Gtk.SeparatorMenuItem())
    menu.append(make_item("Open window", "open"))
    menu.append(make_item("Check for changes now", "check"))
    if pause_options:
        menu.append(Gtk.SeparatorMenuItem())
        for opt in pause_options:
            it = make_item(str(opt.get("label", "Pause")), "pause", int(opt.get("minutes", 0)))
            pause_items.append(it)
            menu.append(it)
    resume_item = make_item("Resume reminders", "resume")
    resume_item.set_sensitive(is_paused)
    menu.append(resume_item)
    menu.append(Gtk.SeparatorMenuItem())
    menu.append(make_item("Open audit log folder", "open-log"))
    menu.append(Gtk.SeparatorMenuItem())
    menu.append(make_item("Quit", "quit"))
    menu.show_all()
    indicator.set_menu(menu)


def apply_state(msg):
    global is_paused
    kind = msg.get("icon", "ok")
    indicator.set_icon_full(ICONS.get(kind, ICONS["ok"]), kind)
    tip = str(msg.get("tooltip", ""))
    indicator.set_title(tip)
    is_paused = bool(msg.get("paused", False))
    for it in pause_items:
        it.set_sensitive(not is_paused)
    if resume_item is not None:
        resume_item.set_sensitive(is_paused)
    if status_item is not None:
        status_item.set_label(tip or "auto-push-git-app")


def test_click(msg):
    for it in all_items:
        if it._ap_name == msg.get("name") and (it._ap_name != "pause" or it._ap_minutes == msg.get("minutes")):
            it.activate()
            return


def on_stdin(_fd, condition):
    line = sys.stdin.readline()
    if not line:  # engine closed our stdin: shut down with it
        Gtk.main_quit()
        return False
    try:
        msg = json.loads(line)
    except ValueError:
        return True
    kind = msg.get("type")
    if kind == "init":
        build_menu(msg.get("pause") or [])
    elif kind == "state":
        apply_state(msg)
    elif kind == "test-click" and TEST_MODE:
        test_click(msg)
    return True


signal.signal(signal.SIGINT, signal.SIG_DFL)
build_menu([])
GLib.io_add_watch(sys.stdin.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP, on_stdin)
send({"type": "ready"})
Gtk.main()
