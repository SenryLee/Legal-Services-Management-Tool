// ---------------------------------------------------------------------------
// Barrel re-exports — 所有 consumer 继续从 '../storage' 或 './storage' 导入
// ---------------------------------------------------------------------------

// app-state
export {
  isTauri,
  safeParse,
  loadAppState,
  rememberWorkspace,
  forgetWorkspace,
  getRecentWorkspacesSync,
  getLastWorkspaceSync,
  getDefaultWorkspaceRoot,
  pickWorkspaceDirectory,
} from './app-state'

// workspace
export {
  loadDemo,
  saveDemo,
  createWorkspace,
  openWorkspace,
  seedDemoRecords,
  checkWorkspaceExists,
  saveConfig,
} from './workspace'

// records
export {
  createRecord,
  updateRecord,
  runConflictCheck,
  localConflictCheck,
  generateLedgerSnapshot,
} from './records'

// csv-export
export { exportRowsToCsv } from './csv-export'

// conflict-analysis
export { analyzeClientConflicts } from './conflict-analysis'
export type { ConflictCandidate, AnnotatedConflictHit } from './conflict-analysis'

// extraction
export { parseTextToDraft, draftToFormPatch } from './extraction'

// file-reader
export { readFileAsText, readWordDocumentStats } from './file-reader'
export type { WordDocumentStats } from './file-reader'

// ai
export {
  isAiReady,
  loadAiSettings,
  saveAiSettings,
  getAiDefaultSystemPrompt,
  DEFAULT_AI_SYSTEM_PROMPT,
  aiTestConnection,
  aiChat,
  buildExtractionMessages,
  extractWithAi,
  PROVIDER_LABELS,
} from './ai'

// attachments
export {
  ensureAttachmentsDir,
  listAttachments,
  addAttachments,
  deleteAttachment,
  openInFinder,
  pickFilesToAttach,
} from './attachments'
