import { useState, useEffect } from 'react'
import { Smartphone, X, Share, Plus, Download, ChevronRight, Check } from 'lucide-react'

const STORAGE_KEY_DISMISSED = 'mlc_pwa_banner_dismissed'

// Detect device platform
function detectPlatform() {
  const ua = navigator.userAgent || ''
  const isIPhone = /iPhone|iPad|iPod/.test(ua) && !window.MSStream
  const isAndroid = /Android/.test(ua)
  const isMobile = isIPhone || isAndroid
  return { isIPhone, isAndroid, isMobile, isDesktop: !isMobile }
}

// Detect if already installed (running in standalone mode)
function isInstalled() {
  return window.matchMedia?.('(display-mode: standalone)').matches ||
         window.navigator.standalone === true
}

export default function InstallBanner() {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY_DISMISSED) === '1' } catch { return false }
  })
  const [showModal, setShowModal] = useState(false)
  const [platform, setPlatform] = useState({ isIPhone: false, isAndroid: false, isMobile: false, isDesktop: true })
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    setPlatform(detectPlatform())
    setInstalled(isInstalled())
  }, [])

  // Don't show if already installed, or dismissed, or on desktop (banner is mobile-targeted)
  if (installed || dismissed || !platform.isMobile) return null

  const dismiss = () => {
    try { localStorage.setItem(STORAGE_KEY_DISMISSED, '1') } catch {}
    setDismissed(true)
  }

  return (
    <>
      <div className="install-banner">
        <div className="install-banner-content">
          <Smartphone size={18} className="install-banner-icon" />
          <div className="install-banner-text">
            <strong>Install MI Little Care</strong>
            <span>One-tap access from your home screen</span>
          </div>
          <button className="install-banner-cta" onClick={() => setShowModal(true)}>
            Show me how
            <ChevronRight size={14} />
          </button>
          <button className="install-banner-close" onClick={dismiss} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      </div>

      {showModal && (
        <InstallModal platform={platform} onClose={() => setShowModal(false)} />
      )}
    </>
  )
}

// Standalone link — for sidebar footer or anywhere we want a manual entry point
export function InstallLink({ children }) {
  const [showModal, setShowModal] = useState(false)
  const [platform, setPlatform] = useState({ isIPhone: false, isAndroid: false, isMobile: false, isDesktop: true })
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    setPlatform(detectPlatform())
    setInstalled(isInstalled())
  }, [])

  if (installed) return null

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          background: 'transparent',
          border: 'none',
          color: 'var(--clr-ink-soft)',
          fontSize: '0.78125rem',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          width: '100%',
          borderRadius: 'var(--radius-sm)',
        }}
        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
      >
        <Smartphone size={13} />
        {children || 'Install on phone'}
      </button>

      {showModal && (
        <InstallModal platform={platform} onClose={() => setShowModal(false)} />
      )}
    </>
  )
}

function InstallModal({ platform, onClose }) {
  // Pick which platform tab to show first
  const [activeTab, setActiveTab] = useState(
    platform.isIPhone ? 'ios' :
    platform.isAndroid ? 'android' :
    'ios'  // default for desktop
  )

  return (
    <div className="install-modal-overlay" onClick={onClose}>
      <div className="install-modal" onClick={e => e.stopPropagation()}>
        <button className="install-modal-close" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>

        <div className="install-modal-hero">
          <div className="install-modal-hero-icon">
            <Smartphone size={28} />
          </div>
          <h2>Install on your phone</h2>
          <p>Get one-tap access from your home screen — works just like a native app.</p>
        </div>

        <div className="install-tabs">
          <button
            className={`install-tab ${activeTab === 'ios' ? 'active' : ''}`}
            onClick={() => setActiveTab('ios')}
          >
            🍎 iPhone / iPad
          </button>
          <button
            className={`install-tab ${activeTab === 'android' ? 'active' : ''}`}
            onClick={() => setActiveTab('android')}
          >
            🤖 Android
          </button>
        </div>

        {activeTab === 'ios' && (
          <div className="install-steps">
            <div className="install-callout">
              <strong>⚠️ Use Safari, not Chrome</strong>
              <span>iOS only allows installing from Safari.</span>
            </div>
            <Step num={1}>
              Open <strong>Safari</strong> on your iPhone or iPad
            </Step>
            <Step num={2}>
              Go to <strong>milittlecare.com</strong>
            </Step>
            <Step num={3}>
              Tap the <strong>Share button</strong> at the bottom of the screen
              <div className="install-step-illust">
                <Share size={16} />
                <span>(square with arrow pointing up)</span>
              </div>
            </Step>
            <Step num={4}>
              Scroll down and tap <strong>"Add to Home Screen"</strong>
            </Step>
            <Step num={5}>
              Tap <strong>"Add"</strong> in the top right
            </Step>
            <Step num={6} done>
              Look for the MI Little Care icon on your home screen — tap to open!
            </Step>
          </div>
        )}

        {activeTab === 'android' && (
          <div className="install-steps">
            <div className="install-callout">
              <strong>Use Chrome</strong>
              <span>Works best in Chrome on Android.</span>
            </div>
            <Step num={1}>
              Open <strong>Chrome</strong> on your Android phone
            </Step>
            <Step num={2}>
              Go to <strong>milittlecare.com</strong>
            </Step>
            <Step num={3}>
              You may see a banner saying <strong>"Add MI Little Care to Home screen"</strong> — tap it and you're done.
            </Step>
            <Step num={3.5}>
              <strong>If no banner:</strong> Tap the three-dot menu <strong>⋮</strong> in the top-right of Chrome
            </Step>
            <Step num={4}>
              Tap <strong>"Install app"</strong> or <strong>"Add to Home screen"</strong>
            </Step>
            <Step num={5}>
              Confirm by tapping <strong>Install</strong>
            </Step>
            <Step num={6} done>
              MI Little Care icon appears on your home screen. Tap to open!
            </Step>
          </div>
        )}

        <div className="install-modal-footer">
          Trouble with this? Email <a href="mailto:smdominique@gmail.com">smdominique@gmail.com</a>
        </div>
      </div>
    </div>
  )
}

function Step({ num, children, done }) {
  return (
    <div className="install-step">
      <div className={`install-step-num ${done ? 'done' : ''}`}>
        {done ? <Check size={14} /> : num}
      </div>
      <div className="install-step-content">{children}</div>
    </div>
  )
}
