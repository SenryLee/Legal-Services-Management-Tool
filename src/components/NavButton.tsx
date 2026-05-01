import type { ModuleIcon } from '../shared/constants'

export default function NavButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean
  icon: ModuleIcon
  label: string
  onClick: () => void
}) {
  return (
    <button type="button" className={active ? 'nav-item active' : 'nav-item'} onClick={onClick}>
      <Icon size={18} />
      <span>{label}</span>
    </button>
  )
}
