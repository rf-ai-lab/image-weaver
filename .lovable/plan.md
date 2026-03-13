

# Image Editor MVP - Plan

## Overview

Two-page app for AI-powered image editing: a setup page to define source images and instructions, and an editing page for iterative refinements.

## Architecture

```text
Page 1 (Setup)                         Page 2 (Editor)
┌─────────────────────────┐            ┌─────────────────────────┐
│ [Header: GERAR 1ª VERSÃO]│            │ [Header: nav links]     │
├─────────────────────────┤            ├─────────────────────────┤
│ Row: [★] [img] [text]   │            │   [Generated Image]     │
│ Row: [○] [img] [text]   │            │                         │
│ Row: [○] [img] [text]   │            │ [Text input + Send]     │
│ [+ Add Row]             │            ├─────────────────────────┤
└─────────────────────────┘            │ Version History sidebar │
                                       │ v1 v2 v3...            │
                                       └─────────────────────────┘
```

## Pages and Components

### Shared
- **Header** — nav links for "Configuração" and "Editor", plus "Gerar Primeira Versão" button (page 1 only)

### Page 1 — Setup (`/`)
- **ImageRow** — each row has: radio button (main image selector), image upload input, textarea for extraction instructions
- Add/remove rows; only one row can be marked as "Foto Principal"
- State stored in React context/state shared between pages

### Page 2 — Editor (`/editor`)
- Displays the latest generated image centered
- Text input below for refinement requests
- **Version History** panel (right sidebar or bottom strip) showing thumbnails labeled "Versão 1", "Versão 2", etc.
- Clicking a version loads that image as current; further edits branch from it
- "Volte para a versão anterior" detected in text input or via dedicated undo button

## State Management

- React Context (`ImageEditorContext`) holding:
  - `rows[]` — setup rows with image data (base64), instructions, isPrimary flag
  - `versions[]` — array of generated image base64 strings
  - `currentVersionIndex` — which version is displayed
- All state in-memory (no backend persistence for MVP)

## AI Integration (Lovable Cloud + Edge Function)

- **Edge function `edit-image`** — calls Lovable AI Gateway with `google/gemini-2.5-flash-image` model
  - For initial generation: sends primary image + all row instructions as a combined prompt with reference images
  - For refinements: sends the **current version image** + the new text instruction (preserving edits)
  - Returns base64 image
- `modalities: ["image", "text"]` for image output

## File Plan

| File | Purpose |
|------|---------|
| `src/contexts/ImageEditorContext.tsx` | Shared state (rows, versions, current index) |
| `src/components/Header.tsx` | Navigation + generate button |
| `src/components/ImageRow.tsx` | Single row with radio, upload, textarea |
| `src/components/VersionHistory.tsx` | Clickable version thumbnails |
| `src/pages/Setup.tsx` | Page 1 |
| `src/pages/Editor.tsx` | Page 2 |
| `src/App.tsx` | Routes updated |
| `supabase/functions/edit-image/index.ts` | Edge function for AI image editing |
| `supabase/config.toml` | Function config |

## Key Behaviors

1. **Generate first version**: Combines primary image with all other rows' images+instructions into one prompt, sends to AI, stores result as version 1, navigates to editor
2. **Refinement**: Sends current version image + new instruction to AI, appends result as new version
3. **Version navigation**: Clicking a version sets it as current; next edit builds on that version
4. **Undo**: Moves `currentVersionIndex` back by one

