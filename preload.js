"use strict";

const { contextBridge, ipcRenderer } = require("electron");

async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (!response?.ok) throw new Error(response?.error || "Operation failed");
  return response.data;
}

contextBridge.exposeInMainWorld("templeAPI", {
  auth: {
    status: () => invoke("auth:status"),
    setup: (secret) => invoke("auth:setup", secret),
    login: (username, secret) => invoke("auth:login", username, secret),
    session: () => invoke("auth:session"),
    logout: () => invoke("auth:logout"),
    change: (currentSecret, newSecret) => invoke("auth:change", currentSecret, newSecret)
  },
  dashboard: { get: () => invoke("dashboard:get") },
  calendar: {
    month: (year, month) => invoke("calendar:month", year, month),
    range: (from, to) => invoke("calendar:range", from, to),
    save: (data) => invoke("calendar:save", data),
    delete: (id, deletePin) => invoke("calendar:delete", id, deletePin)
  },
  rituals: {
    list: (includeInactive = true) => invoke("rituals:list", includeInactive),
    save: (data) => invoke("rituals:save", data),
    delete: (id, deletePin) => invoke("rituals:delete", id, deletePin)
  },
  devotees: {
    list: (search = "") => invoke("devotees:list", search),
    save: (data) => invoke("devotees:save", data),
    delete: (id, deletePin) => invoke("devotees:delete", id, deletePin)
  },
  bookings: {
    list: (filters = {}) => invoke("bookings:list", filters),
    get: (id) => invoke("bookings:get", id),
    save: (data) => invoke("bookings:save", data),
    changeStatus: (id, status, reason, refund, deletePin) =>
      invoke("bookings:status", id, status, reason, refund, deletePin),
    delete: (id, deletePin) => invoke("bookings:delete", id, deletePin)
  },
  receipts: { search: (filters = {}) => invoke("receipts:search", filters) },
  inventory: {
    list: (includeInactive = true) => invoke("inventory:list", includeInactive),
    save: (data) => invoke("inventory:save", data),
    delete: (id, deletePin) => invoke("inventory:delete", id, deletePin),
    addStock: (data) => invoke("stock:add", data),
    stockHistory: (itemId = null) => invoke("stock:list", itemId)
  },
  donations: {
    list: (filters = {}) => invoke("donations:list", filters),
    get: (id) => invoke("donations:get", id),
    save: (data) => invoke("donations:save", data),
    changeStatus: (id, status, reason, refund, deletePin) =>
      invoke("donations:status", id, status, reason, refund, deletePin),
    delete: (id, deletePin) => invoke("donations:delete", id, deletePin)
  },
  expenses: {
    list: (filters = {}) => invoke("expenses:list", filters),
    save: (data) => invoke("expenses:save", data),
    delete: (id, deletePin) => invoke("expenses:delete", id, deletePin)
  },
  reports: {
    get: (type, filters = {}) => invoke("reports:get", type, filters),
    saveCsv: (content, name) => invoke("file:saveCsv", content, name),
    print: (html, options = {}) => invoke("print:html", html, options),
    pdf: (html, name, options = {}) => invoke("pdf:html", html, name, options)
  },
  counter: {
    get: (date) => invoke("counter:get", date),
    save: (data) => invoke("counter:save", data),
    list: (filters = {}) => invoke("counter:list", filters)
  },
  users: {
    list: () => invoke("users:list"),
    save: (data) => invoke("users:save", data),
    resetPassword: (id, secret) => invoke("users:resetPassword", id, secret)
  },
  settings: {
    get: () => invoke("settings:get"),
    save: (data) => invoke("settings:save", data),
    image: (kind) => invoke("images:get", kind),
    chooseImage: (kind) => invoke("images:choose", kind),
    changeAccess: (currentSecret, newSecret) => invoke("auth:change", currentSecret, newSecret),
    deletePinStatus: () => invoke("auth:deletePinStatus"),
    setDeletePin: (currentSecret, newPin) => invoke("auth:setDeletePin", currentSecret, newPin),
    audit: (limit = 100) => invoke("audit:list", limit)
  },
  backup: {
    create: () => invoke("backup:create"),
    list: () => invoke("backup:list"),
    restore: (path, deletePin) => invoke("backup:restore", path, deletePin),
    openFolder: () => invoke("folder:openBackups"),
    openDataFolder: () => invoke("folder:openData")
  },
  system: {
    openWhatsApp: (phone, message) => invoke("system:whatsapp", phone, message)
  }
});
