#!/usr/bin/env python3
"""
Itinerary JSON editor (Python + Tkinter, no extra packages needed).

Opens a JSON file exported from the Itinerary Planner (or a bare list of stops),
lets you add / edit / delete locations, and saves it back.

Supported files:
  * a bare list of stops:            [ {...}, {...} ]
  * {"places": [...], ...}           (full export / My attractions export)
  * {"delta": {"places": {"added": [...]}, ...}}   (the app's "Export JSON";
        only the stops ADDED in the app are listed/edited, everything else in
        the file is preserved untouched)

Tip: paste a full google.com/maps link into the Address box and the exact
latitude / longitude are filled in for you. "Look up" geocodes a typed
address or name using OpenStreetMap (needs internet).
"""
import copy
import json
import os
import re
import threading
import time
import tkinter as tk
import urllib.parse
import urllib.request
from tkinter import filedialog, messagebox, ttk

CATEGORIES = {
    "Attractions": "sightseeing",
    "Food & Drink": "dining",
    "Outdoors & Nature": "outdoors",
    "City & Architecture": "skyscrapers",
    "Culture & Museums": "museums-culture",
    "Entertainment & Nightlife": "entertainment-nightlife",
    "Shopping": "shopping",
    "Views & Photography": "viewpoints-photography",
    "Quirky & Pop Culture": "quirky-pop-culture",
}
CAT_BY_VALUE = {v: k for k, v in CATEGORIES.items()}
SUMMARY_MAX = 150


# ----------------------------------------------------------------- logic ----
def parse_maps_link(text):
    """Return (name, lat, lng) from a full Google Maps link, else None."""
    t = (text or "").strip()
    if not re.match(r"^https?://", t, re.I):
        return None
    if not re.search(r"google\.[a-z.]+/maps|maps\.google\.", t, re.I):
        return None
    m = (re.search(r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)", t)
         or re.search(r"[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)", t)
         or re.search(r"@(-?\d+\.\d+),(-?\d+\.\d+)", t))
    if not m:
        return None
    name = None
    nm = re.search(r"/maps/place/([^/]+)/", t)
    if nm:
        name = urllib.parse.unquote(nm.group(1).replace("+", " "))
    return name, float(m.group(1)), float(m.group(2))


def geocode(query):
    """OpenStreetMap Nominatim lookup -> (lat, lng, display_name) or None."""
    url = ("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q="
           + urllib.parse.quote(query))
    req = urllib.request.Request(url, headers={"User-Agent": "itinerary-editor/1.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.load(r)
    if not data:
        return None
    return float(data[0]["lat"]), float(data[0]["lon"]), data[0].get("display_name", "")


def to_float(s):
    s = (s or "").strip()
    return float(s) if s else None


def sample_array_span(txt):
    """(start, end) of the [...] after SAMPLE_PLACES = in sample-places.js; end is inclusive."""
    m = re.search(r"SAMPLE_PLACES\s*=\s*\[", txt)
    if not m:
        raise ValueError("No SAMPLE_PLACES array found")
    start = m.end() - 1
    depth, i, in_str, esc = 0, start, None, False
    while i < len(txt):
        c = txt[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == in_str:
                in_str = None
        elif c in "\"'`":
            in_str = c
        elif c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return start, i
        i += 1
    raise ValueError("Unterminated SAMPLE_PLACES array")


def load_sample_places(path):
    """Read the SAMPLE_PLACES array out of sample-places.js."""
    txt = open(path, encoding="utf-8").read()
    start, end = sample_array_span(txt)
    arr = re.sub(r",(\s*[\]}])", r"\1", txt[start:end + 1])   # trailing commas
    return json.loads(arr)


def write_sample_places(path, stops):
    """Replace the SAMPLE_PLACES array in sample-places.js with `stops` (keeps the rest of the file).
    The old file is kept next to it as sample-places.js.bak."""
    txt = open(path, encoding="utf-8").read()
    start, end = sample_array_span(txt)
    with open(path + ".bak", "w", encoding="utf-8") as f:
        f.write(txt)
    arr = json.dumps(stops, indent=2, ensure_ascii=False)
    with open(path, "w", encoding="utf-8") as f:
        f.write(txt[:start] + arr + txt[end + 1:])


def apply_delta(delta, base):
    """Rebuild the full stop list = sample stops + the app's saved changes."""
    pd = delta.get("places") or {}
    by_id = {p["id"]: p for p in base}
    id_by_name = {p.get("name"): p["id"] for p in base}
    old_names = delta.get("baseNames") or {}
    remap = {}

    def resolve(i):
        if i in by_id:
            return i
        nid = id_by_name.get(old_names.get(i))
        if nid:
            remap[i] = nid
        return nid

    removed = {r for r in (resolve(i) for i in pd.get("removed", [])) if r}
    mods, rescued = {}, []
    for m in pd.get("modified", []):
        r = resolve(m.get("id"))
        if r:
            mods[r] = m
        elif m.get("full"):
            rescued.append(m["full"])
    for p in delta.get("pinned", []):
        if not resolve(p.get("id")):
            rescued.append(p)

    out = []
    for p in base:
        if p["id"] in removed:
            continue
        q = copy.deepcopy(p)
        m = mods.get(p["id"])
        if m:
            q.update(copy.deepcopy(m.get("set", {})))
            for k in m.get("unset", []):
                q.pop(k, None)
        out.append(q)

    used = {p["id"] for p in out}
    for p in list(pd.get("added", [])) + rescued:
        if not isinstance(p, dict):
            continue
        p = copy.deepcopy(p)
        if p.get("id") in used:
            at = next(i for i, q in enumerate(out) if q["id"] == p["id"])
            if out[at].get("name") == p.get("name"):
                out[at] = p
                continue
            old, nid, n = p["id"], p["id"] + "-u", 2
            while nid in used:
                nid = f"{old}-u{n}"
                n += 1
            p["id"] = nid
            remap[old] = nid
        used.add(p.get("id"))
        out.append(p)

    order = delta.get("order")
    if isinstance(order, list):
        by = {p.get("id"): p for p in out}
        ordered, seen = [], set()
        for i in order:
            i = remap.get(i, i)
            if i in by and i not in seen:
                ordered.append(by[i])
                seen.add(i)
        out = ordered + [p for p in out if p.get("id") not in seen]
    return out


def compute_delta(stops, base, old):
    """Inverse of apply_delta: store only what differs from the sample."""
    base_map = {p["id"]: p for p in base}
    cur_ids = {p.get("id") for p in stops}
    added = [p for p in stops if p.get("id") not in base_map]
    removed = [p["id"] for p in base if p["id"] not in cur_ids]
    modified = []
    missing = object()
    for p in stops:
        o = base_map.get(p.get("id"))
        if o is None:
            continue
        st = {k: v for k, v in p.items() if o.get(k, missing) != v}
        un = [k for k in o if k not in p]
        if st or un:
            modified.append({"id": p["id"], "set": st, "unset": un, "full": p})
    new = dict(old)
    new["places"] = {"added": added, "removed": removed, "modified": modified}
    new["baseNames"] = {p["id"]: p.get("name") for p in base}
    listed = {e.get("placeId") for e in old.get("myList", []) if isinstance(e, dict)}
    mod_ids = {m["id"] for m in modified}
    new["pinned"] = [p for p in stops if p.get("id") in base_map
                     and p["id"] in listed and p["id"] not in mod_ids]
    expected = [p["id"] for p in base if p["id"] not in removed] + [p["id"] for p in added]
    actual = [p.get("id") for p in stops]
    if expected != actual:
        new["order"] = actual
    else:
        new.pop("order", None)
    return new


def locate_stops(data):
    """Return (stops_list, description). stops_list is edited IN PLACE."""
    if isinstance(data, list):
        return data, "list of stops"
    if isinstance(data, dict):
        if isinstance(data.get("places"), list):
            return data["places"], "places"
        d = data.get("delta")
        if isinstance(d, dict):
            pl = d.setdefault("places", {})
            if not isinstance(pl.get("added"), list):
                pl["added"] = []
            return pl["added"], "stops added in the app (delta export)"
    raise ValueError("Couldn't find a list of stops in this file.")


# ------------------------------------------------------------------- GUI ----
import sys
import webbrowser
from tkinter import font as tkfont

BG = "#eef1ef"
SURFACE = "#ffffff"
FIELD = "#f4f6f5"
TEXT = "#16324f"
MUTED = "#526773"
FAINT = "#8a9aa3"
BORDER = "#dbe3e0"
NAVY = "#16324f"
NAVY_HOVER = "#2a4d75"
ACCENT = "#c1861f"
ACCENT_DARK = "#9c6c17"
ACCENT_SOFT = "#f8edd9"
DANGER = "#a8433a"
DANGER_SOFT = "#f5e6e3"
STRIPE = "#f7f9f8"


def enable_dpi_awareness():
    if sys.platform == "win32":
        try:
            import ctypes
            try:
                ctypes.windll.shcore.SetProcessDpiAwareness(1)
            except Exception:
                ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


class SearchEntry(ttk.Entry):
    """Entry with grey placeholder text."""

    def __init__(self, master, placeholder, on_change, **kw):
        super().__init__(master, **kw)
        self.ph, self.on_change, self.showing = placeholder, on_change, False
        self.bind("<FocusIn>", self._in)
        self.bind("<FocusOut>", self._out)
        self.bind("<KeyRelease>", lambda e: self.on_change())
        self._out()

    def _in(self, _e=None):
        if self.showing:
            self.delete(0, "end")
            self.configure(foreground=TEXT)
            self.showing = False

    def _out(self, _e=None):
        if not self.get():
            self.insert(0, self.ph)
            self.configure(foreground=FAINT)
            self.showing = True

    def value(self):
        return "" if self.showing else self.get().strip().lower()


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Itinerary editor")
        self.configure(bg=BG)
        self.minsize(1000, 620)
        self.fs = 11
        self.data = None
        self.stops = []
        self.path = None
        self.dirty = False
        self.current = None      # index of stop being edited, None = new stop
        self.extra_locs = []     # extra locations kept from an edited stop
        self.base = None         # sample stops when editing a delta export
        self.sample_path = None  # sample-places.js in use
        self.js_mode = False     # True when editing sample-places.js directly
        self.sort = (None, False)
        self.sig_clean = None
        self._status_job = None

        self.make_fonts()
        self.make_styles()
        self.build()
        self.apply_fonts()
        self.new_file(silent=True)

        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        w, h = min(int(sw * 0.78), 1800), min(int(sh * 0.82), 1050)
        self.geometry(f"{w}x{h}+{(sw - w) // 2}+{max(0, (sh - h) // 3)}")

        self.after(150, self.auto_open_sample)
        self.bind_all("<Control-s>", lambda e: self.save_file())
        self.bind_all("<Control-o>", lambda e: self.open_file())
        self.bind_all("<Control-n>", lambda e: self.clear_form())
        self.bind_all("<Control-Return>", lambda e: self.submit())
        self.bind_all("<Control-equal>", lambda e: self.zoom(1))
        self.bind_all("<Control-plus>", lambda e: self.zoom(1))
        self.bind_all("<Control-minus>", lambda e: self.zoom(-1))
        self.protocol("WM_DELETE_WINDOW", self.on_close)

    # ---------------------------------------------------------- look & feel
    def make_fonts(self):
        fam = {"win32": "Segoe UI", "darwin": "Helvetica Neue"}.get(sys.platform, "DejaVu Sans")
        self.fam = fam
        self.f_base = tkfont.Font(family=fam, size=self.fs)
        self.f_small = tkfont.Font(family=fam, size=self.fs - 1)
        self.f_bold = tkfont.Font(family=fam, size=self.fs, weight="bold")
        self.f_sec = tkfont.Font(family=fam, size=self.fs + 1, weight="bold")
        self.f_title = tkfont.Font(family=fam, size=self.fs + 6, weight="bold")
        self.f_head = tkfont.Font(family=fam, size=self.fs + 3, weight="bold")

    def apply_fonts(self):
        fs = self.fs
        self.f_base.configure(size=fs)
        self.f_small.configure(size=max(8, fs - 1))
        self.f_bold.configure(size=fs)
        self.f_sec.configure(size=fs + 1)
        self.f_title.configure(size=fs + 6)
        self.f_head.configure(size=fs + 3)
        for n in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont"):
            try:
                tkfont.nametofont(n).configure(family=self.fam, size=fs)
            except tk.TclError:
                pass
        rh = int(self.f_base.metrics("linespace") * 1.7)
        self.style.configure("Treeview", rowheight=rh)

    def zoom(self, d):
        self.fs = max(8, min(20, self.fs + d))
        self.apply_fonts()

    def make_styles(self):
        st = self.style = ttk.Style(self)
        st.theme_use("clam")
        st.configure(".", background=BG, foreground=TEXT, font=self.f_base,
                     bordercolor=BORDER, focuscolor=BG)
        st.configure("TFrame", background=BG)
        st.configure("TLabel", background=BG, foreground=TEXT, font=self.f_base)
        st.configure("Card.TLabel", background=SURFACE)
        st.configure("Muted.Card.TLabel", background=SURFACE, foreground=MUTED, font=self.f_small)
        st.configure("Sec.Card.TLabel", background=SURFACE, foreground=ACCENT_DARK, font=self.f_sec)
        st.configure("Title.Card.TLabel", background=SURFACE, foreground=TEXT, font=self.f_title)
        st.configure("Head.Card.TLabel", background=SURFACE, foreground=TEXT, font=self.f_head)
        st.configure("Hdr.TLabel", background=NAVY, foreground="#ffffff", font=self.f_head)
        st.configure("HdrSub.TLabel", background=NAVY, foreground="#b9c7d6", font=self.f_base)
        st.configure("HdrWarn.TLabel", background=NAVY, foreground="#ffc857", font=self.f_small)
        st.configure("Count.Card.TLabel", background=SURFACE, foreground=FAINT, font=self.f_small)

        flat = dict(lightcolor=SURFACE, darkcolor=SURFACE, relief="flat", borderwidth=1)
        st.configure("TButton", padding=(14, 7), background=FIELD, foreground=TEXT,
                     bordercolor="#c5d0cc", focuscolor=FIELD, font=self.f_bold,
                     lightcolor=FIELD, darkcolor=FIELD, relief="flat", borderwidth=1)
        st.map("TButton", background=[("active", "#e7ece9")])
        st.configure("Primary.TButton", background=ACCENT, foreground="#ffffff",
                     bordercolor=ACCENT, lightcolor=ACCENT, darkcolor=ACCENT, padding=(18, 8))
        st.map("Primary.TButton", background=[("active", ACCENT_DARK)],
               bordercolor=[("active", ACCENT_DARK)], lightcolor=[("active", ACCENT_DARK)],
               darkcolor=[("active", ACCENT_DARK)])
        st.configure("Danger.TButton", foreground=DANGER)
        st.map("Danger.TButton", background=[("active", DANGER_SOFT)])
        st.configure("Hdr.TButton", background="#244a73", foreground="#ffffff",
                     bordercolor="#244a73", lightcolor="#244a73", darkcolor="#244a73", padding=(14, 6))
        st.map("Hdr.TButton", background=[("active", NAVY_HOVER)], bordercolor=[("active", NAVY_HOVER)],
               lightcolor=[("active", NAVY_HOVER)], darkcolor=[("active", NAVY_HOVER)])
        st.configure("Small.TButton", padding=(10, 6), font=self.f_small)

        for w in ("TEntry", "TCombobox"):
            st.configure(w, fieldbackground=FIELD, foreground=TEXT, bordercolor=BORDER,
                         lightcolor=FIELD, darkcolor=FIELD, padding=7, insertcolor=TEXT)
        st.map("TEntry", fieldbackground=[("focus", SURFACE)], bordercolor=[("focus", ACCENT)],
               lightcolor=[("focus", ACCENT)], darkcolor=[("focus", ACCENT)])
        st.configure("TCombobox", arrowcolor=MUTED, background=FIELD)
        st.map("TCombobox", fieldbackground=[("readonly", FIELD), ("focus", SURFACE)],
               bordercolor=[("focus", ACCENT)], selectbackground=[("readonly", FIELD)],
               selectforeground=[("readonly", TEXT)])
        self.option_add("*TCombobox*Listbox.font", self.f_base)
        self.option_add("*TCombobox*Listbox.selectBackground", ACCENT_SOFT)
        self.option_add("*TCombobox*Listbox.selectForeground", TEXT)

        st.configure("Treeview", background=SURFACE, fieldbackground=SURFACE, foreground=TEXT,
                     borderwidth=0, font=self.f_base)
        st.configure("Treeview.Heading", background="#e7ece9", foreground=MUTED, relief="flat",
                     font=self.f_bold, padding=(8, 6), borderwidth=0)
        st.map("Treeview.Heading", background=[("active", "#dbe3e0")])
        st.map("Treeview", background=[("selected", ACCENT_SOFT)], foreground=[("selected", TEXT)])
        st.layout("Treeview", [("Treeview.treearea", {"sticky": "nswe"})])
        for o in ("Vertical", "Horizontal"):
            st.configure(f"{o}.TScrollbar", background="#c9d3cf", troughcolor=SURFACE,
                         bordercolor=SURFACE, arrowcolor=MUTED, relief="flat")
            st.map(f"{o}.TScrollbar", background=[("active", "#a9b6b1")])

    def card(self, parent):
        return tk.Frame(parent, bg=SURFACE, highlightbackground=BORDER, highlightthickness=1)

    # --------------------------------------------------------------- layout
    def build(self):
        self.columnconfigure(0, weight=1)
        self.rowconfigure(1, weight=1)

        # header bar
        hdr = tk.Frame(self, bg=NAVY)
        hdr.grid(row=0, column=0, sticky="ew")
        left = tk.Frame(hdr, bg=NAVY)
        left.pack(side="left", padx=18, pady=12)
        ttk.Label(left, text="Itinerary editor", style="Hdr.TLabel").pack(side="left")
        self.file_lbl = ttk.Label(left, text="", style="HdrSub.TLabel")
        self.file_lbl.pack(side="left", padx=(16, 0))
        self.dirty_lbl = ttk.Label(left, text="", style="HdrWarn.TLabel")
        self.dirty_lbl.pack(side="left", padx=(10, 0))
        right = tk.Frame(hdr, bg=NAVY)
        right.pack(side="right", padx=14)
        for text, cmd in [("Save as…", self.save_as), ("Save", self.save_file),
                          ("Open…", self.open_file), ("New file", self.new_file),
                          ("Bake into sample", self.bake_sample),
                          ("Compare & merge…", self.open_merge)]:
            ttk.Button(right, text=text, style="Hdr.TButton", command=cmd).pack(side="right", padx=3)

        # main area
        main = tk.Frame(self, bg=BG)
        main.grid(row=1, column=0, sticky="nsew", padx=16, pady=16)
        main.columnconfigure(0, weight=5, uniform="m")
        main.columnconfigure(1, weight=6, uniform="m")
        main.rowconfigure(0, weight=1)
        self.build_list(main)
        self.build_form(main)

        # status bar
        sb = tk.Frame(self, bg=BG)
        sb.grid(row=2, column=0, sticky="ew", padx=18, pady=(0, 8))
        self.status = ttk.Label(sb, text="", foreground=MUTED)
        self.status.pack(side="left")
        ttk.Label(sb, text="Ctrl+S save · Ctrl+N new stop · Ctrl+Enter apply · Ctrl +/− zoom",
                  foreground=FAINT, font=self.f_small).pack(side="right")

    def build_list(self, parent):
        card = self.card(parent)
        card.grid(row=0, column=0, sticky="nsew", padx=(0, 8))
        card.columnconfigure(0, weight=1)
        card.rowconfigure(2, weight=1)

        top = tk.Frame(card, bg=SURFACE)
        top.grid(row=0, column=0, columnspan=2, sticky="ew", padx=14, pady=(14, 8))
        ttk.Label(top, text="Stops", style="Head.Card.TLabel").pack(side="left")
        self.count_lbl = ttk.Label(top, text="", style="Count.Card.TLabel")
        self.count_lbl.pack(side="right")

        sf = tk.Frame(card, bg=SURFACE)
        sf.grid(row=1, column=0, columnspan=2, sticky="ew", padx=14, pady=(0, 10))
        self.search = SearchEntry(sf, "Search name, address or description…", self.refresh_list)
        self.search.pack(fill="x")

        cols = ("name", "category", "cost", "address")
        self.tree = ttk.Treeview(card, columns=cols, show="headings", selectmode="browse")
        self.heads = {"name": "Name", "category": "Category", "cost": "Cost", "address": "Address"}
        for c, w, st_ in (("name", 220, False), ("category", 200, False), ("cost", 70, False), ("address", 260, True)):
            self.tree.heading(c, text=self.heads[c], anchor="w", command=lambda c=c: self.sort_by(c))
            self.tree.column(c, width=w, minwidth=50, anchor="w", stretch=True if c in ("name", "address") else False)
        self.tree.tag_configure("odd", background=STRIPE)
        vsb = ttk.Scrollbar(card, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.grid(row=2, column=0, sticky="nsew", padx=(1, 0), pady=(0, 1))
        vsb.grid(row=2, column=1, sticky="ns", pady=(0, 1), padx=(0, 1))
        self.tree.bind("<<TreeviewSelect>>", self.on_select)
        self.tree.bind("<Delete>", lambda e: self.delete())

    def build_form(self, parent):
        card = self.card(parent)
        card.grid(row=0, column=1, sticky="nsew", padx=(8, 0))
        card.columnconfigure(0, weight=1)
        card.rowconfigure(1, weight=1)

        top = tk.Frame(card, bg=SURFACE)
        top.grid(row=0, column=0, columnspan=2, sticky="ew", padx=20, pady=(16, 8))
        self.form_title = ttk.Label(top, text="Add a stop", style="Title.Card.TLabel")
        self.form_title.pack(side="left")
        self.badge = tk.Label(top, text="EDITING", bg=ACCENT_SOFT, fg=ACCENT_DARK,
                              font=self.f_small, padx=8, pady=2)

        # scrollable body
        self.canvas = tk.Canvas(card, bg=SURFACE, highlightthickness=0, bd=0)
        vsb = ttk.Scrollbar(card, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=vsb.set)
        self.canvas.grid(row=1, column=0, sticky="nsew", padx=(20, 0))
        vsb.grid(row=1, column=1, sticky="ns", padx=(0, 1))
        self.inner = tk.Frame(self.canvas, bg=SURFACE)
        win = self.canvas.create_window((0, 0), window=self.inner, anchor="nw")
        self.inner.bind("<Configure>", lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", lambda e: self.canvas.itemconfigure(win, width=e.width - 16))
        self.canvas.bind("<Enter>", lambda e: self._wheel_on())
        self.canvas.bind("<Leave>", lambda e: self._wheel_off())

        self.v = {k: tk.StringVar() for k in
                  ("name", "category", "day", "address", "website", "cost", "rating", "image", "lat", "lng")}
        self.v["category"].set("Attractions")

        # --- Basics
        g = self.section("Basics", first=True)
        f = self.field(g, "Name *", 0, 0, 2)
        self.entry_row(f, "name")
        f = self.field(g, "Category", 1, 0)
        ttk.Combobox(f, textvariable=self.v["category"], values=list(CATEGORIES),
                     state="readonly", font=self.f_base).pack(fill="x")
        f = self.field(g, "Day", 1, 1)
        ttk.Entry(f, textvariable=self.v["day"], font=self.f_base).pack(fill="x")

        # --- Location
        g = self.section("Location")
        f = self.field(g, "Address — or paste a full Google Maps link for an exact pin", 0, 0, 2)
        row = tk.Frame(f, bg=SURFACE)
        row.pack(fill="x")
        addr = ttk.Entry(row, textvariable=self.v["address"], font=self.f_base)
        addr.pack(side="left", fill="x", expand=True)
        addr.bind("<<Paste>>", lambda e: self.after(60, self.check_maps_link))
        self.clip_btns(row, "address")
        self.lookup_btn = ttk.Button(row, text="Look up", style="Small.TButton", command=self.do_lookup)
        self.lookup_btn.pack(side="left", padx=(8, 0))
        ttk.Button(row, text="Open map ↗", style="Small.TButton", command=self.open_map).pack(side="left", padx=(6, 0))
        f = self.field(g, "Latitude", 1, 0)
        self.entry_row(f, "lat")
        f = self.field(g, "Longitude", 1, 1)
        self.entry_row(f, "lng")
        f = self.field(g, "More locations — one per line:  label | address", 2, 0, 2)
        self.locs = self.text(f, 3)

        # --- Details
        g = self.section("Details")
        f = self.field(g, "Website", 0, 0, 2)
        self.entry_row(f, "website")
        f = self.field(g, "Cost ($)", 1, 0)
        ttk.Entry(f, textvariable=self.v["cost"], font=self.f_base).pack(fill="x")
        f = self.field(g, "Rating (0–5)", 1, 1)
        ttk.Entry(f, textvariable=self.v["rating"], font=self.f_base).pack(fill="x")
        f = self.field(g, "Cover photo (filename or URL)", 2, 0, 2)
        ttk.Entry(f, textvariable=self.v["image"], font=self.f_base).pack(fill="x")

        # --- Description
        g = self.section("Description")
        f = self.field(g, "Short description — shown on the card", 0, 0, 2)
        self.summary = self.text(f, 3)
        self.counter = ttk.Label(f, text=f"0/{SUMMARY_MAX}", style="Count.Card.TLabel")
        self.counter.pack(anchor="e")
        self.summary.bind("<KeyRelease>", lambda e: self.update_counter())
        f = self.field(g, "Tips & tricks — shown in the detail view", 1, 0, 2)
        self.desc = self.text(f, 7)

        # --- action bar
        tk.Frame(card, bg=BORDER, height=1).grid(row=2, column=0, columnspan=2, sticky="ew")
        bar = tk.Frame(card, bg=SURFACE)
        bar.grid(row=3, column=0, columnspan=2, sticky="ew", padx=20, pady=12)
        ttk.Button(bar, text="Delete stop", style="Danger.TButton", command=self.delete).pack(side="left")
        self.save_btn = ttk.Button(bar, text="Add stop", style="Primary.TButton", command=self.submit)
        self.save_btn.pack(side="right")
        ttk.Button(bar, text="New stop", command=self.clear_form).pack(side="right", padx=8)

    # ------------------------------------------------------ copy / paste
    def clip_btns(self, row, key):
        for label, cmd in (("Copy", lambda: self.copy_field(key)), ("Paste", lambda: self.paste_field(key))):
            ttk.Button(row, text=label, style="Small.TButton", command=cmd).pack(side="left", padx=(6, 0))

    def entry_row(self, parent, key):
        row = tk.Frame(parent, bg=SURFACE)
        row.pack(fill="x")
        ttk.Entry(row, textvariable=self.v[key], font=self.f_base).pack(side="left", fill="x", expand=True)
        self.clip_btns(row, key)

    def copy_field(self, key):
        txt = self.v[key].get()
        if not txt:
            self.say("Nothing to copy")
            return
        self.clipboard_clear()
        self.clipboard_append(txt)
        self.say(f"Copied {key}")

    def paste_field(self, key):
        try:
            txt = self.clipboard_get().strip()
        except tk.TclError:
            self.say("Clipboard is empty")
            return
        txt = txt.splitlines()[0].strip() if txt else ""
        if not txt:
            self.say("Clipboard is empty")
            return
        if key in ("lat", "lng"):          # "40.7128, -74.0060" fills both boxes
            m = re.match(r"^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$", txt)
            if m:
                self.v["lat"].set(m.group(1))
                self.v["lng"].set(m.group(2))
                self.say("Pasted latitude and longitude")
                return
        self.v[key].set(txt)
        if key == "address":
            self.check_maps_link()         # a pasted Google Maps link fills the exact pin
        self.say(f"Pasted {key}")

    def section(self, title, first=False):
        if not first:
            tk.Frame(self.inner, bg=BORDER, height=1).pack(fill="x", pady=(8, 0))
        ttk.Label(self.inner, text=title, style="Sec.Card.TLabel").pack(anchor="w", pady=(12, 8))
        g = tk.Frame(self.inner, bg=SURFACE)
        g.pack(fill="x")
        g.columnconfigure(0, weight=1, uniform="c")
        g.columnconfigure(1, weight=1, uniform="c")
        return g

    def field(self, grid, label, row, col, span=1):
        f = tk.Frame(grid, bg=SURFACE)
        f.grid(row=row, column=col, columnspan=span, sticky="ew",
               padx=(0, 10) if (col == 0 and span == 1) else 0, pady=(0, 12))
        ttk.Label(f, text=label, style="Muted.Card.TLabel").pack(anchor="w", pady=(0, 4))
        return f

    def text(self, parent, height):
        t = tk.Text(parent, height=height, wrap="word", font=self.f_base, bg=FIELD, fg=TEXT,
                    relief="flat", highlightthickness=1, highlightbackground=BORDER,
                    highlightcolor=ACCENT, padx=9, pady=7, insertbackground=TEXT, undo=True,
                    selectbackground=ACCENT_SOFT, selectforeground=TEXT, bd=0)
        t.pack(fill="x")
        t.bind("<FocusIn>", lambda e: t.configure(bg=SURFACE))
        t.bind("<FocusOut>", lambda e: t.configure(bg=FIELD))
        t.bind("<MouseWheel>", lambda e: (self._wheel(e), "break")[1])
        return t

    def _wheel(self, e):
        if getattr(e, "num", None) == 4:
            d = -1
        elif getattr(e, "num", None) == 5:
            d = 1
        else:
            d = -1 if e.delta > 0 else 1
        self.canvas.yview_scroll(d * 2, "units")

    def _wheel_on(self):
        self.bind_all("<MouseWheel>", self._wheel)
        self.bind_all("<Button-4>", self._wheel)
        self.bind_all("<Button-5>", self._wheel)

    def _wheel_off(self):
        self.unbind_all("<MouseWheel>")
        self.unbind_all("<Button-4>")
        self.unbind_all("<Button-5>")

    # -------------------------------------------------------------- helpers
    def say(self, msg):
        self.status.config(text=msg)
        if self._status_job:
            self.after_cancel(self._status_job)
        self._status_job = self.after(8000, lambda: self.status.config(text=""))

    def set_dirty(self, d=True):
        self.dirty = d
        self.update_title()

    def update_title(self):
        name = os.path.basename(self.path) if self.path else "Untitled"
        self.file_lbl.config(text=name)
        self.dirty_lbl.config(text="● unsaved changes" if self.dirty else "")
        self.title(f"{name}{' *' if self.dirty else ''} - Itinerary editor")

    def confirm_discard(self):
        return (not self.dirty) or messagebox.askyesno("Unsaved changes", "Discard unsaved changes?")

    def update_counter(self):
        n = len(self.summary.get("1.0", "end-1c"))
        self.counter.config(text=f"{n}/{SUMMARY_MAX}", foreground=DANGER if n > SUMMARY_MAX else FAINT)

    # ------------------------------------------------------------- file ops
    def new_file(self, silent=False):
        if not silent and not self.confirm_discard():
            return
        self.data = {"places": [], "packages": [], "myList": []}
        self.stops = self.data["places"]
        self.base = None
        self.js_mode = False
        self.path = None
        self.clear_form()
        self.refresh_list()
        self.set_dirty(False)
        self.say("New empty itinerary")

    def open_file(self):
        if not self.confirm_discard():
            return
        p = filedialog.askopenfilename(filetypes=[("sample-places.js or JSON", "*.js *.json"), ("All files", "*.*")])
        if not p:
            return
        if p.lower().endswith(".js"):
            self.open_sample(p)
            return
        try:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
            stops, kind = self.load_data(data, p)
        except Exception as e:
            messagebox.showerror("Can't open file", str(e))
            return
        self.js_mode = False
        self.data, self.stops, self.path = data, stops, p
        self.clear_form()
        self.refresh_list()
        self.set_dirty(False)
        self.say(f"Opened {len(stops)} stop(s) — {kind}")

    def open_sample(self, p):
        """Edit sample-places.js directly: it is the app's main list of locations."""
        try:
            stops = load_sample_places(p)
        except Exception as e:
            messagebox.showerror("Can't read sample-places.js", str(e))
            return False
        self.data = {"places": stops}
        self.stops = stops
        self.base = None
        self.path = self.sample_path = p
        self.js_mode = True
        self.clear_form()
        self.refresh_list()
        self.set_dirty(False)
        self.say(f"Editing {os.path.basename(p)}: {len(stops)} stop(s). Save writes straight into this file.")
        return True

    def auto_open_sample(self):
        if self.path or self.dirty:
            return
        for d in (os.path.dirname(os.path.abspath(__file__)), os.getcwd()):
            c = os.path.join(d, "sample-places.js")
            if os.path.isfile(c):
                self.open_sample(c)
                return

    def find_sample(self, json_path):
        here = os.path.dirname(os.path.abspath(__file__))
        jdir = os.path.dirname(os.path.abspath(json_path))
        for d in (jdir, os.path.dirname(jdir), here, os.getcwd()):
            c = os.path.join(d, "sample-places.js")
            if os.path.isfile(c):
                self.sample_path = c
                return c
        messagebox.showinfo(
            "Sample stops needed",
            "This export only stores your changes to the built-in sample trip.\n"
            "To list ALL stops, select the app's sample-places.js file next.")
        c = filedialog.askopenfilename(title="Locate sample-places.js",
                                       filetypes=[("sample-places.js", "*.js"), ("All files", "*.*")])
        if c:
            self.sample_path = c
        return c or None

    def load_data(self, data, path):
        """Return (stops, description). Merges the sample for delta exports."""
        self.base = None
        d = data.get("delta") if isinstance(data, dict) else None
        if isinstance(d, dict):
            if (d.get("base") or "sample") != "sample":
                self.base = []
            else:
                sp = self.find_sample(path)
                if sp:
                    try:
                        self.base = load_sample_places(sp)
                    except Exception as e:
                        messagebox.showwarning("Sample not readable",
                                               f"{e}\n\nShowing only the stops you added.")
            if self.base is not None:
                return apply_delta(d, self.base), "all stops (sample + your changes)"
        return locate_stops(data)

    def save_file(self):
        if not self.flush_form():
            return
        if not self.path:
            return self.save_as()
        self._write(self.path)

    def save_as(self):
        if not self.flush_form():
            return
        p = filedialog.asksaveasfilename(defaultextension=".js" if self.js_mode else ".json",
                                         filetypes=[("sample-places.js", "*.js")] if self.js_mode else [("JSON", "*.json")])
        if p:
            self._write(p)

    def _write(self, p):
        if self.js_mode:
            try:
                if os.path.isfile(p) and "SAMPLE_PLACES" in open(p, encoding="utf-8").read():
                    write_sample_places(p, self.stops)       # keeps the rest of the file, writes a .bak
                else:
                    with open(p, "w", encoding="utf-8") as f:
                        f.write("const SAMPLE_PLACES = " + json.dumps(self.stops, indent=2, ensure_ascii=False) + ";\n")
            except Exception as e:
                messagebox.showerror("Save failed", str(e))
                return
            self.path = self.sample_path = p
            self.set_dirty(False)
            self.say(f"Saved {len(self.stops)} stop(s) into {os.path.basename(p)}. Reload the app to see them.")
            return
        try:
            if self.base is not None and isinstance(self.data, dict) and "delta" in self.data:
                self.data["delta"] = compute_delta(self.stops, self.base, self.data["delta"])
            with open(p, "w", encoding="utf-8") as f:
                json.dump(self.data, f, indent=2, ensure_ascii=False)
        except Exception as e:
            messagebox.showerror("Save failed", str(e))
            return
        self.path = p
        self.set_dirty(False)
        self.say(f"Saved {len(self.stops)} stop(s) to {p}")

    def bake_sample(self):
        """Write ALL current stops into sample-places.js (the app's built-in trip)."""
        if self.js_mode:
            self.save_file()
            return
        if not self.flush_form():
            return
        if not self.stops:
            messagebox.showinfo("Nothing to write", "There are no stops to write.")
            return
        path = self.sample_path
        if not path or not os.path.isfile(path):
            path = filedialog.askopenfilename(title="Select sample-places.js to update",
                                              filetypes=[("sample-places.js", "*.js"), ("All files", "*.*")])
            if not path:
                return
        if not messagebox.askyesno(
                "Update sample-places.js",
                f"Replace the stops in\n{path}\nwith these {len(self.stops)} stops?\n\n"
                "The old file is kept as sample-places.js.bak."):
            return
        try:
            write_sample_places(path, [s for s in self.stops if isinstance(s, dict)])
        except Exception as e:
            messagebox.showerror("Could not update sample", str(e))
            return
        self.sample_path = path
        # The sample now contains every edit, so the delta file no longer needs to repeat them.
        if isinstance(self.data, dict) and isinstance(self.data.get("delta"), dict):
            self.base = copy.deepcopy([s for s in self.stops if isinstance(s, dict)])
            self.data["delta"] = compute_delta(self.stops, self.base, self.data["delta"])
            self.set_dirty()
            self.say(f"Updated {os.path.basename(path)} ({len(self.stops)} stops). Save the JSON too, then reload the app.")
        else:
            self.say(f"Updated {os.path.basename(path)} ({len(self.stops)} stops). Reload the app.")

    def open_merge(self):
        """Compare sample-places.js with a saved JSON export and merge chosen items into the sample."""
        if self.dirty and messagebox.askyesno(
                "Unsaved changes", "Save your current edits first?\n(The comparison reads the files from disk.)"):
            self.save_file()
            if self.dirty:
                return
        if not self.sample_path:
            for d in (os.path.dirname(os.path.abspath(__file__)), os.getcwd()):
                c = os.path.join(d, "sample-places.js")
                if os.path.isfile(c):
                    self.sample_path = c
                    break
        MergeDialog(self)

    def after_merge(self, sample_path, new_stops):
        """Keep the editor in step after the sample file was rewritten by the merge dialog."""
        self.sample_path = sample_path
        same = lambda a, b: os.path.abspath(a or "") == os.path.abspath(b or "")
        if self.js_mode and self.path and same(self.path, sample_path):
            self.open_sample(sample_path)
        elif self.base is not None and isinstance(self.data, dict) and isinstance(self.data.get("delta"), dict):
            # the sample now contains the merged items, so the JSON only needs to keep the rest
            self.base = copy.deepcopy(new_stops)
            self.data["delta"] = compute_delta(self.stops, self.base, self.data["delta"])
            self.set_dirty()

    def on_close(self):
        if self.confirm_discard():
            self.destroy()

    # ----------------------------------------------------------------- list
    def sort_by(self, col):
        c, rev = self.sort
        self.sort = (col, not rev) if c == col else (col, False)
        self.refresh_list(select=self.current)

    def refresh_list(self, select=None):
        q = self.search.value() if hasattr(self, "search") else ""
        rows = []
        for i, s in enumerate(self.stops):
            if not isinstance(s, dict):
                continue
            hay = " ".join(str(s.get(k, "")) for k in ("name", "address", "summary", "desc")).lower()
            if q and q not in hay:
                continue
            cost = s.get("cost")
            try:
                cost_txt = "" if cost in (None, "") else ("Free" if float(cost) == 0 else f"${float(cost):g}")
            except (TypeError, ValueError):
                cost_txt = str(cost)
            rows.append((i, (s.get("name", ""),
                             CAT_BY_VALUE.get(s.get("category"), s.get("category", "")),
                             cost_txt, s.get("address", ""))))
        col, rev = self.sort
        if col:
            ci = ("name", "category", "cost", "address").index(col)
            rows.sort(key=lambda r: str(r[1][ci]).lower(), reverse=rev)
        for c, label in self.heads.items():
            arrow = (" ▼" if rev else " ▲") if c == col else ""
            self.tree.heading(c, text=label + arrow)
        self.tree.delete(*self.tree.get_children())
        for n, (i, vals) in enumerate(rows):
            self.tree.insert("", "end", iid=str(i), values=vals, tags=("odd",) if n % 2 else ())
        total = len([s for s in self.stops if isinstance(s, dict)])
        self.count_lbl.config(text=f"{len(rows)} of {total} stops" if q else f"{total} stops")
        if select is not None and self.tree.exists(str(select)):
            self.tree.selection_set(str(select))
            self.tree.see(str(select))

    def on_select(self, _e=None):
        sel = self.tree.selection()
        if sel:
            self.load_into_form(int(sel[0]))

    # ----------------------------------------------------------------- form
    def _set_text(self, widget, text):
        widget.delete("1.0", "end")
        widget.insert("1.0", text or "")

    def clear_form(self):
        self.current = None
        self.extra_locs = []
        for var in self.v.values():
            var.set("")
        self.v["category"].set("Attractions")
        for w in (self.summary, self.desc, self.locs):
            self._set_text(w, "")
        self.update_counter()
        self.form_title.config(text="Add a stop")
        self.badge.pack_forget()
        self.save_btn.config(text="Add stop")
        if self.tree.selection():
            self.tree.selection_remove(self.tree.selection())
        self.canvas.yview_moveto(0)
        self.sig_clean = self.form_sig()

    def load_into_form(self, idx):
        s = self.stops[idx]
        self.current = idx
        g = lambda k: "" if s.get(k) is None else s.get(k)
        self.v["name"].set(g("name"))
        self.v["category"].set(CAT_BY_VALUE.get(s.get("category"), "Attractions"))
        for k in ("day", "address", "website", "cost", "rating", "image", "lat", "lng"):
            self.v[k].set(g(k))
        self._set_text(self.summary, s.get("summary"))
        self._set_text(self.desc, s.get("desc"))
        locs = s.get("locations") if isinstance(s.get("locations"), list) else []
        self.extra_locs = [l for l in locs if isinstance(l, dict)]
        self._set_text(self.locs, "\n".join(
            f"{l.get('label', '')} | {l.get('address', '')}" for l in self.extra_locs))
        self.update_counter()
        self.form_title.config(text=s.get("name") or "Edit stop")
        self.badge.pack(side="left", padx=12)
        self.save_btn.config(text="Save changes")
        self.canvas.yview_moveto(0)
        self.sig_clean = self.form_sig()

    def check_maps_link(self):
        parsed = parse_maps_link(self.v["address"].get())
        if not parsed:
            return
        name, lat, lng = parsed
        self.v["lat"].set(str(lat))
        self.v["lng"].set(str(lng))
        if name:
            self.v["address"].set(name)
            if not self.v["name"].get().strip():
                self.v["name"].set(name)
        self.say("Exact location captured from Google Maps link")

    def open_map(self):
        """Open Google Maps on the stop, searching by name + address so the place's name shows up."""
        name = self.v["name"].get().strip()
        addr = self.v["address"].get().strip()
        lat, lng = self.v["lat"].get().strip(), self.v["lng"].get().strip()
        if name and addr:
            q = addr if name.lower() in addr.lower() else f"{name}, {addr}"   # no "Name, Name"
        elif name and lat and lng:
            q = f"{name} {lat},{lng}"
        elif name:
            q = name
        else:
            q = f"{lat},{lng}" if lat and lng else addr
        if not q:
            self.say("Nothing to show on the map yet")
            return
        webbrowser.open("https://www.google.com/maps/search/?api=1&query=" + urllib.parse.quote(q))

    def do_lookup(self):
        q = self.v["address"].get().strip() or self.v["name"].get().strip()
        if not q:
            self.say("Type an address or name first")
            return
        self.lookup_btn.config(state="disabled")
        self.say("Looking up…")

        def work():
            try:
                res = ("ok", geocode(q))
            except Exception as e:
                res = ("err", str(e))
            self.after(0, lambda: self.lookup_done(res))
        threading.Thread(target=work, daemon=True).start()

    def lookup_done(self, res):
        self.lookup_btn.config(state="normal")
        kind, val = res
        if kind == "err":
            self.say(f"Lookup failed: {val}")
        elif not val:
            self.say("No match found")
        else:
            lat, lng, disp = val
            self.v["lat"].set(str(lat))
            self.v["lng"].set(str(lng))
            if not self.v["address"].get().strip():
                self.v["address"].set(disp)
            self.say(f"Found: {disp}")

    def parse_extra_locations(self):
        old = {(l.get("address") or "").strip(): l for l in self.extra_locs}
        out = []
        for line in self.locs.get("1.0", "end").splitlines():
            line = line.strip()
            if not line:
                continue
            label, _, addr = line.partition("|") if "|" in line else ("", "", line)
            label, addr = label.strip(), addr.strip()
            loc = {"address": addr}
            if label:
                loc["label"] = label
            prev = old.get(addr)
            if prev:
                for k in ("lat", "lng", "approxLocation"):
                    if k in prev:
                        loc[k] = prev[k]
            else:
                p = parse_maps_link(addr)
                if p:
                    loc.update(lat=p[1], lng=p[2])
                    if p[0]:
                        loc["address"] = p[0]
            if loc.get("address") or "lat" in loc:
                out.append(loc)
        return out

    def form_sig(self):
        """Snapshot of everything typed in the form, to detect un-applied edits."""
        return (tuple(self.v[k].get() for k in sorted(self.v)),
                self.summary.get("1.0", "end-1c"),
                self.desc.get("1.0", "end-1c"),
                self.locs.get("1.0", "end-1c"))

    def flush_form(self):
        """Apply form edits that were typed but never applied. False = abort the save."""
        if self.form_sig() == self.sig_clean:
            return True
        if not self.v["name"].get().strip():
            return True
        return self.submit()

    def submit(self):
        name = self.v["name"].get().strip()
        if not name:
            messagebox.showwarning("Missing name", "Name is required.")
            return False
        try:
            cost = to_float(self.v["cost"].get())
            rating = to_float(self.v["rating"].get())
            lat = to_float(self.v["lat"].get())
            lng = to_float(self.v["lng"].get())
        except ValueError:
            messagebox.showwarning("Bad number", "Cost, rating, latitude and longitude must be numbers.")
            return False
        if rating is not None:
            rating = min(5.0, max(0.0, rating))
        if (lat is None) != (lng is None):
            messagebox.showwarning("Coordinates", "Give both latitude and longitude, or neither.")
            return False

        addr = self.v["address"].get().strip()
        parsed = parse_maps_link(addr)
        if parsed:
            _, lat, lng = parsed
            addr = parsed[0] or addr

        dupe = [i for i, s in enumerate(self.stops)
                if isinstance(s, dict) and s.get("name", "").strip().lower() == name.lower()
                and i != self.current]
        if dupe and not messagebox.askyesno("Duplicate", f'"{name}" already exists. Add it anyway?'):
            return False

        fields = {
            "name": name,
            "category": CATEGORIES.get(self.v["category"].get(), "sightseeing"),
            "day": self.v["day"].get().strip(),
            "website": self.v["website"].get().strip(),
            "address": addr,
            "summary": self.summary.get("1.0", "end").strip()[:SUMMARY_MAX],
            "desc": self.desc.get("1.0", "end").strip(),
            "image": self.v["image"].get().strip() or None,
            "cost": cost,
            "rating": rating,
        }
        locs = self.parse_extra_locations()

        if self.current is not None:
            s = self.stops[self.current]
            addr_changed = (s.get("address") or "") != addr
            s.update(fields)
            if lat is not None:
                s["lat"], s["lng"] = lat, lng
                s.pop("approxLocation", None)
            elif addr_changed:
                s.pop("lat", None); s.pop("lng", None); s.pop("approxLocation", None)
            if locs:
                s["locations"] = locs
            else:
                s.pop("locations", None)
            idx = self.current
            self.say(f'Updated "{name}" — remember to Save')
        else:
            s = {"id": str(int(time.time() * 1000)), **fields, "packageId": None, "gallery": []}
            if lat is not None:
                s["lat"], s["lng"] = lat, lng
            if locs:
                s["locations"] = locs
            self.stops.append(s)
            idx = len(self.stops) - 1
            self.say(f'Added "{name}" — remember to Save')
        was_new = self.current is None
        self.set_dirty()
        self.current = idx
        self.refresh_list(select=idx)
        if was_new:
            self.clear_form()
            self.tree.see(str(idx))
        self.sig_clean = self.form_sig()
        return True

    def delete(self):
        sel = self.tree.selection()
        if not sel:
            self.say("Select a stop in the list first")
            return
        idx = int(sel[0])
        name = self.stops[idx].get("name", "this stop")
        if not messagebox.askyesno("Delete", f'Delete "{name}"?'):
            return
        del self.stops[idx]
        self.clear_form()
        self.refresh_list()
        self.set_dirty()
        self.say(f'Deleted "{name}"')


# ------------------------------------------------------ compare & merge ----
EMPTY = (None, "", [], {})
SKIP_FIELDS = {"id"}          # ids may differ between the two files; stops are matched by id, then name


def _norm_name(s):
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def _same(a, b):
    """Equal, treating None / "" / [] / {} as 'not set' and floats with a tiny tolerance."""
    if isinstance(a, str):
        a = a.strip()
    if isinstance(b, str):
        b = b.strip()
    if a in EMPTY and b in EMPTY:
        return True
    num = lambda x: isinstance(x, (int, float)) and not isinstance(x, bool)
    if num(a) and num(b):
        return abs(a - b) < 1e-6
    return a == b


def load_saved_stops(json_path, sample):
    """Read a saved JSON export and return (stops, is_delta).
    Delta exports are rebuilt on top of `sample`, so unchanged sample stops come out identical."""
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)
    d = data.get("delta") if isinstance(data, dict) else None
    if isinstance(d, dict):
        if (d.get("base") or "sample") == "sample":
            return apply_delta(d, sample), True
        return list((d.get("places") or {}).get("added", [])), False
    return locate_stops(data)[0], False


def compare_stops(sample, saved, is_delta=False):
    """Compare saved stops with the built-in sample.
    Returns (items, identical_count). Each item:
      kind    'new' (only in saved) | 'changed' (in both, fields differ) | 'removed' (delete from sample)
      saved   the stop from the saved file (None for 'removed')
      idx     index of the matching stop in `sample` (None for 'new')
      fields  {field: selected?} for 'changed' items
      checked whether the item will be merged
    'removed' is only reported for delta exports, where the app really recorded a deletion."""
    by_id = {p.get("id"): i for i, p in enumerate(sample) if isinstance(p, dict)}
    by_name = {}
    for i, p in enumerate(sample):
        if isinstance(p, dict):
            by_name.setdefault(_norm_name(p.get("name")), i)
    used, items, same = set(), [], 0
    for p in saved:
        if not isinstance(p, dict):
            continue
        i = by_id.get(p.get("id"))
        if i is None or i in used:
            i = by_name.get(_norm_name(p.get("name")))
            if i in used:
                # same stop listed twice (e.g. an id clash in the export): ignore it if it adds nothing
                if all(_same(sample[i].get(k), p.get(k)) for k in (set(sample[i]) | set(p)) - SKIP_FIELDS):
                    same += 1
                    continue
                i = None
        if i is None:
            items.append({"kind": "new", "saved": p, "idx": None, "fields": {}, "checked": True})
            continue
        used.add(i)
        base = sample[i]
        diffs = {k: True for k in sorted((set(base) | set(p)) - SKIP_FIELDS)
                 if not _same(base.get(k), p.get(k))}
        if diffs:
            items.append({"kind": "changed", "saved": p, "idx": i, "fields": diffs, "checked": True})
        else:
            same += 1
    if is_delta:
        for i, p in enumerate(sample):
            if isinstance(p, dict) and i not in used:
                items.append({"kind": "removed", "saved": None, "idx": i, "fields": {}, "checked": False})
    return items, same


def apply_merge(sample, items):
    """Return (new_sample_list, stats) with the checked items merged in. `sample` is not modified."""
    out = copy.deepcopy(sample)
    ids = {p.get("id") for p in out if isinstance(p, dict)}
    drop, st = set(), {"added": 0, "changed": 0, "removed": 0}
    for it in items:
        if it["kind"] == "new" and it["checked"]:
            p = copy.deepcopy(it["saved"])
            if not p.get("id") or p["id"] in ids:
                root = str(p.get("id") or int(time.time() * 1000))
                nid, n = root + "-m", 2
                while nid in ids:
                    nid, n = f"{root}-m{n}", n + 1
                p["id"] = nid
            ids.add(p["id"])
            out.append(p)
            st["added"] += 1
        elif it["kind"] == "changed":
            picked = [f for f, on in it["fields"].items() if on]
            for f in picked:
                if f in it["saved"]:
                    out[it["idx"]][f] = copy.deepcopy(it["saved"][f])
                else:
                    out[it["idx"]].pop(f, None)
            if picked:
                st["changed"] += 1
        elif it["kind"] == "removed" and it["checked"]:
            drop.add(it["idx"])
            st["removed"] += 1
    if drop:
        out = [p for i, p in enumerate(out) if i not in drop]
    return out, st


def _show(v, n=140):
    if v in EMPTY:
        return ""
    s = json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else str(v)
    s = s.replace("\n", " ⏎ ")
    return s if len(s) <= n else s[:n] + "…"


class MergeDialog(tk.Toplevel):
    """Compare sample-places.js with a saved JSON export and move chosen items into the sample."""
    KIND = {"new": "New", "changed": "Changed", "removed": "Removed"}

    def __init__(self, app):
        super().__init__(app)
        self.app = app
        self.items, self.sample, self.same, self.shown = [], [], 0, None
        self.title("Compare & merge into sample-places.js")
        self.configure(bg=BG)
        self.transient(app)
        self.minsize(980, 600)
        self.geometry(f"1180x720+{app.winfo_x() + 40}+{app.winfo_y() + 40}")
        self.sample_var = tk.StringVar(value=app.sample_path or "")
        self.json_var = tk.StringVar(value=app.path if (app.path and not app.js_mode) else "")
        self.columnconfigure(0, weight=1)
        self.rowconfigure(1, weight=1)
        self.build()
        if self.sample_var.get() and self.json_var.get():
            self.after(100, self.run_compare)

    # ---------------------------------------------------------------- layout
    def build(self):
        top = tk.Frame(self, bg=SURFACE, highlightbackground=BORDER, highlightthickness=1)
        top.grid(row=0, column=0, sticky="ew", padx=16, pady=(16, 8))
        top.columnconfigure(1, weight=1)
        rows = [("Built-in sample (sample-places.js)", self.sample_var,
                 [("sample-places.js", "*.js"), ("All files", "*.*")]),
                ("Saved export (.json)", self.json_var,
                 [("JSON", "*.json"), ("All files", "*.*")])]
        for r, (label, var, kinds) in enumerate(rows):
            ttk.Label(top, text=label, style="Card.TLabel").grid(row=r, column=0, sticky="w", padx=(14, 10), pady=8)
            ttk.Entry(top, textvariable=var).grid(row=r, column=1, sticky="ew", pady=8)
            ttk.Button(top, text="Browse…", style="Small.TButton",
                       command=lambda v=var, k=kinds: self.browse(v, k)).grid(row=r, column=2, padx=8)
        ttk.Button(top, text="Compare", style="Primary.TButton",
                   command=self.run_compare).grid(row=0, column=3, rowspan=2, padx=14)

        mid = tk.PanedWindow(self, orient="horizontal", bg=BG, sashwidth=8, bd=0, sashrelief="flat")
        mid.grid(row=1, column=0, sticky="nsew", padx=16, pady=8)

        # left: list of differences
        left = tk.Frame(mid, bg=SURFACE, highlightbackground=BORDER, highlightthickness=1)
        left.columnconfigure(0, weight=1)
        left.rowconfigure(1, weight=1)
        ttk.Label(left, text="Differences  (click the box to include / exclude)",
                  style="Muted.Card.TLabel").grid(row=0, column=0, sticky="w", padx=12, pady=(10, 6))
        self.tree = ttk.Treeview(left, columns=("ck", "kind", "name", "what"), show="headings", selectmode="browse")
        for c, t, w, stretch in (("ck", "", 44, False), ("kind", "Type", 80, False),
                                 ("name", "Name", 210, True), ("what", "What differs", 220, True)):
            self.tree.heading(c, text=t, anchor="w")
            self.tree.column(c, width=w, minwidth=40, anchor="center" if c == "ck" else "w", stretch=stretch)
        self.tree.tag_configure("new", background="#e6f2e8")
        self.tree.tag_configure("changed", background=ACCENT_SOFT)
        self.tree.tag_configure("removed", background=DANGER_SOFT)
        vs = ttk.Scrollbar(left, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vs.set)
        self.tree.grid(row=1, column=0, sticky="nsew", padx=(1, 0), pady=(0, 1))
        vs.grid(row=1, column=1, sticky="ns", pady=(0, 1), padx=(0, 1))
        self.tree.bind("<Button-1>", self.on_tree_click)
        self.tree.bind("<<TreeviewSelect>>", self.on_tree_select)
        self.tree.bind("<space>", self.on_tree_space)
        mid.add(left, minsize=380, stretch="always")

        # right: field-by-field detail
        right = tk.Frame(mid, bg=SURFACE, highlightbackground=BORDER, highlightthickness=1)
        right.columnconfigure(0, weight=1)
        right.rowconfigure(1, weight=1)
        self.detail_lbl = ttk.Label(right, text="Select a row to see the details", style="Muted.Card.TLabel")
        self.detail_lbl.grid(row=0, column=0, sticky="w", padx=12, pady=(10, 6))
        self.ftree = ttk.Treeview(right, columns=("ck", "field", "sample", "saved"), show="headings", selectmode="browse")
        for c, t, w, stretch in (("ck", "", 44, False), ("field", "Field", 90, False),
                                 ("sample", "In sample-places.js", 230, True), ("saved", "In saved JSON", 230, True)):
            self.ftree.heading(c, text=t, anchor="w")
            self.ftree.column(c, width=w, minwidth=40, anchor="center" if c == "ck" else "w", stretch=stretch)
        fs = ttk.Scrollbar(right, orient="vertical", command=self.ftree.yview)
        self.ftree.configure(yscrollcommand=fs.set)
        self.ftree.grid(row=1, column=0, sticky="nsew", padx=(1, 0), pady=(0, 1))
        fs.grid(row=1, column=1, sticky="ns", pady=(0, 1), padx=(0, 1))
        self.ftree.bind("<Button-1>", self.on_field_click)
        mid.add(right, minsize=380, stretch="always")

        # bottom bar
        bar = tk.Frame(self, bg=BG)
        bar.grid(row=2, column=0, sticky="ew", padx=16, pady=(0, 14))
        self.summary = ttk.Label(bar, text="Pick both files and press Compare.", foreground=MUTED)
        self.summary.pack(side="left")
        ttk.Button(bar, text="Close", command=self.destroy).pack(side="right")
        self.merge_btn = ttk.Button(bar, text="Merge selected into sample", style="Primary.TButton",
                                    command=self.do_merge, state="disabled")
        self.merge_btn.pack(side="right", padx=8)
        ttk.Button(bar, text="Only new", command=lambda: self.select_where(lambda it: it["kind"] == "new")
                   ).pack(side="right", padx=(0, 4))
        ttk.Button(bar, text="Select none", command=lambda: self.select_where(lambda it: False)
                   ).pack(side="right", padx=4)
        ttk.Button(bar, text="Select all", command=lambda: self.select_where(lambda it: it["kind"] != "removed")
                   ).pack(side="right", padx=4)

    def browse(self, var, kinds):
        p = filedialog.askopenfilename(parent=self, filetypes=kinds)
        if p:
            var.set(p)

    # --------------------------------------------------------------- compare
    def run_compare(self):
        sp, jp = self.sample_var.get().strip(), self.json_var.get().strip()
        if not (os.path.isfile(sp) and os.path.isfile(jp)):
            messagebox.showwarning("Pick both files", "Choose sample-places.js and the saved .json file.", parent=self)
            return
        try:
            self.sample = load_sample_places(sp)
            saved, is_delta = load_saved_stops(jp, self.sample)
        except Exception as e:
            messagebox.showerror("Can't compare", str(e), parent=self)
            return
        self.items, self.same = compare_stops(self.sample, saved, is_delta)
        self.fill()

    def fill(self):
        self.tree.delete(*self.tree.get_children())
        self.ftree.delete(*self.ftree.get_children())
        self.shown = None
        self.detail_lbl.config(text="Select a row to see the details")
        for i, it in enumerate(self.items):
            src = it["saved"] if it["saved"] is not None else self.sample[it["idx"]]
            if it["kind"] == "changed":
                names = list(it["fields"])
                what = f"{len(names)} field(s): " + ", ".join(names)
            elif it["kind"] == "new":
                what = "not in the sample yet"
            else:
                what = "deleted in the saved file"
            self.tree.insert("", "end", iid=str(i), tags=(it["kind"],),
                             values=("☑" if it["checked"] else "☐", self.KIND[it["kind"]], src.get("name", ""), what))
        self.update_summary()

    def update_summary(self):
        n = lambda k: sum(1 for it in self.items if it["kind"] == k)
        sel = sum(1 for it in self.items if it["checked"])
        self.summary.config(text=f"{n('new')} new · {n('changed')} changed · {n('removed')} removed · "
                                 f"{self.same} identical    —    {sel} selected")
        self.merge_btn.config(state="normal" if sel else "disabled")

    # ----------------------------------------------------------- interaction
    def on_tree_click(self, e):
        if self.tree.identify_region(e.x, e.y) == "cell" and self.tree.identify_column(e.x) == "#1":
            iid = self.tree.identify_row(e.y)
            if iid:
                self.toggle_item(int(iid))

    def on_tree_space(self, _e=None):
        sel = self.tree.selection()
        if sel:
            self.toggle_item(int(sel[0]))
        return "break"

    def toggle_item(self, i):
        it = self.items[i]
        it["checked"] = not it["checked"]
        for f in it["fields"]:
            it["fields"][f] = it["checked"]
        self.refresh_row(i)
        if self.shown == i:
            self.show_detail(i)
        self.update_summary()

    def refresh_row(self, i):
        self.tree.set(str(i), "ck", "☑" if self.items[i]["checked"] else "☐")

    def select_where(self, pred):
        for i, it in enumerate(self.items):
            it["checked"] = bool(pred(it))
            for f in it["fields"]:
                it["fields"][f] = it["checked"]
            self.refresh_row(i)
        if self.shown is not None:
            self.show_detail(self.shown)
        self.update_summary()

    def on_tree_select(self, _e=None):
        sel = self.tree.selection()
        if sel:
            self.show_detail(int(sel[0]))

    def show_detail(self, i):
        it = self.items[i]
        self.shown = i
        self.ftree.delete(*self.ftree.get_children())
        old = self.sample[it["idx"]] if it["idx"] is not None else {}
        new = it["saved"] or {}
        keys = list(it["fields"]) if it["kind"] == "changed" else sorted((set(old) | set(new)) - SKIP_FIELDS)
        for k in keys:
            ck = ("☑" if it["fields"][k] else "☐") if it["kind"] == "changed" else ""
            self.ftree.insert("", "end", iid=k, values=(ck, k, _show(old.get(k)), _show(new.get(k))))
        name = new.get("name") or old.get("name") or ""
        hint = "  — tick the fields to copy" if it["kind"] == "changed" else ""
        self.detail_lbl.config(text=f"{self.KIND[it['kind']]}: {name}{hint}")

    def on_field_click(self, e):
        if self.shown is None or self.ftree.identify_region(e.x, e.y) != "cell":
            return
        if self.ftree.identify_column(e.x) != "#1":
            return
        f = self.ftree.identify_row(e.y)
        it = self.items[self.shown]
        if f and it["kind"] == "changed" and f in it["fields"]:
            it["fields"][f] = not it["fields"][f]
            it["checked"] = any(it["fields"].values())
            self.ftree.set(f, "ck", "☑" if it["fields"][f] else "☐")
            self.refresh_row(self.shown)
            self.update_summary()

    # ----------------------------------------------------------------- merge
    def do_merge(self):
        sp = self.sample_var.get().strip()
        new_list, st = apply_merge(self.sample, self.items)
        if not any(st.values()):
            return
        msg = (f"Write into\n{sp}\n\n  {st['added']} stop(s) added\n  {st['changed']} stop(s) updated\n"
               f"  {st['removed']} stop(s) removed\n\nThe old file is kept as sample-places.js.bak.")
        if not messagebox.askyesno("Merge into sample", msg, parent=self):
            return
        try:
            write_sample_places(sp, new_list)
        except Exception as e:
            messagebox.showerror("Merge failed", str(e), parent=self)
            return
        self.app.after_merge(sp, new_list)
        self.app.say(f"Merged into {os.path.basename(sp)}: {st['added']} added, "
                     f"{st['changed']} updated, {st['removed']} removed. Reload the app.")
        self.run_compare()      # shows what is still different


if __name__ == "__main__":
    enable_dpi_awareness()
    App().mainloop()
