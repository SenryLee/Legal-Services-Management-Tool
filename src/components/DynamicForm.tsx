import type { FieldDefinition } from '../domain'

export default function DynamicForm({
  fields,
  value,
  onChange,
}: {
  fields: FieldDefinition[]
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}) {
  const setValue = (key: string, next: unknown) => {
    onChange({ ...value, [key]: next })
  }

  return (
    <div className="dynamic-form">
      {fields.map((field) => (
        <label key={field.key} className={field.type === 'long_text' ? 'field full' : 'field'}>
          <span>
            {field.label}
            {field.required ? <b>*</b> : null}
          </span>
          {field.type === 'long_text' ? (
            <textarea
              value={String(value[field.key] ?? '')}
              onChange={(event) => setValue(field.key, event.target.value)}
            />
          ) : field.type === 'single_select' && field.options?.length ? (
            <select
              value={String(value[field.key] ?? '')}
              onChange={(event) => setValue(field.key, event.target.value)}
            >
              <option value="">（未选择）</option>
              {field.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : field.type === 'boolean' ? (
            <input
              type="checkbox"
              checked={Boolean(value[field.key])}
              onChange={(event) => setValue(field.key, event.target.checked)}
            />
          ) : (
            <input
              type={
                field.type === 'date'
                  ? 'date'
                  : field.type === 'money' || field.type === 'number'
                    ? 'number'
                    : 'text'
              }
              value={String(value[field.key] ?? '')}
              onChange={(event) => setValue(field.key, event.target.value)}
            />
          )}
        </label>
      ))}
    </div>
  )
}
