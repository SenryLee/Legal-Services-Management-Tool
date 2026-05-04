import { useEffect, useMemo, useState } from 'react'
import type { RecordSummary } from '../domain'

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

const parseMonth = (month: string) => {
  const [yearText, monthText] = month.split('-')
  const year = Number(yearText)
  const monthIndex = Number(monthText) - 1

  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return null
  }

  return { year, monthIndex }
}

const formatDay = (year: number, monthIndex: number, day: number) =>
  `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

const recordDate = (record: RecordSummary) => {
  const value = record.date ?? record.fields.date
  return typeof value === 'string' && value.length >= 10 ? value.slice(0, 10) : ''
}

const eventMeta = (record: RecordSummary) =>
  [record.fields.time, record.fields.event_type, record.status ?? record.fields.status]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join(' · ')

export default function CalendarMonthView({
  records,
  month,
  setMonth,
  className = '',
}: {
  records: RecordSummary[]
  month: string
  setMonth: (month: string) => void
  className?: string
}) {
  const parsedMonth = useMemo(() => parseMonth(month), [month])
  const initialSelectedDate = parsedMonth ? formatDay(parsedMonth.year, parsedMonth.monthIndex, 1) : ''
  const [selectedDate, setSelectedDate] = useState(initialSelectedDate)

  useEffect(() => {
    if (!parsedMonth) return

    setSelectedDate((current) =>
      current.startsWith(month) ? current : formatDay(parsedMonth.year, parsedMonth.monthIndex, 1),
    )
  }, [month, parsedMonth])

  const recordsByDate = useMemo(() => {
    const next: Record<string, RecordSummary[]> = {}

    for (const record of records) {
      if (record.module !== 'calendar_event') continue
      const date = recordDate(record)
      if (!date.startsWith(month)) continue

      next[date] = [...(next[date] ?? []), record]
    }

    for (const date of Object.keys(next)) {
      next[date].sort((a, b) => String(a.fields.time ?? '').localeCompare(String(b.fields.time ?? '')))
    }

    return next
  }, [month, records])

  const calendarDays = useMemo(() => {
    if (!parsedMonth) return []

    const { year, monthIndex } = parsedMonth
    const firstDay = new Date(year, monthIndex, 1)
    const startOffset = (firstDay.getDay() + 6) % 7
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate()
    const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7

    return Array.from({ length: totalCells }, (_, index) => {
      const day = index - startOffset + 1
      if (day < 1 || day > daysInMonth) return null

      return {
        day,
        date: formatDay(year, monthIndex, day),
      }
    })
  }, [parsedMonth])

  const selectedRecords = recordsByDate[selectedDate] ?? []

  const changeMonth = (offset: number) => {
    if (!parsedMonth) return

    const next = new Date(parsedMonth.year, parsedMonth.monthIndex + offset, 1)
    setMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`)
  }

  if (!parsedMonth) return null

  return (
    <div className={`calendar-month-view${className ? ` ${className}` : ''}`}>
      <div className="calendar-grid-panel" aria-label={`${month} 月视图日历`}>
        <div className="calendar-head">
          <div>
            <strong>{month} 月视图</strong>
            <span>按周一至周日排列，红色日期表示有日程。</span>
          </div>
          <div className="calendar-nav">
            <button type="button" onClick={() => changeMonth(-1)}>
              上月
            </button>
            <button type="button" onClick={() => changeMonth(1)}>
              下月
            </button>
          </div>
        </div>

        <div className="calendar-weekdays">
          {WEEKDAYS.map((weekday) => (
            <span key={weekday}>{weekday}</span>
          ))}
        </div>

        <div className="calendar-days">
          {calendarDays.map((item, index) => {
            if (!item) {
              return <div key={`empty-${index}`} className="calendar-day empty" aria-hidden="true" />
            }

            const dayRecords = recordsByDate[item.date] ?? []
            const hasEvents = dayRecords.length > 0
            const isSelected = selectedDate === item.date

            return (
              <button
                key={item.date}
                type="button"
                className={`calendar-day${hasEvents ? ' has-events' : ''}${isSelected ? ' selected' : ''}`}
                onClick={() => setSelectedDate(item.date)}
                aria-pressed={isSelected}
              >
                <span className="day-number">{item.day}</span>
                {hasEvents ? (
                  <span className="day-events">
                    {dayRecords.slice(0, 2).map((record) => (
                      <span key={record.id}>{record.title}</span>
                    ))}
                    {dayRecords.length > 2 ? <small>另 {dayRecords.length - 2} 项</small> : null}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </div>

      <aside className="calendar-agenda-panel">
        <strong>{selectedDate || month}</strong>
        <span className="agenda-count">{selectedRecords.length} 项日程</span>
        {selectedRecords.length === 0 ? (
          <p>该日期暂无符合当前筛选条件的日程。</p>
        ) : (
          <div className="calendar-agenda-list">
            {selectedRecords.map((record) => (
              <article key={record.id}>
                <strong>{record.title}</strong>
                {eventMeta(record) ? <span>{eventMeta(record)}</span> : null}
                {record.fields.related_matter ? <small>{String(record.fields.related_matter)}</small> : null}
              </article>
            ))}
          </div>
        )}
      </aside>
    </div>
  )
}
