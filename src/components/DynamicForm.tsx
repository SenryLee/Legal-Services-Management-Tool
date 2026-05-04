import type { FieldDefinition, ModuleKey } from '../domain'
import {
  relationOptionsForField,
  relationTargetForField,
  type RelationIndex,
  type RelationTarget,
} from '../shared/relations'

const arrayValue = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string' && value) return [value]
  return []
}

const textPlaceholderFor = (field: FieldDefinition) => {
  if (field.type === 'single_select') return '未配置选项，暂按文本记录'
  if (field.type === 'party_ref') return '输入客户、当事人或相对方名称'
  if (field.type === 'matter_ref') return '输入关联事项名称或编号'
  if (field.type === 'file_ref') return '输入本地文件名或路径'
  return undefined
}

export default function DynamicForm({
  fields,
  value,
  onChange,
  moduleKey,
  relationIndex,
  onFieldCommit,
  onOpenReference,
}: {
  fields: FieldDefinition[]
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  moduleKey?: ModuleKey
  relationIndex?: RelationIndex
  onFieldCommit?: (fieldKey: string, value: unknown) => void
  onOpenReference?: (target: RelationTarget) => void
}) {
  const setValue = (key: string, next: unknown) => {
    onChange({ ...value, [key]: next })
  }

  const commitValue = (key: string) => {
    onFieldCommit?.(key, value[key])
  }

  return (
    <div className="dynamic-form">
      {fields.map((field) => {
        const relationOptions =
          moduleKey && relationIndex ? relationOptionsForField(moduleKey, field, relationIndex) : []
        const datalistId =
          relationOptions.length > 0 ? `relation-${moduleKey ?? 'module'}-${field.key}` : undefined
        const relationTarget =
          moduleKey && relationIndex
            ? relationTargetForField(moduleKey, field, value[field.key], relationIndex)
            : null

        return (
          <label
            key={field.key}
            className={field.type === 'long_text' || field.type === 'multi_select' ? 'field full' : 'field'}
          >
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
            ) : field.type === 'multi_select' && field.options?.length ? (
              <select
                multiple
                size={Math.min(Math.max(field.options.length, 2), 6)}
                value={arrayValue(value[field.key])}
                onChange={(event) =>
                  setValue(
                    field.key,
                    Array.from(event.target.selectedOptions, (option) => option.value),
                  )
                }
              >
                {field.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : field.type === 'multi_select' ? (
              <textarea
                value={arrayValue(value[field.key]).join('\n')}
                onChange={(event) =>
                  setValue(
                    field.key,
                    event.target.value
                      .split('\n')
                      .map((item) => item.trim())
                      .filter(Boolean),
                  )
                }
                placeholder="未配置选项，每行记录一个值"
              />
            ) : field.type === 'boolean' ? (
              <input
                type="checkbox"
                checked={Boolean(value[field.key])}
                onChange={(event) => setValue(field.key, event.target.checked)}
              />
            ) : (
              <>
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
                  onBlur={() => commitValue(field.key)}
                  placeholder={textPlaceholderFor(field)}
                  list={datalistId}
                />
                {datalistId ? (
                  <datalist id={datalistId}>
                    {relationOptions.map((option) => (
                      <option key={`${option.module}-${option.id}`} value={option.value}>
                        {option.subtitle}
                      </option>
                    ))}
                  </datalist>
                ) : null}
                {relationTarget ? (
                  <button
                    type="button"
                    className="reference-chip"
                    onClick={() => onOpenReference?.(relationTarget)}
                  >
                    查看已关联：{relationTarget.label}
                  </button>
                ) : null}
              </>
            )}
          </label>
        )
      })}
    </div>
  )
}
