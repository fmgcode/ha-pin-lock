class PinLockCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._pin = "";
    this._status = "idle";
    this._statusTimer = null;
  }

  setConfig(config) {
    const prevEntryId = this._config && this._config.entry_id;
    this._config = {
      name: "Garaje",
      icon: "mdi:garage",
      secondary_icon: "mdi:lock",
      ...config,
    };
    // El modal (teclado o confirmación) siempre arranca cerrado
    this._modalOpen = false;

    // El estado de la puerta (status_entity) ya no se configura en la card:
    // se obtiene automáticamente del candado elegido en "entry_id".
    if (this._config.entry_id !== prevEntryId) {
      this._meta = null;
      if (this._hass) this._loadMeta();
    }
  }

  static getConfigElement() {
    return document.createElement("pin-lock-card-editor");
  }

  static getStubConfig() {
    return {
      entry_id: "",
      name: "Garaje",
      icon: "mdi:garage",
      secondary_icon: "mdi:lock",
    };
  }

  set hass(hass) {
    const prev = this._hass;
    const first = !prev;
    this._hass = hass;

    // Si aún no hay suscripción activa (primera carga o un intento anterior
    // falló), reintentar en cada actualización de hass hasta conseguirla.
    if (!this._unsub) {
      this._subscribeEvents();
    }

    if (first) {
      this._loadMeta();
      this._render();
      return;
    }

    // Re-render si cambió el estado del sensor de puerta que estamos mostrando
    // (el sensor lo indica el propio candado, obtenido vía _loadMeta)
    const statusEnt = this._meta && this._meta.status_entity;
    if (statusEnt) {
      const prevSt = prev && prev.states ? prev.states[statusEnt] : null;
      const newSt = hass.states ? hass.states[statusEnt] : null;
      const prevVal = prevSt ? prevSt.state : null;
      const newVal = newSt ? newSt.state : null;
      if (prevVal !== newVal) {
        this._render();
      }
    }
  }

  async _loadMeta() {
    if (!this._hass || !this._config || !this._config.entry_id) {
      this._meta = null;
      return;
    }
    try {
      const res = await this._hass.callWS({ type: "pin_lock/list" });
      const entries = (res && res.entries) || [];
      this._meta =
        entries.find((e) => e.entry_id === this._config.entry_id) || null;
    } catch (e) {
      this._meta = null;
    }
    this._render();
  }

  getCardSize() {
    // La card siempre es una tile compacta: el teclado (con PIN) o la
    // confirmación (sin PIN) se abren en un modal flotante que no ocupa
    // espacio del grid.
    return 1;
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
      // Éxito: limpiar y cerrar el modal si estaba abierto
      this._pin = "";
      this._status = "idle";
      this._modalOpen = false;
      this._render();
    } else if (data.result === "locked") {
      this._pin = "";
      this._setStatus("locked", data.retry_in);
    } else if (data.result === "fail") {
      this._pin = "";
      this._setStatus("fail");
    } else {
      this._pin = "";
      this._setStatus("error");
    }
  }

  _setStatus(status, extra) {
    this._status = status;
    this._extra = extra;
    this._render();
    if (this._statusTimer) {
      clearTimeout(this._statusTimer);
      this._statusTimer = null;
    }
    // Solo para estados de error/fail: mostrar mensaje 1,5s y volver a idle
    if (status === "fail" || status === "error") {
      this._statusTimer = setTimeout(() => {
        this._status = "idle";
        this._statusTimer = null;
        this._render();
      }, 1500);
    }
  }

  _press(digit) {
    if (this._status === "locked") return;
    // Tope técnico razonable (nunca se alcanza en uso real)
    if (this._pin.length >= 20) return;
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
    await this._callValidate(pin);
  }

  /**
   * Envío para candados sin PIN (confirmación simple). A diferencia de
   * `_submit()`, NO pasa por el estado "checking": la confirmación ya fue
   * el "¿estás seguro?", así que mostrar además un "Comprobando…"
   * duplicaría el paso de espera sin aportar nada.
   */
  async _confirmSubmit() {
    if (this._confirmPending) return;
    this._confirmPending = true;
    try {
      await this._hass.callService("pin_lock", "validate", {
        entry_id: this._config.entry_id,
        pin: "",
      });
    } catch (e) {
      this._setStatus("error");
    } finally {
      this._confirmPending = false;
    }
  }

  async _callValidate(pin) {
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
    const statusEntity = this._meta && this._meta.status_entity;
    if (!statusEntity) return null;
    const st = this._hass.states[statusEntity];
    if (!st || ["unknown", "unavailable"].includes(st.state)) {
      return { open: null, text: "—", color: "var(--secondary-text-color)" };
    }
    const isOn = st.state === "on";
    // Texto: personalizado (en la card) > estado amigable de HA > por defecto
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
      : c.color_closed || "var(--secondary-text-color)";
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

    const resultColor =
      statusClass === "ok"
        ? "var(--success-color, #2e8b57)"
        : statusClass === "fail"
        ? "var(--error-color, #d84343)"
        : "var(--secondary-text-color)";

    const resultHtml = statusText
      ? `<div class="pin-result" style="color:${resultColor};">${statusText}</div>`
      : "";

    return `
      <div class="dots">${dots}</div>
      <div class="grid">${keysHtml}</div>
      ${resultHtml}
    `;
  }

  _escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  _confirmHtml(confirmText, statusText, statusClass, inModal) {
    const resultColor =
      statusClass === "ok"
        ? "var(--success-color, #2e8b57)"
        : statusClass === "fail"
        ? "var(--error-color, #d84343)"
        : "var(--secondary-text-color)";

    const resultHtml = statusText
      ? `<div class="pin-result" style="color:${resultColor};">${statusText}</div>`
      : "";

    const cancelBtn = inModal
      ? `<button class="btn cancel" data-key="cancel">Cancelar</button>`
      : "";

    return `
      <div class="confirm-caption">${this._escapeHtml(confirmText)}</div>
      <div class="confirm-actions">
        ${cancelBtn}
        <button class="btn confirm" data-key="confirm">Confirmar</button>
      </div>
      ${resultHtml}
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
    // Mientras se cargan los metadatos del candado, se asume que requiere
    // PIN (comportamiento previo, evita mostrar el panel equivocado un instante)
    const requiresPin = !this._meta || this._meta.requires_pin !== false;
    const confirmText =
      (this._meta && this._meta.confirm_text) || "¿Estás seguro?";

    // Subtítulo del header: SIEMPRE el estado de la puerta (si hay sensor
    // configurado). El resultado del PIN va aparte, bajo el teclado.
    const subtitle = door ? door.text : "";
    const subtitleColor = door ? door.color : "var(--secondary-text-color)";

    // Color del icono: si hay puerta, sigue su color; si no, neutro
    const iconColor = door ? door.color : "var(--primary-text-color)";

    const header = `
      <div class="head clickable">
        <div class="icon-box" style="color:${iconColor}; background:${door ? `color-mix(in srgb, ${door.color} 14%, transparent)` : "rgba(0,0,0,0.06)"};">
          <ha-icon icon="${c.icon}" style="--mdc-icon-size:20px;"></ha-icon>
        </div>
        <div class="head-text">
          <div class="name">${c.name}</div>
          ${subtitle ? `<div class="status" style="color:${subtitleColor};">${subtitle}</div>` : ""}
        </div>
        <ha-icon class="chev" icon="${c.secondary_icon || "mdi:lock"}" style="--mdc-icon-size:18px;"></ha-icon>
      </div>
    `;

    // La card es siempre una tile compacta de tamaño fijo. Al pulsarla se
    // abre un modal (position:fixed) con el teclado (candados con PIN) o el
    // panel de confirmación (candados sin PIN); el modal no ocupa espacio
    // del grid del dashboard.
    const bodyInner = requiresPin
      ? this._keypadHtml(dotColor, statusText, statusClass)
      : this._confirmHtml(confirmText, statusText, statusClass, true);

    const modalBlock = this._modalOpen
      ? `
      <div class="overlay">
        <div class="overlay-panel">
          <button class="overlay-close" data-key="close" aria-label="Cerrar">
            <ha-icon icon="mdi:close" style="--mdc-icon-size:18px;"></ha-icon>
          </button>
          <div class="overlay-title">
            <div class="icon-box" style="color:${iconColor}; background:${door ? `color-mix(in srgb, ${door.color} 14%, transparent)` : "rgba(0,0,0,0.06)"};">
              <ha-icon icon="${c.icon}" style="--mdc-icon-size:20px;"></ha-icon>
            </div>
            <div class="name">${c.name}</div>
          </div>
          ${bodyInner}
        </div>
      </div>
    `
        : "";

    this.shadowRoot.innerHTML = `
      <style>
        /* Tamaño fijo pensado para encajar con una tile nativa de HA
           (~246.4 x 56.4px): padding 8px + icon-box 40px = 56px de alto. */
        ha-card { padding: 8px 12px; }
        .head { display:flex; align-items:center; gap:10px; min-height:40px; }
        .head.clickable { cursor:pointer; }
        .head-text { flex:1; min-width:0; }
        .icon-box { width:40px; height:40px; border-radius:10px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .name { font-size:15px; font-weight:500; color: var(--primary-text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .status { font-size:12px; margin-top:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .pin-result { text-align:center; font-size:12px; font-weight:600; margin-top:12px; min-height:16px; }
        .confirm-caption { font-size:14px; color: var(--primary-text-color); text-align:center; padding: 4px 4px 16px; line-height:1.4; }
        .confirm-actions { display:flex; gap:10px; }
        .btn { flex:1; padding:12px; border-radius:10px; font-size:14px; font-weight:600; cursor:pointer; border:1px solid var(--divider-color, #ddd); transition: background 0.1s; }
        .btn:active { transform: scale(0.98); }
        .btn.confirm { background: var(--primary-color, #3f87d8); color: #fff; border-color: transparent; }
        .btn.cancel { background: transparent; color: var(--secondary-text-color); }
        .btn.cancel:hover { background: rgba(0,0,0,0.04); }
        .chev { color: var(--secondary-text-color); flex-shrink:0; }
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
        .overlay {
          position: fixed; inset: 0; z-index: 1000;
          background: rgba(0,0,0,0.5);
          display: flex; align-items: center; justify-content: center;
          padding: 16px; box-sizing: border-box;
        }
        .overlay-panel {
          position: relative;
          background: var(--card-background-color, #fff);
          border-radius: 16px; padding: 20px;
          width: 100%; max-width: 320px;
          box-shadow: 0 10px 40px rgba(0,0,0,0.35);
        }
        .overlay-close {
          position: absolute; top: 10px; right: 10px;
          background: none; border: none; cursor: pointer;
          color: var(--secondary-text-color); padding: 4px; line-height: 0;
        }
        .overlay-title { display:flex; align-items:center; gap:12px; margin-bottom: 4px; }
      </style>
      <ha-card>
        ${header}
      </ha-card>
      ${modalBlock}
    `;

    // Click en la cabecera: abre el modal (teclado o confirmación)
    const head = this.shadowRoot.querySelector(".head");
    if (head)
      head.addEventListener("click", () => {
        this._modalOpen = true;
        this._render();
      });

    // Click en el fondo del modal: cerrar sin hacer nada
    const overlay = this.shadowRoot.querySelector(".overlay");
    if (overlay) {
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) {
          this._modalOpen = false;
          this._pin = "";
          this._render();
        }
      });
    }

    const closeBtn = this.shadowRoot.querySelector(".overlay-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._modalOpen = false;
        this._pin = "";
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

    // Botones Cancelar/Confirmar del panel de confirmación: en ambos casos
    // se cierra al instante (si estaba en modal), evitando poder pulsar dos
    // veces. Confirmar además dispara la acción en segundo plano.
    this.shadowRoot.querySelectorAll(".btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const k = btn.getAttribute("data-key");
        if (k === "cancel") {
          this._modalOpen = false;
          this._render();
        } else if (k === "confirm") {
          this._modalOpen = false;
          this._render();
          this._confirmSubmit();
        }
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
      const res = await this._hass.callWS({ type: "pin_lock/list" });
      this._entries = (res && res.entries) || [];
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
          `<option value="${e.entry_id}" ${c.entry_id === e.entry_id ? "selected" : ""}>${e.name || e.entry_id}</option>`
      )
      .join("");

    const noEntries = this._entries.length === 0;
    const selectedEntry = this._entries.find((e) => e.entry_id === c.entry_id);
    const hasStatusEntity = !!(selectedEntry && selectedEntry.status_entity);

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
        .hint code { background: rgba(0,0,0,0.06); padding:1px 5px; border-radius:4px; font-size:0.76rem; }
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
          ${
            selectedEntry
              ? selectedEntry.requires_pin === false
                ? `<div class="hint">Este candado no pide PIN, solo confirmación: al pulsar la tile se abrirá un diálogo de confirmación. El texto se configura en Ajustes → Dispositivos y servicios → PIN Lock → este candado → Configurar.</div>`
                : `<div class="hint">Este candado pide PIN: al pulsar la tile se abrirá el teclado numérico.</div>`
              : ""
          }
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
          <label>Icono secundario</label>
          <input id="secondary_icon" type="text" value="${c.secondary_icon || ""}" placeholder="mdi:lock" />
          <div class="hint">Se muestra junto al nombre en la tile, indicando que al pulsar se pedirá PIN o confirmación.</div>
        </div>

        <div class="section">Estado de puerta</div>
        <div class="row">
          ${
            !c.entry_id
              ? `<div class="hint">Selecciona un candado para ver si tiene un sensor de puerta asociado.</div>`
              : hasStatusEntity
              ? `<div class="hint">Sensor asociado: <code>${selectedEntry.status_entity}</code>. Se configura desde Ajustes → Dispositivos y servicios → PIN Lock → este candado → Configurar.</div>`
              : `<div class="hint">Este candado no tiene sensor de puerta asociado. Añádelo desde Ajustes → Dispositivos y servicios → PIN Lock → este candado → Configurar.</div>`
          }
        </div>
        ${
          hasStatusEntity
            ? `
        <div class="cols">
          <div class="row">
            <label>Color abierto</label>
            <div class="color-row">
              <input id="color_open" type="color" value="${c.color_open || "#d84343"}" />
              <input id="color_open_txt" type="text" value="${c.color_open || ""}" placeholder="por defecto: rojo" />
            </div>
          </div>
          <div class="row">
            <label>Color cerrado</label>
            <div class="color-row">
              <input id="color_closed" type="color" value="${c.color_closed || "#9e9e9e"}" />
              <input id="color_closed_txt" type="text" value="${c.color_closed || ""}" placeholder="por defecto: gris" />
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
        </div>`
            : ""
        }
      </div>
    `;

    const entrySel = this.shadowRoot.getElementById("entry_id");
    if (entrySel) {
      entrySel.addEventListener("change", (e) => {
        const id = e.target.value;
        this._update("entry_id", id);
        // Autocompletar el nombre con el del candado si está vacío
        const found = this._entries.find((x) => x.entry_id === id);
        if (found && (!this._config.name || this._config.name === "Garaje")) {
          this._update("name", found.name);
        }
        // Re-render para actualizar el aviso de sensor de puerta asociado
        this._render();
      });
    }

    const nameEl = this.shadowRoot.getElementById("name");
    if (nameEl) nameEl.addEventListener("change", (e) => this._update("name", e.target.value));

    const iconEl = this.shadowRoot.getElementById("icon");
    if (iconEl) iconEl.addEventListener("change", (e) => this._update("icon", e.target.value));

    const secondaryIconEl = this.shadowRoot.getElementById("secondary_icon");
    if (secondaryIconEl)
      secondaryIconEl.addEventListener("change", (e) =>
        this._update("secondary_icon", e.target.value)
      );

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
