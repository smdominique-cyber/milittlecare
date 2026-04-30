import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

export default function PrivacyPage() {
  return (
    <div style={{
      maxWidth: 760,
      margin: '0 auto',
      padding: '40px 24px',
      fontFamily: 'var(--font-body, -apple-system, sans-serif)',
      lineHeight: 1.6,
      color: '#1e2620',
    }}>
      <Link to="/" style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color: '#3e5849',
        textDecoration: 'none',
        fontSize: 14,
        marginBottom: 32,
      }}>
        <ArrowLeft size={14} /> Back home
      </Link>

      <h1 style={{
        fontFamily: 'Georgia, serif',
        fontSize: '2rem',
        fontWeight: 400,
        letterSpacing: '-0.02em',
        marginBottom: 8,
      }}>Privacy Policy</h1>

      <p style={{ fontSize: '0.875em', color: '#888' }}>Last updated: April 30, 2026</p>

      <div style={{ marginTop: 24 }}>
        {/* PASTE PRIVACY POLICY CONTENT HERE FROM CHATGPT */}
        <p style={{ fontStyle: 'italic', color: '#888', padding: 20, background: '#faf6ec', borderRadius: 8 }}>
          Privacy Policy content will be added shortly. For questions about how MI Little Care handles your data, please contact us at <a href="mailto:smdominique@gmail.com">smdominique@gmail.com</a>.
        </p>

        <h2>Summary of our practices</h2>
        <ul>
          <li>We collect only the information needed to operate the service</li>
          <li>We never sell user data</li>
          <li>We use Stripe (PCI Level 1 certified) for all payment processing — we never see card numbers</li>
          <li>Data is stored encrypted in the United States via Supabase</li>
          <li>You can request deletion of your account at any time</li>
          <li>Provider records are retained for 4 years per Michigan licensing requirement R 400.1907</li>
        </ul>

        <h2>Third-party services we use</h2>
        <ul>
          <li><strong>Stripe</strong> — payment processing (<a href="https://stripe.com/privacy">privacy policy</a>)</li>
          <li><strong>Supabase</strong> — encrypted database hosting (<a href="https://supabase.com/privacy">privacy policy</a>)</li>
          <li><strong>Vercel</strong> — web hosting (<a href="https://vercel.com/legal/privacy-policy">privacy policy</a>)</li>
          <li><strong>Resend</strong> — transactional email (<a href="https://resend.com/legal/privacy-policy">privacy policy</a>)</li>
          <li><strong>Anthropic</strong> — receipt OCR via Claude AI (<a href="https://www.anthropic.com/legal/privacy">privacy policy</a>)</li>
        </ul>

        <h2>Children's privacy (COPPA)</h2>
        <p>MI Little Care collects information about children (names, dates of birth, allergies, medical notes) for daycare operations. The child themselves is NOT a user of the service. Parents and guardians provide this information on behalf of children. We do not knowingly market to children or use children's data for any purpose other than facilitating their care.</p>

        <h2>Contact</h2>
        <p>Questions, requests for data deletion, or concerns: <a href="mailto:smdominique@gmail.com">smdominique@gmail.com</a></p>
      </div>
    </div>
  )
}
