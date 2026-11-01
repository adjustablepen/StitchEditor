# Stitch Editor
Making Roblox Clothing Easier


A desktop editor for Roblox classic **shirt and pants templates** (585 × 559) with a live 3D character preview.

## Run it

1. Install **Node.js LTS** from nodejs.org (one-time).
2. Open a terminal in this folder and run:
   ```
   npm install
   npm start
   ```
   `npm install` downloads Electron the first time (~100 MB); after that, just run `npm start`.

To build a standalone Windows app instead: `npm run build:win` (the output goes in `dist/`).

## Features

- **Home page** with all your projects (autosaved, with previews). Create new, open a file or drop one in, duplicate or delete projects. The house button (top left) goes back to Home.
- **Two project types.** *Template*: Roblox shirt + pants at 585 × 559 with the 3D preview. *Normal*: a plain canvas of any size (1920 × 1080 by default). `.stitch` files remember which type they are.
- **Shirt and Pants tabs.** Each has its own layers and undo history, and the preview shows both together. Tab switches between them.
- **Live 3D preview** with R6/R15 rigs, skin colour, a spin toggle and "Save image" (handy for catalog thumbnails).
- **Tools:** brush (B), pencil for hard pixels (P), eraser (E), fill (G, Shift+click fills a whole region), gradient (D), eyedropper (I, or Alt+click), rectangle (U), ellipse (O), line (L), text (T) and move (V, arrow keys nudge).
- **"Paint only in"** locks all painting to one region (for example Torso - Front or Left Arm - Back). Guides and "Dim unused" show the template layout.
- **Layers:** opacity, blend modes, rename (double-click), duplicate, merge down, reorder and hide.
- **Layer tools:** adjust colours (hue, saturation, brightness, contrast, invert), "Fit to region" to scale a logo onto a face, and "Mirror R → L / L → R" to copy one arm or leg onto the other.
- **Import** any image or an existing template PNG (button or drag and drop). A 585×559 image goes in at its exact position.
- **Export PNG** saves an upload-ready template. **Save/Open** uses `.stitch` project files, which keep layers.
- **Autosave:** your last session is restored when you open the app.

## Shortcuts
Ctrl+Z / Ctrl+Y undo/redo · Ctrl+S save · Ctrl+O open · Ctrl+E export · Ctrl+I import · Ctrl+J duplicate layer ·
Ctrl+Shift+N new layer · Ctrl+M merge down · [ ] brush size · X swap colours · Space+drag or middle-drag to pan ·
Ctrl/Alt+scroll to zoom · 0 fit · 1 actual size · F12 dev tools
