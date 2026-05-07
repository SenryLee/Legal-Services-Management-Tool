import type { RecordSummary } from '../domain'

// ---------------------------------------------------------------------------
// CSV export — UTF-8 with BOM so Excel opens it directly. Replaces the heavy
// write-excel-file dependency.
// ---------------------------------------------------------------------------

const csvEscape = (value: unknown): string => {
  const text = value == null ? '' : String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export const exportRowsToCsv = (
  records: RecordSummary[],
  filename: string,
): void => {
  const rows: Array<Record<string, unknown>> = records.map((record) => ({
    id: record.id,
    module: record.module,
    title: record.title,
    status: record.status,
    date: record.date,
    ...record.fields,
  }))

  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','))
  }

  const blob = new Blob(['﻿', lines.join('\r\n')], {
    type: 'text/csv;charset=utf-8;',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
