import { Lock, Shield, CreditCard, FileText, AlertCircle, CheckCircle, Eye, EyeOff } from 'lucide-react'
import '@/styles/how-money-works.css'

export default function HowMoneyWorksPage() {
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: 'var(--space-2) 0' }}>
      {/* Hero */}
      <div style={{
        background: 'linear-gradient(135deg, var(--clr-sage-dark) 0%, var(--clr-sage) 100%)',
        borderRadius: 'var(--radius-xl)',
        padding: 'var(--space-8)',
        color: 'white',
        marginBottom: 'var(--space-6)',
        position: 'relative',
        overflow: 'hidden',
      }}>
        <div style={{ position: 'relative', zIndex: 1, maxWidth: 520 }}>
          <div style={{
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
          }}>
            <Shield size={13} /> Plain-English Transparency
          </div>
          <h1 style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(1.75rem, 4vw, 2.25rem)',
            fontWeight: 400,
            letterSpacing: '-0.02em',
            lineHeight: 1.2,
            marginBottom: 'var(--space-3)',
          }}>
            How money <em style={{ fontStyle: 'italic', color: 'var(--clr-accent-light)' }}>actually</em> works in MI Little Care
          </h1>
          <p style={{ color: 'rgba(255,255,255,0.85)', fontSize: '1rem', lineHeight: 1.6 }}>
            The straight facts about how payments flow, what we see, what we don't,
            and what protects you. No legalese.
          </p>
        </div>
      </div>

      {/* Section: What we never see */}
      <Section icon={<EyeOff size={22} />} iconClass="error" title="What we NEVER see">
        <p>
          When parents pay you, their card information goes <strong>directly from their phone to Stripe</strong>.
          It never passes through MI Little Care's servers. We physically cannot access:
        </p>
        <ul className="hmw-list">
          <li>Card numbers</li>
          <li>Bank account or routing numbers</li>
          <li>CVV codes</li>
          <li>Expiration dates</li>
        </ul>
        <p style={{ marginTop: 'var(--space-3)' }}>
          Even if our database were hacked tomorrow, the attacker couldn't charge anyone's
          card — because that data isn't in our database in the first place.
        </p>
      </Section>

      {/* Section: What we DO store */}
      <Section icon={<Eye size={22} />} iconClass="sage" title="What we DO store">
        <p>For display purposes only:</p>
        <ul className="hmw-list">
          <li><strong>"Visa ending in 4242"</strong> — so you and the parent can identify which card</li>
          <li><strong>A meaningless Stripe token</strong> like <code>cus_NQhXrLp7K</code> — useless to anyone except Stripe</li>
        </ul>
        <p style={{ marginTop: 'var(--space-3)' }}>
          That's it. That's the entire payment-related dataset for any family in MI Little Care.
        </p>
      </Section>

      {/* Section: Who handles your money */}
      <Section icon={<CreditCard size={22} />} iconClass="accent" title="Who actually handles your money">
        <p>
          <strong>Stripe</strong> processes every payment. They are PCI DSS Level 1 certified —
          the highest tier of card security that exists. They handle payments for:
        </p>
        <ul className="hmw-list">
          <li>Lyft, DoorDash, Instacart, Target, Shopify, Substack, and millions of other businesses</li>
          <li>Over <strong>$1 trillion</strong> in payments annually</li>
        </ul>
        <p style={{ marginTop: 'var(--space-3)' }}>
          Your parents are paying through the same secure infrastructure they already use
          on dozens of sites. <strong>Safer than swiping a card at any restaurant.</strong>
        </p>
      </Section>

      {/* Section: How a payment actually flows */}
      <Section icon={<CheckCircle size={22} />} iconClass="success" title="How a payment actually flows">
        <ol style={{ paddingLeft: 'var(--space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <li>You generate an invoice for a family</li>
          <li>The parent gets an email with a payment link</li>
          <li>Parent taps the link → lands on a secure Stripe-powered page</li>
          <li>Parent pays with card, Apple Pay, or Google Pay</li>
          <li>Stripe processes the payment (their infrastructure, their security)</li>
          <li>Stripe sends MI Little Care a "yes, paid" confirmation</li>
          <li>We update the invoice status — that's it</li>
          <li>Money lands in your Stripe account, then transfers to your bank (typically 2 business days)</li>
        </ol>
        <p style={{ marginTop: 'var(--space-4)' }}>
          MI Little Care never holds your money. It goes straight from parent → Stripe → your bank account.
        </p>
      </Section>

      {/* Section: Autopay */}
      <Section icon={<Lock size={22} />} iconClass="warning" title="What about autopay?">
        <p>
          When a parent enrolls in autopay, they explicitly authorize Stripe to charge their
          card on a schedule (e.g., every Monday at 9 AM). The authorization is:
        </p>
        <ul className="hmw-list">
          <li>Tied to your specific family rate and billing day</li>
          <li>Cancelable by the parent at any time, in 2 taps</li>
          <li>Documented for legal record (we keep proof of consent)</li>
          <li>Confirmed by email after every successful charge</li>
        </ul>
        <p style={{ marginTop: 'var(--space-3)' }}>
          If a parent's card fails, Stripe automatically retries and notifies both of you.
          You don't have to manage any of it.
        </p>
      </Section>

      {/* Section: 1099-K */}
      <Section icon={<FileText size={22} />} iconClass="sage" title="The Form 1099-K — what you need to know">
        <p>
          <strong>This is important.</strong> Once you receive more than <strong>$5,000 in
          payments per year</strong> through Stripe, the IRS requires Stripe to issue you a
          <strong> Form 1099-K</strong> at tax time.
        </p>
        <p>
          For most active providers, this happens within the <strong>first 7-8 weeks</strong> of accepting payments.
          You'll receive your 1099-K in late January for the previous year's payments.
        </p>
        <div style={{
          background: 'var(--clr-warning-pale)',
          border: '1px solid rgba(212,153,63,0.25)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-4)',
          marginTop: 'var(--space-3)',
        }}>
          <strong style={{ color: 'var(--clr-warning)', display: 'block', marginBottom: 4 }}>What to do with it:</strong>
          The 1099-K reports your gross payment income to the IRS. You'll use it (along with
          your tracked deductions in MI Little Care) when filing your taxes. Most providers
          give it to their tax preparer. <strong>You're not in trouble — this is normal.</strong>
        </div>
        <p style={{ marginTop: 'var(--space-3)' }}>
          We'll send you a reminder when your 1099-K is available each January.
        </p>
      </Section>

      {/* Section: Disputes & chargebacks */}
      <Section icon={<AlertCircle size={22} />} iconClass="error" title="If a parent disputes a charge">
        <p>
          Parents are protected by their card issuer's fraud protection — same as any online
          purchase. If a parent claims they didn't authorize a charge:
        </p>
        <ul className="hmw-list">
          <li>Stripe handles the dispute process directly with the card company</li>
          <li>We provide them with the parent's autopay authorization on file (proves consent)</li>
          <li>You're not personally liable for the chargeback investigation</li>
          <li>If the dispute is upheld, the funds are returned and the invoice is reopened</li>
        </ul>
        <p style={{ marginTop: 'var(--space-3)' }}>
          Disputes are rare when families have explicit autopay authorization on file. We
          make sure that authorization is captured cleanly for every parent who enrolls.
        </p>
      </Section>

      {/* Section: Your subscription to MI Little Care */}
      <Section icon={<CreditCard size={22} />} iconClass="sage" title="Your $10/month subscription">
        <p>
          Your subscription to MI Little Care is also processed through Stripe. We use the
          same secure infrastructure for our own billing.
        </p>
        <ul className="hmw-list">
          <li>Cancel anytime in 2 taps from the Subscription page</li>
          <li>If you cancel, you keep access until the end of your paid period</li>
          <li>No refunds for unused time, but no penalties or contracts either</li>
          <li>Update your card or pause billing whenever you need to</li>
        </ul>
      </Section>

      {/* Footer reassurance */}
      <div style={{
        background: 'var(--clr-cream)',
        border: '1px solid var(--clr-warm-mid)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-5)',
        textAlign: 'center',
        color: 'var(--clr-ink-mid)',
        fontSize: '0.9375rem',
        marginTop: 'var(--space-6)',
      }}>
        <Shield size={20} style={{ color: 'var(--clr-sage-dark)', marginBottom: 'var(--space-2)' }} />
        <div style={{ marginBottom: 4 }}>
          Have a question we didn't answer here?
        </div>
        <div>
          Email us at <a href="mailto:support@milittlecare.com" style={{ color: 'var(--clr-sage-dark)', fontWeight: 500 }}>support@milittlecare.com</a>
        </div>
      </div>
    </div>
  )
}

function Section({ icon, iconClass, title, children }) {
  return (
    <section style={{
      background: 'var(--clr-white)',
      border: '1px solid var(--clr-warm-mid)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-6)',
      marginBottom: 'var(--space-4)',
      boxShadow: 'var(--shadow-sm)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
        <div className={`stat-icon ${iconClass}`} style={{ width: 44, height: 44 }}>
          {icon}
        </div>
        <h2 style={{
          fontFamily: 'var(--font-display)',
          fontSize: '1.25rem',
          fontWeight: 500,
          color: 'var(--clr-ink)',
          letterSpacing: '-0.01em',
          margin: 0,
        }}>
          {title}
        </h2>
      </div>
      <div className="hmw-content" style={{
        color: 'var(--clr-ink-mid)',
        fontSize: '0.9375rem',
        lineHeight: 1.65,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}>
        {children}
      </div>
    </section>
  )
}
