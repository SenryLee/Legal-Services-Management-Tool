import { useEffect, useState } from 'react'
import { Plus, Save, Trash2 } from 'lucide-react'
import type { FieldDefinition, FieldType, ModuleKey, WorkspaceSnapshot } from '../../domain'
import { MODULE_ORDER } from '../../domain'
import { saveConfig } from '../../storage'
import { fieldTypes, fieldTypeLabel } from '../../shared/constants'
import { friendlyError } from '../../shared/utils'

export default function FieldSettingsTab({
  config,
  workspacePath,
  onSaved,
  setStatus,
}: {
  config: WorkspaceSnapshot['config']
  workspacePath: string
  onSaved: (config: WorkspaceSnapshot['config']) => void
  setStatus: (status: string) => void
}) {
  const [draft, setDraft] = useState(config)
  const [moduleKey, setModuleKey] = useState<ModuleKey>('litigation')
  const [newField, setNewField] = useState({ key: '', label: '', type: 'text' as FieldType })

  useEffect(() => {
    setDraft(config)
  }, [config])

  const moduleDef = draft.modules[moduleKey]

  const addField = () => {
    if (!newField.key || !newField.label) return
    if (moduleDef.fields.some((field) => field.key === newField.key)) {
      setStatus(`字段 Key 重复：${newField.key}`)
      return
    }
    const nextField: FieldDefinition = {
      key: newField.key,
      label: newField.label,
      type: newField.type,
      required: false,
      builtIn: false,
      ledger: true,
      filterable: true,
    }
    setDraft({
      ...draft,
      modules: {
        ...draft.modules,
        [moduleKey]: { ...moduleDef, fields: [...moduleDef.fields, nextField] },
      },
    })
    setNewField({ key: '', label: '', type: 'text' })
  }

  const toggleField = (fieldKey: string, patch: Partial<FieldDefinition>) => {
    setDraft({
      ...draft,
      modules: {
        ...draft.modules,
        [moduleKey]: {
          ...moduleDef,
          fields: moduleDef.fields.map((field) =>
            field.key === fieldKey ? { ...field, ...patch } : field,
          ),
        },
      },
    })
  }

  const removeField = (fieldKey: string) => {
    setDraft({
      ...draft,
      modules: {
        ...draft.modules,
        [moduleKey]: {
          ...moduleDef,
          fields: moduleDef.fields.filter((field) => field.key !== fieldKey),
        },
      },
    })
  }

  const persist = async () => {
    try {
      const saved = await saveConfig(workspacePath, draft)
      onSaved(saved)
      setStatus('字段配置已保存到 .legalbiz/config.json。')
    } catch (error) {
      setStatus(`保存失败：${friendlyError(error)}`)
    }
  }

  return (
    <div className="settings-grid">
      <section className="panel">
        <div className="section-title">
          <h2>板块字段</h2>
          <span>大板块固定；板块内字段可扩展。内置字段锁定语义。</span>
        </div>
        <div className="module-pills">
          {MODULE_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              className={moduleKey === key ? 'active' : ''}
              onClick={() => setModuleKey(key)}
            >
              {draft.modules[key].label}
            </button>
          ))}
        </div>

        <div className="field-list">
          {moduleDef.fields.map((field) => (
            <article key={field.key}>
              <div>
                <strong>{field.label}</strong>
                <span>
                  {field.key} · {fieldTypeLabel[field.type]} · {field.builtIn ? '内置字段' : '自定义字段'}
                </span>
              </div>
              <label>
                入台账
                <input
                  type="checkbox"
                  checked={field.ledger}
                  onChange={(event) => toggleField(field.key, { ledger: event.target.checked })}
                />
              </label>
              <label>
                可筛选
                <input
                  type="checkbox"
                  checked={field.filterable}
                  onChange={(event) => toggleField(field.key, { filterable: event.target.checked })}
                />
              </label>
              {field.builtIn ? null : (
                <button
                  type="button"
                  className="icon-btn"
                  title="移除字段"
                  onClick={() => removeField(field.key)}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </article>
          ))}
        </div>
      </section>

      <aside className="panel editor-panel">
        <h2>新增字段</h2>
        <label className="field">
          字段 Key
          <input
            value={newField.key}
            onChange={(event) => setNewField({ ...newField, key: event.target.value })}
            placeholder="custom_priority"
          />
        </label>
        <label className="field">
          显示名
          <input
            value={newField.label}
            onChange={(event) => setNewField({ ...newField, label: event.target.value })}
            placeholder="业务优先级"
          />
        </label>
        <label className="field">
          字段类型
          <select
            value={newField.type}
            onChange={(event) => setNewField({ ...newField, type: event.target.value as FieldType })}
          >
            {fieldTypes.map((type) => (
              <option key={type} value={type}>
                {fieldTypeLabel[type]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={addField}>
          <Plus size={16} /> 加入当前板块
        </button>
        <button type="button" className="primary" onClick={persist}>
          <Save size={16} /> 保存字段配置
        </button>
      </aside>
    </div>
  )
}
