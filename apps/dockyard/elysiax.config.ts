import { defineConfig } from "@elysiax/core";

export default defineConfig({
  app: { name: "elysiax", version: "0.1.0", identifier: "dev.elysiax.demo" },
  build: {
    targets: ["linux-x64", "windows-x64"],
  },
  desktop: {
    title: "elysiax",
    width: 1100,
    height: 720,
    port: 3000,
    icon: "assets/icon.png",
  },
  package: {
    linux: { pkgbuild: true },
  },
});
