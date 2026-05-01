import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

export default function TermsPage() {
  return (
    <div style={{
      maxWidth: 760,
      margin: '0 auto',
      padding: '40px 24px',
      fontFamily: 'var(--font-body, -apple-system, sans-serif)',
      lineHeight: 1.65,
      color: '#1e2620',
      background: '#fbf8f1',
      minHeight: '100vh',
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

      <section className="legal-content">
        <p style={{ fontSize: '0.875em', color: '#888' }}>Last updated: April 30, 2026</p>

        <h2>Terms of Service</h2>

        <p>
          These Terms of Service ("Terms") govern your use of MI Little Care ("Service"), operated by Seth Dominique in Michigan, USA.
          By using the Service, you agree to these Terms.
        </p>

        <h3>1. Description of Service</h3>
        <p>
          MI Little Care is a software platform designed for home daycare providers in Michigan. It provides tools for:
        </p>
        <ul>
          <li>Enrollment and family management</li>
          <li>Billing and invoicing</li>
          <li>Payment collection via Stripe</li>
          <li>Receipt tracking and categorization</li>
          <li>Time/Space ratio calculations</li>
          <li>Tax reporting summaries</li>
        </ul>

        <h3>2. Eligibility</h3>
        <p>
          You must be at least 18 years old and legally capable of entering into a binding agreement to use the Service.
        </p>

        <h3>3. Accounts</h3>
        <ul>
          <li>You are responsible for maintaining account security</li>
          <li>You must provide accurate information</li>
          <li>You are responsible for all activity under your account</li>
        </ul>

        <h3>4. Subscription and Billing</h3>
        <ul>
          <li>Subscription cost: $14.99/month</li>
          <li>Free trial: 30 days (90 days for early users, if applicable)</li>
          <li>Billing is recurring unless canceled</li>
          <li>No refunds for unused time</li>
          <li>Access continues through the end of the paid billing period after cancellation</li>
        </ul>

        <h3>5. Payments</h3>
        <p>
          Payments are processed through Stripe. We do not process or store payment credentials.
        </p>
        <ul>
          <li>We are not a payment processor</li>
          <li>Stripe is responsible for payment processing and compliance</li>
        </ul>

        <h3>6. Autopay</h3>
        <p>
          Providers may enable automatic billing for parents. By enabling autopay:
        </p>
        <ul>
          <li>Parents authorize recurring charges via Stripe</li>
          <li>Charges are typically processed weekly on Mondays</li>
        </ul>

        <h3>7. User Responsibilities</h3>

        <h4>Providers</h4>
        <ul>
          <li>Must comply with Michigan licensing requirements (LARA)</li>
          <li>Are responsible for accuracy of all data entered</li>
          <li>Are responsible for maintaining proper records</li>
        </ul>

        <h4>Parents/Guardians</h4>
        <ul>
          <li>Must provide accurate information about themselves and their children</li>
          <li>Are responsible for payment obligations</li>
        </ul>

        <h3>8. Tax Disclaimer</h3>
        <p>
          The Service provides tools to assist with financial tracking and Time/Space ratio calculations.
          We are not a tax advisor and do not provide tax, legal, or accounting advice.
        </p>
        <p>
          You should consult a qualified tax professional for guidance.
        </p>

        <h3>9. Acceptable Use</h3>
        <p>You agree not to:</p>
        <ul>
          <li>Use the Service for illegal purposes</li>
          <li>Commit fraud or misrepresentation</li>
          <li>Attempt to access unauthorized data</li>
          <li>Interfere with system security or operations</li>
        </ul>

        <h3>10. Suspension and Termination</h3>
        <p>
          We may suspend or terminate access if:
        </p>
        <ul>
          <li>You violate these Terms</li>
          <li>You engage in fraud or abuse</li>
          <li>Your use poses legal or operational risk</li>
        </ul>

        <h3>11. Data and Records</h3>
        <p>
          Providers retain responsibility for maintaining required childcare and financial records.
          We are not responsible for data loss due to user error or external system failures.
        </p>

        <h3>12. Disclaimer of Warranties</h3>
        <p>
          The Service is provided "as is" and "as available" without warranties of any kind.
          We do not guarantee uninterrupted or error-free operation.
        </p>

        <h3>13. Limitation of Liability</h3>
        <p>
          To the fullest extent permitted by law:
        </p>
        <ul>
          <li>We are not liable for indirect, incidental, or consequential damages</li>
          <li>Total liability is limited to the amount paid by you in the last 12 months</li>
        </ul>

        <h3>14. Indemnification</h3>
        <p>
          You agree to indemnify and hold harmless MI Little Care from claims arising out of your use of the Service or violation of these Terms.
        </p>

        <h3>15. Governing Law</h3>
        <p>
          These Terms are governed by the laws of the State of Michigan, without regard to conflict of law principles.
        </p>

        <h3>16. Changes to Terms</h3>
        <p>
          We may update these Terms periodically. Continued use of the Service constitutes acceptance of the updated Terms.
        </p>

        <h3>17. Contact</h3>
        <p>
          Email: <a href="mailto:smdominique@gmail.com">smdominique@gmail.com</a>
        </p>
      </section>

      <style>{`
        .legal-content h2 {
          font-family: Georgia, 'Times New Roman', serif;
          font-size: 2rem;
          font-weight: 400;
          letter-spacing: -0.02em;
          margin: 8px 0 24px;
          color: #1e2620;
        }
        .legal-content h3 {
          font-family: Georgia, 'Times New Roman', serif;
          font-size: 1.25rem;
          font-weight: 500;
          margin: 32px 0 12px;
          color: #1e2620;
          letter-spacing: -0.01em;
        }
        .legal-content h4 {
          font-size: 1rem;
          font-weight: 600;
          margin: 20px 0 8px;
          color: #3e4639;
        }
        .legal-content p {
          margin: 12px 0;
          color: #3e4639;
        }
        .legal-content ul {
          margin: 8px 0 16px;
          padding-left: 24px;
          color: #3e4639;
        }
        .legal-content li {
          margin: 4px 0;
        }
        .legal-content a {
          color: #3e5849;
          text-decoration: underline;
        }
      `}</style>
    </div>
  )
}
