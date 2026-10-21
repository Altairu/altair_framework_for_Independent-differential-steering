/* ==========================================================================
   Altair Web Controller v2 - フロントエンド メイン JavaScript
   機能: ビュー切り替え, REST API通信, WebSocket双方向通信, 動的カード描画, プロファイル管理
   ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
  // アプリケーションの状態管理
  const state = {
    ws: null,
    wsUrl: `ws://${window.location.hostname}:8000/ws`,
    config: { modules: [] },
    ports: [],
    profiles: [],
    canConnected: false,
    behaviorStatus: "IDLE",
    controlMode: "SETUP", // SETUP (送信待ち), CONTROL (制御中)
    controlStartTimeMs: 0, // パラメータ送信直後の古いテレメトリによる誤リセット防止用タイムスタンプ
    moduleSendToggles: {}, // 各モジュールへのUI指令値の送信ON/OFFトグル状態
    gamepadMappings: [], // コントローラーのマッピングデータ
  };

  // --- 1. DOM要素の取得 ---
  const el = {
    menuItems: document.querySelectorAll(".menu-item"),
    views: document.querySelectorAll(".content-view"),
    pageTitle: document.getElementById("page-title"),

    // 接続関連
    canStatusIndicator: document.getElementById("can-status-indicator"),
    groupConnectionSlcan: document.getElementById("group-connection-slcan"),
    slcanConnectionStatus: document.getElementById("slcan-connection-status"),
    tabModeEth: document.getElementById("tab-mode-eth"),
    tabModeUsb: document.getElementById("tab-mode-usb"),
    panelConnEth: document.getElementById("panel-conn-eth"),
    panelConnUsb: document.getElementById("panel-conn-usb"),
    txtEthIp: document.getElementById("txt-eth-ip"),
    txtEthPort: document.getElementById("txt-eth-port"),
    btnConnectEth: document.getElementById("btn-connect-eth"),
    btnDisconnectEth: document.getElementById("btn-disconnect-eth"),
    chkAutoConnect: document.getElementById("chk-auto-connect"),
    selCanPort: document.getElementById("sel-can-port"),
    btnRefreshPorts: document.getElementById("btn-refresh-ports"),
    btnConnectCan: document.getElementById("btn-connect-can"),
    btnDisconnectCan: document.getElementById("btn-disconnect-can"),
    btnEmergencyStop: document.getElementById("btn-emergency-stop"),

    // パラメータ・モジュール管理
    btnSendParams: document.getElementById("btn-send-params"),
    lblControlModeStatus: document.getElementById("control-mode-status"),
    modulesContainer: document.getElementById("modules-container"),
    btnAddModuleModal: document.getElementById("btn-add-module-modal"),

    // プロファイル管理
    profileListUl: document.getElementById("profile-list-ul"),
    txtNewProfileName: document.getElementById("txt-new-profile-name"),
    btnSaveProfile: document.getElementById("btn-save-profile"),
    fileImportProfile: document.getElementById("file-import-profile"),
    btnExportProfile: document.getElementById("btn-export-profile"),

    // 動作プログラム(Behavior)関連
    selBehaviorScript: document.getElementById("sel-behavior-script"),
    btnStartBehavior: document.getElementById("btn-start-behavior"),
    btnStopBehavior: document.getElementById("btn-stop-behavior"),
    lblBehaviorStatus: document.getElementById("lbl-behavior-status"),
    behaviorTerminal: document.getElementById("behavior-terminal"),
    btnClearConsole: document.getElementById("btn-clear-console"),

    // システムログ関連
    canLogsTerminal: document.getElementById("can-logs-terminal"),
    btnClearCanLogs: document.getElementById("btn-clear-can-logs"),

    // モジュール追加モーダル
    modal: document.getElementById("add-module-modal"),
    btnCloseModal: document.getElementById("btn-close-modal"),
    btnCancelModal: document.getElementById("btn-cancel-modal"),
    btnSaveModule: document.getElementById("btn-save-module"),
    modalModuleType: document.getElementById("modal-module-type"),
    modalModuleName: document.getElementById("modal-module-name"),
    modalModuleId: document.getElementById("modal-module-id"),
    modalModuleDesc: document.getElementById("modal-module-desc"),
  };

  // Blocklyワークスペース参照（タブ表示時の再レイアウトに使用）
  let blocklyWorkspace = null;

  // --- 2. ビュー（画面）切り替えロジック ---
  el.menuItems.forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      const targetId = item.getAttribute("data-target");

      // メニューの活性状態をトグル
      el.menuItems.forEach(i => i.classList.remove("active"));
      item.classList.add("active");

      // ビューの表示をトグル
      el.views.forEach(view => {
        if (view.id === targetId) {
          view.classList.add("active");
          el.pageTitle.textContent = item.textContent.trim();
        } else {
          view.classList.remove("active");
        }
      });

      // 非表示タブで初期化されたBlocklyを表示時に再レイアウトする
      if (targetId === "view-automation" && blocklyWorkspace && typeof Blockly !== "undefined") {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            Blockly.svgResize(blocklyWorkspace);
          });
        });
      }
    });
  });

  // --- 3. WebSocket 接続管理 ＆ メッセージング ---
  function connectWebSocket() {
    console.log("WebSocket接続を開始します: ", state.wsUrl);
    state.ws = new WebSocket(state.wsUrl);

    state.ws.onopen = () => {
      console.log("WebSocket接続が確立されました。");
      window.appWs = state.ws; // コントローラー（gamepad.js）との連携用にグローバルに共有
    };

    state.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (err) {
        console.error("受信データのパースに失敗しました:", err);
      }
    };

    state.ws.onclose = () => {
      console.warn("WebSocket接続が切断されました。2秒後に再接続を試みます...");
      setTimeout(connectWebSocket, 2000);
    };

    state.ws.onerror = (err) => {
      console.error("WebSocketエラーが発生しました:", err);
    };
  }

  // 受信メッセージのディスパッチ
  function handleWsMessage(msg) {
    const type = msg.type;
    const data = msg.data;

    switch (type) {
      case "can_status":
        updateCanStatusUI(data);
        break;

      case "behavior_status":
        updateBehaviorStatusUI(data);
        break;

      case "behavior_log":
        appendTerminalLog(el.behaviorTerminal, data);
        break;

      case "mdd_feedback":
        updateMddCardFeedback(msg.name, data);
        break;

      case "raw_can_frame": // システム全体のCANログ用
        appendCanLog(data);
        break;
    }
  }

  // --- 4. 接続状態UIの更新 ---
  function updateCanStatusUI(data) {
    state.canConnected = data.is_connected;
    const dot = el.canStatusIndicator.querySelector(".status-dot");
    const text = el.canStatusIndicator.querySelector(".status-text");

    if (data.is_connected) {
      dot.className = "status-dot connected";
      text.textContent = `CAN: Connected (${data.active_port})`;
      if (el.btnConnectCan) el.btnConnectCan.disabled = true;
      if (el.btnDisconnectCan) el.btnDisconnectCan.disabled = false;
      if (el.btnConnectEth) el.btnConnectEth.disabled = true;
      if (el.btnDisconnectEth) el.btnDisconnectEth.disabled = false;

      // slcan接続グループのUI更新
      if (el.slcanConnectionStatus) {
        el.slcanConnectionStatus.innerHTML = `状態: <span class="badge badge-success" style="padding: 4px 8px; font-size: 11px;">接続完了 (${data.active_port})</span>`;
      }
      if (el.groupConnectionSlcan) {
        el.groupConnectionSlcan.style.borderColor = "var(--success-color)";
        el.groupConnectionSlcan.style.boxShadow = "0 0 10px rgba(19, 115, 51, 0.1)";
      }
    } else {
      dot.className = "status-dot disconnected";
      text.textContent = "CAN: Disconnected";
      if (el.btnConnectCan) el.btnConnectCan.disabled = false;
      if (el.btnDisconnectCan) el.btnDisconnectCan.disabled = true;
      if (el.btnConnectEth) el.btnConnectEth.disabled = false;
      if (el.btnDisconnectEth) el.btnDisconnectEth.disabled = true;

      // slcan接続グループのUI更新
      if (el.slcanConnectionStatus) {
        el.slcanConnectionStatus.innerHTML = `状態: <span class="badge badge-danger" style="padding: 4px 8px; font-size: 11px;">未接続</span>`;
      }
      if (el.groupConnectionSlcan) {
        el.groupConnectionSlcan.style.borderColor = "var(--border-light)";
        el.groupConnectionSlcan.style.boxShadow = "none";
      }

      if (data.error_message) {
        appendTerminalLog(el.behaviorTerminal, `[CAN ERROR] ${data.error_message}`, "error-msg");
      }
    }
  }

  // --- 5. 動作プログラム状態UIの更新 ---
  function updateBehaviorStatusUI(status) {
    state.behaviorStatus = status;
    el.lblBehaviorStatus.textContent = status;

    // バッジ色の変更
    if (status.includes("RUNNING")) {
      el.lblBehaviorStatus.className = "badge badge-success";
      el.btnStartBehavior.disabled = true;
      el.btnStopBehavior.disabled = false;
    } else if (status === "IDLE") {
      el.lblBehaviorStatus.className = "badge badge-secondary";
      el.btnStartBehavior.disabled = false;
      el.btnStopBehavior.disabled = true;
    } else {
      el.lblBehaviorStatus.className = "badge badge-warning";
      el.btnStartBehavior.disabled = false;
      el.btnStopBehavior.disabled = true;
    }
  }

  // --- 6. コンソールロギングヘルパー ---
  function appendTerminalLog(terminal, text, className = "") {
    const line = document.createElement("div");
    line.className = `terminal-line ${className}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    terminal.appendChild(line);

    // 最大300行に制限
    while (terminal.childElementCount > 300) {
      terminal.removeChild(terminal.firstChild);
    }

    // スクロール追従
    terminal.scrollTop = terminal.scrollHeight;
  }

  // --- 7. モジュール構成 (config) のロードとレンダリング ---
  async function loadConfigAndRender() {
    try {
      const res = await fetch("/api/config");
      state.config = await res.json();

      renderModuleCards();
    } catch (err) {
      console.error("モジュール設定のロードに失敗しました:", err);
    }
  }

  function renderModuleCards() {
    el.modulesContainer.innerHTML = ""; // クリア

    if (state.config.modules.length === 0) {
      el.modulesContainer.innerHTML = `
        <div class="glass-card page-card" style="grid-column: 1/-1; text-align: center; padding: 40px;">
          <i class="fa-solid fa-folder-open" style="font-size: 48px; color: var(--text-muted); margin-bottom: 15px;"></i>
          <p>登録されている制御モジュールはありません。右上の「Add Module」から追加してください。</p>
        </div>`;
      return;
    }

    state.config.modules.forEach(mod => {
      const card = document.createElement("div");
      card.className = `glass-card module-card module-card-${mod.type}`;
      card.id = `module-card-${mod.name}`;

      // 各モジュールタイプに応じた内部HTMLの生成
      let contentHtml = "";

      if (mod.type === "mdd") {
        contentHtml = renderMddCardHtml(mod);
      } else if (mod.type === "servo") {
        contentHtml = renderServoCardHtml(mod);
      } else if (mod.type === "solenoid") {
        contentHtml = renderSolenoidCardHtml(mod);
      }

      card.innerHTML = `
        <div class="card-header-row">
          <div class="module-title">
            <h2>${mod.name}</h2>
            <div class="module-meta-info" style="margin-bottom: 2px;">
              <span>ID: ${mod.base_id}</span>
              <span>Type: ${mod.type.toUpperCase()}</span>
            </div>
            <!-- UI操作送信トグルスイッチ -->
            <div class="send-toggle-row" style="display: flex; align-items: center; gap: 6px; margin-top: 6px;">
              <label class="toggle-checkbox" style="display: flex; align-items: center; gap: 6px; cursor: pointer; margin-bottom: 0;">
                <input type="checkbox" class="toggle-send-cmd" data-module="${mod.name}" id="toggle-send-${mod.name}" ${state.moduleSendToggles[mod.name] ? "checked" : ""}>
                <span class="toggle-switch toggle-switch-sm"></span>
              </label>
              <span style="font-size: 11px; font-weight: 600; color: var(--text-muted); user-select: none;">UI操作送信</span>
            </div>
          </div>
          <div class="card-actions">
            <button class="btn btn-secondary btn-icon btn-xs" onclick="editModule('${mod.name}')" title="設定編集">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="btn btn-danger btn-icon btn-xs" onclick="deleteModule('${mod.name}')" title="削除">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>
        <div class="card-body">
          ${contentHtml}
        </div>
      `;

      el.modulesContainer.appendChild(card);

      // イベントリスナーの動的設定
      bindCardEvents(mod);
    });
  }

  // --- MDDカードレンダリング ---
  function renderMddCardHtml(mod) {
    let slidersHtml = "";
    for (let i = 1; i <= 4; i++) {
      const motorParam = mod.parameters?.[`m${i}`] ?? { mode: 0, p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1 };
      const mode = motorParam.mode ?? 0;

      let min = -10;
      let max = 10;
      let step = 0.1;
      let unit = "rps";

      if (mode === 1) {
        min = -360;
        max = 360;
        step = 1;
        unit = "deg";
      } else if (mode === 2) {
        min = -1000;
        max = 1000;
        step = 1;
        unit = "mm";
      }

      slidersHtml += `
        <div class="control-slider-group mt-2">
          <div class="slider-label-row" style="display: flex; justify-content: space-between; align-items: center;">
            <span class="slider-name">Motor ${i} Goal</span>
            <div style="display: flex; align-items: center; gap: 4px;">
              <button class="btn btn-secondary btn-xs btn-target-adjust" data-module="${mod.name}" data-motor="${i}" data-action="minus" style="padding: 0; width: 16px; height: 16px; font-size: 10px; line-height: 1; font-weight: bold;">-</button>
              <span class="slider-val" id="val-${mod.name}-m${i}" style="min-width: 60px; text-align: center; font-weight: 500;">0.0 ${unit}</span>
              <button class="btn btn-secondary btn-xs btn-target-adjust" data-module="${mod.name}" data-motor="${i}" data-action="plus" style="padding: 0; width: 16px; height: 16px; font-size: 10px; line-height: 1; font-weight: bold;">+</button>
            </div>
          </div>
          <input type="range" class="custom-range range-mdd" data-module="${mod.name}" data-motor="${i}" 
                 min="${min}" max="${max}" step="${step}" value="0" id="range-${mod.name}-m${i}">
        </div>`;
    }

    // M1〜M4のパラメータ（モード, P, I, D, diameter, direction）編集テーブル
    let paramsRowsHtml = "";
    for (let i = 1; i <= 4; i++) {
      const motorParam = mod.parameters?.[`m${i}`] ?? { mode: 0, p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1 };
      paramsRowsHtml += `
        <tr style="border-bottom: 1px solid var(--border-light);">
          <td style="padding: 4px 0; font-weight: 500;">M${i}</td>
          <td style="padding: 4px 0;">
            <select class="form-input form-input-sm select-mdd-mode" data-module="${mod.name}" data-motor="${i}" style="padding: 2px 4px; font-size: 11px; height: 22px; width: 62px;">
              <option value="0" ${motorParam.mode === 0 ? "selected" : ""}>Speed</option>
              <option value="1" ${motorParam.mode === 1 ? "selected" : ""}>Angle</option>
              <option value="2" ${motorParam.mode === 2 ? "selected" : ""}>Pos</option>
            </select>
          </td>
          <td style="padding: 4px 0; text-align: center;">
            <div style="display: flex; align-items: center; justify-content: center; gap: 2px;">
              <button class="btn btn-secondary btn-xs btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="p" data-action="minus" style="padding: 0; width: 12px; height: 18px; font-size: 9px; line-height: 1;">-</button>
              <input type="number" class="form-input form-input-sm input-mdd-p" data-module="${mod.name}" data-motor="${i}" step="0.1" value="${motorParam.p}" style="padding: 2px 0; font-size: 11px; height: 22px; width: 30px; text-align: center; display: inline-block; margin: 0;">
              <button class="btn btn-secondary btn-xs btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="p" data-action="plus" style="padding: 0; width: 12px; height: 18px; font-size: 9px; line-height: 1;">+</button>
            </div>
          </td>
          <td style="padding: 4px 0; text-align: center;">
            <div style="display: flex; align-items: center; justify-content: center; gap: 2px;">
              <button class="btn btn-secondary btn-xs btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="i" data-action="minus" style="padding: 0; width: 12px; height: 18px; font-size: 9px; line-height: 1;">-</button>
              <input type="number" class="form-input form-input-sm input-mdd-i" data-module="${mod.name}" data-motor="${i}" step="0.01" value="${motorParam.i}" style="padding: 2px 0; font-size: 11px; height: 22px; width: 30px; text-align: center; display: inline-block; margin: 0;">
              <button class="btn btn-secondary btn-xs btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="i" data-action="plus" style="padding: 0; width: 12px; height: 18px; font-size: 9px; line-height: 1;">+</button>
            </div>
          </td>
          <td style="padding: 4px 0; text-align: center;">
            <div style="display: flex; align-items: center; justify-content: center; gap: 2px;">
              <button class="btn btn-secondary btn-xs btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="d" data-action="minus" style="padding: 0; width: 12px; height: 18px; font-size: 9px; line-height: 1;">-</button>
              <input type="number" class="form-input form-input-sm input-mdd-d" data-module="${mod.name}" data-motor="${i}" step="0.01" value="${motorParam.d}" style="padding: 2px 0; font-size: 11px; height: 22px; width: 30px; text-align: center; display: inline-block; margin: 0;">
              <button class="btn btn-secondary btn-xs btn-pid-adjust" data-module="${mod.name}" data-motor="${i}" data-param="d" data-action="plus" style="padding: 0; width: 12px; height: 18px; font-size: 9px; line-height: 1;">+</button>
            </div>
          </td>
          <td style="padding: 4px 0; text-align: center;">
            <input type="number" class="form-input form-input-sm input-mdd-wheel" data-module="${mod.name}" data-motor="${i}" step="1" value="${motorParam.diameter ?? 100.0}" style="padding: 2px 4px; font-size: 11px; height: 22px; width: 36px; text-align: center; display: inline-block; margin: 0;">
          </td>
          <td style="padding: 4px 0; text-align: center;">
            <select class="form-input form-input-sm select-mdd-dir" data-module="${mod.name}" data-motor="${i}" style="padding: 2px 4px; font-size: 11px; height: 22px; width: 34px; text-align: center; display: inline-block; font-weight: bold;">
              <option value="1" ${(motorParam.direction ?? 1) >= 0 ? "selected" : ""}>+</option>
              <option value="-1" ${(motorParam.direction ?? 1) < 0 ? "selected" : ""}>-</option>
            </select>
          </td>
        </tr>`;
    }

    const paramTableHtml = `
      <div class="mdd-params-table-wrapper mt-3">
        <h4 style="font-size: 12px; margin-bottom: 6px; font-weight: 600;"><i class="fa-solid fa-gears"></i> PID & Mode Settings</h4>
        <table class="mdd-params-table" style="width: 100%; border-collapse: collapse; font-size: 11px;">
          <thead>
            <tr style="border-bottom: 1px solid var(--border-light); text-align: left; color: var(--text-muted);">
              <th style="padding-bottom: 4px; width: 8%;">Ch</th>
              <th style="padding-bottom: 4px; width: 22%;">Mode</th>
              <th style="padding-bottom: 4px; text-align: center; width: 14%;">P</th>
              <th style="padding-bottom: 4px; text-align: center; width: 14%;">I</th>
              <th style="padding-bottom: 4px; text-align: center; width: 14%;">D</th>
              <th style="padding-bottom: 4px; text-align: center; width: 16%;">Wheel</th>
              <th style="padding-bottom: 4px; text-align: center; width: 12%;">Dir</th>
            </tr>
          </thead>
          <tbody>
            ${paramsRowsHtml}
          </tbody>
        </table>
      </div>`;

    return `
      <!-- モータ目標値スライダー -->
      <div class="mdd-sliders">
        ${slidersHtml}
      </div>
      
      <!-- PIDおよびモードの編集テーブル -->
      ${paramTableHtml}

      <!-- Limitスイッチインジケータ -->
      <div class="switches-section mt-3">
        <h4 style="font-size: 12px; margin-bottom: 6px; font-weight: 600;">Limit Switches</h4>
        <div class="switches-row">
          <div class="sw-indicator" id="sw-${mod.name}-1">SW 1</div>
          <div class="sw-indicator" id="sw-${mod.name}-2">SW 2</div>
          <div class="sw-indicator" id="sw-${mod.name}-3">SW 3</div>
          <div class="sw-indicator" id="sw-${mod.name}-4">SW 4</div>
        </div>
      </div>

      <!-- エンコーダ実測データ表示 -->
      <div class="mdd-params-grid mt-3">
        <div class="mdd-param-item">M1 FB: <span id="lbl-${mod.name}-m1-fb">0.0° / 0.0</span></div>
        <div class="mdd-param-item">M2 FB: <span id="lbl-${mod.name}-m2-fb">0.0° / 0.0</span></div>
        <div class="mdd-param-item">M3 FB: <span id="lbl-${mod.name}-m3-fb">0.0° / 0.0</span></div>
        <div class="mdd-param-item">M4 FB: <span id="lbl-${mod.name}-m4-fb">0.0° / 0.0</span></div>
      </div>
    `;
  }

  // --- Servoカードレンダリング ---
  function renderServoCardHtml(mod) {
    let slidersHtml = "";
    for (let i = 1; i <= 6; i++) {
      slidersHtml += `
        <div class="control-slider-group mt-2">
          <div class="slider-label-row">
            <span class="slider-name">Servo ${i}</span>
            <span class="slider-val" id="val-${mod.name}-s${i}">90°</span>
          </div>
          <input type="range" class="custom-range range-servo" data-module="${mod.name}" data-servo="${i}" 
                 min="0" max="180" value="90" id="range-${mod.name}-s${i}">
        </div>`;
    }
    return slidersHtml;
  }

  // --- Solenoidカードレンダリング ---
  function renderSolenoidCardHtml(mod) {
    let buttonsHtml = "";
    for (let i = 1; i <= 12; i++) {
      buttonsHtml += `<button class="valve-btn btn-solenoid" data-module="${mod.name}" data-channel="${i}" id="btn-${mod.name}-v${i}">V${i}</button>`;
    }
    return `
      <div class="valves-grid">
        ${buttonsHtml}
      </div>
    `;
  }

  // --- モジュール操作イベントのバインディング ---
  function bindCardEvents(mod) {
    // UI操作送信トグルの状態変更イベント
    const toggleSend = document.getElementById(`toggle-send-${mod.name}`);
    if (toggleSend) {
      if (state.moduleSendToggles[mod.name] === undefined) {
        state.moduleSendToggles[mod.name] = false;
      }
      toggleSend.checked = state.moduleSendToggles[mod.name];

      toggleSend.addEventListener("change", (e) => {
        const isChecked = e.target.checked;
        state.moduleSendToggles[mod.name] = isChecked;

        if (isChecked) {
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${mod.name} へのリアルタイムUI操作送信を有効にしました。`, "system-msg");
        } else {
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${mod.name} へのリアルタイムUI操作送信を無効にしました（目標値をゼロに安全停止します）。`, "system-msg");

          // トグルOFF時は安全のために目標値を0に戻す
          if (mod.type === "mdd") {
            for (let i = 1; i <= 4; i++) {
              const slider = document.getElementById(`range-${mod.name}-m${i}`);
              const valEl = document.getElementById(`val-${mod.name}-m${i}`);
              if (slider) slider.value = 0;
              if (valEl) {
                const mode = mod.parameters?.[`m${i}`]?.mode ?? 0;
                const unit = mode === 0 ? "rps" : mode === 1 ? "deg" : "mm";
                valEl.textContent = `0.0 ${unit}`;
              }
            }
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
              state.ws.send(JSON.stringify({
                type: "mdd_cmd",
                name: mod.name,
                targets: [0, 0, 0, 0]
              }));
            }
          } else if (mod.type === "servo") {
            // サーボは中央（90度）にリセット
            for (let i = 1; i <= 6; i++) {
              const slider = document.getElementById(`range-${mod.name}-s${i}`);
              const valEl = document.getElementById(`val-${mod.name}-s${i}`);
              if (slider) slider.value = 90;
              if (valEl) valEl.textContent = `90°`;
            }
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
              state.ws.send(JSON.stringify({
                type: "servo_cmd",
                name: mod.name,
                angles: [90, 90, 90, 90, 90, 90]
              }));
            }
          }
        }
      });
    }

    if (mod.type === "mdd") {
      // MDDスライダーのドラッグイベント
      const sliders = document.querySelectorAll(`.range-mdd[data-module="${mod.name}"]`);
      sliders.forEach(slider => {
        slider.addEventListener("input", (e) => {
          const motorIdx = e.target.getAttribute("data-motor");
          const valEl = document.getElementById(`val-${mod.name}-m${motorIdx}`);

          // モード表示の読み込み
          const mode = mod.parameters?.[`m${motorIdx}`]?.mode ?? 0;
          const unit = mode === 0 ? "rps" : mode === 1 ? "deg" : "mm";
          valEl.textContent = `${parseFloat(e.target.value).toFixed(1)} ${unit}`;

          // WebSocket経由で指令送信 (送信トグルがONのときのみ)
          if (state.moduleSendToggles[mod.name]) {
            sendMddTargetCommand(mod.name);
          }
        });
      });

      // モード変更イベントリスナーの追加
      const modeSelects = document.querySelectorAll(`.select-mdd-mode[data-module="${mod.name}"]`);
      modeSelects.forEach(sel => {
        sel.addEventListener("change", async (e) => {
          const motorIdx = e.target.getAttribute("data-motor");
          const modeVal = parseInt(e.target.value);

          const moduleObj = state.config.modules.find(m => m.name === mod.name);
          if (moduleObj) {
            if (!moduleObj.parameters) moduleObj.parameters = {};
            if (!moduleObj.parameters[`m${motorIdx}`]) {
              moduleObj.parameters[`m${motorIdx}`] = { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 };
            }
            moduleObj.parameters[`m${motorIdx}`].mode = modeVal;

            // スライダーおよび単位の動的更新
            const valEl = document.getElementById(`val-${mod.name}-m${motorIdx}`);
            const slider = document.getElementById(`range-${mod.name}-m${motorIdx}`);

            let min = -10;
            let max = 10;
            let step = 0.1;
            let unit = "rps";

            if (modeVal === 1) {
              min = -360;
              max = 360;
              step = 1;
              unit = "deg";
            } else if (modeVal === 2) {
              min = -1000;
              max = 1000;
              step = 1;
              unit = "mm";
            }

            if (slider) {
              slider.min = min;
              slider.max = max;
              slider.step = step;
              slider.value = 0; // モード切替時にリセット
            }
            if (valEl) valEl.textContent = `0.0 ${unit}`;

            // 設定ファイルを自動保存
            await saveConfigToServer();
          }
        });
      });

      // 目標値（スライダー値）の微調整ボタンイベントリスナー
      const adjustBtns = document.querySelectorAll(`.btn-target-adjust[data-module="${mod.name}"]`);
      adjustBtns.forEach(btn => {
        btn.addEventListener("click", (e) => {
          const motorIdx = btn.getAttribute("data-motor");
          const action = btn.getAttribute("data-action");

          const slider = document.getElementById(`range-${mod.name}-m${motorIdx}`);
          const valEl = document.getElementById(`val-${mod.name}-m${motorIdx}`);
          if (!slider) return;

          let curVal = parseFloat(slider.value) || 0.0;
          let step = parseFloat(slider.step) || 0.1;

          if (action === "plus") {
            curVal = Math.min(parseFloat(slider.max), curVal + step);
          } else {
            curVal = Math.max(parseFloat(slider.min), curVal - step);
          }

          slider.value = curVal;

          // モード表示の読み込み
          const mode = mod.parameters?.[`m${motorIdx}`]?.mode ?? 0;
          const unit = mode === 0 ? "rps" : mode === 1 ? "deg" : "mm";
          if (valEl) {
            valEl.textContent = `${curVal.toFixed(mode === 0 ? 1 : 0)} ${unit}`;
          }

          // WebSocket経由で指令送信 (送信トグルがONのときのみ)
          if (state.moduleSendToggles[mod.name]) {
            sendMddTargetCommand(mod.name);
          }
        });
      });

      // PIDの向き (direction) 変更イベントリスナーの追加
      const dirSelects = document.querySelectorAll(`.select-mdd-dir[data-module="${mod.name}"]`);
      dirSelects.forEach(sel => {
        sel.addEventListener("change", async (e) => {
          const motorIdx = e.target.getAttribute("data-motor");
          const dirVal = parseInt(e.target.value) || 1;

          const moduleObj = state.config.modules.find(m => m.name === mod.name);
          if (moduleObj) {
            if (!moduleObj.parameters) moduleObj.parameters = {};
            if (!moduleObj.parameters[`m${motorIdx}`]) {
              moduleObj.parameters[`m${motorIdx}`] = { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 };
            }
            moduleObj.parameters[`m${motorIdx}`].direction = dirVal;

            // 設定ファイルを自動保存
            await saveConfigToServer();
          }
        });
      });

      // 車輪直径 (diameter) 変更イベントリスナーの追加
      const wheelInputs = document.querySelectorAll(`.input-mdd-wheel[data-module="${mod.name}"]`);
      wheelInputs.forEach(input => {
        input.addEventListener("change", async (e) => {
          const motorIdx = e.target.getAttribute("data-motor");
          const wheelVal = parseFloat(e.target.value) || 100.0;

          const moduleObj = state.config.modules.find(m => m.name === mod.name);
          if (moduleObj) {
            if (!moduleObj.parameters) moduleObj.parameters = {};
            if (!moduleObj.parameters[`m${motorIdx}`]) {
              moduleObj.parameters[`m${motorIdx}`] = { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 };
            }
            moduleObj.parameters[`m${motorIdx}`].diameter = wheelVal;

            // 設定ファイルを自動保存
            await saveConfigToServer();
          }
        });
      });

      // PID値変更イベントリスナーの追加
      const pidInputs = document.querySelectorAll(`.input-mdd-p[data-module="${mod.name}"], .input-mdd-i[data-module="${mod.name}"], .input-mdd-d[data-module="${mod.name}"]`);
      pidInputs.forEach(input => {
        input.addEventListener("change", async (e) => {
          const motorIdx = e.target.getAttribute("data-motor");
          const moduleObj = state.config.modules.find(m => m.name === mod.name);
          if (moduleObj) {
            if (!moduleObj.parameters) moduleObj.parameters = {};
            if (!moduleObj.parameters[`m${motorIdx}`]) {
              moduleObj.parameters[`m${motorIdx}`] = { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 };
            }

            const val = parseFloat(e.target.value) || 0.0;
            if (e.target.classList.contains("input-mdd-p")) {
              moduleObj.parameters[`m${motorIdx}`].p = val;
            } else if (e.target.classList.contains("input-mdd-i")) {
              moduleObj.parameters[`m${motorIdx}`].i = val;
            } else if (e.target.classList.contains("input-mdd-d")) {
              moduleObj.parameters[`m${motorIdx}`].d = val;
            }

            // 設定ファイルを自動保存
            await saveConfigToServer();
          }
        });
      });

    } else if (mod.type === "servo") {
      // サーボスライダーのドラッグイベント
      const sliders = document.querySelectorAll(`.range-servo[data-module="${mod.name}"]`);
      sliders.forEach(slider => {
        slider.addEventListener("input", (e) => {
          const servoIdx = e.target.getAttribute("data-servo");
          const valEl = document.getElementById(`val-${mod.name}-s${servoIdx}`);
          valEl.textContent = `${e.target.value}°`;

          // 即時送信 (送信トグルがONのときのみ)
          if (state.moduleSendToggles[mod.name]) {
            sendServoAngleCommand(mod.name);
          }
        });
      });

    } else if (mod.type === "solenoid") {
      // ソレノイドバルブのON/OFFトグルイベント
      const btns = document.querySelectorAll(`.btn-solenoid[data-module="${mod.name}"]`);
      btns.forEach(btn => {
        btn.addEventListener("click", (e) => {
          btn.classList.toggle("active");

          // 即時送信 (送信トグルがONのときのみ)
          if (state.moduleSendToggles[mod.name]) {
            sendSolenoidCommand(mod.name);
          } else {
            // トグルOFFの場合はクリックされてもスタイルをもとに戻す
            btn.classList.toggle("active");
            appendTerminalLog(el.behaviorTerminal, `[WARNING] ${mod.name} の「UI操作送信」がOFFのためバルブ制御は送信されません。`, "error-msg");
          }
        });
      });
    }
  }

  // --- WebSocket 指令送信ロジック ---
  function sendMddTargetCommand(moduleName) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    // 4つのスライダー値を取得
    const targets = [];
    for (let i = 1; i <= 4; i++) {
      const slider = document.getElementById(`range-${moduleName}-m${i}`);
      targets.push(parseFloat(slider.value));
    }

    const payload = {
      type: "mdd_cmd",
      name: moduleName,
      targets: targets
    };
    state.ws.send(JSON.stringify(payload));
  }

  function sendServoAngleCommand(moduleName) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    const angles = [];
    for (let i = 1; i <= 6; i++) {
      const slider = document.getElementById(`range-${moduleName}-s${i}`);
      angles.push(parseInt(slider.value));
    }

    const payload = {
      type: "servo_cmd",
      name: moduleName,
      angles: angles
    };
    state.ws.send(JSON.stringify(payload));
  }

  function sendSolenoidCommand(moduleName) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    const valves = [];
    for (let i = 1; i <= 12; i++) {
      const btn = document.getElementById(`btn-${moduleName}-v${i}`);
      valves.push(btn.classList.contains("active"));
    }

    const payload = {
      type: "solenoid_cmd",
      name: moduleName,
      valves: valves
    };
    state.ws.send(JSON.stringify(payload));
  }

  // --- 8. WebSocket テレメトリ（フィードバック）のカード反映 ---
  function updateMddCardFeedback(name, data) {
    // Limitスイッチ
    for (let i = 0; i < 4; i++) {
      const swEl = document.getElementById(`sw-${name}-${i + 1}`);
      if (swEl) {
        if (data.limit_switches[i]) {
          swEl.classList.add("active");
        } else {
          swEl.classList.remove("active");
        }
      }
    }

    // エンコーダフィードバック (角度 ＆ 速度)
    for (let i = 0; i < 4; i++) {
      const fbEl = document.getElementById(`lbl-${name}-m${i + 1}-fb`);
      if (fbEl) {
        const ang = data.angles[i].toFixed(1);
        const spd = data.speeds[i].toFixed(2);
        fbEl.textContent = `${ang}° / ${spd} rps`;
      }
    }

    // エラー状態のチェック
    if (data.error_code > 0) {
      const card = document.getElementById(`module-card-${name}`);
      card.style.borderColor = "var(--color-danger)";
    } else {
      const card = document.getElementById(`module-card-${name}`);
      if (card) card.style.borderColor = "var(--border-light)";
    }

    // マイコン側のモード判定による自動リセット検知
    if (typeof data.system_status !== 'undefined') {
      const inGracePeriod = (Date.now() - (state.controlStartTimeMs || 0)) < 1500;
      if (data.system_status === 1 && state.controlMode !== "CONTROL") {
        state.controlMode = "CONTROL";
        if (el.lblControlModeStatus) {
          el.lblControlModeStatus.innerHTML = 'ステータス: <span class="badge badge-success">制御実行中 (Control Mode)</span>';
        }
      } else if (data.system_status === 0 && state.controlMode === "CONTROL" && !inGracePeriod) {
        state.controlMode = "SETUP";
        if (el.lblControlModeStatus) {
          el.lblControlModeStatus.innerHTML = 'ステータス: <span class="badge badge-warning">パラメータ未送信 (待機中)</span>';
        }
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] マイコン '${name}' の待機状態（パラメータ設定モード）へのリセットを検知しました。パラメータを再送信してください。`, "system-msg");
      }
    }
  }

  // --- 9. ポート一覧 ＆ CAN接続制御 ---
  async function refreshPorts() {
    try {
      const res = await fetch("/api/ports");
      const data = await res.json();
      state.ports = data.ports;

      el.selCanPort.innerHTML = "";
      if (state.ports.length === 0) {
        el.selCanPort.innerHTML = '<option value="">ポート未検出</option>';
        return;
      }

      state.ports.forEach(port => {
        const opt = document.createElement("option");
        opt.value = port;
        opt.textContent = port;
        el.selCanPort.appendChild(opt);
      });
    } catch (err) {
      console.error("ポート取得失敗:", err);
    }
  }

  el.btnRefreshPorts.addEventListener("click", refreshPorts);

  // Ethernet / USB 接続モードタブ切り替え
  if (el.tabModeEth && el.tabModeUsb) {
    el.tabModeEth.addEventListener("click", () => {
      el.tabModeEth.className = "btn btn-sm btn-primary";
      el.tabModeUsb.className = "btn btn-sm btn-secondary";
      el.panelConnEth.style.display = "block";
      el.panelConnUsb.style.display = "none";
    });

    el.tabModeUsb.addEventListener("click", () => {
      el.tabModeUsb.className = "btn btn-sm btn-primary";
      el.tabModeEth.className = "btn btn-sm btn-secondary";
      el.panelConnUsb.style.display = "block";
      el.panelConnEth.style.display = "none";
    });
  }

  // Ethernet-CAN 設定の初期ロード
  async function loadEthCanConfig() {
    try {
      const res = await fetch("/api/eth_can/config");
      const cfg = await res.json();
      if (cfg.target_ip && el.txtEthIp) el.txtEthIp.value = cfg.target_ip;
      if (cfg.target_port && el.txtEthPort) el.txtEthPort.value = cfg.target_port;
    } catch (e) {
      // 読み込み失敗時は初期値を維持
    }
  }
  loadEthCanConfig();

  // Ethernet-CAN 接続ボタン
  if (el.btnConnectEth) {
    el.btnConnectEth.addEventListener("click", async () => {
      const ip = el.txtEthIp.value.trim();
      const port = parseInt(el.txtEthPort.value.trim(), 10) || 5000;

      appendTerminalLog(el.behaviorTerminal, `Ethernet-CAN (${ip}:${port}) への接続要求を送信中...`);

      try {
        const res = await fetch("/api/eth_can/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target_ip: ip, target_port: port })
        });
        const data = await res.json();
        if (data.success) {
          appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
        } else {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信に失敗しました: ${err}`, "error-msg");
      }
    });
  }

  // 自動探索チェックボックスの挙動
  el.chkAutoConnect.addEventListener("change", (e) => {
    const isAuto = e.target.checked;
    el.selCanPort.disabled = isAuto;
    el.btnRefreshPorts.disabled = isAuto;
  });

  // 接続ボタン
  el.btnConnectCan.addEventListener("click", async () => {
    const auto = el.chkAutoConnect.checked;
    const port = el.selCanPort.value;

    appendTerminalLog(el.behaviorTerminal, "USB-to-CAN 接続要求を送信中...");

    try {
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: port, auto_connect: auto })
      });
      const data = await res.json();

      if (data.success) {
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
      } else {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
      }
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信に失敗しました: ${err}`, "error-msg");
    }
  });

  // 切断ボタン
  el.btnDisconnectCan.addEventListener("click", async () => {
    appendTerminalLog(el.behaviorTerminal, "USB-to-CAN 切断要求を送信中...");
    try {
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: "", auto_connect: false }) // 空で送ると切断
      });
      const data = await res.json();
      appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信失敗: ${err}`, "error-msg");
    }
  });

  // パラメータ送信 ＆ 制御開始
  el.btnSendParams.addEventListener("click", async () => {
    appendTerminalLog(el.behaviorTerminal, "制御パラメータ送信中...");
    try {
      const res = await fetch("/api/start_control", { method: "POST" });
      const data = await res.json();

      if (data.success) {
        state.controlStartTimeMs = Date.now();
        appendTerminalLog(el.behaviorTerminal, "[SYSTEM] パラメータ送信成功。制御実行状態になりました！", "system-msg");
        el.lblControlModeStatus.innerHTML = 'ステータス: <span class="badge badge-success">制御実行中 (Control Mode)</span>';
        state.controlMode = "CONTROL";
      } else {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 送信失敗: ${data.message}`, "error-msg");
      }
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信失敗: ${err}`, "error-msg");
    }
  });

  // --- 10. プロファイル管理処理 ---
  async function refreshProfiles() {
    try {
      const res = await fetch("/api/profiles");
      const data = await res.json();
      state.profiles = data.profiles;

      el.profileListUl.innerHTML = "";
      if (state.profiles.length === 0) {
        el.profileListUl.innerHTML = '<li class="profile-item">プロファイルはありません。</li>';
        return;
      }

      state.profiles.forEach(pname => {
        const li = document.createElement("li");
        li.className = "profile-item";
        li.innerHTML = `
          <div class="profile-name-sec">
            <i class="fa-solid fa-file-invoice"></i>
            <span>${pname}</span>
          </div>
          <div class="profile-actions">
            <button class="btn btn-primary btn-xs" onclick="loadProfile('${pname}')">適用</button>
            <button class="btn btn-danger btn-xs" onclick="deleteProfileFile('${pname}')">削除</button>
          </div>
        `;
        el.profileListUl.appendChild(li);
      });
    } catch (err) {
      console.error("プロファイル取得失敗:", err);
    }
  }

  // --- 動作プログラムファイル一覧の動的取得と表示 ---
  async function refreshBehaviors() {
    try {
      const res = await fetch("/api/behavior/list");
      const data = await res.json();

      if (!data.success || !data.behaviors) {
        console.error("プログラムファイル取得失敗:", data.error || "不明なエラー");
        el.selBehaviorScript.innerHTML = '<option value="">ファイルが見つかりません</option>';
        return;
      }

      // ドロップダウンをクリア
      el.selBehaviorScript.innerHTML = '';

      // 取得したファイル一覧をオプションとして追加
      if (data.behaviors.length === 0) {
        el.selBehaviorScript.innerHTML = '<option value="">プログラムファイルがありません</option>';
      } else {
        data.behaviors.forEach(filename => {
          const option = document.createElement("option");
          option.value = filename;
          option.textContent = filename;
          el.selBehaviorScript.appendChild(option);
        });
      }
    } catch (err) {
      console.error("プログラムファイル取得失敗:", err);
      el.selBehaviorScript.innerHTML = '<option value="">通信エラー</option>';
    }
  }

  // プロファイルのロード（グローバル関数化）
  window.loadProfile = async (name) => {
    appendTerminalLog(el.behaviorTerminal, `プロファイル '${name}' をロード中...`);
    try {
      const res = await fetch(`/api/profiles/load?name=${name}`, { method: "POST" });
      const data = await res.json();
      appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");

      // 設定ファイルを再読み込みしてDashboardを更新
      await loadConfigAndRender();
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] ロード失敗: ${err}`, "error-msg");
    }
  };

  // プロファイルの削除（グローバル関数化）
  window.deleteProfileFile = async (name) => {
    if (!confirm(`プロファイル '${name}' を本当に削除しますか？`)) {
      return;
    }
    appendTerminalLog(el.behaviorTerminal, `プロファイル '${name}' を削除中...`);
    try {
      const res = await fetch(`/api/profiles/delete?name=${name}`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
        refreshProfiles();
      } else {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 削除失敗: ${data.detail || data.message}`, "error-msg");
      }
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 削除失敗: ${err}`, "error-msg");
    }
  };

  // プロファイル新規保存
  el.btnSaveProfile.addEventListener("click", async () => {
    const name = el.txtNewProfileName.value.trim();
    if (!name) return;

    appendTerminalLog(el.behaviorTerminal, `現在の構成をプロファイル '${name}' として保存中...`);
    try {
      const res = await fetch(`/api/profiles/save?name=${name}`, { method: "POST" });
      const data = await res.json();
      appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");

      el.txtNewProfileName.value = "";
      refreshProfiles();
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 保存失敗: ${err}`, "error-msg");
    }
  });

  // プロファイルエクスポート
  el.btnExportProfile.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/config");
      const configData = await res.json();

      const blob = new Blob([JSON.stringify(configData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = "modules_config.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("エクスポート失敗:", err);
    }
  });

  // プロファイルインポート
  el.fileImportProfile.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const configData = JSON.parse(event.target.result);

        // サーバーの設定を上書き更新
        const res = await fetch("/api/config/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(configData)
        });
        const data = await res.json();

        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] 設定ファイルをインポートしました: ${data.message}`, "system-msg");
        await loadConfigAndRender();
      } catch (err) {
        alert("インポートに失敗しました。JSONファイルの構造が正しいか確認してください。");
      }
    };
    reader.readAsText(file);
  });

  // --- 11. 動作プログラム(Behavior)の起動 ＆ 停止制御 ---
  el.btnStartBehavior.addEventListener("click", async () => {
    const script = el.selBehaviorScript.value;
    appendTerminalLog(el.behaviorTerminal, `プログラム '${script}' の起動要求を送信...`);
    try {
      const res = await fetch("/api/behavior/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ behavior_name: script })
      });
      const data = await res.json();
      if (data.success) {
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
      } else {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
      }
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信エラー: ${err}`, "error-msg");
    }
  });

  el.btnStopBehavior.addEventListener("click", async () => {
    appendTerminalLog(el.behaviorTerminal, "プログラム停止要求を送信...");
    try {
      const res = await fetch("/api/behavior/stop", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        appendTerminalLog(el.behaviorTerminal, `[SYSTEM] ${data.message}`, "system-msg");
      } else {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] ${data.message}`, "error-msg");
      }
    } catch (err) {
      appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信エラー: ${err}`, "error-msg");
    }
  });

  el.btnClearConsole.addEventListener("click", () => {
    el.behaviorTerminal.innerHTML = '<div class="terminal-line system-msg">[SYSTEM] ターミナルをクリアしました。</div>';
  });

  // --- 12. モジュール動的削除 ＆ 編集用（グローバル定義） ---
  window.deleteModule = async (name) => {
    if (!confirm(`本当にモジュール '${name}' を削除しますか？`)) return;

    // 設定ファイルから除外して更新
    state.config.modules = state.config.modules.filter(m => m.name !== name);

    try {
      const res = await fetch("/api/config/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.config)
      });
      const data = await res.json();
      appendTerminalLog(el.behaviorTerminal, `モジュールを削除しました: ${data.message}`);
      await loadConfigAndRender();
    } catch (err) {
      console.error("モジュール削除失敗:", err);
    }
  };

  // モーダル制御
  el.btnAddModuleModal.addEventListener("click", () => {
    el.modal.classList.add("active");
  });

  el.btnCloseModal.addEventListener("click", closeModal);
  el.btnCancelModal.addEventListener("click", closeModal);

  function closeModal() {
    el.modal.classList.remove("active");
    // フォームクリア
    el.modalModuleName.value = "";
    el.modalModuleId.value = "";
    el.modalModuleDesc.value = "";
  }

  el.btnSaveModule.addEventListener("click", async () => {
    const type = el.modalModuleType.value;
    const name = el.modalModuleName.value.trim();
    const id = el.modalModuleId.value.trim();
    const desc = el.modalModuleDesc.value.trim();

    if (!name || !id) {
      alert("名前とBase CAN IDは必須です。");
      return;
    }

    // 重複チェック
    if (state.config.modules.some(m => m.name === name)) {
      alert("すでに同じ名前のモジュールが存在します。");
      return;
    }

    // 新規モジュールオブジェクト
    const newMod = {
      name: name,
      type: type,
      base_id: id,
      description: desc
    };

    // MDD特有の初期パラメータ構造を追加
    if (type === "mdd") {
      newMod.parameters = {
        m1: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 },
        m2: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 },
        m3: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 },
        m4: { p: 10.0, i: 0.0, d: 0.0, diameter: 100.0, direction: 1, mode: 0 }
      };
    }

    state.config.modules.push(newMod);

    try {
      const res = await fetch("/api/config/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.config)
      });
      const data = await res.json();
      appendTerminalLog(el.behaviorTerminal, `モジュールを追加しました: ${data.message}`);

      closeModal();
      await loadConfigAndRender();
    } catch (err) {
      console.error("モジュール追加失敗:", err);
    }
  });

  // 非常停止
  el.btnEmergencyStop.addEventListener("click", async () => {
    appendTerminalLog(el.behaviorTerminal, "🚨 [EMERGENCY STOP] 非常停止コマンドを発行しました！", "error-msg");
    // 全指令を停止するために WebSocket に停止要求を一括送信
    state.config.modules.forEach(mod => {
      if (mod.type === "mdd") {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: "mdd_cmd", name: mod.name, targets: [0, 0, 0, 0] }));
        }
      } else if (mod.type === "solenoid") {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: "solenoid_cmd", name: mod.name, valves: [false] * 12 }));
        }
      }
    });

    // 動作プログラムの強制終了
    await fetch("/api/behavior/stop", { method: "POST" });
  });

  // 設定保存用APIの呼び出し
  async function saveConfigToServer() {
    try {
      await fetch("/api/config/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.config)
      });
    } catch (err) {
      console.error("設定の自動保存に失敗しました:", err);
    }
  }

  // --- 13. 初期化処理の実行 ---
  connectWebSocket();
  loadConfigAndRender();
  refreshPorts();
  refreshProfiles();
  refreshBehaviors();

  // 全画面表示の切り替え
  const btnFullscreen = document.getElementById("btn-fullscreen-toggle");
  if (btnFullscreen) {
    btnFullscreen.addEventListener("click", () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
          console.error(`全画面表示への切り替えに失敗しました: ${err.message}`);
        });
        btnFullscreen.innerHTML = '<i class="fa-solid fa-compress"></i> 画面縮小';
      } else {
        document.exitFullscreen();
        btnFullscreen.innerHTML = '<i class="fa-solid fa-expand"></i> 全画面表示';
      }
    });
  }

  // ==========================================================================
  // --- 14. Blockly ビジュアルマクロ統合 ＆ Pythonコードリアルタイム生成 ---
  // ==========================================================================

  // 登録済みモジュールの一覧を動的に取得するドロップダウン生成ヘルパー
  const getModuleOptionsDropdown = function (type) {
    return function () {
      if (!state.config || !state.config.modules) {
        return [["未選択", "none"]];
      }
      const mods = state.config.modules.filter(m => m.type === type);
      let options = mods.map(m => [m.name, m.name]);
      if (options.length === 0) {
        options.push(["登録なし", "none"]);
      }
      return options;
    };
  };

  // Blockly カスタムブロック定義
  Blockly.Blocks['mdd_move'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("MDD モータ制御")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('mdd')), "NAME");
      this.appendValueInput("M1")
        .setCheck("Number")
        .appendField("M1");
      this.appendValueInput("M2")
        .setCheck("Number")
        .appendField("M2");
      this.appendValueInput("M3")
        .setCheck("Number")
        .appendField("M3");
      this.appendValueInput("M4")
        .setCheck("Number")
        .appendField("M4");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(230);
      this.setTooltip("MDDモータの目標速度/目標角度/目標位置を一括指示します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['servo_move'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("Servo 角度制御")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('servo')), "NAME");
      this.appendValueInput("S1")
        .setCheck("Number")
        .appendField("S1 (0-180°)");
      this.appendValueInput("S2")
        .setCheck("Number")
        .appendField("S2 (0-180°)");
      this.appendValueInput("S3")
        .setCheck("Number")
        .appendField("S3 (0-180°)");
      this.appendValueInput("S4")
        .setCheck("Number")
        .appendField("S4 (0-180°)");
      this.appendValueInput("S5")
        .setCheck("Number")
        .appendField("S5 (0-180°)");
      this.appendValueInput("S6")
        .setCheck("Number")
        .appendField("S6 (0-180°)");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(60);
      this.setTooltip("サーボの目標角度を6ch一括指示します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['valve_control'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("Solenoid 電磁弁制御")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('solenoid')), "NAME")
        .appendField("Ch")
        .appendField(new Blockly.FieldNumber(1, 1, 12, 1), "CHANNEL")
        .appendField("状態")
        .appendField(new Blockly.FieldDropdown([["ON", "True"], ["OFF", "False"]]), "STATE");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(0);
      this.setTooltip("特定の電磁弁をON/OFF制御します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['mdd_sw_val'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("MDD SW:")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('mdd')), "NAME")
        .appendField("の リミットSW")
        .appendField(new Blockly.FieldDropdown([["SW1", "0"], ["SW2", "1"], ["SW3", "2"], ["SW4", "3"]]), "SW_IDX")
        .appendField("状態 (ON/OFF)");
      this.setOutput(true, "Boolean");
      this.setColour(80);
      this.setTooltip("対象MDDのリミットスイッチ状態(True=ON / 押されている, False=OFF)を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['mdd_enc_deg_val'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("MDD エンコーダー:")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('mdd')), "NAME")
        .appendField("の モータ")
        .appendField(new Blockly.FieldDropdown([["M1", "0"], ["M2", "1"], ["M3", "2"], ["M4", "3"]]), "MOTOR_IDX")
        .appendField("の現在角度 (度)");
      this.setOutput(true, "Number");
      this.setColour(80);
      this.setTooltip("対象MDDのモータの現在角度(度)を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['mdd_enc_rps_val'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("MDD エンコーダー:")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('mdd')), "NAME")
        .appendField("の モータ")
        .appendField(new Blockly.FieldDropdown([["M1", "0"], ["M2", "1"], ["M3", "2"], ["M4", "3"]]), "MOTOR_IDX")
        .appendField("の現在速度 (rps)");
      this.setOutput(true, "Number");
      this.setColour(80);
      this.setTooltip("対象MDDのモータの現在回転速度(rps)を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['event_macro'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("🏁 マクロ実行時 (エントリポイント)");
      this.appendStatementInput("DO")
        .setCheck(null);
      this.setColour('#f59e0b');
      this.setTooltip("「マクロを実行」ボタンを押した時に、この中に接続されたブロックが上から順に実行されます。");
    }
  };

  Blockly.Blocks['delay_wait'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("遅延ウェイト")
        .appendField(new Blockly.FieldNumber(500, 0, 60000, 10), "MS")
        .appendField("ミリ秒 (ms)");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(120);
      this.setTooltip("指定されたミリ秒数処理を一時停止します。1000ミリ秒＝1秒です。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['print_log'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("ログ出力");
      this.appendValueInput("TEXT")
        .setCheck(null);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(180);
      this.setTooltip("ROS2ログ出力画面に変数の値や文字列を出力します。");
      this.setHelpUrl("");
    }
  };

  // コントローラー用カスタムブロック
  Blockly.Blocks['gamepad_button'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("コントローラー ボタン")
        .appendField(new Blockly.FieldDropdown([
          ["Button A / ×", "0"],
          ["Button B / ○", "1"],
          ["Button X / □", "2"],
          ["Button Y / △", "3"],
          ["L1", "4"],
          ["R1", "5"],
          ["L2 (デジタル)", "6"],
          ["R2 (デジタル)", "7"],
          ["Share / Select", "8"],
          ["Options / Start", "9"],
          ["L-Stick クリック", "10"],
          ["R-Stick クリック", "11"],
          ["D-Pad Up", "12"],
          ["D-Pad Down", "13"],
          ["D-Pad Left", "14"],
          ["D-Pad Right", "15"]
        ]), "BUTTON");
      this.setOutput(true, "Boolean");
      this.setColour(290);
      this.setTooltip("ゲームコントローラーの特定のボタンが押されているか(True/False)を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['gamepad_axis'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("コントローラー ")
        .appendField(new Blockly.FieldDropdown([
          ["L-Stick 左右 (X)", "0"],
          ["L-Stick 上下 (Y)", "1"],
          ["R-Stick 左右 (X)", "2"],
          ["R-Stick 上下 (Y)", "3"]
        ]), "AXIS")
        .appendField("傾き");
      this.setOutput(true, "Number");
      this.setColour(290);
      this.setTooltip("ゲームコントローラーの指定されたスティックの傾き値(-1.0〜1.0)を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['gamepad_axis_scaled'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("コントローラー ")
        .appendField(new Blockly.FieldDropdown([
          ["L-Stick 左右 (X)", "0"],
          ["L-Stick 上下 (Y)", "1"],
          ["R-Stick 左右 (X)", "2"],
          ["R-Stick 上下 (Y)", "3"]
        ]), "AXIS")
        .appendField("の傾き × 係数")
        .appendField(new Blockly.FieldNumber(1000, -10000, 10000, 1), "SCALE");
      this.setOutput(true, "Number");
      this.setColour(290);
      this.setTooltip("コントローラーの指定されたスティックの傾き値(-1.0〜1.0)に指定した係数を掛けた値を取得します。");
      this.setHelpUrl("");
    }
  };

  Blockly.Blocks['robot_kinematics'] = {
    init: function () {
      this.appendDummyInput()
        .appendField("🤖 ロボット運動学制御")
        .appendField(new Blockly.FieldDropdown([
          ["3輪オムニ", "3_OMNI"],
          ["4輪オムニ", "4_OMNI"],
          ["4輪メカナム", "4_MECANUM"],
          ["差動2輪", "2_DIFF"]
        ]), "TYPE");
      this.appendDummyInput()
        .appendField("モータドライバ:")
        .appendField(new Blockly.FieldDropdown(getModuleOptionsDropdown('mdd')), "MDD")
        .appendField("  旋回直径:")
        .appendField(new Blockly.FieldNumber(300, 10, 2000, 1), "L")
        .appendField("mm");
      this.appendDummyInput()
        .appendField("モータ割当: LF/左前/左輪:")
        .appendField(new Blockly.FieldDropdown([["M1", "m1"], ["M2", "m2"], ["M3", "m3"], ["M4", "m4"], ["なし", "none"]]), "M_LF")
        .appendField(" 反転:")
        .appendField(new Blockly.FieldCheckbox("FALSE"), "INV_LF");
      this.appendDummyInput()
        .appendField("            RF/右前/右輪:")
        .appendField(new Blockly.FieldDropdown([["M1", "m1"], ["M2", "m2"], ["M3", "m3"], ["M4", "m4"], ["なし", "none"]]), "M_RF")
        .appendField(" 反転:")
        .appendField(new Blockly.FieldCheckbox("FALSE"), "INV_RF");
      this.appendDummyInput()
        .appendField("            LR/左後/左輪:")
        .appendField(new Blockly.FieldDropdown([["M1", "m1"], ["M2", "m2"], ["M3", "m3"], ["M4", "m4"], ["なし", "none"]]), "M_LR")
        .appendField(" 反転:")
        .appendField(new Blockly.FieldCheckbox("FALSE"), "INV_LR");
      this.appendDummyInput()
        .appendField("            RR/右後/右輪:")
        .appendField(new Blockly.FieldDropdown([["M1", "m1"], ["M2", "m2"], ["M3", "m3"], ["M4", "m4"], ["なし", "none"]]), "M_RR")
        .appendField(" 反転:")
        .appendField(new Blockly.FieldCheckbox("FALSE"), "INV_RR");
      this.appendValueInput("VX")
        .setCheck("Number")
        .appendField("入力 Vx (左右速度 mm/s)");
      this.appendValueInput("VY")
        .setCheck("Number")
        .appendField("入力 Vy (前後速度 mm/s)");
      this.appendValueInput("OMEGA")
        .setCheck("Number")
        .appendField("入力 ω (旋回角速度 rad/s)");
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour(260);
      this.setTooltip("Vx, Vy, ω から足回りの逆運動学を計算し、指定したMDDモータの目標値へ指示します。各タイヤ直径はパラメータ設定の値が自動使用されます。");
      this.setHelpUrl("");
    }
  };

  // Blockly.Python ジェネレーターの定義と互換性ポリフィル
  let pyGen = null;
  if (typeof python !== 'undefined' && python.pythonGenerator) {
    pyGen = python.pythonGenerator;
    // 古いコードへの互換マッピングを安全に行う
    if (typeof Blockly !== 'undefined') {
      Blockly.Python = pyGen;
    }
  } else if (typeof Blockly !== 'undefined' && Blockly.Python) {
    pyGen = Blockly.Python;
  }
  if (pyGen) {
    pyGen.INDENT = "    "; // Pythonの標準インデント幅を4スペースに統一
  }
  if (typeof Blockly !== 'undefined' && Blockly.Python) {
    Blockly.Python.INDENT = "    ";
  }

  // ジェネレーター登録ヘルパー（最新・旧バージョン両対応）
  const registerGenerator = function (blockName, generatorFunc) {
    if (!pyGen) return;
    if (pyGen.forBlock) {
      pyGen.forBlock[blockName] = generatorFunc;
    } else {
      pyGen[blockName] = generatorFunc;
    }
  };

  // アトミックオーダー取得ヘルパー
  const getAtomicOrder = function () {
    if (pyGen && pyGen.Order) return pyGen.Order.ATOMIC;
    if (Blockly.Python && typeof Blockly.Python.ORDER_ATOMIC !== 'undefined') return Blockly.Python.ORDER_ATOMIC;
    return 99; // fallback
  };

  registerGenerator('event_macro', function (block, generator) {
    const gen = generator || pyGen;
    const branch = gen.statementToCode(block, 'DO');
    // statementToCode が自動付与する先頭のインデントを1レベル分削除する
    const indent = gen.INDENT || '    ';
    const cleanedBranch = branch.split('\n').map(line => {
      if (line.startsWith(indent)) {
        return line.substring(indent.length);
      }
      return line;
    }).join('\n');
    return cleanedBranch;
  });

  registerGenerator('mdd_move', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const name = block.getFieldValue('NAME');
    if (name === 'none') return '';
    const gen = generator || pyGen;
    const order = getAtomicOrder();
    const m1 = gen.valueToCode(block, 'M1', order) || '0.0';
    const m2 = gen.valueToCode(block, 'M2', order) || '0.0';
    const m3 = gen.valueToCode(block, 'M3', order) || '0.0';
    const m4 = gen.valueToCode(block, 'M4', order) || '0.0';
    return `self.get_module("${name}").set_targets([${m1}, ${m2}, ${m3}, ${m4}])\n`;
  });

  registerGenerator('servo_move', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const name = block.getFieldValue('NAME');
    if (name === 'none') return '';
    const gen = generator || pyGen;
    const order = getAtomicOrder();
    const s1 = gen.valueToCode(block, 'S1', order) || '90';
    const s2 = gen.valueToCode(block, 'S2', order) || '90';
    const s3 = gen.valueToCode(block, 'S3', order) || '90';
    const s4 = gen.valueToCode(block, 'S4', order) || '90';
    const s5 = gen.valueToCode(block, 'S5', order) || '90';
    const s6 = gen.valueToCode(block, 'S6', order) || '90';
    return `self.get_module("${name}").set_angles([${s1}, ${s2}, ${s3}, ${s4}, ${s5}, ${s6}])\n`;
  });

  registerGenerator('valve_control', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const name = block.getFieldValue('NAME');
    if (name === 'none') return '';
    const channel = block.getFieldValue('CHANNEL');
    const state = block.getFieldValue('STATE');
    return `self.get_module("${name}").set_valve(${channel}, ${state})\n`;
  });

  registerGenerator('delay_wait', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const ms = block.getFieldValue('MS');
    return `time.sleep(${ms} / 1000.0)\n`;
  });

  registerGenerator('print_log', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const gen = generator || pyGen;
    const val = gen.valueToCode(block, 'TEXT', getAtomicOrder()) || '"マクロを実行中..."';
    return `self.get_logger().info(f"[BLOCKLY] {${val}}")\n`;
  });

  registerGenerator('gamepad_button', function (block, generator) {
    const buttonIdx = block.getFieldValue('BUTTON');
    const code = `self.gamepad.get_button(${buttonIdx})`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('gamepad_axis', function (block, generator) {
    const axisIdx = block.getFieldValue('AXIS');
    const code = `self.gamepad.get_axis(${axisIdx})`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('mdd_sw_val', function (block, generator) {
    const name = block.getFieldValue('NAME');
    if (name === 'none') return ['False', getAtomicOrder()];
    const swIdx = block.getFieldValue('SW_IDX');
    const code = `self.get_module("${name}").get_feedback().limit_switches[${swIdx}]`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('mdd_enc_deg_val', function (block, generator) {
    const name = block.getFieldValue('NAME');
    if (name === 'none') return ['0.0', getAtomicOrder()];
    const motorIdx = block.getFieldValue('MOTOR_IDX');
    const code = `self.get_module("${name}").get_feedback().angles[${motorIdx}]`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('mdd_enc_rps_val', function (block, generator) {
    const name = block.getFieldValue('NAME');
    if (name === 'none') return ['0.0', getAtomicOrder()];
    const motorIdx = block.getFieldValue('MOTOR_IDX');
    const code = `self.get_module("${name}").get_feedback().speeds[${motorIdx}]`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('gamepad_axis_scaled', function (block, generator) {
    const axisIdx = block.getFieldValue('AXIS');
    const scale = block.getFieldValue('SCALE') || '1.0';
    const code = `(self.gamepad.get_axis(${axisIdx}) * ${scale})`;
    return [code, getAtomicOrder()];
  });

  registerGenerator('robot_kinematics', function (block, generator) {
    const root = block.getRootBlock();
    if (!root || root.type !== 'event_macro') return '';
    const gen = generator || pyGen;
    const order = getAtomicOrder();

    const type = block.getFieldValue('TYPE');
    const mddName = block.getFieldValue('MDD');
    const tread = block.getFieldValue('L') || '300.0';

    const mLf = block.getFieldValue('M_LF');
    const mRf = block.getFieldValue('M_RF');
    const mLr = block.getFieldValue('M_LR');
    const mRr = block.getFieldValue('M_RR');

    const invLf = block.getFieldValue('INV_LF') === 'TRUE' ? '-1.0' : '1.0';
    const invRf = block.getFieldValue('INV_RF') === 'TRUE' ? '-1.0' : '1.0';
    const invLr = block.getFieldValue('INV_LR') === 'TRUE' ? '-1.0' : '1.0';
    const invRr = block.getFieldValue('INV_RR') === 'TRUE' ? '-1.0' : '1.0';

    const vx = gen.valueToCode(block, 'VX', order) || '0.0';
    const vy = gen.valueToCode(block, 'VY', order) || '0.0';
    const omega = gen.valueToCode(block, 'OMEGA', order) || '0.0';

    return `
# 運動学計算実行
def _calc_kinematics():
    import math
    vx_val = float(${vx}) / 1000.0
    vy_val = float(${vy}) / 1000.0
    omega_val = float(${omega})
    
    r_t = ${tread} / 2000.0
    
    def get_dia(m_name):
        if m_name == 'none': return 100.0
        for m in self.config.get('modules', []):
            if m.get('name') == "${mddName}":
                return m.get('parameters', {}).get(m_name, {}).get('diameter', 100.0)
        return 100.0
        
    dia_lf = get_dia("${mLf}")
    dia_rf = get_dia("${mRf}")
    dia_lr = get_dia("${mLr}")
    dia_rr = get_dia("${mRr}")
    
    k_lf = 1000.0 / (math.pi * dia_lf) if dia_lf > 0 else 1.0
    k_rf = 1000.0 / (math.pi * dia_rf) if dia_rf > 0 else 1.0
    k_lr = 1000.0 / (math.pi * dia_lr) if dia_lr > 0 else 1.0
    k_rr = 1000.0 / (math.pi * dia_rr) if dia_rr > 0 else 1.0
    
    target_speeds = [0.0, 0.0, 0.0, 0.0]
    
    if "${type}" == "3_OMNI":
        v1 = (vy_val + r_t * omega_val) * ${invLf}
        v2 = (-0.866025 * vx_val - 0.5 * vy_val + r_t * omega_val) * ${invRf}
        v3 = (0.866025 * vx_val - 0.5 * vy_val + r_t * omega_val) * ${invLr}
        
        for slot, val in [("${mLf}", v1 * k_lf), ("${mRf}", v2 * k_rf), ("${mLr}", v3 * k_lr)]:
            if slot != 'none':
                idx = int(slot[1]) - 1
                target_speeds[idx] = val
                
    elif "${type}" == "4_OMNI":
        v_lf = (-0.707107 * vx_val + 0.707107 * vy_val - r_t * omega_val) * ${invLf}
        v_rf = (0.707107 * vx_val + 0.707107 * vy_val + r_t * omega_val) * ${invRf}
        v_lr = (-0.707107 * vx_val - 0.707107 * vy_val + r_t * omega_val) * ${invLr}
        v_rr = (0.707107 * vx_val - 0.707107 * vy_val - r_t * omega_val) * ${invRr}
        
        for slot, val in [("${mLf}", v_lf * k_lf), ("${mRf}", v_rf * k_rf), ("${mLr}", v_lr * k_lr), ("${mRr}", v_rr * k_rr)]:
            if slot != 'none':
                idx = int(slot[1]) - 1
                target_speeds[idx] = val
                
    elif "${type}" == "4_MECANUM":
        v_lf = (vy_val - vx_val - r_t * omega_val) * ${invLf}
        v_rf = (vy_val + vx_val + r_t * omega_val) * ${invRf}
        v_lr = (vy_val + vx_val - r_t * omega_val) * ${invLr}
        v_rr = (vy_val - vx_val + r_t * omega_val) * ${invRr}
        
        for slot, val in [("${mLf}", v_lf * k_lf), ("${mRf}", v_rf * k_rf), ("${mLr}", v_lr * k_lr), ("${mRr}", v_rr * k_rr)]:
            if slot != 'none':
                idx = int(slot[1]) - 1
                target_speeds[idx] = val
                
    elif "${type}" == "2_DIFF":
        v_l = vy_val - r_t * omega_val
        v_r = vy_val + r_t * omega_val
        
        for slot, val in [("${mLf}", v_l * k_lf * ${invLf}), ("${mLr}", v_l * k_lr * ${invLr})]:
            if slot != 'none':
                idx = int(slot[1]) - 1
                target_speeds[idx] = val
        for slot, val in [("${mRf}", v_r * k_rf * ${invRf}), ("${mRr}", v_r * k_rr * ${invRr})]:
            if slot != 'none':
                idx = int(slot[1]) - 1
                target_speeds[idx] = val
                
    self.get_module("${mddName}").set_targets(target_speeds)

_calc_kinematics()
`;
  });

  // フルPythonコードに組み立てるヘルパー
  function generatePythonCode(blocklyCode) {
    // すべての行に対して一律で 12スペース（tryブロックのインデント）を動的に付与する
    const indentedCode = blocklyCode
      .split('\n')
      .map(line => {
        if (line.trim() === '') return '';
        return '            ' + line;
      })
      .join('\n');

    return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Altair Module System - Blockly 自動生成プログラム
"""

import sys
import rclpy
import os
import time

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from altair_core.base_behavior import AltairBehavior

class BlocklyBehavior(AltairBehavior):
    def on_init(self):
        self.get_logger().info("BlocklyマクロBehaviorが初期化されました。")
        self.executed = False

    def loop(self):
        if self.executed:
            return
        self.executed = True
        
        try:
            print("--- Blocklyマクロの実行を開始します ---")
${indentedCode}
            print("--- Blocklyマクロの実行が完了しました ---")
        except Exception as e:
            self.get_logger().error(f"マクロ実行中にエラーが発生しました: {str(e)}")
        finally:
            sys.exit(0)

def main(args=None):
    rclpy.init(args=args)
    behavior = BlocklyBehavior("blockly_behavior_node")
    behavior.run(rate_hz=500.0)

if __name__ == '__main__':
    main()
`;
  }

  // ツールボックスの定義 XML (Logic, Math, Loops, Gamepad, 変数, テキスト, アクチュエータ, センサーの統合)
  const toolboxXml = `
    <xml id="toolbox" style="display: none">
      <category name="イベント" colour="#f59e0b">
        <block type="event_macro"></block>
      </category>
      <category name="基本動作" colour="120">
        <block type="delay_wait">
          <value name="MS"><block type="math_number"><field name="NUM">500</field></block></value>
        </block>
        <block type="print_log">
          <value name="TEXT"><block type="text"><field name="TEXT">マクロを実行中...</field></block></value>
        </block>
      </category>
      <category name="条件分岐 (Logic)" colour="210">
        <block type="controls_if"></block>
        <block type="logic_compare"></block>
        <block type="logic_operation"></block>
        <block type="logic_negate"></block>
        <block type="logic_boolean"></block>
      </category>
      <category name="繰り返し (Loops)" colour="120">
        <block type="controls_repeat_ext">
          <value name="TIMES">
            <shadow type="math_number">
              <field name="NUM">10</field>
            </shadow>
          </value>
        </block>
        <block type="controls_whileUntil"></block>
      </category>
      <category name="計算・数値 (Math)" colour="230">
        <block type="math_number"></block>
        <block type="math_arithmetic"></block>
      </category>
      <category name="テキスト" colour="160">
        <block type="text"></block>
      </category>
      <category name="変数" custom="VARIABLE" colour="330"></category>
      <category name="コントローラー" colour="290">
        <block type="gamepad_button"></block>
        <block type="gamepad_axis"></block>
        <block type="gamepad_axis_scaled">
          <field name="SCALE">1000</field>
        </block>
      </category>
      <category name="MDDモータ" colour="230">
        <block type="mdd_move">
          <value name="M1"><block type="math_number"><field name="NUM">0</field></block></value>
          <value name="M2"><block type="math_number"><field name="NUM">0</field></block></value>
          <value name="M3"><block type="math_number"><field name="NUM">0</field></block></value>
          <value name="M4"><block type="math_number"><field name="NUM">0</field></block></value>
        </block>
        <block type="robot_kinematics">
          <field name="TYPE">4_MECANUM</field>
          <field name="L">300</field>
          <field name="M_LF">m1</field>
          <field name="M_RF">m2</field>
          <field name="M_LR">m3</field>
          <field name="M_RR">m4</field>
          <value name="VX">
            <block type="gamepad_axis_scaled">
              <field name="AXIS">0</field>
              <field name="SCALE">1000</field>
            </block>
          </value>
          <value name="VY">
            <block type="gamepad_axis_scaled">
              <field name="AXIS">1</field>
              <field name="SCALE">1000</field>
            </block>
          </value>
          <value name="OMEGA">
            <block type="gamepad_axis_scaled">
              <field name="AXIS">2</field>
              <field name="SCALE">2.0</field>
            </block>
          </value>
        </block>
      </category>
      <category name="MDDセンサー値" colour="80">
        <block type="mdd_sw_val"></block>
        <block type="mdd_enc_deg_val"></block>
        <block type="mdd_enc_rps_val"></block>
      </category>
      <category name="サーボ" colour="60">
        <block type="servo_move">
          <value name="S1"><block type="math_number"><field name="NUM">90</field></block></value>
          <value name="S2"><block type="math_number"><field name="NUM">90</field></block></value>
          <value name="S3"><block type="math_number"><field name="NUM">90</field></block></value>
          <value name="S4"><block type="math_number"><field name="NUM">90</field></block></value>
          <value name="S5"><block type="math_number"><field name="NUM">90</field></block></value>
          <value name="S6"><block type="math_number"><field name="NUM">90</field></block></value>
        </block>
      </category>
      <category name="電磁弁" colour="0">
        <block type="valve_control"></block>
      </category>
    </xml>
  `;

  const blocklyDiv = document.getElementById('blocklyDiv');
  if (blocklyDiv && typeof Blockly !== 'undefined') {
    const toolboxDom = Blockly.utils.xml.textToDom(toolboxXml);
    blocklyWorkspace = Blockly.inject('blocklyDiv', {
      toolbox: toolboxDom,
      scrollbars: true,
      trashcan: true,
      grid: { spacing: 20, length: 3, colour: '#ccc', snap: true },
      zoom: { controls: true, wheel: true }
    });
  }

  // 既存コード互換のため参照名を維持
  const workspace = blocklyWorkspace;

  // サーバーから保存済みBlocklyワークスペースをロードして復元
  if (workspace && typeof Blockly !== 'undefined') {
    fetch("/api/behavior/get_blockly_workspace")
      .then(res => res.json())
      .then(data => {
        if (data.success && data.xml) {
          try {
            workspace.clear();
            const dom = Blockly.utils.xml.textToDom(data.xml);
            Blockly.Xml.domToWorkspace(dom, workspace);
            console.log("Blocklyワークスペースを正常に復元しました。");
          } catch (restoreErr) {
            console.error("Blocklyワークスペースの復元に失敗しました。デフォルトをロードします:", restoreErr);
            loadDefaultEntryBlock(workspace);
          }
        } else {
          loadDefaultEntryBlock(workspace);
        }
      })
      .catch(err => {
        console.error("Blocklyワークスペースのロードエラー:", err);
        loadDefaultEntryBlock(workspace);
      });
  }

  function loadDefaultEntryBlock(ws) {
    try {
      ws.clear();
      const defaultXml = '<xml xmlns="https://developers.google.com/blockly/xml"><block type="event_macro" id="initial_entry" x="30" y="30"></block></xml>';
      const dom = Blockly.utils.xml.textToDom(defaultXml);
      Blockly.Xml.domToWorkspace(dom, ws);
    } catch (e) {
      console.error("Defaultブロック配置失敗:", e);
    }
  }

  // リアルタイムにコードを生成＆プレビュー
  if (workspace) {
    workspace.addChangeListener(() => {
      try {
        const rawCode = Blockly.Python.workspaceToCode(workspace);
        const fullPython = generatePythonCode(rawCode);
        const codeArea = document.getElementById("blockly-code-area");
        if (codeArea) {
          codeArea.textContent = fullPython;
        }
      } catch (err) {
        const codeArea = document.getElementById("blockly-code-area");
        if (codeArea) {
          codeArea.textContent = "# コード自動生成エラー: " + err.message;
        }
      }
    });
  }

  // 単体「ブロックを保存」ボタンのイベント
  const btnSaveBlocklyXml = document.getElementById("btn-save-blockly-xml");
  if (btnSaveBlocklyXml) {
    btnSaveBlocklyXml.addEventListener("click", async () => {
      if (!workspace) {
        appendTerminalLog(el.behaviorTerminal, "[ERROR] Blocklyワークスペースが初期化されていません。", "error-msg");
        return;
      }

      const rawCode = Blockly.Python.workspaceToCode(workspace);
      const fullPython = generatePythonCode(rawCode);

      let xmlText = "";
      try {
        const dom = Blockly.Xml.workspaceToDom(workspace);
        xmlText = Blockly.Xml.domToText(dom);
      } catch (xmlErr) {
        console.error("XML変換エラー:", xmlErr);
        appendTerminalLog(el.behaviorTerminal, `[ERROR] ブロックXML変換に失敗しました: ${xmlErr.message}`, "error-msg");
        return;
      }

      appendTerminalLog(el.behaviorTerminal, "ブロックとコードをサーバーに保存中...");

      try {
        const saveRes = await fetch("/api/behavior/save_blockly", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: fullPython, xml: xmlText })
        });
        const saveData = await saveRes.json();

        if (saveData.success) {
          appendTerminalLog(el.behaviorTerminal, "[SUCCESS] ブロックの配置状態と自動生成コードを保存しました！", "system-msg");
        } else {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] 保存失敗: ${saveData.message}`, "error-msg");
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 保存API通信エラー: ${err.message}`, "error-msg");
      }
    });
  }

  // マクロ実行ボタンのイベント
  const btnRunBlockly = document.getElementById("btn-run-blockly");
  if (btnRunBlockly) {
    btnRunBlockly.addEventListener("click", async () => {
      if (!workspace) {
        appendTerminalLog(el.behaviorTerminal, "[ERROR] Blocklyワークスペースの初期化に失敗しています。ページを再読み込みしてください。", "error-msg");
        return;
      }
      const rawCode = Blockly.Python.workspaceToCode(workspace);
      const fullPython = generatePythonCode(rawCode);

      let xmlText = "";
      try {
        const dom = Blockly.Xml.workspaceToDom(workspace);
        xmlText = Blockly.Xml.domToText(dom);
      } catch (xmlErr) {
        console.error("XML変換エラー:", xmlErr);
      }

      appendTerminalLog(el.behaviorTerminal, "Blocklyコードを blockly_behavior.py として保存中...");

      try {
        const saveRes = await fetch("/api/behavior/save_blockly", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: fullPython, xml: xmlText })
        });
        const saveData = await saveRes.json();

        if (!saveData.success) {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] コード保存失敗: ${saveData.message}`, "error-msg");
          return;
        }

        appendTerminalLog(el.behaviorTerminal, "Blocklyビジュアルマクロを起動中...");

        const runRes = await fetch("/api/behavior/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ behavior_name: "blockly_behavior.py" })
        });
        const runData = await runRes.json();

        if (runData.success) {
          appendTerminalLog(el.behaviorTerminal, "[SYSTEM] Blocklyマクロが正常に起動しました。", "system-msg");
          // 実行画面（Behaviorビュー）へ自動的に切り替える
          const targetItem = document.querySelector('.menu-item[data-target="view-behavior"]');
          if (targetItem) targetItem.click();
        } else {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] 起動失敗: ${runData.message}`, "error-msg");
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信エラー: ${err}`, "error-msg");
      }
    });
  }

  // マクロ停止ボタンのイベント
  const btnStopBlockly = document.getElementById("btn-stop-blockly");
  if (btnStopBlockly) {
    btnStopBlockly.addEventListener("click", async () => {
      appendTerminalLog(el.behaviorTerminal, "マクロ停止要求を送信...");
      try {
        const res = await fetch("/api/behavior/stop", { method: "POST" });
        const data = await res.json();
        if (data.success) {
          appendTerminalLog(el.behaviorTerminal, "[SYSTEM] マクロを停止しました。", "system-msg");
        } else {
          appendTerminalLog(el.behaviorTerminal, `[ERROR] 停止失敗: ${data.message}`, "error-msg");
        }
      } catch (err) {
        appendTerminalLog(el.behaviorTerminal, `[ERROR] 通信エラー: ${err}`, "error-msg");
      }
    });
  }

  // 保存ボタンのイベント
  const btnExportBlocklyCode = document.getElementById("btn-export-blockly-code");
  if (btnExportBlocklyCode) {
    btnExportBlocklyCode.addEventListener("click", () => {
      if (!workspace) {
        appendTerminalLog(el.behaviorTerminal, "[ERROR] Blocklyワークスペースが未初期化のため保存できません。", "error-msg");
        return;
      }
      const rawCode = Blockly.Python.workspaceToCode(workspace);
      const fullPython = generatePythonCode(rawCode);
      const blob = new Blob([fullPython], { type: "text/x-python" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "blockly_behavior.py";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  // コードプレビュードロワーの開閉制御
  const btnToggleCode = document.getElementById("btn-toggle-code");
  const btnCloseDrawer = document.getElementById("btn-close-drawer");
  const codeDrawer = document.getElementById("blockly-code-drawer");

  if (btnToggleCode && codeDrawer) {
    btnToggleCode.addEventListener("click", () => {
      codeDrawer.classList.toggle("open");
    });
  }

  if (btnCloseDrawer && codeDrawer) {
    btnCloseDrawer.addEventListener("click", () => {
      codeDrawer.classList.remove("open");
    });
  }
});
