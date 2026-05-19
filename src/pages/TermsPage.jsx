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
  Scale,
  RefreshCw,
} from 'lucide-react'
import { SUBSCRIPTION_PRICE_DISPLAY } from '@/lib/pricing'
import '@/styles/how-money-works.css'

export default function TermsPage() {
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
            <FileText size={13} /> Terms of Service
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
            The terms for using <em style={{ fontStyle: 'italic', color: 'var(--clr-accent-light)' }}>MI Little Care</em>
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.85)', fontSize: '1rem', lineHeight: 1.6 }}>
            Last updated: May 19, 2026. By creating an account or using the
            Service, you agree to these Terms. If you don't agree, you may not
            use the Service.
          </p>
        </div>
      </div>

      {/* 1. Description of Service */}
      <Section icon={<FileText size={22} />} iconClass="sage" title="1. What MI Little Care is">
        <p>
          MI Little Care ("we," "us," "our") is a software platform operated by{' '}
          <strong>Seth Dominique in Michigan, USA</strong>, designed for Michigan
          home childcare providers. The Service may include tools related to:
        </p>
        <ul className="hmw-list">
          <li>Enrollment and family management</li>
          <li>Attendance tracking</li>
          <li>CDC billing and reimbursement tracking</li>
          <li>Training and licensing deadline tracking</li>
          <li>Document storage and organization</li>
          <li>Tax and financial tracking tools</li>
          <li>Staff management tools</li>
          <li>Compliance-related dashboards and summaries</li>
        </ul>
        <p>
          The Service is an <strong>administrative and informational tool only</strong>. MI Little Care is not a government agency, law firm, accounting firm, tax advisor, licensing authority, or compliance certification service.
        </p>
      </Section>

      {/* 2. No Legal Advice */}
      <Section icon={<AlertCircle size={22} />} iconClass="warning" title="2. We don't give legal, regulatory, or tax advice">
        <p>
          MI Little Care does not provide legal advice, regulatory advice, licensing advice, accounting advice, tax advice, or compliance certification.
        </p>
        <p>
          Any compliance-related information, reminders, dashboards, health scores, reimbursement calculations, audit-preparation materials, deadline tracking, or summaries are for informational and administrative assistance purposes only.
        </p>
        <p>
          You remain solely responsible for independently verifying all requirements, deadlines, records, reimbursement submissions, licensing obligations, training requirements, attendance records, and compliance obligations with applicable Michigan laws, regulations, and agency guidance.
        </p>
        <p><strong>Your use of the Service does not guarantee:</strong></p>
        <ul className="hmw-list">
          <li>Licensing compliance</li>
          <li>Audit readiness</li>
          <li>Successful inspections</li>
          <li>Approval of reimbursements</li>
          <li>Avoidance of citations or penalties</li>
          <li>Accuracy of agency determinations</li>
        </ul>
      </Section>

      {/* 3. Eligibility */}
      <Section icon={<CheckCircle size={22} />} iconClass="success" title="3. Who can use the Service">
        <p>
          You must be at least <strong>18 years old</strong> and legally capable of entering into a binding agreement to use the Service.
        </p>
      </Section>

      {/* 4. Accounts and Security */}
      <Section icon={<Lock size={22} />} iconClass="sage" title="4. Accounts and security">
        <ul className="hmw-list">
          <li>You are responsible for maintaining account confidentiality and security</li>
          <li>You must provide accurate and current information</li>
          <li>You are responsible for all activity occurring under your account</li>
          <li>You must promptly notify us of any unauthorized access or security incident</li>
          <li>You are responsible for managing staff access and permissions within your account</li>
        </ul>
        <p>
          We reserve the right to suspend or terminate accounts that present security, legal, operational, or financial risk.
        </p>
      </Section>

      {/* 5. User Responsibilities */}
      <Section icon={<Users size={22} />} iconClass="sage" title="5. Your responsibilities">
        <p><strong>If you're a provider:</strong></p>
        <ul className="hmw-list">
          <li>Comply with all applicable childcare laws, regulations, and agency requirements</li>
          <li>Remain solely responsible for maintaining legally required records</li>
          <li>Remain solely responsible for all reimbursement submissions and reporting</li>
          <li>Independently verify all information generated by the Service</li>
          <li>You are responsible for the accuracy, legality, and completeness of all uploaded or entered data</li>
          <li>Maintain any legally required backups or copies of records</li>
          <li>Ensure staff access permissions are appropriate</li>
        </ul>
        <p><strong>If you're a parent or guardian:</strong></p>
        <ul className="hmw-list">
          <li>Provide accurate information about yourself and your children</li>
          <li>You are responsible for payment obligations owed to providers</li>
        </ul>
      </Section>

      {/* 6. Child and Sensitive Data */}
      <Section icon={<Shield size={22} />} iconClass="warning" title="6. Child and sensitive data">
        <p>
          Providers may upload or store information relating to children, caregivers, attendance, health-related notes, licensing records, training records, and related business records.
        </p>
        <p>
          You represent and warrant that <strong>you have all necessary rights, permissions, notices, and consents</strong> required to collect, upload, process, store, and share any data submitted to the Service.
        </p>
        <p>
          You acknowledge that <strong>you, and not MI Little Care</strong>, are responsible for determining what information you upload and whether such uploads comply with applicable privacy, childcare, educational, health, or data protection laws.
        </p>
        <p>
          MI Little Care is not responsible for verifying parental consent, mandated reporting compliance, licensing compliance, or the legality of records maintained by providers.
        </p>
      </Section>

      {/* 7. Subscription and Billing */}
      <Section icon={<CreditCard size={22} />} iconClass="sage" title="7. Subscription and billing">
        <ul className="hmw-list">
          <li>Subscription cost: <strong>{SUBSCRIPTION_PRICE_DISPLAY}/month</strong> unless otherwise agreed in writing</li>
          <li>Free trial: 30 days (or 90 days for eligible early users)</li>
          <li>Subscriptions automatically renew until canceled</li>
          <li>No refunds or prorated refunds for partial billing periods</li>
          <li>Access continues through the end of the current paid billing period after cancellation</li>
          <li>We may modify pricing, plans, or features with reasonable notice</li>
        </ul>
        <p>
          You authorize recurring charges to your selected payment method until cancellation.
        </p>
      </Section>

      {/* 8. Payments and Third-Party Services */}
      <Section icon={<CreditCard size={22} />} iconClass="accent" title="8. Payments and third-party services">
        <p>
          Payments are processed through third-party providers including <strong>Stripe</strong>. We do not directly store full payment card information.
        </p>
        <p>
          The Service may rely on third-party infrastructure and services, including hosting, email delivery, payment processing, authentication, analytics, and cloud storage providers.
        </p>
        <p>
          We are not responsible for failures, outages, delays, inaccuracies, security incidents, or interruptions caused by third-party providers.
        </p>
      </Section>

      {/* 9. Regulatory Info Disclaimer */}
      <Section icon={<AlertCircle size={22} />} iconClass="warning" title="9. Regulatory information disclaimer">
        <p>
          The Service may display or reference information derived from third-party sources, including Michigan agencies, reimbursement schedules, licensing rules, training records, and regulatory guidance.
        </p>
        <p>
          Such information <strong>may change without notice</strong> and may contain errors, omissions, delays, inaccuracies, or outdated content.
        </p>
        <p>
          You are solely responsible for independently verifying all regulatory, reimbursement, licensing, attendance, training, and compliance-related information before relying on it.
        </p>
      </Section>

      {/* 10. Acceptable Use */}
      <Section icon={<Lock size={22} />} iconClass="error" title="10. Acceptable use">
        <p>You agree not to:</p>
        <ul className="hmw-list">
          <li>Use the Service for unlawful purposes</li>
          <li>Commit fraud, misrepresentation, or reimbursement abuse</li>
          <li>Upload unlawful, infringing, or unauthorized data</li>
          <li>Attempt to access unauthorized systems or data</li>
          <li>Interfere with system operations or security</li>
          <li>Reverse engineer or misuse the Service</li>
        </ul>
      </Section>

      {/* 11. Data and Availability */}
      <Section icon={<Eye size={22} />} iconClass="sage" title="11. Data, retention, and availability">
        <p>
          Providers remain solely responsible for maintaining all legally required records and backups.
        </p>
        <p>
          While we implement reasonable administrative and technical measures, no software platform or internet transmission can be guaranteed fully secure, uninterrupted, or error-free.
        </p>
        <p><strong>We do not guarantee:</strong></p>
        <ul className="hmw-list">
          <li>Continuous availability of the Service</li>
          <li>Error-free operation</li>
          <li>Permanent retention of uploaded records</li>
          <li>Recovery of deleted or corrupted data</li>
          <li>Compatibility with all devices or browsers</li>
        </ul>
        <p>
          We reserve the right to modify, suspend, discontinue, or remove features at any time.
        </p>
      </Section>

      {/* 12. Suspension and Termination */}
      <Section icon={<AlertCircle size={22} />} iconClass="error" title="12. Suspension and termination">
        <p>We may suspend or terminate access immediately if:</p>
        <ul className="hmw-list">
          <li>You violate these Terms</li>
          <li>You create legal, operational, financial, or security risk</li>
          <li>You misuse the Service</li>
          <li>We are required to do so by law or third-party providers</li>
        </ul>
        <p>Upon termination, your right to use the Service ends immediately.</p>
      </Section>

      {/* 13. IP */}
      <Section icon={<Shield size={22} />} iconClass="sage" title="13. Intellectual property">
        <p>
          The Service, including its software, branding, content, design, workflows, dashboards, graphics, and functionality, is owned by MI Little Care and protected by intellectual property laws.
        </p>
        <p>
          Except for limited access rights necessary to use the Service, no rights are granted to you.
        </p>
      </Section>

      {/* 14. Disclaimer of Warranties */}
      <Section icon={<AlertCircle size={22} />} iconClass="warning" title="14. Disclaimer of warranties">
        <p>
          THE SERVICE IS PROVIDED <strong>"AS IS"</strong> AND <strong>"AS AVAILABLE"</strong> WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED.
        </p>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE DISCLAIM ALL IMPLIED WARRANTIES, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, RELIABILITY, AND AVAILABILITY.
        </p>
        <p><strong>WE DO NOT WARRANT THAT:</strong></p>
        <ul className="hmw-list">
          <li>The Service will be uninterrupted or error-free</li>
          <li>The Service will meet all regulatory requirements</li>
          <li>The Service will prevent compliance violations</li>
          <li>The Service will guarantee reimbursement outcomes</li>
          <li>The Service will guarantee successful audits or inspections</li>
        </ul>
      </Section>

      {/* 15. Limitation of Liability */}
      <Section icon={<Scale size={22} />} iconClass="error" title="15. Limitation of liability">
        <p>TO THE MAXIMUM EXTENT PERMITTED BY LAW:</p>
        <ul className="hmw-list">
          <li>WE ARE NOT LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES</li>
          <li>WE ARE NOT LIABLE FOR LOST PROFITS, LOST REVENUE, LOST DATA, LOST REIMBURSEMENTS, LICENSING ACTIONS, AUDIT OUTCOMES, PENALTIES, FINES, OR BUSINESS INTERRUPTION</li>
          <li>WE ARE NOT LIABLE FOR THIRD-PARTY ACTIONS OR AGENCY DECISIONS</li>
          <li>WE ARE NOT LIABLE FOR USER DATA ERRORS OR FAILURE TO MAINTAIN REQUIRED RECORDS</li>
        </ul>
        <p>
          <strong>Our total liability</strong> for any claim relating to the Service shall not exceed the greater of:
        </p>
        <ul className="hmw-list">
          <li>The amount paid by you to us during the previous 12 months, or</li>
          <li>$100 USD</li>
        </ul>
      </Section>

      {/* 16. Indemnification */}
      <Section icon={<Scale size={22} />} iconClass="warning" title="16. Indemnification">
        <p>
          You agree to defend, indemnify, and hold harmless MI Little Care, Seth Dominique, affiliates, contractors, and service providers from and against any claims, damages, liabilities, losses, penalties, investigations, costs, and expenses arising out of or relating to:
        </p>
        <ul className="hmw-list">
          <li>Your use of the Service</li>
          <li>Your violation of these Terms</li>
          <li>Your violation of laws or regulations</li>
          <li>Your uploaded data or records</li>
          <li>Parent, reimbursement, licensing, or employment disputes</li>
          <li>Your failure to obtain required permissions or consents</li>
        </ul>
      </Section>

      {/* 17. Governing Law */}
      <Section icon={<Scale size={22} />} iconClass="sage" title="17. Governing law and disputes">
        <p>
          These Terms are governed by the laws of the <strong>State of Michigan</strong>, excluding conflict-of-law rules.
        </p>
        <p>
          Any dispute arising out of or relating to the Service or these Terms shall be resolved exclusively in the state or federal courts located in Michigan, and you consent to the personal jurisdiction of those courts.
        </p>
        <p>
          You waive any right to participate in class actions or class-wide proceedings.
        </p>
      </Section>

      {/* 18. Force Majeure */}
      <Section icon={<AlertCircle size={22} />} iconClass="warning" title="18. Force majeure">
        <p>
          We are not liable for delays or failures caused by events beyond our reasonable control, including internet outages, infrastructure failures, cyberattacks, labor disputes, acts of government, natural disasters, or third-party service interruptions.
        </p>
      </Section>

      {/* 19. Misc */}
      <Section icon={<FileText size={22} />} iconClass="sage" title="19. Miscellaneous">
        <ul className="hmw-list">
          <li>If any provision of these Terms is found unenforceable, the remaining provisions remain in effect</li>
          <li>Our failure to enforce any provision is not a waiver of future enforcement</li>
          <li>These Terms constitute the entire agreement between you and MI Little Care regarding the Service</li>
          <li>You may not assign these Terms without our written consent</li>
        </ul>
      </Section>

      {/* 20. Changes */}
      <Section icon={<RefreshCw size={22} />} iconClass="sage" title="20. Changes to these Terms">
        <p>
          We may update these Terms periodically. Continued use of the Service after updated Terms become effective constitutes acceptance of the revised Terms.
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
        <div style={{ marginBottom: 4 }}>Questions about these Terms?</div>
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
