import type { ModuleIcon } from '../shared/constants'

export default function Metric({
  title,
  value,
  icon: Icon,
  onClick,
}: {
  title: string
  value: number
  icon: ModuleIcon
  onClick: () => void
}) {
  return (
    <button type="button" className="metric" onClick={onClick}>
      <Icon size={20} />
      <span>{title}</span>
      <strong>{value}</strong>
    </button>
  )
}
