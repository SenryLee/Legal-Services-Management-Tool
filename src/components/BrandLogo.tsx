import legalbotLogo from '../assets/legalbot-logo.png'

export default function BrandLogo() {
  return (
    <div className="brand-mark" aria-label="logo">
      <img src={legalbotLogo} alt="法律人业务管理" />
    </div>
  )
}
