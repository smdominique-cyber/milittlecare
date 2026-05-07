import { Link } from 'react-router-dom'
import '@/styles/landing.css'

export default function LandingPage() {
  return (
    <div className="landing-page">
      {/* ─── Top nav ──────────────────────────────── */}
      <nav className="landing-nav">
        <div className="landing-nav-inner">
          <Link to="/" className="landing-nav-brand">
            <span className="landing-nav-brand-icon">🏡</span>
            Mi Little Care
          </Link>
          <div className="landing-nav-actions">
            <Link to="/login" className="landing-nav-link">Sign in</Link>
            <Link to="/login" className="landing-nav-cta">Start free trial</Link>
          </div>
        </div>
      </nav>

      {/* ─── Hero ─────────────────────────────────── */}
      <section className="landing-hero">
        <div className="landing-hero-inner">
          <span className="landing-hero-eyebrow">Built in Michigan, for Michigan</span>
          <h1>
            Built for Michigan home daycare <em>providers</em>.
          </h1>
          <p className="landing-hero-sub">
            Track CDC attendance. Generate licensing-ready reports. Get paid faster.
            The childcare software that actually understands Michigan's rules — built by a
            Michigander, for Michiganders.
          </p>
          <div className="landing-hero-ctas">
            <Link to="/login" className="landing-cta-primary">
              Start your 30-day free trial →
            </Link>
            <a href="#how-it-works" className="landing-cta-secondary">
              See how it works ↓
            </a>
          </div>
          <p className="landing-hero-footnote">
            No credit card required. Cancel anytime.
          </p>
        </div>
      </section>

      {/* ─── Why MILittleCare ─────────────────────── */}
      <section className="landing-section">
        <div className="landing-section-inner">
          <span className="landing-section-eyebrow">Why MILittleCare</span>
          <h2>You're not running a generic daycare.<br />Why use generic software?</h2>
          <p className="landing-section-lead">
            Brightwheel and Procare are built for big national centers. Your home daycare runs on different rules —
            Michigan licensing requirements, CDC subsidy billing, the bi-weekly I-Billing portal, BEM 706 record-keeping.
            Most childcare software ignores all of that. MILittleCare is built specifically for what
            <strong> you</strong> actually deal with.
          </p>

          <div className="landing-cards">
            <div className="landing-card">
              <div className="landing-card-icon">📋</div>
              <h3>Licensing-ready records</h3>
              <p>
                Every attendance record we save satisfies BEM 706. Generate inspector-ready Excel reports
                with parent signature lines, certified-by-parent tracking, and four-year retention — all in one click.
              </p>
            </div>

            <div className="landing-card">
              <div className="landing-card-icon">⏱️</div>
              <h3>Stop wasting hours on I-Billing</h3>
              <p>
                Your attendance is already tracked. Export it ready for the I-Billing portal in seconds, not hours.
                New provider waiting on your CDC credentials? Track everything from day one and back-bill when approved.
              </p>
            </div>

            <div className="landing-card">
              <div className="landing-card-icon">💰</div>
              <h3>Get paid by parents in one place</h3>
              <p>
                Stripe autopay, Venmo, Zelle, cash, check — accept any way you want to be paid. Send invoices in two clicks.
                Parents pay in two taps. Year-end FSA statements generated automatically.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Features ───────────────────────────── */}
      <section id="how-it-works" className="landing-section alt">
        <div className="landing-section-inner">
          <span className="landing-section-eyebrow">How it works</span>
          <h2>The whole day, handled.</h2>
          <p className="landing-section-lead">
            Six features that cover what running a Michigan home daycare actually looks like.
            No bloat, no kitchen-sink dashboards.
          </p>

          {/* Today widget */}
          <div className="landing-feature">
            <div className="landing-feature-text">
              <h3>Daily check-ins, in one tap</h3>
              <p>
                Drop off, release, done. Parents can check in their own kids on their phone — you stay focused on care.
                Custody handoffs are recorded with timestamps, so you have a full record of who released the child to whom.
              </p>
            </div>
            <div className="landing-feature-image">
              <span>Today widget screenshot</span>
            </div>
          </div>

          {/* Attendance + custody handoff */}
          <div className="landing-feature reverse">
            <div className="landing-feature-text">
              <h3>Attendance with real liability protection</h3>
              <p>
                Every drop-off and pickup is recorded with who handed off the child — parent or provider.
                Export Excel reports with parent signature lines for licensing inspections.
                Built specifically to satisfy Michigan's BEM 706 requirements.
              </p>
            </div>
            <div className="landing-feature-image">
              <span>Attendance export screenshot</span>
            </div>
          </div>

          {/* Family management */}
          <div className="landing-feature">
            <div className="landing-feature-text">
              <h3>All your families in one place</h3>
              <p>
                Children, guardians, allergies, medical notes, emergency contacts.
                Send parent invitations with one click — they get their own portal to pay invoices and update info themselves.
                No more sticky notes on the fridge.
              </p>
            </div>
            <div className="landing-feature-image">
              <span>Families page screenshot</span>
            </div>
          </div>

          {/* Smart billing */}
          <div className="landing-feature reverse">
            <div className="landing-feature-text">
              <h3>Billing that handles itself</h3>
              <p>
                Weekly, bi-weekly, monthly, or custom cycles — the math handles itself.
                Cycle ends Friday for your Mon-Fri operation? Set it once, never think about it again.
                Stripe autopay or any payment method you accept.
              </p>
            </div>
            <div className="landing-feature-image">
              <span>Billing page screenshot</span>
            </div>
          </div>

          {/* Tax tools */}
          <div className="landing-feature">
            <div className="landing-feature-text">
              <h3>Tax season, finally simple</h3>
              <p>
                Snap a photo of any receipt — AI extracts the merchant, amount, and category for you.
                T/S ratio calculator built in. Year-end Excel export your tax preparer will actually thank you for.
              </p>
            </div>
            <div className="landing-feature-image">
              <span>Deductions page screenshot</span>
            </div>
          </div>

          {/* Parent portal */}
          <div className="landing-feature reverse">
            <div className="landing-feature-text">
              <h3>Parents get their own portal</h3>
              <p>
                Parents see their kids' attendance, pay invoices, manage contact info, and message you directly.
                They never have to text you to ask "what time do you open?" again.
                Set it up once, save hours every week.
              </p>
            </div>
            <div className="landing-feature-image">
              <span>Parent dashboard screenshot</span>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Pricing ─────────────────────────────── */}
      <section className="landing-section">
        <div className="landing-section-inner">
          <span className="landing-section-eyebrow">Pricing</span>
          <h2>Simple pricing.</h2>

          <div className="landing-pricing-card">
            <div className="landing-pricing-price">
              <span className="amount">$14.99</span>
              <span className="period"> / month</span>
            </div>
            <p className="landing-pricing-tag">
              Everything included. No tiers, no per-child fees, no hidden costs.
            </p>
            <ul className="landing-pricing-features">
              <li>Unlimited families and children</li>
              <li>Unlimited team members during alpha</li>
              <li>Stripe payment processing (Stripe fees apply)</li>
              <li>AI receipt scanning</li>
              <li>All current and future Michigan-specific features</li>
            </ul>
            <Link to="/login" className="landing-cta-primary" style={{ width: '100%', justifyContent: 'center' }}>
              Start your 30-day free trial →
            </Link>
            <p className="landing-pricing-footnote">
              No credit card required to start. We'll ask for one before your trial ends.
            </p>
          </div>
        </div>
      </section>

      {/* ─── Founder ─────────────────────────────── */}
      <section className="landing-section alt">
        <div className="landing-section-inner">
          <span className="landing-section-eyebrow">Built by a Michigander</span>
          <h2>One developer, in Michigan.</h2>

          <div className="landing-founder">
            <div className="landing-founder-photo">
              SD
            </div>
            <p>
              I'm Seth Dominique, a Michigan resident who watched my partner navigate the chaos of running a home daycare.
              I-Billing took her hours every two weeks. Tax season was a nightmare of receipts in shoe boxes.
              Tracking which kid had which allergy meant a sticky note on the fridge.
            </p>
            <p>
              So I built MILittleCare. It's not a Silicon Valley startup. It's one developer making the software
              that should already exist for Michigan's 3,300+ home daycare providers.
            </p>
            <p>
              If you have feedback, you'll be talking to me directly. Promise.
            </p>
            <p className="landing-founder-signoff">— Seth</p>
          </div>
        </div>
      </section>

      {/* ─── Final CTA ───────────────────────────── */}
      <section className="landing-final-cta">
        <h2>Try it free for 30 days.</h2>
        <Link to="/login" className="landing-cta-primary">
          Start your free trial →
        </Link>
        <p className="landing-final-cta-footnote">
          Questions first? <a href="mailto:smdominique@gmail.com">Email me directly</a>
        </p>
      </section>

      {/* ─── Footer ──────────────────────────────── */}
      <footer className="landing-footer">
        <div>
          © {new Date().getFullYear()} MI Little Care · Made in Michigan
        </div>
        <div style={{ marginTop: 12 }}>
          <Link to="/privacy">Privacy Policy</Link>
          <Link to="/terms">Terms of Service</Link>
          <a href="mailto:smdominique@gmail.com">Contact</a>
        </div>
      </footer>
    </div>
  )
}
