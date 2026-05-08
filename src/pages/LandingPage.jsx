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

          {/* Feature 1: Today widget */}
          <div className="landing-feature">
            <div className="landing-feature-text">
              <h3>Daily check-ins, in one tap</h3>
              <p>
                Drop off, release, done. Parents can check in their own kids on their phone — you stay focused on care.
                Custody handoffs are recorded with timestamps, so you have a full record of who released the child to whom.
              </p>
            </div>
            <div className="landing-feature-image">
              <svg viewBox="0 0 640 400" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: '100%' }}>
                <rect width="640" height="400" fill="#fdfcf7"/>
                <rect x="20" y="20" width="600" height="60" rx="12" fill="white" stroke="#e8e0c8"/>
                <text x="40" y="48" fontFamily="Georgia, serif" fontSize="20" fill="#2c3329">Today</text>
                <text x="40" y="68" fontFamily="system-ui, sans-serif" fontSize="13" fill="#7a8076">Wednesday, May 7</text>
                <rect x="475" y="35" width="55" height="22" rx="11" fill="#dde8d9"/>
                <text x="502" y="50" fontFamily="system-ui, sans-serif" fontSize="11" fontWeight="600" fill="#4a6957" textAnchor="middle">2 here</text>
                <rect x="540" y="35" width="65" height="22" rx="11" fill="#f4eee2"/>
                <text x="572" y="50" fontFamily="system-ui, sans-serif" fontSize="11" fontWeight="600" fill="#7a8076" textAnchor="middle">1 done</text>
                <rect x="20" y="100" width="600" height="80" rx="10" fill="white" stroke="#e8e0c8"/>
                <text x="40" y="130" fontFamily="Georgia, serif" fontSize="15" fill="#2c3329">Sophia Johnson</text>
                <text x="40" y="150" fontFamily="system-ui, sans-serif" fontSize="12" fill="#7a8076">The Johnson Family</text>
                <text x="40" y="168" fontFamily="system-ui, sans-serif" fontSize="11" fill="#4a9b6f">✓ In at 8:14 AM</text>
                <rect x="475" y="125" width="120" height="32" rx="6" fill="#4a6957"/>
                <text x="535" y="146" fontFamily="system-ui, sans-serif" fontSize="13" fontWeight="500" fill="white" textAnchor="middle">Release</text>
                <rect x="20" y="195" width="600" height="80" rx="10" fill="white" stroke="#e8e0c8"/>
                <text x="40" y="225" fontFamily="Georgia, serif" fontSize="15" fill="#2c3329">Liam Carter</text>
                <text x="40" y="245" fontFamily="system-ui, sans-serif" fontSize="12" fill="#7a8076">The Carter Family</text>
                <text x="40" y="263" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">Not arrived yet</text>
                <rect x="445" y="220" width="90" height="32" rx="6" fill="#4a6957"/>
                <text x="490" y="241" fontFamily="system-ui, sans-serif" fontSize="13" fontWeight="500" fill="white" textAnchor="middle">Drop Off</text>
                <rect x="545" y="220" width="65" height="32" rx="6" fill="white" stroke="#c9c0a0"/>
                <text x="577" y="241" fontFamily="system-ui, sans-serif" fontSize="12" fill="#7a8076" textAnchor="middle">Absent</text>
                <rect x="20" y="290" width="600" height="80" rx="10" fill="white" stroke="#e8e0c8"/>
                <text x="40" y="320" fontFamily="Georgia, serif" fontSize="15" fill="#2c3329">Emma Davis</text>
                <text x="40" y="340" fontFamily="system-ui, sans-serif" fontSize="12" fill="#7a8076">The Davis Family</text>
                <text x="40" y="358" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">8:30 AM – 4:15 PM · 7h 45m</text>
                <text x="595" y="338" fontSize="22" fill="#4a9b6f" textAnchor="end">✓</text>
              </svg>
            </div>
          </div>

          {/* Feature 2: Attendance export */}
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
              <svg viewBox="0 0 640 400" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: '100%' }}>
                <rect width="640" height="400" fill="#fdfcf7"/>
                <rect x="20" y="20" width="600" height="360" rx="12" fill="white" stroke="#e8e0c8"/>
                <text x="40" y="50" fontFamily="Georgia, serif" fontSize="17" fill="#2c3329">Attendance Report — April 2026</text>
                <line x1="40" y1="65" x2="600" y2="65" stroke="#e8e0c8"/>
                {/* Header row */}
                <text x="50" y="92" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="700" fill="#7a8076">DATE</text>
                <text x="130" y="92" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="700" fill="#7a8076">CHILD</text>
                <text x="270" y="92" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="700" fill="#7a8076">CHECK IN</text>
                <text x="350" y="92" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="700" fill="#7a8076">CHECK OUT</text>
                <text x="430" y="92" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="700" fill="#7a8076">HOURS</text>
                <text x="490" y="92" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="700" fill="#7a8076">CERTIFIED</text>
                <line x1="40" y1="100" x2="600" y2="100" stroke="#e8e0c8"/>
                {/* Rows */}
                <text x="50" y="122" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">Apr 28</text>
                <text x="130" y="122" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">Sophia Johnson</text>
                <text x="270" y="122" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">8:14 AM</text>
                <text x="350" y="122" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">4:30 PM</text>
                <text x="430" y="122" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">8.27</text>
                <text x="490" y="122" fontFamily="system-ui, sans-serif" fontSize="11" fill="#4a9b6f">Yes — by parent</text>
                <text x="50" y="146" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">Apr 28</text>
                <text x="130" y="146" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">Liam Carter</text>
                <text x="270" y="146" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">7:55 AM</text>
                <text x="350" y="146" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">5:00 PM</text>
                <text x="430" y="146" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">9.08</text>
                <text x="490" y="146" fontFamily="system-ui, sans-serif" fontSize="11" fill="#4a9b6f">Yes — by parent</text>
                <text x="50" y="170" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">Apr 29</text>
                <text x="130" y="170" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">Sophia Johnson</text>
                <text x="270" y="170" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">8:20 AM</text>
                <text x="350" y="170" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">4:15 PM</text>
                <text x="430" y="170" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">7.92</text>
                <text x="490" y="170" fontFamily="system-ui, sans-serif" fontSize="11" fill="#4a9b6f">Yes — by parent</text>
                <text x="50" y="194" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">Apr 29</text>
                <text x="130" y="194" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">Liam Carter</text>
                <text x="270" y="194" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">—</text>
                <text x="350" y="194" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329">—</text>
                <text x="430" y="194" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">Absent</text>
                <text x="490" y="194" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">Provider-recorded</text>
                {/* Signature block */}
                <line x1="40" y1="240" x2="600" y2="240" stroke="#e8e0c8"/>
                <text x="40" y="270" fontFamily="Georgia, serif" fontSize="13" fill="#2c3329">Provider Certification</text>
                <text x="40" y="290" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">I certify the above attendance records are accurate and complete.</text>
                <line x1="40" y1="320" x2="320" y2="320" stroke="#7a8076"/>
                <text x="40" y="335" fontFamily="system-ui, sans-serif" fontSize="10" fill="#7a8076">Provider Signature</text>
                <line x1="380" y1="320" x2="540" y2="320" stroke="#7a8076"/>
                <text x="380" y="335" fontFamily="system-ui, sans-serif" fontSize="10" fill="#7a8076">Date</text>
                <text x="40" y="370" fontFamily="system-ui, sans-serif" fontSize="9" fill="#a8a48f">Parent/Substitute Parent signature line continues below…</text>
              </svg>
            </div>
          </div>

          {/* Feature 3: Families */}
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
              <svg viewBox="0 0 640 400" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: '100%' }}>
                <rect width="640" height="400" fill="#fdfcf7"/>
                {/* Header */}
                <text x="40" y="40" fontFamily="Georgia, serif" fontSize="20" fill="#2c3329">Families</text>
                <rect x="500" y="20" width="115" height="32" rx="6" fill="#4a6957"/>
                <text x="558" y="41" fontFamily="system-ui, sans-serif" fontSize="13" fontWeight="500" fill="white" textAnchor="middle">+ Add family</text>
                {/* Family card 1 */}
                <rect x="20" y="65" width="600" height="100" rx="10" fill="white" stroke="#e8e0c8"/>
                <circle cx="55" cy="115" r="22" fill="#dde8d9"/>
                <text x="55" y="121" fontFamily="Georgia, serif" fontSize="16" fontWeight="600" fill="#4a6957" textAnchor="middle">JF</text>
                <text x="95" y="100" fontFamily="Georgia, serif" fontSize="16" fill="#2c3329">The Johnson Family</text>
                <rect x="270" y="86" width="50" height="20" rx="10" fill="#dde8d9"/>
                <text x="295" y="100" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="600" fill="#4a6957" textAnchor="middle">ACTIVE</text>
                <rect x="328" y="86" width="60" height="20" rx="10" fill="#f4eee2"/>
                <text x="358" y="100" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="600" fill="#a8854a" textAnchor="middle">AUTOPAY</text>
                <text x="95" y="123" fontFamily="system-ui, sans-serif" fontSize="12" fill="#7a8076">Sophia (4) · Mia (2)</text>
                <text x="95" y="142" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">$280/wk · Bills weekly · Mon–Fri</text>
                <text x="600" y="125" fontFamily="Georgia, serif" fontSize="14" fontWeight="600" fill="#4a9b6f" textAnchor="end">Paid up</text>
                {/* Family card 2 */}
                <rect x="20" y="180" width="600" height="100" rx="10" fill="white" stroke="#e8e0c8"/>
                <circle cx="55" cy="230" r="22" fill="#f4eee2"/>
                <text x="55" y="236" fontFamily="Georgia, serif" fontSize="16" fontWeight="600" fill="#a8854a" textAnchor="middle">CF</text>
                <text x="95" y="215" fontFamily="Georgia, serif" fontSize="16" fill="#2c3329">The Carter Family</text>
                <rect x="265" y="201" width="50" height="20" rx="10" fill="#dde8d9"/>
                <text x="290" y="215" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="600" fill="#4a6957" textAnchor="middle">ACTIVE</text>
                <text x="95" y="238" fontFamily="system-ui, sans-serif" fontSize="12" fill="#7a8076">Liam (3)</text>
                <text x="95" y="257" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">$200/wk · Bills bi-weekly · Mon–Fri</text>
                <text x="600" y="240" fontFamily="Georgia, serif" fontSize="14" fontWeight="600" fill="#c0392b" textAnchor="end">$200 due</text>
                {/* Family card 3 */}
                <rect x="20" y="295" width="600" height="85" rx="10" fill="white" stroke="#e8e0c8"/>
                <circle cx="55" cy="338" r="22" fill="#dde8d9"/>
                <text x="55" y="344" fontFamily="Georgia, serif" fontSize="16" fontWeight="600" fill="#4a6957" textAnchor="middle">DF</text>
                <text x="95" y="325" fontFamily="Georgia, serif" fontSize="16" fill="#2c3329">The Davis Family</text>
                <rect x="248" y="311" width="50" height="20" rx="10" fill="#dde8d9"/>
                <text x="273" y="325" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="600" fill="#4a6957" textAnchor="middle">ACTIVE</text>
                <text x="95" y="348" fontFamily="system-ui, sans-serif" fontSize="12" fill="#7a8076">Emma (5)</text>
                <text x="95" y="367" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">$220/wk · Bills weekly · Mon–Fri</text>
                <text x="600" y="350" fontFamily="Georgia, serif" fontSize="14" fontWeight="600" fill="#4a9b6f" textAnchor="end">Paid up</text>
              </svg>
            </div>
          </div>

          {/* Feature 4: Billing */}
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
              <svg viewBox="0 0 640 400" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: '100%' }}>
                <rect width="640" height="400" fill="#fdfcf7"/>
                {/* Header & summary */}
                <text x="40" y="40" fontFamily="Georgia, serif" fontSize="20" fill="#2c3329">Billing</text>
                {/* Stat cards */}
                <rect x="20" y="60" width="195" height="80" rx="10" fill="white" stroke="#e8e0c8"/>
                <text x="40" y="85" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">OUTSTANDING</text>
                <text x="40" y="115" fontFamily="Georgia, serif" fontSize="22" fill="#c0392b">$420</text>
                <text x="40" y="132" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">2 invoices</text>
                <rect x="222" y="60" width="195" height="80" rx="10" fill="white" stroke="#e8e0c8"/>
                <text x="242" y="85" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">PAID THIS WEEK</text>
                <text x="242" y="115" fontFamily="Georgia, serif" fontSize="22" fill="#4a9b6f">$960</text>
                <text x="242" y="132" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">3 payments</text>
                <rect x="424" y="60" width="195" height="80" rx="10" fill="white" stroke="#e8e0c8"/>
                <text x="444" y="85" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">ON AUTOPAY</text>
                <text x="444" y="115" fontFamily="Georgia, serif" fontSize="22" fill="#2c3329">2 / 3</text>
                <text x="444" y="132" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">families</text>
                {/* Invoices section */}
                <text x="40" y="175" fontFamily="Georgia, serif" fontSize="15" fill="#2c3329">Recent invoices</text>
                <rect x="20" y="190" width="600" height="55" rx="8" fill="white" stroke="#e8e0c8"/>
                <text x="40" y="213" fontFamily="system-ui, sans-serif" fontSize="13" fontWeight="500" fill="#2c3329">Carter Family</text>
                <text x="40" y="230" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">INV-0042 · Apr 21–May 2 · Bi-weekly</text>
                <rect x="430" y="201" width="60" height="22" rx="11" fill="#fde7e3"/>
                <text x="460" y="216" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="600" fill="#c0392b" textAnchor="middle">UNPAID</text>
                <text x="600" y="221" fontFamily="Georgia, serif" fontSize="15" fontWeight="500" fill="#2c3329" textAnchor="end">$400</text>
                <rect x="20" y="255" width="600" height="55" rx="8" fill="white" stroke="#e8e0c8"/>
                <text x="40" y="278" fontFamily="system-ui, sans-serif" fontSize="13" fontWeight="500" fill="#2c3329">Johnson Family</text>
                <text x="40" y="295" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">INV-0041 · Apr 28–May 2 · Autopay Mon</text>
                <rect x="425" y="266" width="65" height="22" rx="11" fill="#f4eee2"/>
                <text x="458" y="281" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="600" fill="#a8854a" textAnchor="middle">SCHEDULED</text>
                <text x="600" y="286" fontFamily="Georgia, serif" fontSize="15" fontWeight="500" fill="#2c3329" textAnchor="end">$280</text>
                <rect x="20" y="320" width="600" height="55" rx="8" fill="white" stroke="#e8e0c8"/>
                <text x="40" y="343" fontFamily="system-ui, sans-serif" fontSize="13" fontWeight="500" fill="#2c3329">Davis Family</text>
                <text x="40" y="360" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">INV-0040 · Apr 21–25 · Paid Apr 26</text>
                <rect x="440" y="331" width="50" height="22" rx="11" fill="#dde8d9"/>
                <text x="465" y="346" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="600" fill="#4a6957" textAnchor="middle">PAID</text>
                <text x="600" y="351" fontFamily="Georgia, serif" fontSize="15" fontWeight="500" fill="#4a9b6f" textAnchor="end">$220</text>
              </svg>
            </div>
          </div>

          {/* Feature 5: Deductions */}
          <div className="landing-feature">
            <div className="landing-feature-text">
              <h3>Tax season, finally simple</h3>
              <p>
                Snap a photo of any receipt — AI extracts the merchant, amount, and category for you.
                T/S ratio calculator built in. Year-end Excel export your tax preparer will actually thank you for.
              </p>
            </div>
            <div className="landing-feature-image">
              <svg viewBox="0 0 640 400" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: '100%' }}>
                <rect width="640" height="400" fill="#fdfcf7"/>
                {/* Header */}
                <text x="40" y="40" fontFamily="Georgia, serif" fontSize="20" fill="#2c3329">2026 Deductions</text>
                {/* Total + T/S card */}
                <rect x="20" y="60" width="395" height="100" rx="10" fill="white" stroke="#e8e0c8"/>
                <text x="40" y="85" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">TOTAL DEDUCTIONS</text>
                <text x="40" y="125" fontFamily="Georgia, serif" fontSize="32" fill="#2c3329">$3,247</text>
                <text x="40" y="148" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">42 receipts · +12 this month</text>
                <rect x="425" y="60" width="195" height="100" rx="10" fill="white" stroke="#e8e0c8"/>
                <text x="445" y="85" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">T/S RATIO</text>
                <text x="445" y="125" fontFamily="Georgia, serif" fontSize="32" fill="#4a6957">38.4%</text>
                <text x="445" y="148" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">Time-Space deduction</text>
                {/* Recent receipts */}
                <text x="40" y="195" fontFamily="Georgia, serif" fontSize="15" fill="#2c3329">Recent receipts</text>
                <rect x="20" y="210" width="600" height="50" rx="8" fill="white" stroke="#e8e0c8"/>
                <rect x="32" y="222" width="32" height="26" rx="4" fill="#dde8d9"/>
                <text x="48" y="240" fontSize="14" textAnchor="middle">🛒</text>
                <text x="78" y="232" fontFamily="system-ui, sans-serif" fontSize="13" fontWeight="500" fill="#2c3329">Meijer</text>
                <text x="78" y="248" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">May 5 · Groceries</text>
                <text x="600" y="241" fontFamily="Georgia, serif" fontSize="14" fontWeight="500" fill="#2c3329" textAnchor="end">$87.42</text>
                <rect x="20" y="270" width="600" height="50" rx="8" fill="white" stroke="#e8e0c8"/>
                <rect x="32" y="282" width="32" height="26" rx="4" fill="#f4eee2"/>
                <text x="48" y="300" fontSize="14" textAnchor="middle">🧸</text>
                <text x="78" y="292" fontFamily="system-ui, sans-serif" fontSize="13" fontWeight="500" fill="#2c3329">Target</text>
                <text x="78" y="308" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">May 3 · Toys & Activities</text>
                <text x="600" y="301" fontFamily="Georgia, serif" fontSize="14" fontWeight="500" fill="#2c3329" textAnchor="end">$34.99</text>
                <rect x="20" y="330" width="600" height="50" rx="8" fill="white" stroke="#e8e0c8"/>
                <rect x="32" y="342" width="32" height="26" rx="4" fill="#dde8d9"/>
                <text x="48" y="360" fontSize="14" textAnchor="middle">🧽</text>
                <text x="78" y="352" fontFamily="system-ui, sans-serif" fontSize="13" fontWeight="500" fill="#2c3329">Costco</text>
                <text x="78" y="368" fontFamily="system-ui, sans-serif" fontSize="11" fill="#7a8076">May 1 · Cleaning & Household</text>
                <text x="600" y="361" fontFamily="Georgia, serif" fontSize="14" fontWeight="500" fill="#2c3329" textAnchor="end">$142.18</text>
              </svg>
            </div>
          </div>

          {/* Feature 6: Parent portal */}
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
              <svg viewBox="0 0 640 400" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: '100%' }}>
                <rect width="640" height="400" fill="#fdfcf7"/>
                {/* Phone frame */}
                <rect x="180" y="30" width="280" height="350" rx="28" fill="#2c3329"/>
                <rect x="190" y="40" width="260" height="330" rx="20" fill="#fdfcf7"/>
                {/* Status bar */}
                <text x="320" y="58" fontFamily="system-ui, sans-serif" fontSize="9" fill="#7a8076" textAnchor="middle">9:41 AM</text>
                {/* Hero balance */}
                <rect x="200" y="70" width="240" height="80" rx="10" fill="#dde8d9"/>
                <text x="320" y="92" fontFamily="system-ui, sans-serif" fontSize="9" fill="#4a6957" textAnchor="middle">JOHNSON FAMILY · WITH MARY'S DAYCARE</text>
                <text x="320" y="125" fontFamily="Georgia, serif" fontSize="28" fill="#2c3329" textAnchor="middle">$0.00</text>
                <text x="320" y="142" fontFamily="system-ui, sans-serif" fontSize="9" fill="#4a6957" textAnchor="middle">All caught up — autopay handles the rest ⚡</text>
                {/* Today section */}
                <text x="200" y="175" fontFamily="Georgia, serif" fontSize="13" fill="#2c3329">Today</text>
                <rect x="200" y="183" width="240" height="55" rx="8" fill="white" stroke="#e8e0c8"/>
                <text x="212" y="205" fontFamily="Georgia, serif" fontSize="13" fontWeight="500" fill="#2c3329">Sophia</text>
                <text x="212" y="222" fontFamily="system-ui, sans-serif" fontSize="10" fill="#4a9b6f">✓ Dropped off at 8:14 AM</text>
                <rect x="370" y="200" width="60" height="22" rx="11" fill="#dde8d9"/>
                <text x="400" y="215" fontFamily="system-ui, sans-serif" fontSize="9" fontWeight="600" fill="#4a6957" textAnchor="middle">At daycare</text>
                {/* Autopay card */}
                <rect x="200" y="252" width="240" height="60" rx="10" fill="white" stroke="#e8e0c8"/>
                <text x="212" y="273" fontFamily="Georgia, serif" fontSize="12" fill="#2c3329">⚡ Autopay is on</text>
                <rect x="370" y="262" width="55" height="20" rx="10" fill="#dde8d9"/>
                <text x="397" y="276" fontFamily="system-ui, sans-serif" fontSize="9" fontWeight="600" fill="#4a6957" textAnchor="middle">ACTIVE</text>
                <text x="212" y="293" fontFamily="system-ui, sans-serif" fontSize="10" fill="#7a8076">We'll charge your card every Monday at 9 AM.</text>
                {/* Action buttons */}
                <rect x="200" y="325" width="115" height="35" rx="8" fill="white" stroke="#e8e0c8"/>
                <text x="257" y="346" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329" textAnchor="middle">💬 Messages</text>
                <rect x="325" y="325" width="115" height="35" rx="8" fill="white" stroke="#e8e0c8"/>
                <text x="382" y="346" fontFamily="system-ui, sans-serif" fontSize="11" fill="#2c3329" textAnchor="middle">⚙️ My Family</text>
              </svg>
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
