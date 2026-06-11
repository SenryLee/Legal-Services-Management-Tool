# Liquid Glass Drafting Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Liquid Glass redesign and split document drafting into template drafting and free drafting with default-template export.

**Architecture:** Keep the existing Tauri + React app. Move drafting behavior into small pure helpers, keep filesystem work in `src/storage/drafting.ts` and Rust Tauri commands, and move document drafting UI styling out of inline React style objects into shared Liquid Glass CSS classes.

**Tech Stack:** React 19, TypeScript 6, Tauri 2, JSZip, docxtemplater, Node 22 `node --test` with `--experimental-strip-types`.

---

## File Structure

- Modify `package.json`: add a `test` script.
- Modify `src/domain.ts` and `src-tauri/src/lib.rs` / `src-tauri/src/config.rs`: persist `drafting.defaultFreeTemplateId` in workspace config.
- Create `src/storage/drafting-logic.ts`: pure prompt parsing, mode state, free-draft template selection, basic document normalization helpers.
- Create `src/storage/drafting-logic.test.ts`: Node test coverage for prompt parsing and default-template fallback.
- Modify `src/storage/drafting.ts`: add metadata reader, default free document template generation, and structured prompt constants.
- Modify `src/components/DocumentDrafter.tsx`: replace single mixed chat flow with explicit template/free modes and CSS classes.
- Modify `src/components/settings/GeneralSettingsTab.tsx` and `src/components/settings/SettingsPage.tsx`: default free drafting template selector.
- Modify `src/App.css` and `src/index.css`: global strong Liquid Glass visual system and document drafting UI.

## Tasks

### Task 1: Workspace Config and Tests

- [ ] Add failing tests for drafting prompt parsing and default-template fallback.
- [ ] Add `npm test` using `node --experimental-strip-types --test`.
- [ ] Extend TS/Rust workspace config with `drafting.defaultFreeTemplateId`.
- [ ] Verify `npm test` passes after implementation.

### Task 2: Drafting Storage Helpers

- [ ] Add `readTemplateMetadata`.
- [ ] Add prompt constants for template drafting and free drafting.
- [ ] Add default free drafting `.docx` generation using JSZip/docxtemplater path already used by the app.
- [ ] Fix metadata read parameter mismatch.

### Task 3: Settings for Default Free Template

- [ ] Add selector in General settings for saved templates.
- [ ] Save selected default template into workspace config.
- [ ] Clear invalid selection if template is deleted or missing.

### Task 4: Document Drafting UI and Logic

- [ ] Replace mixed chat flow with explicit `template` and `free` modes.
- [ ] Template mode: choose template, collect variables, generate `.docx`.
- [ ] Free mode: generate structured draft, support modifications, export `.docx` with selected default template or built-in fallback.
- [ ] Preserve drafts when switching modes.

### Task 5: Global Liquid Glass Styling

- [ ] Add Liquid Glass design tokens.
- [ ] Restyle app shell, nav, buttons, tables, settings, drawers, and drafting page.
- [ ] Remove drafting inline style constants.
- [ ] Keep table and long text readability.

### Task 6: Verification

- [ ] Run `npm test`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] Run `cargo test`.
- [ ] Start dev server, inspect desktop and constrained widths in browser, and capture screenshot evidence.
