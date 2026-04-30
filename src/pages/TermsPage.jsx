import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

export default function TermsPage() {
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
      }}>Terms of Service</h1>

      <p style={{ fontSize: '0.875em', color: '#888' }}>Last updated: April 30, 2026</p>

      <div style={{ marginTop: 24 }}>
        {/* PASTE TERMS OF SERVICE CONTENT HERE FROM CHATGPT */}
        <p style={{ fontStyle: 'italic', color: '#888', padding: 20, background: '#faf6ec', borderRadius: 8 }}>
          Full Terms of Service will be added shortly. For now, the key terms below apply.
        </p>

        <h2>Service description</h2>
        <p>MI Little Care is a software-as-a-service tool for licensed home daycare providers in Michigan. We provide tools to help with billing, family management, tax tracking, and parent communications. We are not a payment processor, tax advisor, or licensing body.</p>

        <h2>Subscription and billing</h2>
        <ul>
          <li>Subscription is $10 USD per month, billed via Stripe</li>
          <li>30-day free trial (90 days for early testers during alpha period)</li>
          <li>Cancel anytime — access continues until the end of your paid period</li>
          <li>No refunds for unused time on partial months</li>
        </ul>

        <h2>What we are NOT</h2>
        <ul>
          <li><strong>Not a tax advisor.</strong> T/S ratios and deduction tracking are tools, not tax advice. Consult a qualified tax professional for tax decisions.</li>
          <li><strong>Not a payment processor.</strong> Stripe handles all payment processing and bears all related liability.</li>
          <li><strong>Not a licensing body.</strong> You are responsible for your own compliance with Michigan LARA licensing requirements.</li>
        </ul>

        <h2>Your responsibilities</h2>
        <ul>
          <li>Maintain accurate information about your families and children in your care</li>
          <li>Comply with all applicable Michigan child care licensing rules</li>
          <li>Maintain proper insurance and licensing for your daycare business</li>
          <li>Use the service lawfully and in good faith</li>
        </ul>

        <h2>Limitation of liability</h2>
        <p>The service is provided AS-IS without warranty. We are not liable for indirect, consequential, or incidental damages. Our total liability is capped at the fees you have paid us in the previous 12 months.</p>

        <h2>Termination</h2>
        <p>We may suspend or terminate accounts for fraud, abuse, illegal use, or material violations of these terms. You may cancel your subscription at any time.</p>

        <h2>Governing law</h2>
        <p>These terms are governed by the laws of the State of Michigan, USA.</p>

        <h2>Contact</h2>
        <p>Questions about these terms: <a href="mailto:smdominique@gmail.com">smdominique@gmail.com</a></p>
      </div>
    </div>
  )
}
