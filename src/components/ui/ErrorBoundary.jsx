import { Component } from 'react'
import { AlertTriangle, RefreshCw, Home } from 'lucide-react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught an error:', error, info)
  }

  reset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#fbf8f1',
          padding: '20px',
          fontFamily: '-apple-system, Segoe UI, Roboto, sans-serif',
        }}>
          <div style={{
            background: 'white',
            border: '1px solid #e5d9c4',
            borderRadius: '16px',
            padding: '40px 32px',
            maxWidth: '480px',
            width: '100%',
            textAlign: 'center',
            boxShadow: '0 4px 20px rgba(0,0,0,0.06)',
          }}>
            <div style={{
              width: '64px',
              height: '64px',
              background: 'rgba(192, 57, 43, 0.1)',
              color: '#c0392b',
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              margin: '0 auto 20px',
            }}>
              <AlertTriangle size={32} />
            </div>

            <h1 style={{
              fontFamily: 'Georgia, serif',
              fontSize: '24px',
              fontWeight: 400,
              color: '#1e2620',
              margin: '0 0 12px',
              letterSpacing: '-0.02em',
            }}>
              Something went wrong
            </h1>

            <p style={{
              color: '#6b7c6f',
              fontSize: '15px',
              lineHeight: 1.55,
              margin: '0 0 24px',
            }}>
              We hit an unexpected error. Try refreshing the page, or head back home.
            </p>

            {this.state.error?.message && (
              <details style={{
                background: '#faf6ec',
                border: '1px solid #e5d9c4',
                borderRadius: '8px',
                padding: '12px 14px',
                marginBottom: '20px',
                textAlign: 'left',
                fontSize: '12px',
                color: '#6b7c6f',
              }}>
                <summary style={{ cursor: 'pointer', fontWeight: 500 }}>Error details</summary>
                <pre style={{
                  margin: '8px 0 0',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'monospace',
                  fontSize: '11px',
                }}>{this.state.error.message}</pre>
              </details>
            )}

            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
              <button
                onClick={() => window.location.reload()}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '10px 20px',
                  background: '#3e5849',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                <RefreshCw size={14} /> Refresh
              </button>
              <button
                onClick={() => { window.location.href = '/dashboard' }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '10px 20px',
                  background: 'white',
                  color: '#3e4639',
                  border: '1px solid #e5d9c4',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                <Home size={14} /> Home
              </button>
            </div>

            <p style={{
              fontSize: '12px',
              color: '#8a9281',
              marginTop: '24px',
              marginBottom: 0,
            }}>
              If this keeps happening, email <a href="mailto:smdominique@gmail.com" style={{ color: '#3e5849' }}>smdominique@gmail.com</a>
            </p>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
