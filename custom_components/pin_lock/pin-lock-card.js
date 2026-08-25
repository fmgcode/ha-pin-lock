class PinLockCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._pin = "";
    this._status = "idle";
    this._statusTimer = null;
  }

  setConfig(config) {
    this._config = {
      name: "Garaje",
      icon: "mdi:garage",
      pin_length: 8,
      display_mode: "keypad",
      status_entity: "",
      ...config,
    };
    // En modo tile arranca plegado; en modo keypad siempre expandido
    this._expanded = this._config.display_mode !== "tile";
  }

  static getConfigElement() {
    return document.createElement("pin-lock-card-editor");
  }

  static getStubConfig() {
    return {
      entry_id: "",
      name: "Garaje",
      icon: "mdi:garage",
      pin_length: 8,
      display_mode: "keypad",
    };
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._subscribeEvents();
      this._render();
    }
  }

  getCardSize() {
    return 5;
  }

  async _subscribeEvents() {
    if (this._unsub || this._subscribing) return;
    this._subscribing = true;
    try {
      this._unsub = await this._hass.connection.subscribeMessage(
        (ev) => {
          const data = ev && ev.data ? ev.data : {};
          if (data.entry_id === this._config.entry_id) {
            this._onResult(data);
          }
        },
        { type: "subscribe_events", event_type: "pin_lock_result" }
      );
    } catch (e) {
      this._subscribing = false;
    }
  }

  disconnectedCallback() {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    if (this._statusTimer) clearTimeout(this._statusTimer);
  }

  connectedCallback() {
    if (this._hass && !this._unsub) {
      this._subscribeEvents();
    }
  }

  _onResult(data) {
    if (this._checkTimeout) {
      clearTimeout(this._checkTimeout);
      this._checkTimeout = null;
    }
    if (data.result === "ok") {
      this._setStatus("ok");
    } else if (data.result === "locked") {
      this._setStatus("locked", data.retry_in);
    } else if (data.result === "fail") {
      this._setStatus("fail");
    } else {
      this._setStatus("error");
    }
    this._pin = "";
  }

  _setStatus(status, extra) {
    this._status = status;
    this._extra = extra;
    this._render();
    if (this._statusTimer) clearTimeout(this._statusTimer);
    if (status !== "locked") {
      this._statusTimer = setTimeout(() => {
        this._status = "idle";
        // En modo tile, tras un PIN correcto se repliega el teclado
        if (status === "ok" && this._config.display_mode === "tile") {
          this._expanded = false;
        }
        this._render();
      }, 1500);
    }
  }

  _press(digit) {
    if (this._status === "locked") return;
    // Límite máximo de dígitos (usa pin_length como tope, pero no autovalida)
    const maxLen = this._config.max_length || this._config.pin_length || 8;
    if (this._pin.length >= maxLen) return;
    this._pin += digit;
    this._render();
  }

  _backspace() {
    this._pin = this._pin.slice(0, -1);
    this._render();
  }

  async _submit() {
    if (this._status === "locked") return;
    const pin = this._pin;
    if (!pin || pin.length === 0) return;
    this._status = "checking";
    this._render();

    // Timeout de seguridad: si no llega el evento en 3s, salir de "comprobando"
    if (this._checkTimeout) clearTimeout(this._checkTimeout);
    this._checkTimeout = setTimeout(() => {
      if (this._status === "checking") {
        this._status = "idle";
        this._pin = "";
        this._render();
      }
    }, 3000);

    try {
      await this._hass.callService("pin_lock", "validate", {
        entry_id: this._config.entry_id,
        pin: pin,
      });
    } catch (e) {
      this._setStatus("error");
    }
  }

  _doorState() {
    const c = this._config;
    if (!c.status_entity) return null;
    const st = this._hass.states[c.status_entity];
    if (!st || ["unknown", "unavailable"].includes(st.state)) {
      return { open: null, text: "—", color: "var(--secondary-text-color)" };
    }
    const isOn = st.state === "on";
    // Texto: personalizado > estado amigable de HA > por defecto
    let text;
    if (isOn && c.text_open) text = c.text_open;
    else if (!isOn && c.text_closed) text = c.text_closed;
    else {
      const friendly = this._hass.formatEntityState
        ? this._hass.formatEntityState(st)
        : null;
      text = friendly || (isOn ? "Abierto" : "Cerrado");
    }
    const color = isOn
      ? c.color_open || "var(--error-color, #d84343)"
      : c.color_closed || "var(--success-color, #2e8b57)";
    return { open: isOn, text, color };
  }

  _keypadHtml(dotColor, statusText, statusClass) {
    const count = this._pin.length;
    let dots;
    if (count === 0) {
      dots = `<span class="empty">— — — —</span>`;
    } else {
      dots = Array.from({ length: count }, () => {
        return `<span class="dot filled" style="background:${dotColor};border-color:${dotColor};"></span>`;
      }).join("");
    }

    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "back", "0", "ok"];
    const keysHtml = keys
      .map((k) => {
        if (k === "back")
          return `<button class="key sub" data-key="back"><ha-icon icon="mdi:backspace"></ha-icon></button>`;
        if (k === "ok")
          return `<button class="key sub" data-key="ok"><ha-icon icon="mdi:check"></ha-icon></button>`;
        return `<button class="key" data-key="${k}">${k}</button>`;
      })
      .join("");

    return `
      <div class="dots">${dots}</div>
      <div class="grid">${keysHtml}</div>
    `;
  }

  _render() {
    if (!this._hass || !this._config) return;
    const c = this._config;

    if (!c.entry_id) {
      this.shadowRoot.innerHTML = `
        <style>ha-card { padding: 16px; } .warn { color: var(--secondary-text-color); font-size: 14px; text-align:center; padding: 20px; }</style>
        <ha-card><div class="warn">Selecciona un candado PIN Lock en la configuración de la card.</div></ha-card>
      `;
      return;
    }

    const dotColor =
      this._status === "ok"
        ? "var(--success-color, #2e8b57)"
        : this._status === "fail" || this._status === "locked"
        ? "var(--error-color, #d84343)"
        : "var(--primary-color, #3f87d8)";

    // Texto de estado del teclado (comprobando/correcto/incorrecto)
    let statusText = "";
    let statusClass = "";
    if (this._status === "ok") {
      statusText = "Correcto";
      statusClass = "ok";
    } else if (this._status === "fail") {
      statusText = "Código incorrecto";
      statusClass = "fail";
    } else if (this._status === "locked") {
      statusText = `Bloqueado ${this._extra || ""}s`;
      statusClass = "fail";
    } else if (this._status === "checking") {
      statusText = "Comprobando…";
    }

    const door = this._doorState();
    const isTile = c.display_mode === "tile";
    const expanded = this._expanded;

    // Subtítulo del tile: estado del teclado tiene prioridad si está activo,
    // si no, el estado de la puerta, si no, nada.
    let subtitle = "";
    let subtitleColor = "var(--secondary-text-color)";
    if (statusText) {
      subtitle = statusText;
      subtitleColor =
        statusClass === "ok"
          ? "var(--success-color, #2e8b57)"
          : statusClass === "fail"
          ? "var(--error-color, #d84343)"
          : "var(--secondary-text-color)";
    } else if (door) {
      subtitle = door.text;
      subtitleColor = door.color;
    }

    // Color del icono: si hay puerta, sigue su color; si no, neutro
    const iconColor = door ? door.color : "var(--primary-text-color)";
    const iconBg = door
      ? "color-mix(in srgb, " + "currentColor 12%, transparent)"
      : "rgba(0,0,0,0.06)";

    const header = `
      <div class="head ${isTile ? "clickable" : ""}">
        <div class="icon-box" style="color:${iconColor}; background:${door ? `color-mix(in srgb, ${door.color} 14%, transparent)` : "rgba(0,0,0,0.06)"};">
          <ha-icon icon="${c.icon}" style="--mdc-icon-size:22px;"></ha-icon>
        </div>
        <div class="head-text">
          <div class="name">${c.name}</div>
          ${subtitle ? `<div class="status" style="color:${subtitleColor};">${subtitle}</div>` : ""}
        </div>
        ${
          isTile
            ? `<ha-icon class="chev" icon="${expanded ? "mdi:chevron-up" : "mdi:lock"}" style="--mdc-icon-size:18px;"></ha-icon>`
            : ""
        }
      </div>
    `;

    const showKeypad = !isTile || expanded;
    const keypadBlock = showKeypad
      ? `<div class="keypad ${isTile ? "in-tile" : ""}">${this._keypadHtml(dotColor, statusText, statusClass)}</div>`
      : "";

    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 16px; }
        .head { display:flex; align-items:center; gap:12px; }
        .head.clickable { cursor:pointer; }
        .head-text { flex:1; min-width:0; }
        .icon-box { width:42px; height:42px; border-radius:11px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .name { font-size:15px; font-weight:500; color: var(--primary-text-color); }
        .status { font-size:12px; margin-top:1px; }
        .chev { color: var(--secondary-text-color); flex-shrink:0; }
        .keypad.in-tile { margin-top:14px; padding-top:14px; border-top:0.5px solid var(--divider-color, #e0e0e0); }
        .dots { display:flex; justify-content:center; align-items:center; gap:10px; margin:6px 0 16px; min-height:14px; }
        .dot { width:12px; height:12px; border-radius:50%; border:1.5px solid var(--divider-color, #bbb); box-sizing:border-box; transition: all 0.15s; }
        .empty { color: var(--secondary-text-color); letter-spacing:2px; font-size:14px; }
        .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
        .key {
          aspect-ratio:1; font-size:20px; border:1px solid var(--divider-color, #ddd);
          background: var(--card-background-color, #fff); color: var(--primary-text-color);
          border-radius:10px; cursor:pointer; transition: background 0.1s;
        }
        .key:hover { background: rgba(0,0,0,0.04); }
        .key:active { transform: scale(0.96); }
        .key.sub { font-size:16px; color: var(--secondary-text-color); }
      </style>
      <ha-card>
        ${header}
        ${keypadBlock}
      </ha-card>
    `;

    // Click en la cabecera (solo modo tile): plegar/desplegar
    if (isTile) {
      const head = this.shadowRoot.querySelector(".head");
      if (head)
        head.addEventListener("click", () => {
          this._expanded = !this._expanded;
          if (!this._expanded) this._pin = "";
          this._render();
        });
    }

    this.shadowRoot.querySelectorAll(".key").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const k = btn.getAttribute("data-key");
        if (k === "back") this._backspace();
        else if (k === "ok") this._submit();
        else this._press(k);
      });
    });
  }
}

customElements.define("pin-lock-card", PinLockCard);

class PinLockCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._entries = [];
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._loaded) {
      this._loaded = true;
      this._loadEntries();
    }
  }

  async _loadEntries() {
    try {
      const all = await this._hass.callWS({ type: "config_entries/get" });
      this._entries = (all || []).filter((e) => e.domain === "pin_lock");
    } catch (e) {
      this._entries = [];
    }
    this._render();
  }

  _emit(next) {
    this._config = next;
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: next },
        bubbles: true,
        composed: true,
      })
    );
  }

  _update(key, value) {
    const next = { ...this._config };
    if (value === "" || value === undefined || value === null) delete next[key];
    else next[key] = value;
    this._emit(next);
  }

  _render() {
    if (!this._config) return;
    const c = this._config;

    const options = this._entries
      .map(
        (e) =>
          `<option value="${e.entry_id}" ${c.entry_id === e.entry_id ? "selected" : ""}>${e.title || e.entry_id}</option>`
      )
      .join("");

    const noEntries = this._entries.length === 0;
    const isTile = c.display_mode === "tile";

    this.shadowRoot.innerHTML = `
      <style>
        .form { display:grid; gap:14px; padding:4px 2px; }
        .row { display:grid; gap:4px; }
        label { font-size:0.82rem; color: var(--secondary-text-color); font-weight:600; }
        input, select {
          padding:8px 10px; border-radius:8px; border:1px solid var(--divider-color,#ccc);
          background: var(--card-background-color,#fff); color: var(--primary-text-color);
          font-size:0.9rem; width:100%; box-sizing:border-box;
        }
        .hint { font-size:0.78rem; color: var(--secondary-text-color); }
        .warn { font-size:0.82rem; color: var(--error-color,#d84343); }
        .section { font-size:0.75rem; text-transform:uppercase; letter-spacing:0.05em; color:var(--secondary-text-color); font-weight:700; margin-top:6px; border-top:1px solid var(--divider-color,#eee); padding-top:10px; }
        .cols { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
        .color-row { display:flex; gap:8px; align-items:center; }
        .color-row input[type=color] { width:42px; height:36px; padding:2px; flex-shrink:0; }
      </style>
      <div class="form">
        <div class="row">
          <label>Candado PIN Lock</label>
          ${
            noEntries
              ? `<div class="warn">No hay candados configurados. Añade primero la integración PIN Lock en Ajustes → Dispositivos y servicios.</div>`
              : `<select id="entry_id"><option value="">— Selecciona —</option>${options}</select>`
          }
          <div class="hint">Elige el candado que has configurado en la integración.</div>
        </div>
        <div class="row">
          <label>Modo de visualización</label>
          <select id="display_mode">
            <option value="keypad" ${!isTile ? "selected" : ""}>Teclado siempre visible</option>
            <option value="tile" ${isTile ? "selected" : ""}>Tile que despliega el teclado</option>
          </select>
        </div>
        <div class="row">
          <label>Nombre a mostrar</label>
          <input id="name" type="text" value="${c.name || ""}" />
        </div>
        <div class="row">
          <label>Icono (mdi:...)</label>
          <input id="icon" type="text" value="${c.icon || ""}" />
        </div>
        <div class="row">
          <label>Longitud máxima del PIN</label>
          <input id="pin_length" type="number" min="4" max="12" value="${c.pin_length || 8}" />
        </div>

        <div class="section">Estado de puerta (opcional)</div>
        <div class="row">
          <label>Sensor de estado (binary_sensor)</label>
          <div id="slot-status_entity"></div>
          <div class="hint">Muestra abierto/cerrado en el tile. Déjalo vacío si no lo quieres.</div>
        </div>
        <div class="cols">
          <div class="row">
            <label>Color abierto</label>
            <div class="color-row">
              <input id="color_open" type="color" value="${c.color_open || "#d84343"}" />
              <input id="color_open_txt" type="text" value="${c.color_open || ""}" placeholder="#d84343" />
            </div>
          </div>
          <div class="row">
            <label>Color cerrado</label>
            <div class="color-row">
              <input id="color_closed" type="color" value="${c.color_closed || "#2e8b57"}" />
              <input id="color_closed_txt" type="text" value="${c.color_closed || ""}" placeholder="#2e8b57" />
            </div>
          </div>
        </div>
        <div class="cols">
          <div class="row">
            <label>Texto abierto</label>
            <input id="text_open" type="text" value="${c.text_open || ""}" placeholder="Abierto" />
          </div>
          <div class="row">
            <label>Texto cerrado</label>
            <input id="text_closed" type="text" value="${c.text_closed || ""}" placeholder="Cerrado" />
          </div>
        </div>
      </div>
    `;

    const entrySel = this.shadowRoot.getElementById("entry_id");
    if (entrySel) {
      entrySel.addEventListener("change", (e) => {
        const id = e.target.value;
        this._update("entry_id", id);
        // Autocompletar el nombre con el título del candado si está vacío
        const found = this._entries.find((x) => x.entry_id === id);
        if (found && (!this._config.name || this._config.name === "Garaje")) {
          this._update("name", found.title);
        }
      });
    }

    const nameEl = this.shadowRoot.getElementById("name");
    if (nameEl) nameEl.addEventListener("change", (e) => this._update("name", e.target.value));

    const iconEl = this.shadowRoot.getElementById("icon");
    if (iconEl) iconEl.addEventListener("change", (e) => this._update("icon", e.target.value));

    const lenEl = this.shadowRoot.getElementById("pin_length");
    if (lenEl)
      lenEl.addEventListener("change", (e) =>
        this._update("pin_length", parseInt(e.target.value, 10) || 4)
      );

    const modeEl = this.shadowRoot.getElementById("display_mode");
    if (modeEl)
      modeEl.addEventListener("change", (e) => {
        this._update("display_mode", e.target.value);
        this._render();
      });

    // Entity picker para el sensor de estado
    const slot = this.shadowRoot.getElementById("slot-status_entity");
    if (slot && this._hass) {
      const picker = document.createElement("ha-entity-picker");
      picker.hass = this._hass;
      picker.value = c.status_entity || "";
      picker.includeDomains = ["binary_sensor"];
      picker.allowCustomEntity = false;
      picker.addEventListener("value-changed", (e) =>
        this._update("status_entity", e.detail.value)
      );
      slot.appendChild(picker);
    }

    // Colores: sincronizar el selector de color con su input de texto
    const bindColor = (colorId, txtId, key) => {
      const colorEl = this.shadowRoot.getElementById(colorId);
      const txtEl = this.shadowRoot.getElementById(txtId);
      if (colorEl)
        colorEl.addEventListener("change", (e) => {
          if (txtEl) txtEl.value = e.target.value;
          this._update(key, e.target.value);
        });
      if (txtEl)
        txtEl.addEventListener("change", (e) => {
          const v = e.target.value.trim();
          if (colorEl && v) colorEl.value = v;
          this._update(key, v);
        });
    };
    bindColor("color_open", "color_open_txt", "color_open");
    bindColor("color_closed", "color_closed_txt", "color_closed");

    const textOpenEl = this.shadowRoot.getElementById("text_open");
    if (textOpenEl)
      textOpenEl.addEventListener("change", (e) => this._update("text_open", e.target.value));

    const textClosedEl = this.shadowRoot.getElementById("text_closed");
    if (textClosedEl)
      textClosedEl.addEventListener("change", (e) => this._update("text_closed", e.target.value));
  }
}

customElements.define("pin-lock-card-editor", PinLockCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "pin-lock-card",
  name: "PIN Lock Card",
  description: "Teclado PIN que valida en el backend y ejecuta una acción",
  preview: true,
});
