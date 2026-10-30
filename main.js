"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");
const { TempleDatabase } = require("./src/database");
const { todayDisplay } = require("./src/dates");
const { malayalamMonth } = require("./src/malayalam-calendar");

app.disableHardwareAcceleration();

let mainWindow;
let database;
let loggedIn = false;
let currentUser = null;
let failedAttempts = 0;
let blockedUntil = 0;
let backupTimer;

const isDev = !app.isPackaged;

function dataRoot() {
  return app.getPath("userData");
}

function databasePath() {
  return path.join(dataRoot(), "data", "melamcode-temple.sqlite");
}

function backupDirectory() {
  return path.join(dataRoot(), "backups");
}

function mediaDirectory() {
  return path.join(dataRoot(), "media");
}

function startupLog(message, error = null) {
  try {
    const directory = path.join(dataRoot(), "logs");
    fs.mkdirSync(directory, { recursive: true });
    const details = error ? `\n${error.stack || error.message || String(error)}` : "";
    fs.appendFileSync(
      path.join(directory, "startup-v1.0.16.log"),
      `[${new Date().toISOString()}] ${message}${details}\n`,
      "utf8"
    );
  } catch {
    // A logging problem must never stop the application.
  }
}

function createUpgradeSafetyCopy() {
  const source = databasePath();
  const marker = path.join(dataRoot(), ".upgrade-safety-v1.0.16");
  if (!fs.existsSync(source) || fs.existsSync(marker)) return null;
  fs.mkdirSync(backupDirectory(), { recursive: true });
  const target = path.join(backupDirectory(), `melamcode-before-v1.0.16-${fileStamp()}.sqlite`);
  fs.copyFileSync(source, target);
  fs.writeFileSync(marker, target, "utf8");
  startupLog(`Upgrade safety copy created: ${target}`);
  return target;
}

function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function purgeOldBackups() {
  const retention = Math.max(5, Math.min(180, Number(database.getSettings().backup_retention) || 30));
  const directory = backupDirectory();
  if (!fs.existsSync(directory)) return;
  const files = fs.readdirSync(directory)
    .filter((name) => /^melamcode-auto-.*\.sqlite$/i.test(name))
    .map((name) => ({ name, time: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const file of files.slice(retention)) fs.unlinkSync(path.join(directory, file.name));
}

function performAutoBackup(reason = "automatic") {
  if (!database) return null;
  fs.mkdirSync(backupDirectory(), { recursive: true });
  let target = path.join(backupDirectory(), `melamcode-auto-${fileStamp()}.sqlite`);
  let suffix = 1;
  while (fs.existsSync(target)) {
    target = path.join(backupDirectory(), `melamcode-auto-${fileStamp()}-${suffix++}.sqlite`);
  }
  database.backup(target);
  database.saveSettings({ last_auto_backup: new Date().toISOString(), last_backup_reason: reason });
  purgeOldBackups();
  return target;
}

function scheduleBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    try {
      performAutoBackup("data-change");
    } catch (error) {
      console.error("Automatic backup failed:", error);
    }
  }, 8000);
}

function maybeDailyBackup() {
  const settings = database.getSettings();
  const last = String(settings.last_auto_backup || "").slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  if (last !== today) performAutoBackup("daily-startup");
}

function assertAuthenticated() {
  if (!loggedIn || !currentUser) throw new Error("Session അവസാനിച്ചു. വീണ്ടും login ചെയ്യുക.");
}

function assertRole(roles = null) {
  assertAuthenticated();
  if (roles && !roles.includes(currentUser.role)) {
    throw new Error("ഈ പ്രവർത്തനത്തിന് നിങ്ങളുടെ user role-ന് permission ഇല്ല.");
  }
}

function publicHandler(channel, handler) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await handler(...args) };
    } catch (error) {
      console.error(channel, error);
      return { ok: false, error: error?.message || "അപ്രതീക്ഷിത പിശക്." };
    }
  });
}

function secureHandler(channel, handler, mutates = false, roles = null) {
  publicHandler(channel, async (...args) => {
    assertRole(roles);
    const result = await handler(...args);
    if (mutates) scheduleBackup();
    return result;
  });
}

function restoreDatabaseFromBackup(sourcePath, deletePin) {
  assertRole(["ADMIN"]);
  database.assertDeleteAuthorized(deletePin);
  const source = path.resolve(String(sourcePath || ""));
  const backupRoot = `${path.resolve(backupDirectory())}${path.sep}`;
  if (!source.startsWith(backupRoot) || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error("തിരഞ്ഞെടുത്ത backup file സാധുവല്ല.");
  }
  const check = new DatabaseSync(source, { readOnly: true });
  try {
    const integrity = check.prepare("PRAGMA integrity_check").get();
    if (String(integrity?.integrity_check || "").toLowerCase() !== "ok") {
      throw new Error("Backup database integrity പരിശോധന വിജയിച്ചില്ല.");
    }
    const tables = new Set(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    for (const required of ["settings", "users", "bookings", "donations", "expenses"]) {
      if (!tables.has(required)) throw new Error("ഇത് Melamcode Temple Manager backup അല്ല.");
    }
  } finally {
    check.close();
  }
  const safety = path.join(backupDirectory(), `melamcode-before-restore-${fileStamp()}.sqlite`);
  database.backup(safety);
  database.close();
  const clearDatabaseSidecars = () => {
    for (const suffix of ["-wal", "-shm"]) {
      try {
        fs.unlinkSync(`${databasePath()}${suffix}`);
      } catch {
        // Sidecar may not exist.
      }
    }
  };
  try {
    clearDatabaseSidecars();
    fs.copyFileSync(source, databasePath());
    database = new TempleDatabase(databasePath());
  } catch (error) {
    clearDatabaseSidecars();
    fs.copyFileSync(safety, databasePath());
    database = new TempleDatabase(databasePath());
    throw error;
  }
  loggedIn = false;
  currentUser = null;
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
  }, 700);
  return { restored: true, source: path.basename(source), safety: path.basename(safety) };
}

function selectedImagePath(kind) {
  const settings = database.getSettings();
  const custom = kind === "deity" ? settings.deity_image_path : settings.temple_image_path;
  if (custom && fs.existsSync(custom)) return custom;
  return path.join(__dirname, "assets", kind === "deity" ? "deities.jpg" : "temple.png");
}

function imageAsDataUrl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  const extension = path.extname(filePath).toLowerCase();
  const mime = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

async function renderPrintWindow(html, mode, suggestedName = "statement.pdf", options = {}) {
  const paperSize = String(options?.paperSize || "").toUpperCase() === "A5" ? "A5" : "A4";
  const printCacheDirectory = path.join(dataRoot(), "print-cache");
  fs.mkdirSync(printCacheDirectory, { recursive: true });
  const printFilePath = path.join(
    printCacheDirectory,
    `print-${Date.now()}-${Math.random().toString(16).slice(2)}.html`
  );
  fs.writeFileSync(printFilePath, String(html), "utf8");
  const printWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 1100,
    parent: mainWindow,
    webPreferences: { sandbox: true, contextIsolation: true }
  });
  try {
    await printWindow.loadFile(printFilePath);
    await printWindow.webContents.executeJavaScript(
      "Promise.all([document.fonts ? document.fonts.ready : Promise.resolve(), ...Array.from(document.images).map(img => img.complete ? Promise.resolve() : new Promise(resolve => { img.onload = img.onerror = resolve; }))]).then(() => true)"
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (mode === "pdf") {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: "PDF ആയി സൂക്ഷിക്കുക",
        defaultPath: suggestedName,
        filters: [{ name: "PDF Document", extensions: ["pdf"] }]
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      let pdf;
      try {
        pdf = await printWindow.webContents.printToPDF({
          printBackground: true,
          pageSize: paperSize,
          preferCSSPageSize: true,
          margins: { marginType: "default" }
        });
      } catch {
        // Fallback for Windows systems that reject explicit page settings.
        pdf = await printWindow.webContents.printToPDF({
          printBackground: true,
          pageSize: paperSize,
          preferCSSPageSize: true
        });
      }
      if (!pdf?.length || !pdf.subarray(0, 4).equals(Buffer.from("%PDF"))) {
        throw new Error("PDF file തയ്യാറാക്കാനായില്ല. Application വീണ്ടും തുറന്ന് ശ്രമിക്കുക.");
      }
      fs.writeFileSync(result.filePath, pdf);
      if (!fs.statSync(result.filePath).size) throw new Error("PDF file save ചെയ്യാനായില്ല.");
      return { canceled: false, path: result.filePath };
    }
    printWindow.show();
    printWindow.focus();
    await new Promise((resolve) => setTimeout(resolve, 350));
    return await new Promise((resolve, reject) => {
      printWindow.webContents.print(
        {
          silent: false,
          printBackground: true,
          color: true,
          pageSize: paperSize,
          margins: { marginType: "default" }
        },
        (success, failureReason) => {
          if (success) {
            resolve({ printed: true, canceled: false });
            return;
          }
          if (/cancel/i.test(String(failureReason || ""))) {
            resolve({ printed: false, canceled: true });
            return;
          }
          reject(new Error(
            `Print ചെയ്യാനായില്ല${failureReason ? `: ${failureReason}` : "."} Printer connection/default printer പരിശോധിക്കുക.`
          ));
        }
      );
    });
  } finally {
    if (!printWindow.isDestroyed()) printWindow.close();
    try {
      fs.unlinkSync(printFilePath);
    } catch {
      // The operating system may still hold the temporary print file briefly.
    }
  }
}

function registerHandlers() {
  publicHandler("auth:status", () => database.authStatus());
  publicHandler("auth:setup", (secret) => {
    database.setupAdmin(secret);
    currentUser = database.authenticate("admin", secret);
    loggedIn = true;
    return currentUser;
  });
  publicHandler("auth:login", (username, secret) => {
    if (secret === undefined) {
      secret = username;
      username = "admin";
    }
    const now = Date.now();
    if (now < blockedUntil) {
      const seconds = Math.ceil((blockedUntil - now) / 1000);
      throw new Error(`അധിക ശ്രമങ്ങൾ. ${seconds} സെക്കന്റ് കഴിഞ്ഞ് വീണ്ടും ശ്രമിക്കുക.`);
    }
    const user = database.authenticate(username, secret);
    if (!user) {
      failedAttempts += 1;
      if (failedAttempts >= 5) {
        blockedUntil = Date.now() + 30_000;
        failedAttempts = 0;
      }
      throw new Error("PIN/password ശരിയല്ല.");
    }
    failedAttempts = 0;
    blockedUntil = 0;
    loggedIn = true;
    currentUser = user;
    database.audit("LOGIN", "session", user.username, user.role);
    return user;
  });
  secureHandler("auth:session", () => currentUser);
  secureHandler("auth:logout", () => {
    database.audit("LOGOUT", "session", currentUser.username, currentUser.role);
    loggedIn = false;
    currentUser = null;
    return true;
  });
  secureHandler(
    "auth:change",
    (currentSecret, newSecret) => database.changeOwnSecret(currentUser.username, currentSecret, newSecret),
    true
  );
  secureHandler("auth:deletePinStatus", () => database.deletePinStatus());
  secureHandler(
    "auth:setDeletePin",
    (currentSecret, newPin) => database.setDeletePin(currentSecret, newPin, currentUser.username),
    true,
    ["ADMIN"]
  );
  secureHandler("users:list", () => database.listUsers(), false, ["ADMIN"]);
  secureHandler("users:save", (data) => database.saveUser(data, currentUser.username), true, ["ADMIN"]);
  secureHandler(
    "users:resetPassword",
    (id, secret) => database.resetUserPassword(id, secret, currentUser.username),
    true,
    ["ADMIN"]
  );

  secureHandler("dashboard:get", () => ({ ...database.dashboard(todayDisplay()), currentUser }));
  secureHandler("calendar:month", (year, month) => ({
    ...malayalamMonth(year, month),
    events: database.listSpecialDays(year, month)
  }));
  secureHandler("calendar:range", (from, to) => {
    const monthCache = new Map();
    return database.listSpecialDaysRange(from, to).map((event) => {
      const [year, month] = event.calendar_date.split("-").map(Number);
      const key = `${year}-${month}`;
      if (!monthCache.has(key)) monthCache.set(key, malayalamMonth(year, month));
      const day = monthCache.get(key).days.find((item) => item.iso_date === event.calendar_date);
      return {
        ...event,
        weekday: new Intl.DateTimeFormat("ml-IN", {
          weekday: "long",
          timeZone: "UTC"
        }).format(new Date(`${event.calendar_date}T12:00:00Z`)),
        malayalam_year: day?.malayalam_year || "",
        malayalam_month: day?.malayalam_month || "",
        malayalam_day: day?.malayalam_day || "",
        malayalam_star: day?.malayalam_star || ""
      };
    });
  });
  secureHandler("calendar:save", (data) => database.saveSpecialDay(data), true, ["ADMIN"]);
  secureHandler("calendar:delete", (id, deletePin) => database.deleteSpecialDay(id, deletePin), true, ["ADMIN"]);

  secureHandler("rituals:list", (includeInactive) => database.listRituals(includeInactive));
  secureHandler("rituals:save", (data) => database.saveRitual(data), true, ["ADMIN"]);
  secureHandler("rituals:delete", (id, deletePin) => database.deleteRitual(id, deletePin), true, ["ADMIN"]);

  secureHandler("devotees:list", (search) => database.listDevotees(search));
  secureHandler("devotees:save", (data) => database.saveDevotee(data), true, ["ADMIN", "CASHIER"]);
  secureHandler("devotees:delete", (id, deletePin) => database.deleteDevotee(id, deletePin), true, ["ADMIN"]);

  secureHandler("bookings:list", (filters) => database.listBookings(filters));
  secureHandler("bookings:get", (id) => database.getBooking(id));
  secureHandler("bookings:save", (data) => database.createBooking(data), true, ["ADMIN", "CASHIER"]);
  secureHandler(
    "bookings:status",
    (id, status, reason, refund, deletePin) =>
      database.changeBookingStatus(id, status, reason, refund, deletePin, currentUser.username),
    true,
    ["ADMIN", "CASHIER"]
  );
  secureHandler("bookings:delete", (id, deletePin) => database.deleteBooking(id, deletePin), true, ["ADMIN", "CASHIER"]);
  secureHandler("receipts:search", (filters) => database.searchReceipts(filters));

  secureHandler("inventory:list", (includeInactive) => database.listInventory(includeInactive));
  secureHandler("inventory:save", (data) => database.saveInventoryItem(data), true, ["ADMIN"]);
  secureHandler("inventory:delete", (id, deletePin) => database.deleteInventoryItem(id, deletePin), true, ["ADMIN"]);
  secureHandler("stock:add", (data) => database.addStockTransaction(data), true, ["ADMIN"]);
  secureHandler("stock:list", (itemId) => database.listStockTransactions(itemId));

  secureHandler("donations:list", (filters) => database.listDonations(filters));
  secureHandler("donations:get", (id) => database.getDonation(id));
  secureHandler("donations:save", (data) => database.saveDonation(data), true, ["ADMIN", "CASHIER"]);
  secureHandler(
    "donations:status",
    (id, status, reason, refund, deletePin) =>
      database.changeDonationStatus(id, status, reason, refund, deletePin, currentUser.username),
    true,
    ["ADMIN", "CASHIER"]
  );
  secureHandler("donations:delete", (id, deletePin) => database.deleteDonation(id, deletePin), true, ["ADMIN", "CASHIER"]);
  secureHandler("expenses:list", (filters) => database.listExpenses(filters));
  secureHandler("expenses:save", (data) => database.saveExpense(data), true, ["ADMIN", "ACCOUNTANT"]);
  secureHandler("expenses:delete", (id, deletePin) => database.deleteExpense(id, deletePin), true, ["ADMIN"]);

  secureHandler("reports:get", (type, filters) => database.report(type, filters));
  secureHandler("counter:get", (date) => database.counterSummary(date));
  secureHandler(
    "counter:save",
    (data) => database.saveCounterClosing(data, currentUser.username),
    true,
    ["ADMIN", "CASHIER", "ACCOUNTANT"]
  );
  secureHandler("counter:list", (filters) => database.listCounterClosings(filters));
  secureHandler("audit:list", (limit) => database.getAuditLogs(limit));

  secureHandler("settings:get", () => database.getSettings());
  secureHandler("settings:save", (values) => database.saveSettings(values), true, ["ADMIN"]);
  secureHandler("images:get", (kind) => imageAsDataUrl(selectedImagePath(kind)));
  secureHandler("images:choose", async (kind) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: kind === "deity" ? "ദേവീചിത്രം തിരഞ്ഞെടുക്കുക" : "ക്ഷേത്രചിത്രം തിരഞ്ഞെടുക്കുക",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp"] }]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    fs.mkdirSync(mediaDirectory(), { recursive: true });
    const source = result.filePaths[0];
    const destination = path.join(mediaDirectory(), `${kind}${path.extname(source).toLowerCase()}`);
    if (path.resolve(source) !== path.resolve(destination)) fs.copyFileSync(source, destination);
    const key = kind === "deity" ? "deity_image_path" : "temple_image_path";
    database.saveSettings({ [key]: destination });
    scheduleBackup();
    return { canceled: false, dataUrl: imageAsDataUrl(destination) };
  }, false, ["ADMIN"]);

  secureHandler("backup:create", async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Database backup സൂക്ഷിക്കുക",
      defaultPath: `melamcode-temple-backup-${fileStamp()}.sqlite`,
      filters: [{ name: "SQLite Database", extensions: ["sqlite"] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    if (fs.existsSync(result.filePath)) fs.unlinkSync(result.filePath);
    database.backup(result.filePath);
    return { canceled: false, path: result.filePath };
  });
  secureHandler("backup:list", () => {
    fs.mkdirSync(backupDirectory(), { recursive: true });
    return fs.readdirSync(backupDirectory())
      .filter((name) => name.endsWith(".sqlite"))
      .map((name) => {
        const stats = fs.statSync(path.join(backupDirectory(), name));
        return { name, path: path.join(backupDirectory(), name), size: stats.size, modified: stats.mtime.toISOString() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
  });
  secureHandler(
    "backup:restore",
    (sourcePath, deletePin) => restoreDatabaseFromBackup(sourcePath, deletePin),
    false,
    ["ADMIN"]
  );
  secureHandler("folder:openData", () => shell.openPath(dataRoot()));
  secureHandler("folder:openBackups", () => shell.openPath(backupDirectory()));

  secureHandler("file:saveCsv", async (content, suggestedName) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "CSV ആയി സൂക്ഷിക്കുക",
      defaultPath: suggestedName || "statement.csv",
      filters: [{ name: "CSV File", extensions: ["csv"] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, `\uFEFF${String(content)}`, "utf8");
    return { canceled: false, path: result.filePath };
  });
  secureHandler("print:html", (html, options) => renderPrintWindow(String(html), "print", "statement.pdf", options));
  secureHandler("pdf:html", (html, suggestedName, options) => renderPrintWindow(String(html), "pdf", suggestedName, options));
  secureHandler("system:whatsapp", async (phoneValue, message) => {
    let digits = String(phoneValue || "").replace(/\D/g, "");
    if (digits.length === 10) digits = `91${digits}`;
    if (digits.length < 10 || digits.length > 15) {
      throw new Error("WhatsApp reminder-ന് ശരിയായ mobile number നൽകുക.");
    }
    const url = `https://wa.me/${digits}?text=${encodeURIComponent(String(message || ""))}`;
    await shell.openExternal(url);
    return { opened: true };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 700,
    backgroundColor: "#f8f3e8",
    title: "മേലാംകോട് ദേവിക്ഷേത്രം — Temple Manager",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  let readyShown = false;
  const showFallback = (error) => {
    startupLog("Renderer startup fallback used", error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  };
  mainWindow.once("ready-to-show", () => {
    readyShown = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html")).catch(showFallback);
  setTimeout(() => {
    if (!readyShown && mainWindow && !mainWindow.isDestroyed()) showFallback(new Error("ready-to-show timeout"));
  }, 8000);
  if (isDev && process.env.TEMPLE_DEVTOOLS === "1") mainWindow.webContents.openDevTools({ mode: "detach" });
}

app.whenReady().then(() => {
  try {
    startupLog("Starting Melamcode Temple Manager v1.0.16");
    fs.mkdirSync(path.dirname(databasePath()), { recursive: true });
    createUpgradeSafetyCopy();
    database = new TempleDatabase(databasePath());
    try {
      maybeDailyBackup();
    } catch (error) {
      startupLog("Startup automatic backup failed; startup will continue", error);
    }
    registerHandlers();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  } catch (error) {
    startupLog("Application startup failed", error);
    dialog.showErrorBox(
      "Melamcode Temple Manager",
      `Application തുറക്കാനായില്ല.\n\n${error?.message || String(error)}\n\nLogs folder: ${path.join(dataRoot(), "logs")}`
    );
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  clearTimeout(backupTimer);
  if (database) {
    try {
      performAutoBackup("app-close");
    } catch (error) {
      console.error("Closing backup failed:", error);
    }
    database.close();
    database = null;
  }
});
