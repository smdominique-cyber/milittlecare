import { createContext, useContext, useState, useCallback } from 'react'
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react'

const ToastContext = createContext({
  show: () => {},
  success: () => {},
  error: () => {},
  info: () => {},
})

let nextId = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const remove = useCallback((id) => {
    setToasts(t => t.filter(toast => toast.id !== id))
  }, [])

  const show = useCallback((message, type = 'info', duration = 4000) => {
    const id = ++nextId
    setToasts(t => [...t, { id, message, type }])
    if (duration > 0) {
      setTimeout(() => remove(id), duration)
    }
    return id
  }, [remove])

  const success = useCallback((msg, dur) => show(msg, 'success', dur), [show])
  const error = useCallback((msg, dur) => show(msg, 'error', dur || 6000), [show])
  const info = useCallback((msg, dur) => show(msg, 'info', dur), [show])

  return (
    <ToastContext.Provider value={{ show, success, error, info, remove }}>
      {children}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <div className="toast-icon">
              {t.type === 'success' && <CheckCircle size={16} />}
              {t.type === 'error' && <AlertCircle size={16} />}
              {t.type === 'info' && <Info size={16} />}
            </div>
            <div className="toast-message">{t.message}</div>
            <button className="toast-close" onClick={() => remove(t.id)}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}
