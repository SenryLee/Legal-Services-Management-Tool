import {
  CalendarDays,
  ClipboardList,
  FileInput,
  Landmark,
  LayoutDashboard,
  ReceiptText,
  Settings2,
  ShieldCheck,
  Users,
} from 'lucide-react'
import type { FieldType, ModuleKey, RecordSummary } from '../domain'

export type ModuleIcon = typeof LayoutDashboard

export const moduleIcons: Record<ModuleKey | 'dashboard' | 'settings', ModuleIcon> = {
  dashboard: LayoutDashboard,
  settings: Settings2,
  client: Users,
  conflict_check: ShieldCheck,
  service_contract: ClipboardList,
  litigation: Landmark,
  non_litigation: FileInput,
  invoice: ReceiptText,
  calendar_event: CalendarDays,
}

export const fieldTypes: FieldType[] = [
  'text',
  'long_text',
  'date',
  'money',
  'number',
  'single_select',
  'multi_select',
  'boolean',
  'party_ref',
  'file_ref',
  'matter_ref',
]

export const fieldTypeLabel: Record<FieldType, string> = {
  text: '文本',
  long_text: '长文本',
  date: '日期',
  money: '金额',
  number: '数字',
  single_select: '单选',
  multi_select: '多选',
  boolean: '布尔',
  party_ref: '主体引用',
  file_ref: '文件引用',
  matter_ref: '事项引用',
}

export const today = new Date().toISOString().slice(0, 10)
export const currentMonth = today.slice(0, 7)
export const emptyRecords: RecordSummary[] = []
export const closedTaskStatuses = new Set(['已完成', '已取消', '归档', '已结案', '已交付', '已复盘'])
