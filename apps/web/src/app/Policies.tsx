import type { ReactNode } from 'react';

/**
 * Privacy, terms, and support: the three pages Onshape's App Store entry links to. They describe what the Worker
 * actually stores (see apps/worker/src/index.ts and CLAUDE.md); change them together with any new KV key or lifetime.
 */
export const supportUrl = 'https://github.com/ZOGWORK/control-kit/issues';
const updated = 'October 26, 2026';

export type PolicyPage = 'privacy' | 'terms' | 'support';
export const policyPages: PolicyPage[] = ['privacy', 'terms', 'support'];
const titles: Record<PolicyPage, string> = { privacy: 'Privacy', terms: 'Terms of use', support: 'Support' };

const External = ({ href, children }: { href: string; children: ReactNode }) => <a className="link" href={href} target="_blank" rel="noopener noreferrer">{children}</a>;

export function PolicyLinks() {
  return <nav className="policy-links" aria-label="Policies">
    {policyPages.map(page => <a key={page} className="link" href={`/${page}`}>{titles[page]}</a>)}
  </nav>;
}

export function Policy({ page }: { page: PolicyPage }) {
  return <main className="landing policy">
    <header className="landing-hero">
      <a className="brand" href="/"><img className="brand-mark" src="/control-kit-logo.png" alt="" /><span>Control Kit</span></a>
      <h1>{titles[page]}</h1>
      {page !== 'support' && <p className="muted small">Last updated {updated}</p>}
    </header>
    {page === 'privacy' ? <Privacy /> : page === 'terms' ? <Terms /> : <Support />}
    <footer className="landing-footer muted small"><PolicyLinks /></footer>
  </main>;
}

function Privacy() {
  return <>
    <section className="landing-section">
      <p className="landing-lead">Control Kit reads your Onshape assembly to build its bill of materials. It never edits your CAD, never sells data, and shows no ads.</p>
    </section>
    <section className="landing-section">
      <h2>What Control Kit reads</h2>
      <ul className="landing-list">
        <li><strong>Your Onshape profile</strong> (the "read your profile" permission): your Onshape user id and name. The name shows who is signed in and who changed a part's type.</li>
        <li><strong>Your documents</strong> (the "read your documents" permission): only the assembly you open Control Kit beside, its bill of materials, part pictures, and the STEP files you ask to export.</li>
      </ul>
    </section>
    <section className="landing-section">
      <h2>What it keeps, and for how long</h2>
      <ul className="landing-list">
        <li>Your Onshape sign-in tokens, encrypted on our server, for 30 days after you last use Control Kit. Your browser holds only a random session cookie. Signing out deletes them at once.</li>
        <li>For you alone: the assembly and its bill of materials for 30 days per revision, your latest scan for a week, part pictures for 30 days, and exported STEP files for an hour. These make rescans fast and keep Onshape requests low.</li>
        <li>Your team number, if you enter one in Settings.</li>
        <li>Your team's part choices, saved with the document for everyone who scans it, with the name of who made each change. The history of changes is kept for a year.</li>
        <li>Daily counts of Onshape requests and their results, with no names, documents, or part data.</li>
      </ul>
    </section>
    <section className="landing-section">
      <h2>What leaves Control Kit</h2>
      <ul className="landing-list">
        <li><strong>Control Point</strong>, only if you link a Control Point account and press Send: the reviewed bill of materials goes to the workspace you pick. A record of what was sent is kept for a year.</li>
        <li><strong>AI review</strong>, only when you ask for it: the names, descriptions, and candidate products of the undecided parts are sent to Google Gemini, or to Anthropic if Gemini is unavailable. Nothing else from your document is sent.</li>
        <li>Nothing else. Vendor prices come from the vendors' public catalogs, which Control Kit reads on its own schedule, not with your data.</li>
      </ul>
    </section>
    <section className="landing-section">
      <h2>Where it runs</h2>
      <p className="landing-lead">Control Kit runs on Cloudflare (Pages and Workers, with data in Workers KV). All traffic uses HTTPS. You can remove Control Kit's access at any time in Onshape under My account, Applications.</p>
    </section>
    <section className="landing-section">
      <h2>Questions or deletion</h2>
      <p className="landing-lead">To ask about your data or have it deleted sooner, see <a className="link" href="/support">Support</a>. Control Kit is built for FIRST Tech Challenge teams and is not directed at children under 13 on their own; students use it through their team's Onshape accounts.</p>
    </section>
  </>;
}

function Terms() {
  return <>
    <section className="landing-section">
      <p className="landing-lead">These terms cover your use of Control Kit, an app for Onshape made by ZOGWORK. By adding Control Kit to your Onshape account you agree to them.</p>
    </section>
    <section className="landing-section">
      <h2>Using Control Kit</h2>
      <ul className="landing-list">
        <li>Control Kit is free. We may add, change, or remove features, or stop the service, at any time.</li>
        <li>Use it only with documents you are allowed to read, and follow Onshape's own terms of use.</li>
        <li>Don't try to break, overload, or get around the limits of Control Kit, Onshape, or the vendor sites it reads.</li>
        <li>Your documents stay yours. Control Kit only reads them, as described in the <a className="link" href="/privacy">privacy page</a>.</li>
      </ul>
    </section>
    <section className="landing-section">
      <h2>Prices and parts</h2>
      <p className="landing-lead">Prices, stock, and pack sizes come from public vendor catalogs and can be out of date or wrong. Totals are list prices before shipping, tax, or discounts. Check every order with the vendor before you buy, and check every part before you make it.</p>
    </section>
    <section className="landing-section">
      <h2>No warranty</h2>
      <p className="landing-lead">Control Kit is provided "as is", without warranties of any kind, express or implied, including fitness for a particular purpose. To the extent the law allows, ZOGWORK is not liable for any indirect, incidental, or consequential damages, or for any loss arising from your use of Control Kit, including incorrect orders or parts.</p>
    </section>
    <section className="landing-section">
      <h2>Changes</h2>
      <p className="landing-lead">We may update these terms; the date above shows the latest version. Continuing to use Control Kit after a change means you accept it. Questions go to <a className="link" href="/support">Support</a>.</p>
    </section>
    <p className="muted small">Onshape is a trademark of PTC Inc. FIRST and FIRST Tech Challenge are trademarks of FIRST. goBILDA, REV, ServoCity, AndyMark, and Pitsco are trademarks of their owners. Control Kit is not affiliated with or endorsed by any of them.</p>
  </>;
}

function Support() {
  return <>
    <section className="landing-section">
      <p className="landing-lead">Questions, a part sorted wrong, or something broken? <External href={supportUrl}>Open an issue on GitHub</External>. We read every one and reply there.</p>
      <ul className="landing-list">
        <li>Say which screen you were on and what you expected. A screenshot helps.</li>
        <li>Issues are public, so leave out private document links or anything you don't want seen. If it can't be public, open an issue asking us to contact you and we'll take it from there.</li>
        <li>To have your data deleted, open an issue titled "Delete my data". Signing out already deletes your sign-in tokens.</li>
      </ul>
    </section>
    <section className="landing-section">
      <h2>Common answers</h2>
      <ul className="landing-list">
        <li><strong>The panel says to connect again.</strong> Onshape's sign-in needs third-party cookies allowed for cad.onshape.com and control-kit.pages.dev.</li>
        <li><strong>A document can't be read.</strong> On free Onshape plans, a document may need to be public before apps can read it.</li>
        <li><strong>A part has no price.</strong> Control Kit prices a part only when its vendor SKU, pack size, and price are verified. Add the vendor SKU to the part number in Onshape and rescan.</li>
      </ul>
    </section>
  </>;
}
