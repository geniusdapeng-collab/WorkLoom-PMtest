"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("workloomDesktopSetup", {
  status: () => ipcRenderer.invoke("pm-desktop:setup-status"),
  create: (input) => ipcRenderer.invoke("pm-desktop:setup-create", input),
});
