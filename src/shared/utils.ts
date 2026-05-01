import { closedTaskStatuses, today } from './constants'

export const friendlyError = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export const formatBytes = (size: number): string => {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export const textValue = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

export const moneyValue = (value: unknown): number => {
  const next = Number(value)
  return Number.isFinite(next) ? next : 0
}

export const isClosedStatus = (status: unknown): boolean => closedTaskStatuses.has(textValue(status))

export const formatDateLabel = (date: string): string => {
  if (!date) return '未设日期'
  if (date === today) return '今天'

  const current = new Date(`${today}T00:00:00`)
  const target = new Date(`${date.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(target.getTime())) return date

  const diff = Math.round((target.getTime() - current.getTime()) / 86_400_000)
  if (diff === 1) return '明天'
  if (diff === -1) return '昨天'
  if (diff < 0) return `逾期 ${Math.abs(diff)} 天`
  if (diff <= 7) return `${diff} 天后`
  return date
}
