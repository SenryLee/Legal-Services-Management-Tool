import { invoke } from '@tauri-apps/api/core'
import type {
  CaseAction,
  LitigationCaseExecutionResult,
  LitigationCasePlan,
  LitigationCaseScan,
} from '../domain'
import { isTauri } from './app-state'
import { readFileAsText } from './file-reader'

export const scanLitigationCase = async (
  workspacePath: string,
  recordPath: string,
): Promise<LitigationCaseScan> => {
  if (isTauri()) {
    return invoke<LitigationCaseScan>('scan_litigation_case', { workspacePath, recordPath })
  }
  return {
    caseRoot: recordPath,
    caseRootRelative: recordPath,
    pendingFiles: [],
    lastScannedAt: new Date().toISOString(),
    hasPending: false,
  }
}

const readLitigationCaseFile = async (
  workspacePath: string,
  recordPath: string,
  filePath: string,
): Promise<File> => {
  const content = await invoke<{ name: string; bytes: number[] }>('read_litigation_case_file', {
    workspacePath,
    recordPath,
    filePath,
  })
  return new File([Uint8Array.from(content.bytes)], content.name)
}

export const proposeLitigationCasePlan = async (
  workspacePath: string,
  recordPath: string,
  files: string[],
  deepAnalysis: boolean,
): Promise<LitigationCasePlan> => {
  if (isTauri()) {
    const deepTexts: Record<string, string> = {}
    if (deepAnalysis) {
      for (const filePath of files) {
        try {
          const file = await readLitigationCaseFile(workspacePath, recordPath, filePath)
          deepTexts[filePath] = await readFileAsText(file)
        } catch {
          deepTexts[filePath] = ''
        }
      }
    }
    return invoke<LitigationCasePlan>('propose_litigation_case_plan', {
      workspacePath,
      recordPath,
      files,
      deepAnalysis,
      deepTexts,
    })
  }
  return {
    caseRoot: recordPath,
    caseRootRelative: recordPath,
    reports: [],
    actions: [],
    notes: ['浏览器演示模式不扫描本地案件文件夹；请在桌面 App 中使用此功能。'],
  }
}

export const executeLitigationCaseActions = async (
  workspacePath: string,
  recordPath: string,
  actions: CaseAction[],
): Promise<LitigationCaseExecutionResult> => {
  if (isTauri()) {
    return invoke<LitigationCaseExecutionResult>('execute_litigation_case_actions', {
      workspacePath,
      recordPath,
      actions,
    })
  }
  return {
    caseRoot: recordPath,
    results: actions.map((action) => ({
      actionId: action.id,
      ok: false,
      message: '浏览器演示模式不会执行本地文件改动。',
    })),
    logPath: '',
    snapshot: [],
  }
}
