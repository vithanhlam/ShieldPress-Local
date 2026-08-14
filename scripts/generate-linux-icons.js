#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { app, nativeImage } = require("electron");

const root = path.join(__dirname, "..");
const output = path.join(root, "assets", "icons");

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(path.join(root, "assets", "icon.png"));
  if (source.isEmpty()) throw new Error("Could not load assets/icon.png");
  fs.mkdirSync(output, { recursive: true });
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    const png = source.resize({ width: size, height: size, quality: "best" }).toPNG();
    fs.writeFileSync(path.join(output, `${size}x${size}.png`), png);
  }
  console.log("Generated Linux icon sizes in assets/icons");
  app.quit();
});
