import { useMemo } from 'react'
import { CalendarDays, CheckCircle2, FileInput, Landmark, ListTodo, Plus, ReceiptText, Sparkles, Users } from 'lucide-react'
import type { ModuleKey, RecordSummary } from '../domain'
import { today } from '../shared/constants'
import { formatDateLabel, isClosedStatus, moneyValue, textValue } from '../shared/utils'
import Metric from './Metric'

export default function Dashboard({
  records,
  setActive,
  onSeedDemo,
}: {
  records: RecordSummary[]
  setActive: (key: ModuleKey) => void
  onSeedDemo: () => void
}) {
  const metrics = {
    client: records.filter((item) => item.module === 'client').length,
    litigation: records.filter((item) => item.module === 'litigation').length,
    nonLitigation: records.filter((item) => item.module === 'non_litigation').length,
    invoiceOpen: records.filter(
      (item) => item.module === 'invoice' && item.fields.invoice_status !== '已开票',
    ).length,
  }

  const calendarItems = useMemo(
    () =>
      records
        .filter((item) => item.module === 'calendar_event')
        .map((item) => ({
          id: item.id,
          title: item.title,
          date: textValue(item.fields.date ?? item.date),
          time: textValue(item.fields.time),
          type: textValue(item.fields.event_type || '日程'),
          status: textValue(item.fields.status ?? item.status),
          relatedMatter: textValue(item.fields.related_matter),
        }))
        .filter((item) => item.date && (item.date >= today || !isClosedStatus(item.status)))
        .sort((left, right) => `${left.date} ${left.time}`.localeCompare(`${right.date} ${right.time}`))
        .slice(0, 8),
    [records],
  )

  const taskItems = useMemo(() => {
    const items: Array<{
      id: string
      title: string
      date: string
      source: string
      detail: string
      status: string
    }> = []

    records.forEach((record) => {
      const status = textValue(record.fields.status ?? record.status)
      if (isClosedStatus(status)) return

      if (record.module === 'calendar_event') {
        const eventType = textValue(record.fields.event_type)
        if (eventType === '任务' || eventType === '跟进') {
          items.push({
            id: `${record.id}-calendar-task`,
            title: record.title,
            date: textValue(record.fields.date ?? record.date),
            source: eventType,
            detail: textValue(record.fields.related_matter),
            status,
          })
        }
        return
      }

      if (record.module === 'litigation') {
        const nextTask = textValue(record.fields.next_task)
        const nextTaskDue = textValue(record.fields.next_task_due)
        const keyDeadline = textValue(record.fields.limitation_deadline)
        if (nextTask || nextTaskDue) {
          items.push({
            id: `${record.id}-next-task`,
            title: nextTask || `${record.title} · 下一步`,
            date: nextTaskDue,
            source: '诉讼',
            detail: record.title,
            status,
          })
        }
        if (keyDeadline) {
          items.push({
            id: `${record.id}-deadline`,
            title: `${record.title} · 关键期限`,
            date: keyDeadline,
            source: '期限',
            detail: textValue(record.fields.court || record.fields.case_number),
            status,
          })
        }
        return
      }

      if (record.module === 'non_litigation') {
        const deadline = textValue(record.fields.delivery_deadline)
        if (deadline) {
          items.push({
            id: `${record.id}-delivery`,
            title: `${record.title} · 交付`,
            date: deadline,
            source: '非诉',
            detail: textValue(record.fields.client_name),
            status,
          })
        }
        return
      }

      if (record.module === 'invoice') {
        const invoiceStatus = textValue(record.fields.invoice_status)
        if (invoiceStatus && invoiceStatus !== '已开票' && invoiceStatus !== '无需开票') {
          const receivable = moneyValue(record.fields.receivable_amount)
          const paid = moneyValue(record.fields.paid_amount)
          items.push({
            id: `${record.id}-invoice`,
            title: record.title,
            date: textValue(record.fields.invoice_date),
            source: '开票',
            detail: receivable > 0 ? `应收 ${receivable}，已收 ${paid}` : textValue(record.fields.client_name),
            status: invoiceStatus,
          })
        }
      }
    })

    return items
      .sort((left, right) => (left.date || '9999-12-31').localeCompare(right.date || '9999-12-31'))
      .slice(0, 8)
  }, [records])

  return (
    <div className="dashboard-grid">
      <Metric title="客户档案" value={metrics.client} icon={Users} onClick={() => setActive('client')} />
      <Metric
        title="诉讼案件"
        value={metrics.litigation}
        icon={Landmark}
        onClick={() => setActive('litigation')}
      />
      <Metric
        title="非诉业务"
        value={metrics.nonLitigation}
        icon={FileInput}
        onClick={() => setActive('non_litigation')}
      />
      <Metric
        title="待核开票"
        value={metrics.invoiceOpen}
        icon={ReceiptText}
        onClick={() => setActive('invoice')}
      />

      <section className="wide-panel">
        <div className="section-title">
          <div>
            <h2>日历日程</h2>
            <span>开庭、会议、交付、期限和跟进安排</span>
          </div>
          <button type="button" onClick={() => setActive('calendar_event')}>
            <CalendarDays size={14} /> 进入日历
          </button>
        </div>
        <div className="schedule-list">
          {calendarItems.length === 0 ? (
            <div className="empty-block">
              <p>暂无近期日程。</p>
              <button type="button" onClick={onSeedDemo}>
                <Sparkles size={14} /> 一键载入示例数据
              </button>
            </div>
          ) : (
            calendarItems.map((item) => (
              <article key={item.id} className={item.date < today ? 'overdue' : ''}>
                <time>
                  <strong>{formatDateLabel(item.date)}</strong>
                  <span>{item.date}{item.time ? ` ${item.time}` : ''}</span>
                </time>
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.relatedMatter || item.status || '未关联事项'}</span>
                </div>
                <em>{item.type}</em>
              </article>
            ))
          )}
        </div>
      </section>

      <section className="wide-panel">
        <div className="section-title">
          <div>
            <h2>待办任务</h2>
            <span>从日历任务、诉讼进度、非诉交付和开票状态汇总</span>
          </div>
          <button type="button" onClick={() => setActive('litigation')}>
            <ListTodo size={14} /> 查看来源
          </button>
        </div>
        <div className="task-list">
          {taskItems.length === 0 ? (
            <div className="empty-block">
              <p>暂无待办任务。</p>
              <button type="button" onClick={() => setActive('calendar_event')}>
                <Plus size={14} /> 新增日程任务
              </button>
            </div>
          ) : (
            taskItems.map((item) => (
              <article key={item.id} className={item.date && item.date < today ? 'overdue' : ''}>
                <CheckCircle2 size={16} />
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.detail || item.status || '待处理'}</span>
                </div>
                <time>{item.date ? formatDateLabel(item.date) : '未设期限'}</time>
                <em>{item.source}</em>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  )
}
