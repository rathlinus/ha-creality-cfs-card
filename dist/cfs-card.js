(() => {
  const Lit =
    window.LitElement ||
    Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
  const html = Lit.prototype.html;
  const css = Lit.prototype.css;

  const SLOT_FIELDS = [
    "percent",
    "type",
    "name",
    "color",
    "min_temp",
    "max_temp",
    "selected",
    "state",
  ];

  // ----- color helpers -----
  function hexToHSL(hex) {
    if (!hex) return { h: 0, s: 0, l: 0.5 };
    let h = String(hex).replace(/^#/, "").trim();
    if (![3, 6].includes(h.length)) return { h: 0, s: 0, l: 0.5 };
    if (h.length === 3)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    const d = max - min;
    let H = 0;
    const L = (max + min) / 2;
    const S = d === 0 ? 0 : d / (1 - Math.abs(2 * L - 1));
    if (d !== 0) {
      switch (max) {
        case r:
          H = ((g - b) / d) % 6;
          break;
        case g:
          H = (b - r) / d + 2;
          break;
        case b:
          H = (r - g) / d + 4;
          break;
      }
      H *= 60;
      if (H < 0) H += 360;
    }
    return { h: H, s: S, l: L };
  }

  // Calibrated filter from pure red (#FF0000, H=0 S=1 L=0.5) to target hex.
  // Tunables live in _config.tint_* with sensible defaults.
  function filterFromRedTo(hex, cfg) {
    const { h, s, l } = hexToHSL(hex);
    const hue = Math.round(((h % 360) + 360) % 360);

    // These biases make bright yellows/greens come out bright enough
    // and deep blues not get washed out.
    const sat = cfg.saturation_base + s * cfg.saturation_gain;
    const bri = cfg.brightness_base + l * cfg.brightness_gain;
    const con = cfg.contrast;

    const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
    const sVal = clamp(sat, 0.2, 3);
    const bVal = clamp(bri, 0.3, 2.5);
    const cVal = clamp(con, 0.5, 2);

    return `hue-rotate(${hue}deg) saturate(${sVal.toFixed(
      3
    )}) brightness(${bVal.toFixed(3)}) contrast(${cVal.toFixed(3)})`;
  }

  function normHex(c) {
    if (!c) return undefined;
    let s = String(c).trim();
    if (s.startsWith("#")) s = s.slice(1);
    if (s.length >= 6) s = s.slice(-6);
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return undefined;
    return "#" + s.toLowerCase();
  }

  class CFSCard extends Lit {
    static get properties() {
      return {
        hass: {},
        _config: {},
        _printers: { type: Array },
        _printerKey: { type: String },
        _boxes: { type: Array },
        _boxId: { type: Number },
        _data: { type: Object },
      };
    }

    static get styles() {
      return css`
        ha-card {
          overflow: hidden;
        }

        /* ── top bar ───────────────── */
        .bar {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 10px;
          border-bottom: 1px solid var(--divider-color);
        }
        .title {
          font-weight: 600;
          font-size: 14px;
        }
        .spacer {
          flex: 1;
        }
        select {
          border: 1px solid var(--divider-color);
          border-radius: 8px;
          padding: 4px 6px;
          font-size: 12px;
          background: var(--card-background-color);
          color: var(--primary-text-color);
        }

        /* ── stage (assets 1100×800 → 11:8) ───────── */
        .stage {
          position: relative;
          width: 100%;
          aspect-ratio: 11 / 8;
          max-height: 380px; /* was 460 */
          isolation: isolate;
        }
        .layer {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          pointer-events: none;
        }
        .layer img {
          width: 100%;
          height: 100%;
          object-fit: contain;
          image-rendering: -webkit-optimize-contrast;
        }

        /* mask color + frame */
        .layer .ink,
        .layer .frameimg {
          width: 100%;
          height: 100%;
          background-position: center;
          background-size: contain;
          background-repeat: no-repeat;
        }
        .layer .ink {
          background: var(--ink, transparent);
          -webkit-mask-image: var(--img);
          mask-image: var(--img);
          -webkit-mask-position: center;
          mask-position: center;
          -webkit-mask-size: contain;
          mask-size: contain;
          -webkit-mask-repeat: no-repeat;
          mask-repeat: no-repeat;
        }
        .layer .frameimg {
          background-image: var(--img);
        }

        /* chips */
        .chips {
          position: absolute;
          left: 8px;
          bottom: 8px;
          display: flex;
          gap: 6px;
          pointer-events: none;
        }
        .chip {
          pointer-events: none;
          backdrop-filter: blur(5px);
          background: color-mix(
            in srgb,
            var(--card-background-color) 75%,
            transparent
          );
          border: 1px solid var(--divider-color);
          border-radius: 10px;
          padding: 4px 8px;
          font-size: 11px;
        }

        /* ── slots (compact) ───────── */
        .slots {
          --tile-bg: color-mix(
            in srgb,
            var(--card-background-color) 90%,
            transparent
          );
          --tile-border: color-mix(
            in srgb,
            var(--divider-color) 70%,
            transparent
          );
          padding: 10px;
          display: grid;
          gap: 8px;
          grid-template-columns: repeat(
            auto-fit,
            minmax(120px, 1fr)
          ); /* denser */
        }

        .slot {
          position: relative;
          border: 1px solid var(--tile-border);
          border-radius: 12px;
          background: var(--tile-bg);
          padding: 10px;
          display: grid;
          gap: 6px;
          grid-template-rows: auto auto auto 1fr;
          box-shadow: 0 1px 8px rgba(0, 0, 0, 0.1);
          transition: transform 0.12s ease, box-shadow 0.12s ease;
        }
        .slot:hover {
          transform: translateY(-1px);
          box-shadow: 0 2px 12px rgba(0, 0, 0, 0.14);
        }

        .slothead {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 2px;
        }
        .slot h4 {
          margin: 0;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.25px;
          text-transform: uppercase;
          padding: 2px 6px;
          border-radius: 999px;
          background: color-mix(
            in srgb,
            var(--primary-text-color) 10%,
            transparent
          );
          color: var(--secondary-text-color);
        }
        .meta {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .swatch {
          width: 14px;
          height: 14px;
          border-radius: 4px;
          box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25) inset;
        }
        .badge {
          font-size: 10px;
          font-weight: 700;
          padding: 2px 6px;
          border-radius: 999px;
          border: 1px solid var(--divider-color);
          background: color-mix(in srgb, var(--primary-color) 16%, transparent);
        }

        .type {
          font-weight: 800;
          font-size: 13px;
          letter-spacing: 0.1px;
        }
        .name {
          font-size: 11px;
          color: var(--secondary-text-color);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        /* progress bar (thin) */
        .barwrap {
          width: 100%;
          height: 6px;
          border-radius: 999px;
          overflow: hidden;
          background: color-mix(
            in srgb,
            var(--primary-text-color) 14%,
            transparent
          );
        }
        .barfill {
          height: 100%;
          width: 0%;
          background: linear-gradient(
            90deg,
            color-mix(in srgb, var(--primary-color) 78%, transparent),
            color-mix(
              in srgb,
              var(--primary-color) 52%,
              var(--secondary-background-color)
            )
          );
          transition: width 0.25s ease;
        }

        /* compact key-values: two pairs per row */
        .kvs {
          display: grid;
          grid-template-columns: repeat(2, 1fr); /* two pairs per row */
          row-gap: 10px;
          column-gap: 16px;
          font-size: 11px;
          font-variant-numeric: tabular-nums;
          padding: 6px 8px;
          margin-top: 2px;
          border-radius: 8px;
          border: 1px solid var(--tile-border);
          background: color-mix(
            in srgb,
            var(--card-background-color) 88%,
            transparent
          );
        }
        .kvs label {
          color: var(--secondary-text-color);
        }
        .kvs > div {
          justify-self: end;
          font-weight: 700;
        }

        @media (max-width: 900px) {
          .slots {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
        @media (max-width: 520px) {
          .slots {
            grid-template-columns: 1fr;
          }
        }
      `;
    }

    setConfig(config) {
      this._config = {
        title: config.title ?? "Creality CFS Test",
        images_path:
          (
            config.images_path ??
            "https://raw.githubusercontent.com/rathlinus/ha-creality-cfs-card/refs/heads/main/assets"
          ).replace(/\/+$/, "") + "/",
        filter_prefix: config.filter_prefix ?? "",
        default_printer: config.default_printer,
        default_box: config.default_box,

        // Tint calibration (tweak here or via YAML config)
        saturation_base: Number.isFinite(config.saturation_base)
          ? config.saturation_base
          : 0.85,
        saturation_gain: Number.isFinite(config.saturation_gain)
          ? config.saturation_gain
          : 0.6,
        brightness_base: Number.isFinite(config.brightness_base)
          ? config.brightness_base
          : 0.6,
        brightness_gain: Number.isFinite(config.brightness_gain)
          ? config.brightness_gain
          : 1.6,
        contrast: Number.isFinite(config.contrast) ? config.contrast : 1.08,
      };
    }

    getCardSize() {
      return 6;
    }

    set hass(hass) {
      this._hass = hass;
      if (!hass) return;

      const printers = this._detectPrinters(hass);
      const prevPrinter = this._printerKey;
      const prevBox = this._boxId;
      this._printers = printers;

      if (printers.length === 0) {
        this._printerKey = undefined;
        this._boxes = [];
        this._boxId = undefined;
        this._data = undefined;
        return;
      }
      if (!this._printerKey) {
        const want =
          this._config.default_printer &&
          printers.find((p) => p.key.includes(this._config.default_printer));
        this._printerKey = (want || printers[0]).key;
      } else if (!printers.some((p) => p.key === this._printerKey)) {
        this._printerKey = printers[0].key;
      }

      const current = printers.find((p) => p.key === this._printerKey);
      this._boxes = current ? current.boxes : [];
      if (!this._boxes.length) {
        this._boxId = undefined;
        this._data = undefined;
      } else {
        if (!this._boxId) {
          this._boxId =
            this._config.default_box &&
            this._boxes.includes(Number(this._config.default_box))
              ? Number(this._config.default_box)
              : this._boxes[0];
        } else if (!this._boxes.includes(this._boxId)) {
          this._boxId = this._boxes[0];
        }
        this._data = this._collectData(hass, this._printerKey, this._boxId);
      }
      if (prevPrinter !== this._printerKey || prevBox !== this._boxId)
        this.requestUpdate();
    }

    render() {
      const p = this._printers ?? [];
      const pk = this._printerKey;
      const boxes = this._boxes ?? [];
      const box = this._boxId;
      const d = this._data;

      return html`
        <ha-card>
          <div class="bar">
            <div class="title">${this._config.title}</div>
            <div class="spacer"></div>
            <select @change=${this._onPrinterChange}>
              ${p.map(
                (it) =>
                  html`<option value=${it.key} ?selected=${it.key === pk}>
                    ${it.label}
                  </option>`
              )}
            </select>
            ${boxes.length
              ? html` <select
                  style="margin-left:8px"
                  @change=${this._onBoxChange}
                >
                  ${boxes.map(
                    (b) =>
                      html`<option value=${b} ?selected=${b === box}>
                        CFS ${b}
                      </option>`
                  )}
                </select>`
              : html``}
          </div>

          ${d
            ? html`
                <div class="stage">
                  ${[0, 1, 2, 3].map((i) => {
                    const color = d.slots[i]?.color;
                    const img = `${this._config.images_path}${i}.png`;
                    const visible = color ? 1 : 0.12;
                    return html` <div class="layer">
                      <div
                        class="ink"
                        style="--ink:${color ??
                        "transparent"}; --img:url('${img}'); opacity:${visible}"
                      ></div>
                    </div>`;
                  })}

                  <div class="layer">
                    <img
                      class="frame"
                      draggable="false"
                      src="${this._config.images_path}cfs.png"
                      alt="cfs"
                    />
                  </div>
                  <div class="chips">
                    <div class="chip">Temp: ${d.temp ?? "—"}°C</div>
                    <div class="chip">Humidity: ${d.humidity ?? "—"}%</div>
                  </div>
                </div>

                <div class="slots">
                  ${[0, 1, 2, 3].map((i) => this._slotTile(d.slots[i], i))}
                </div>
              `
            : html``}
        </ha-card>
      `;
    }

    _slotTile(s = {}, i) {
      const pct = Number.isFinite(Number(s.percent))
        ? Number(s.percent)
        : undefined;
      return html`
        <div class="slot">
          <div class="slothead">
            <h4>Slot ${i}</h4>
            <div class="meta">
              <div class="swatch" style="background:${s.color || "#ccc"}"></div>
              ${Number(s.selected) === 1
                ? html`<div class="badge">Selected</div>`
                : html``}
            </div>
          </div>
          <div class="type">${s.type ?? "—"}</div>
          <div class="name">${s.name ?? "—"}</div>
          <div class="barwrap">
            <div class="barfill" style="width:${pct ?? 0}%"></div>
          </div>
          <div class="kvs">
            <label>Min Temp</label>
            <div>${s.min_temp ?? "—"}°C</div>
            <label>Max Temp</label>
            <div>${s.max_temp ?? "—"}°C</div>
          </div>
        </div>
      `;
    }

    _onPrinterChange(e) {
      this._printerKey = e.target.value;
      const item = this._printers.find((p) => p.key === this._printerKey);
      this._boxes = item ? item.boxes : [];
      this._boxId = this._boxes[0];
      this._data = this._collectData(this._hass, this._printerKey, this._boxId);
      this.requestUpdate();
    }
    _onBoxChange(e) {
      this._boxId = Number(e.target.value);
      this._data = this._collectData(this._hass, this._printerKey, this._boxId);
      this.requestUpdate();
    }

    _detectPrinters(hass) {
      const printers = new Map();
      // 1) key + optional _<box> + metric
      const re = /^sensor\.(.+?)_cfs_(?:(\d+)_)?(temperature|humidity)$/;
      // 2) compact box form: _cfs<box>_
      const reCompact = /^sensor\.(.+?)_cfs(\d+)_(temperature|humidity)$/;

      for (const [eid] of Object.entries(hass.states)) {
        if (!eid.startsWith("sensor.")) continue;
        if (
          this._config.filter_prefix &&
          !eid.includes(this._config.filter_prefix)
        )
          continue;

        let m = eid.match(re);
        let key, box;
        if (m) {
          key = m[1];
          box = m[2] ? Number(m[2]) : 0;
        } else {
          const mc = eid.match(reCompact);
          if (mc) {
            key = mc[1];
            box = Number(mc[2]);
          } else {
            continue;
          }
        }
        if (!printers.has(key)) printers.set(key, new Set());
        printers.get(key).add(box);
      }

      const arr = [];
      for (const [key, set] of printers.entries()) {
        arr.push({
          key,
          label: this._prettyKey(key),
          boxes: [...set].sort((a, b) => a - b),
        });
      }
      arr.sort((a, b) =>
        a.label.localeCompare(b.label, undefined, { numeric: true })
      );
      return arr;
    }

    _prettyKey(k) {
      return k.replace(/[_\.]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }

    _collectData(hass, key, boxId) {
      const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      const valueOf = (pattern) => {
        const tries = [
          new RegExp(`^sensor\\.${esc(key)}_cfs_${boxId}_${pattern}$`), // standard
          new RegExp(`^sensor\\.${esc(key)}_cfs${boxId}_${pattern}$`), // compact box
          new RegExp(`^sensor\\.${esc(key)}_cfs_${pattern}$`), // no box id
        ];
        for (const [eid, st] of Object.entries(hass.states)) {
          if (!eid.startsWith("sensor.")) continue;
          if (tries.some((re) => re.test(eid))) {
            const v = st.state;
            if (v === "unknown" || v === "unavailable") return undefined;
            const n = Number(v);
            return Number.isFinite(n) ? n : v;
          }
        }
        return undefined;
      };

      const slotVal = (i, f) => {
        // Try slot_0_percent, then slot0_percent
        return valueOf(`slot_${i}_${f}`) ?? valueOf(`slot${i}_${f}`);
      };

      const data = {
        temp: valueOf("temperature"),
        humidity: valueOf("humidity"),
        slots: {},
      };
      for (let i = 0; i < 4; i++) {
        const slot = {};
        for (const f of SLOT_FIELDS) slot[f] = slotVal(i, f);
        slot.color = normHex(slot.color);
        data.slots[i] = slot;
      }
      return data;
    }

    _esc(s) {
      return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }

  customElements.define("cfs-card", CFSCard);
  if (window.customCards) {
    window.customCards.push({
      type: "cfs-card",
      name: "Creality CFS Card",
      description: "Creality CFS Card",
    });
  }
})();
