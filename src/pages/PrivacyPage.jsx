import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  Shield,
  FileText,
  AlertCircle,
  CheckCircle,
  Lock,
  CreditCard,
  Eye,
  Users,
  Database,
  RefreshCw,
  Cookie,
  Globe,
  Trash2,
  Ban,
} from 'lucide-react'
import '@/styles/how-money-works.css'

export default function PrivacyPage() {
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: 'var(--space-2) 0' }}>
      <Link
        to="/"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--clr-sage-dark)',
          textDecoration: 'none',
          fontSize: '0.875rem',
          marginBottom: 'var(--space-5)',
        }}
      >
        <ArrowLeft size={14} /> Back home
      </Link>

      {/* Hero */}
      <div
        style={{
          background:
            'linear-gradient(135deg, var(--clr-sage-dark) 0%, var(--clr-sage) 100%)',
          borderRadius: 'var(--radius-xl)',
          padding: 'var(--space-8)',
          color: 'white',
          marginBottom: 'var(--space-6)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div style={{ position: 'relative', zIndex: 1, maxWidth: 520 }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 12px',
              background: 'rgba(255,255,255,0.18)',
              border: '1px solid rgba(255,255,255,0.25)',
              borderRadius: 'var(--radius-full)',
              fontSize: '0.75rem',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 'var(--space-4)',
            }}
          >
            <Shield size={13} /> Privacy Policy
          </div>
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'clamp(1.75rem, 4vw, 2.25rem)',
              fontWeight: 400,
              letterSpacing: '-0.02em',
              lineHeight: 1.2,
              marginBottom: 'var(--space-3)',
            }}
          >
            How MI Little Care <em style={{ fontStyle: 'italic', color: 'var(--clr-accent-light)' }}>handles your data</em>
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.85)', fontSize: '1rem', lineHeight: 1.6 }}>
            Last updated: May 19, 2026. By using the Service, you acknowledge
            and agree to the practices described below.
          </p>
        </div>
      </div>

      {/* 1. Information We Collect */}
      <Section icon={<Database size={22} />} iconClass="sage" title="1. Information we collect">
        <p>Depending on how you use the Service, we may collect:</p>

        <p><strong>Provider information:</strong></p>
        <ul className="hmw-list">
          <li>Name, email address, phone number, and business information</li>
          <li>License status and licensing-related information</li>
          <li>MiRegistry identifiers and training records</li>
          <li>Subscription and billing information</li>
        </ul>

        <p><strong>Child and family information:</strong></p>
        <ul className="hmw-list">
          <li>Child names</li>
          <li>Attendance records and schedules</li>
          <li>Parent or guardian contact information</li>
          <li>Funding-program participation information</li>
          <li>Health-related or special-needs notes entered by providers</li>
        </ul>

        <p><strong>Staff information:</strong></p>
        <ul className="hmw-list">
          <li>Names and contact information</li>
          <li>Training records and certifications</li>
          <li>Clock-in and attendance records</li>
          <li>Licensing or compliance-related records</li>
        </ul>

        <p><strong>Technical information:</strong></p>
        <ul className="hmw-list">
          <li>IP address and browser information</li>
          <li>Device and usage data</li>
          <li>Log data and diagnostics</li>
          <li>Authentication and session information</li>
        </ul>
      </Section>

      {/* 2. How We Use Information */}
      <Section icon={<Eye size={22} />} iconClass="sage" title="2. How we use information">
        <p>We may use information to:</p>
        <ul className="hmw-list">
          <li>Provide and operate the Service</li>
          <li>Maintain accounts and subscriptions</li>
          <li>Process payments and invoices</li>
          <li>Provide compliance and administrative tools</li>
          <li>Improve platform functionality and reliability</li>
          <li>Respond to support requests</li>
          <li>Detect fraud, abuse, or security incidents</li>
          <li>Comply with legal obligations</li>
        </ul>
      </Section>

      {/* 3. Compliance Disclaimer */}
      <Section icon={<AlertCircle size={22} />} iconClass="warning" title="3. Compliance and regulatory disclaimer">
        <p>
          MI Little Care provides <strong>administrative and informational tools only</strong>. We do not guarantee licensing compliance, reimbursement approval, audit readiness, or regulatory outcomes.
        </p>
        <p>Providers remain solely responsible for:</p>
        <ul className="hmw-list">
          <li>Maintaining legally required records</li>
          <li>Verifying all licensing requirements</li>
          <li>Verifying reimbursement submissions</li>
          <li>Maintaining required parental consents</li>
          <li>Complying with all applicable laws and regulations</li>
        </ul>
      </Section>

      {/* 4. Child Data */}
      <Section icon={<Users size={22} />} iconClass="warning" title="4. Child data and provider responsibilities">
        <p>Providers control the data they upload into the Service.</p>
        <p>
          By using the Service, providers represent and warrant that they have <strong>all necessary rights, permissions, notices, and consents</strong> required to collect, store, process, and share information uploaded into the platform.
        </p>
        <p>Providers are solely responsible for determining whether uploaded data complies with:</p>
        <ul className="hmw-list">
          <li>Privacy laws</li>
          <li>Childcare regulations</li>
          <li>Educational or health-related laws</li>
          <li>Parental consent requirements</li>
          <li>Mandated reporting obligations</li>
        </ul>
      </Section>

      {/* 5. Payments */}
      <Section icon={<CreditCard size={22} />} iconClass="accent" title="5. Payments">
        <p>
          Payments are processed by third-party payment processors including <strong>Stripe</strong>.
        </p>
        <p>
          We do <strong>not directly store complete payment card information</strong> on our servers.
        </p>
      </Section>

      {/* 6. Third-Party Services */}
      <Section icon={<Globe size={22} />} iconClass="sage" title="6. Third-party services and infrastructure">
        <p>
          We may use third-party providers for hosting, authentication, cloud storage, payment processing, analytics, customer support, and email delivery.
        </p>
        <p>These providers may include:</p>
        <ul className="hmw-list">
          <li><strong>Supabase</strong> — database and authentication</li>
          <li><strong>Vercel</strong> — hosting</li>
          <li><strong>Stripe</strong> — payment processing</li>
          <li><strong>Resend</strong> — email delivery</li>
        </ul>
        <p>
          We are not responsible for outages, interruptions, or security events caused by third-party providers.
        </p>
      </Section>

      {/* 7. Data Security */}
      <Section icon={<Lock size={22} />} iconClass="sage" title="7. Data security">
        <p>
          We use commercially reasonable administrative and technical safeguards intended to protect information stored within the Service.
        </p>
        <p>
          However, no internet-based platform, transmission method, or storage system can be guaranteed completely secure.
        </p>
        <p>You acknowledge and accept these inherent risks when using the Service.</p>
      </Section>

      {/* 8. Data Retention */}
      <Section icon={<FileText size={22} />} iconClass="sage" title="8. Data retention">
        <p>
          We may retain information for operational, legal, security, backup, and compliance-related purposes.
        </p>
        <p>
          Providers remain solely responsible for maintaining any legally required copies or backups of records.
        </p>
        <p>We do not guarantee permanent retention of uploaded records.</p>
      </Section>

      {/* 9. Data Deletion */}
      <Section icon={<Trash2 size={22} />} iconClass="error" title="9. Data deletion and account closure">
        <p>
          Upon account cancellation or termination, some information may remain in backups, logs, archives, or retained systems for a reasonable period.
        </p>
        <p>We may delete account data after account termination without further notice.</p>
      </Section>

      {/* 10. Cookies */}
      <Section icon={<Cookie size={22} />} iconClass="sage" title="10. Cookies and analytics">
        <p>
          We may use cookies, local storage, analytics tools, and similar technologies to operate and improve the Service.
        </p>
        <p>
          You may disable certain browser tracking features, though portions of the Service may not function properly as a result.
        </p>
      </Section>

      {/* 11. No Sale */}
      <Section icon={<Ban size={22} />} iconClass="success" title="11. No sale of personal information">
        <p>
          We <strong>do not sell personal information</strong> for monetary compensation.
        </p>
      </Section>

      {/* 12. Children's Privacy */}
      <Section icon={<Shield size={22} />} iconClass="warning" title="12. Children's privacy">
        <p>
          MI Little Care is intended for use by childcare providers and adults, not by children directly.
        </p>
        <p>
          Any child-related information uploaded into the Service is uploaded by providers acting as independent data controllers or operators.
        </p>
        <p>
          Providers are responsible for obtaining any legally required parental notices or consents relating to child information.
        </p>
      </Section>

      {/* 13. International */}
      <Section icon={<Globe size={22} />} iconClass="sage" title="13. International use">
        <p>The Service is intended for use in the United States.</p>
        <p>
          If you access the Service from outside the United States, you are responsible for compliance with applicable local laws.
        </p>
      </Section>

      {/* 14. Changes */}
      <Section icon={<RefreshCw size={22} />} iconClass="sage" title="14. Changes to this Privacy Policy">
        <p>We may update this Privacy Policy periodically.</p>
        <p>
          Continued use of the Service after updates become effective constitutes acceptance of the revised Privacy Policy.
        </p>
      </Section>

      {/* Contact footer */}
      <div
        style={{
          background: 'var(--clr-cream)',
          border: '1px solid var(--clr-warm-mid)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-5)',
          textAlign: 'center',
          color: 'var(--clr-ink-mid)',
          fontSize: '0.9375rem',
          marginTop: 'var(--space-6)',
        }}
      >
        <Shield
          size={20}
          style={{ color: 'var(--clr-sage-dark)', marginBottom: 'var(--space-2)' }}
        />
        <div style={{ marginBottom: 4 }}>Questions about your privacy?</div>
        <div>
          Email us at{' '}
          <a
            href="mailto:smdominique@gmail.com"
            style={{ color: 'var(--clr-sage-dark)', fontWeight: 500 }}
          >
            smdominique@gmail.com
          </a>
        </div>
      </div>
    </div>
  )
}

function Section({ icon, iconClass, title, children }) {
  return (
    <section
      style={{
        background: 'var(--clr-white)',
        border: '1px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-6)',
        marginBottom: 'var(--space-4)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          marginBottom: 'var(--space-4)',
        }}
      >
        <div
          className={`stat-icon ${iconClass}`}
          style={{ width: 44, height: 44 }}
        >
          {icon}
        </div>
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.25rem',
            fontWeight: 500,
            color: 'var(--clr-ink)',
            letterSpacing: '-0.01em',
            margin: 0,
          }}
        >
          {title}
        </h2>
      </div>
      <div
        className="hmw-content"
        style={{
          color: 'var(--clr-ink-mid)',
          fontSize: '0.9375rem',
          lineHeight: 1.65,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
        }}
      >
        {children}
      </div>
    </section>
  )
}
