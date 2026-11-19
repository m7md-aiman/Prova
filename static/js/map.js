/* ProvaMap: Leaflet map of the 1064 junction drawn from results.json.
   Layers, bottom to top: base tiles, road lanes (geo.base), works, queue heatmap. */
(function () {
  "use strict";

  // Sequential single-hue ramp (validated default blue, light -> dark).
  const RAMP = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5",
                "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"];
  const ASPHALT = "#a9a8a2";
  const WORK_ZONE = [600, 760, 800, 1010];          // x0, x1, y0, y1 (brief §9)
  const APPROACH_ANGLE = { A: 25, B: 200, C: 115, D: 293 }; // degrees, measured from the lane geometry
  const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  const RAMP_RGB = RAMP.map(hexToRgb);
  function heatColor(v) {
    const t = Math.max(0, Math.min(100, v)) / 100 * (RAMP.length - 1);
    const i = Math.min(Math.floor(t), RAMP.length - 2), f = t - i;
    const a = RAMP_RGB[i], b = RAMP_RGB[i + 1];
    const c = a.map((x, k) => Math.round(x + (b[k] - x) * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  class Projector {
    constructor(p) {
      this.def = p.proj4; this.off = p.netOffset;
    }
    toLatLng(x, y) {
      const [lon, lat] = proj4(this.def, "WGS84", [x - this.off[0], y - this.off[1]]);
      return [lat, lon];
    }
    toNet(lon, lat) {
      const [e, n] = proj4("WGS84", this.def, [lon, lat]);
      return [e + this.off[0], n + this.off[1]];
    }
    line(flat) {
      const out = [];
      for (let i = 0; i + 1 < flat.length; i += 2) out.push(this.toLatLng(flat[i], flat[i + 1]));
      return out;
    }
    bounds(x0, x1, y0, y1) {
      return L.latLngBounds([this.toLatLng(x0, y0), this.toLatLng(x1, y0), this.toLatLng(x0, y1), this.toLatLng(x1, y1)]);
    }
  }

  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
    let t = L2 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  let mapSeq = 0;

  class ProvaMap {
    constructor(el, data, content, opts = {}) {
      this.el = el; this.data = data; this.content = content;
      this.id = ++mapSeq;
      this.proj = new Projector(data.projection);
      this.laneW = data.lane_width_m;
      this.showHeat = true;
      this.cellKey = null;

      this.map = L.map(el, {
        zoomSnap: 0.25, zoomDelta: 0.5, maxZoom: 20, minZoom: 13,
        attributionControl: true, zoomControl: !opts.noZoomControl,
      });
      this.map.attributionControl.setPrefix(false);
      this.renderer = L.svg({ padding: 0.5 }).addTo(this.map);

      this._initTiles();
      this.fitView(false);
      this._injectDefs();

      this.laneLayer = L.layerGroup().addTo(this.map);
      this.worksLayer = L.layerGroup().addTo(this.map);
      this.heatLayer = L.layerGroup().addTo(this.map);
      this.labelLayer = L.layerGroup().addTo(this.map);
      this.worksMarkers = L.layerGroup().addTo(this.map);

      this._drawLanes();
      this._drawSignalAndApproaches();
      this._addScale();
      this.map.on("zoomend", () => this._restyle());
      this.selfCheck = this._checkProjection();
    }

    /* ---------- base map ---------- */
    _initTiles() {
      let loaded = 0, failed = 0;
      const t = L.tileLayer(TILE_URL, { maxNativeZoom: 19, maxZoom: 20, attribution: TILE_ATTR });
      t.on("tileload", () => { loaded++; this.el.classList.remove("no-tiles"); });
      t.on("tileerror", () => { failed++; if (!loaded) this.el.classList.add("no-tiles"); });
      t.addTo(this.map);
      // If nothing arrived after a while (blocked network), fall back to the lane backdrop.
      setTimeout(() => { if (!loaded) this.el.classList.add("no-tiles"); }, 4000);
      const note = L.DomUtil.create("div", "tiles-note", this.el);
      note.textContent = "تعذّر تحميل الخريطة الأساسية؛ تُعرض مخططات المسارات فقط.";
    }

    _injectDefs() {
      const svg = this.renderer._container;
      const ns = "http://www.w3.org/2000/svg";
      const defs = document.createElementNS(ns, "defs");
      defs.innerHTML =
        `<pattern id="hatch-${this.id}" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
           <rect width="6" height="6" fill="#f2a900"></rect>
           <rect width="2.2" height="6" fill="#5a3b00"></rect>
         </pattern>`;
      svg.insertBefore(defs, svg.firstChild);
    }

    /* ---------- sizing ---------- */
    metresToPx(m) {
      const lat = this.map.getCenter().lat * Math.PI / 180;
      const mpp = 40075016.686 * Math.cos(lat) / Math.pow(2, this.map.getZoom() + 8);
      return m / mpp;
    }
    _laneWeight(min) { return Math.max(min, this.metresToPx(this.laneW)); }
    _restyle() {
      const w = this._laneWeight(1.6);
      this.laneLayer.eachLayer(l => l.setStyle({ weight: w }));
      const ww = this._laneWeight(3);
      this.worksLayer.eachLayer(l => l.setStyle({ weight: ww }));
      const hw = this._laneWeight(2.4);
      this.heatLayer.eachLayer(l => { if (l.options.className === "heat-hit") l.setStyle({ weight: Math.max(14, hw) }); else l.setStyle({ weight: hw }); });
      this.el.dataset.zoom = this.map.getZoom();
    }

    /* ---------- layer 1: lanes ---------- */
    _drawLanes() {
      const w = this._laneWeight(1.6);
      for (const flat of this.data.geo.base) {
        L.polyline(this.proj.line(flat), {
          renderer: this.renderer, color: ASPHALT, weight: w, opacity: 1,
          lineCap: "butt", lineJoin: "round", interactive: false,
        }).addTo(this.laneLayer);
      }
    }

    /* ---------- signal + approach labels ---------- */
    _drawSignalAndApproaches() {
      const [lon, lat] = this.data.projection.signal_1064_lonlat;
      L.marker([lat, lon], {
        icon: L.divIcon({ className: "sig-icon", html: '<span class="sig-dot"></span><span class="sig-text">1064</span>', iconSize: [64, 22], iconAnchor: [11, 11] }),
        keyboard: false, interactive: false, zIndexOffset: 500,
      }).addTo(this.labelLayer);

      const [sx, sy] = this.proj.toNet(lon, lat);
      for (const [k, name] of Object.entries(this.content.approaches)) {
        const a = APPROACH_ANGLE[k] * Math.PI / 180, r = 400;
        // Offset sideways so the label does not sit on the road.
        const px = sx + r * Math.cos(a) - 55 * Math.sin(a), py = sy + r * Math.sin(a) + 55 * Math.cos(a);
        L.marker(this.proj.toLatLng(px, py), {
          icon: L.divIcon({ className: "appr-icon", html: `<div class="appr" dir="rtl"><b>${k}</b><span>${name}</span></div>`, iconSize: null, iconAnchor: [0, 0] }),
          keyboard: false, interactive: false,
        }).addTo(this.labelLayer);
      }
    }

    _checkProjection() {
      // The junction from signal_1064_lonlat must land on the lane network.
      const [lon, lat] = this.data.projection.signal_1064_lonlat;
      const [x, y] = this.proj.toNet(lon, lat);
      let best = Infinity;
      for (const f of this.data.geo.base)
        for (let i = 0; i + 3 < f.length; i += 2) best = Math.min(best, distToSeg(x, y, f[i], f[i + 1], f[i + 2], f[i + 3]));
      const [vx0, vx1, vy0, vy1] = this.data.view;
      const res = { net: [Math.round(x * 10) / 10, Math.round(y * 10) / 10], nearest_lane_m: Math.round(best * 10) / 10,
                    inside_view: x >= vx0 && x <= vx1 && y >= vy0 && y <= vy1 };
      this.el.dataset.projCheck = JSON.stringify(res);
      return res;
    }

    /* ---------- scale bar (Arabic) ---------- */
    _addScale() {
      const Scale = L.Control.extend({
        options: { position: "bottomleft" },
        onAdd: (map) => {
          const div = L.DomUtil.create("div", "scale-ar");
          const upd = () => {
            const target = 110, mPerPx = 1 / this.metresToPx(1);
            const raw = target * mPerPx, p = Math.pow(10, Math.floor(Math.log10(raw)));
            const nice = [1, 2, 5, 10].map(m => m * p).filter(v => v <= raw).pop();
            const w = nice / mPerPx;
            div.innerHTML = `<div class="scale-bar" style="width:${w.toFixed(0)}px"></div><span>${nice >= 1000 ? nice / 1000 + " كم" : nice + " م"}</span>`;
          };
          map.on("zoomend moveend", upd); upd();
          return div;
        },
      });
      new Scale().addTo(this.map);
    }

    /* ---------- view ---------- */
    fitView(animate = true) {
      const [x0, x1, y0, y1] = this.data.view;
      this.map.fitBounds(this.proj.bounds(x0, x1, y0, y1), { padding: [8, 8], animate });
    }
    zoomWorks() {
      const [x0, x1, y0, y1] = WORK_ZONE;
      this.map.fitBounds(this.proj.bounds(x0, x1, y0, y1), { padding: [20, 20] });
    }

    /* ---------- scenario ---------- */
    setCell(cellKey, { heat = true } = {}) {
      this.cellKey = cellKey; this.showHeat = heat;
      const cell = this.data.cells[cellKey];
      this.el.dataset.cell = cellKey;
      this._drawWorks(cell);
      this._drawHeat(heat ? cell : null);
    }

    _drawWorks(cell) {
      this.worksLayer.clearLayers(); this.worksMarkers.clearLayers();
      const items = cell.net === "before" ? [] : (this.data.works[cell.net] || []);
      this.el.dataset.worksCount = String(items.length);
      const w = this._laneWeight(3);
      for (const it of items) {
        L.polyline(this.proj.line(it.line), {
          renderer: this.renderer, color: `url(#hatch-${this.id})`, weight: w, opacity: 1,
          lineCap: "butt", lineJoin: "round", interactive: false, className: "works-band",
        }).addTo(this.worksLayer);
      }
      // One set of markers per closed stretch (lanes with the same id sit side by side).
      const groups = {};
      for (const it of items) (groups[it.id] = groups[it.id] || []).push(it);
      for (const [id, g] of Object.entries(groups)) {
        const ends = [[0, 1], [g[0].line.length - 2, g[0].line.length - 1]].map(([ix, iy]) => {
          let x = 0, y = 0; for (const it of g) { const n = it.line.length; x += it.line[ix >= n ? n - 2 : ix]; y += it.line[iy >= n ? n - 1 : iy]; }
          return [x / g.length, y / g.length];
        });
        for (const [x, y] of ends) {
          L.marker(this.proj.toLatLng(x, y), {
            icon: L.divIcon({ className: "cone-icon", html: CONE_SVG, iconSize: [16, 18], iconAnchor: [8, 14] }),
            keyboard: false, interactive: false,
          }).addTo(this.worksMarkers);
        }
        const mid = [(ends[0][0] + ends[1][0]) / 2, (ends[0][1] + ends[1][1]) / 2];
        const it = g[0];
        const count = g.length === 2 ? "مساران" : "مسار واحد";
        const west = id === "sb";
        L.marker(this.proj.toLatLng(mid[0], mid[1]), {
          icon: L.divIcon({
            className: "wz-icon " + (west ? "wz-west" : "wz-east"),
            html: `<div class="wz-label" dir="rtl"><span class="speed-sign"><span>${it.speed_kmh}</span></span>
                     <span class="wz-text"><b>${it.label}</b><small>نحو ${it.length_m} م · ${count}</small></span></div>`,
            iconSize: null, iconAnchor: [0, 0],
          }),
          keyboard: false, interactive: false, zIndexOffset: 300,
        }).addTo(this.worksMarkers);
      }
    }

    _drawHeat(cell) {
      this.heatLayer.clearLayers();
      this.el.classList.toggle("heat-off", !cell);
      if (!cell) { this.el.dataset.heatCount = "0"; return; }
      const h = cell.heat, pieces = [];
      for (let i = 0; i + 4 < h.length; i += 5) pieces.push([h[i], h[i + 1], h[i + 2], h[i + 3], h[i + 4]]);
      pieces.sort((a, b) => a[4] - b[4]); // darker pieces on top
      const w = this._laneWeight(2.4);
      for (const [x1, y1, x2, y2, v] of pieces) {
        const ll = [this.proj.toLatLng(x1, y1), this.proj.toLatLng(x2, y2)];
        L.polyline(ll, { renderer: this.renderer, color: heatColor(v), weight: w, opacity: 1, lineCap: "butt", interactive: false }).addTo(this.heatLayer);
      }
      // Wide invisible hit lines for hover / tap.
      for (const [x1, y1, x2, y2, v] of pieces) {
        const ll = [this.proj.toLatLng(x1, y1), this.proj.toLatLng(x2, y2)];
        L.polyline(ll, { renderer: this.renderer, color: "#000", opacity: 0, weight: Math.max(14, w), className: "heat-hit" })
          .bindTooltip(`<span dir="rtl">طابور واقف <b class="num">${v}%</b> من الفترة</span>`, { sticky: true, direction: "top", className: "heat-tip" })
          .addTo(this.heatLayer);
      }
      this.el.dataset.heatCount = String(pieces.length);
    }

    syncWith(other) {
      let lock = false;
      const link = (a, b) => a.map.on("move", () => {
        if (lock) return; lock = true;
        b.map.setView(a.map.getCenter(), a.map.getZoom(), { animate: false });
        lock = false;
      });
      link(this, other); link(other, this);
    }

    invalidate() { this.map.invalidateSize({ animate: false }); }
  }

  const CONE_SVG = '<svg viewBox="0 0 16 18" width="16" height="18" aria-hidden="true">' +
    '<path d="M8 1 L13 14 H3 Z" fill="#f2a900" stroke="#5a3b00" stroke-width="1.2" stroke-linejoin="round"/>' +
    '<path d="M5.6 8 H10.4" stroke="#fff" stroke-width="1.6"/>' +
    '<rect x="1" y="14" width="14" height="3" rx="1" fill="#5a3b00"/></svg>';

  window.ProvaMap = ProvaMap;
  window.ProvaHeat = { RAMP, heatColor };
})();
