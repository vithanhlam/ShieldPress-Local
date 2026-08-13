// renderer/js/services.js
window.Services = {
  _busy: {},

  async _run(svc, action) {
    if (this._busy[svc]) return;
    this._busy[svc] = true;

    // Disable + loading toàn bộ row
    const row = document.getElementById("svc-btns-" + svc);
    const btns = row?.querySelectorAll("button");
    btns?.forEach((b) => {
      b.disabled = true;
    });
    const firstBtn = btns?.[0];
    const origHTML = firstBtn?.innerHTML;
    if (firstBtn) firstBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

    const apiMap = {
      nginx: {
        start: "startNginx",
        stop: "stopNginx",
        restart: "restartNginx",
      },
      php: { start: "startPhp", stop: "stopPhp", restart: "restartPhp" },
      mariadb: {
        start: "startMariaDB",
        stop: "stopMariaDB",
        restart: "restartMariaDB",
      },
      redis: {
        start: "startRedis",
        stop: "stopRedis",
        restart: "restartRedis",
      },
    };
    const label = { nginx: "Nginx", php: "PHP", mariadb: "MariaDB", redis: "Redis" }[svc];
    const method = apiMap[svc]?.[action];

    let r;
    try {
      r = await api[method]();
    } catch (e) {
      r = { success: false, message: e.message };
    }

    this._busy[svc] = false;

    if (r?.success !== false) {
      const type = action === "stop" ? "info" : "success";
      toast(`${label} ${action}ed`, type, 2000);
    } else {
      toast(`${label} ${action} failed: ${r?.message || ""}`, "error");
      // Restore nếu lỗi
      if (firstBtn) firstBtn.innerHTML = origHTML;
      btns?.forEach((b) => (b.disabled = false));
    }
    // refreshServiceStatus tự poll mỗi 5s sẽ render lại buttons
  },

  // Giữ các method cũ để tray menu gọi được
  startNginx() {
    return this._run("nginx", "start");
  },
  stopNginx() {
    return this._run("nginx", "stop");
  },
  restartNginx() {
    return this._run("nginx", "restart");
  },
  startPhp() {
    return this._run("php", "start");
  },
  stopPhp() {
    return this._run("php", "stop");
  },
  restartPhp() {
    return this._run("php", "restart");
  },
  startMariaDB() {
    return this._run("mariadb", "start");
  },
  stopMariaDB() {
    return this._run("mariadb", "stop");
  },
  restartMariaDB() {
    return this._run("mariadb", "restart");
  },
};
