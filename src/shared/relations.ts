import type { FieldDefinition, ModuleKey, RecordSummary } from '../domain'

export interface RelationOption {
  module: ModuleKey
  id: string
  value: string
  title: string
  subtitle: string
  record: RecordSummary
}

export interface RelationIndex {
  clients: RelationOption[]
  contracts: RelationOption[]
  matters: RelationOption[]
  byClientName: Map<string, RelationOption>
  byContractTitle: Map<string, RelationOption>
  byMatterTitle: Map<string, RelationOption>
}

export interface RelationTarget {
  module: ModuleKey
  query: string
  label: string
  subtitle: string
}

const clean = (value: unknown): string => String(value ?? '').trim()

const keyOf = (value: unknown): string => clean(value).toLowerCase()

const moneyText = (value: unknown): string => {
  const raw = clean(value)
  if (!raw) return ''
  const numeric = Number(raw)
  if (!Number.isFinite(numeric)) return raw
  return numeric.toLocaleString('zh-CN')
}

const pushUnique = (map: Map<string, RelationOption>, option: RelationOption) => {
  const key = keyOf(option.value)
  if (!key || map.has(key)) return
  map.set(key, option)
}

const clientOption = (record: RecordSummary): RelationOption | null => {
  const name = clean(record.fields.name ?? record.title)
  if (!name) return null
  return {
    module: 'client',
    id: record.id,
    value: name,
    title: name,
    subtitle: [record.fields.client_type, record.fields.status, record.fields.owner]
      .map(clean)
      .filter(Boolean)
      .join(' · '),
    record,
  }
}

const contractOption = (record: RecordSummary): RelationOption | null => {
  const title = clean(record.fields.title ?? record.title)
  if (!title) return null
  const amount = moneyText(record.fields.amount)
  return {
    module: 'service_contract',
    id: record.id,
    value: title,
    title,
    subtitle: [record.fields.client_name, amount ? `合同金额 ${amount}` : '', record.fields.status]
      .map(clean)
      .filter(Boolean)
      .join(' · '),
    record,
  }
}

const matterOption = (record: RecordSummary): RelationOption | null => {
  const title = clean(record.fields.title ?? record.title)
  if (!title) return null
  return {
    module: record.module,
    id: record.id,
    value: title,
    title,
    subtitle: [record.fields.client_name, record.fields.status, record.date]
      .map(clean)
      .filter(Boolean)
      .join(' · '),
    record,
  }
}

export const buildRelationIndex = (records: RecordSummary[]): RelationIndex => {
  const byClientName = new Map<string, RelationOption>()
  const byContractTitle = new Map<string, RelationOption>()
  const byMatterTitle = new Map<string, RelationOption>()

  for (const record of records) {
    if (record.module === 'client') {
      const option = clientOption(record)
      if (option) pushUnique(byClientName, option)
      continue
    }

    if (record.module === 'service_contract') {
      const option = contractOption(record)
      if (option) pushUnique(byContractTitle, option)
      continue
    }

    if (record.module === 'litigation' || record.module === 'non_litigation') {
      const option = matterOption(record)
      if (option) pushUnique(byMatterTitle, option)
    }
  }

  return {
    clients: Array.from(byClientName.values()),
    contracts: Array.from(byContractTitle.values()),
    matters: Array.from(byMatterTitle.values()),
    byClientName,
    byContractTitle,
    byMatterTitle,
  }
}

export const relationOptionsForField = (
  moduleKey: ModuleKey,
  field: FieldDefinition,
  index: RelationIndex,
): RelationOption[] => {
  if (field.type === 'party_ref') return index.clients
  if (field.type !== 'matter_ref') return []
  if (moduleKey === 'invoice' || field.key === 'contract_title') return index.contracts
  return [...index.matters, ...index.contracts]
}

export const relationTargetForField = (
  moduleKey: ModuleKey,
  field: FieldDefinition,
  value: unknown,
  index: RelationIndex,
): RelationTarget | null => {
  const key = keyOf(value)
  if (!key) return null

  if (field.type === 'party_ref' || field.key === 'name' || field.key === 'client_name') {
    const client = index.byClientName.get(key)
    if (!client) return null
    return {
      module: 'client',
      query: client.value,
      label: client.title,
      subtitle: client.subtitle,
    }
  }

  if (field.type === 'matter_ref' || field.key === 'contract_title' || field.key === 'related_matter') {
    const contract = index.byContractTitle.get(key)
    if (contract) {
      return {
        module: 'service_contract',
        query: contract.value,
        label: contract.title,
        subtitle: contract.subtitle,
      }
    }

    if (moduleKey !== 'invoice') {
      const matter = index.byMatterTitle.get(key)
      if (matter) {
        return {
          module: matter.module,
          query: matter.value,
          label: matter.title,
          subtitle: matter.subtitle,
        }
      }
    }
  }

  return null
}

const fillIfEmpty = (
  patch: Record<string, unknown>,
  current: Record<string, unknown>,
  key: string,
  value: unknown,
) => {
  if (value == null || clean(value) === '') return
  if (clean(current[key]) !== '') return
  patch[key] = value
}

export const relationPatchForField = (
  moduleKey: ModuleKey,
  fieldKey: string,
  value: unknown,
  current: Record<string, unknown>,
  index: RelationIndex,
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {}
  const key = keyOf(value)
  if (!key) return patch

  if (fieldKey === 'contract_title' && moduleKey === 'invoice') {
    const contract = index.byContractTitle.get(key)
    if (!contract) return patch
    fillIfEmpty(patch, current, 'client_name', contract.record.fields.client_name)
    fillIfEmpty(patch, current, 'receivable_amount', contract.record.fields.amount)
    fillIfEmpty(patch, current, 'paid_amount', contract.record.fields.paid_amount)
    fillIfEmpty(patch, current, 'title', contract.title)
  }

  return patch
}
