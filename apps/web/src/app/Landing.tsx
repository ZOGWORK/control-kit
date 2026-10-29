import { Boxes, FileSearch, ShoppingCart, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { Policy, PolicyLinks, policyPages, type PolicyPage } from './Policies';

/**
 * The page for someone who opens control-kit.pages.dev outside Onshape: what Control Kit does, shown with real
 * screenshots of a scanned FTC robot (HORS), and how to install it. Inside Onshape the panel always has assembly context.
 */
const appStoreUrl = 'https://cad.onshape.com/appstore';
// Set to true once Onshape publishes the listing; until then the page says Control Kit is not listed yet.
const listed = false;

const features: Array<{ icon: ReactNode; title: string; text: string; image: string; alt: string }> = [
  { icon: <Boxes aria-hidden />, title: 'Every part, sorted', image: 'overview', alt: 'Overview of a scanned FTC robot: its Onshape picture, 119 unique parts split into 61 to buy, 55 to make, and 3 fasteners, $1,768.05 priced so far',
    text: "Control Kit reads the assembly and Onshape's bill of materials, then sorts every part into buy, make, or fastener. Vendor part numbers, standard hardware, linked libraries, and team tags such as \"(3D PRINT)\" decide most parts, so few are left for you." },
  { icon: <ShoppingCart aria-hidden />, title: 'A buy list with real prices', image: 'buy-list', alt: 'Buy list grouped by vendor, with SKUs, quantities, packs to order, prices, and stock',
    text: 'Parts are matched by SKU against the goBILDA, REV, ServoCity, AndyMark, and Pitsco catalogs. Orders round up to whole packs, and a part is priced only when its match, pack size, and price are all verified, so the total never looks complete when it isn\'t.' },
  { icon: <Wrench aria-hidden />, title: 'STEP files for everything you make', image: 'make', alt: 'Make list of 3D-printed and 2D-cut parts with a Download STEP files button',
    text: 'Printed, CNC, and 2D-cut parts download as one ZIP of STEP files straight from Onshape, with a manifest of sources and quantities.' },
  { icon: <FileSearch aria-hidden />, title: 'Every decision explained', image: 'part-drawer', alt: 'Part details for a goBILDA Yellow Jacket motor, with its Onshape picture and exact SKU match',
    text: 'Each part shows its picture from Onshape and why it was sorted the way it was, and one click changes it for the whole team. The Excel workbook carries the buy list with live totals, the make list, and links to every product and Part Studio.' },
];

export function Landing() {
  const page = location.pathname.replace(/^\/+|\/+$/g, '') as PolicyPage;
  if (policyPages.includes(page)) return <Policy page={page} />;
  return <main className="landing">
    <header className="landing-hero">
      <div className="brand"><img className="brand-mark" src="/control-kit-logo.png" alt="" /><span>Control Kit</span></div>
      <h1>Your FTC robot's bill of materials, straight from Onshape</h1>
      <p className="landing-lead">Scan an assembly and get what to buy, with vendor prices, and what to make, with STEP files. Built for FIRST Tech Challenge teams.</p>
      <div className="inline-actions">
        <a className="landing-cta" href="#install">How to install</a>
        <a className="landing-link" href={appStoreUrl} target="_blank" rel="noopener noreferrer">Onshape App Store</a>
      </div>
      {!listed && <p className="muted small">Control Kit is not in the Onshape App Store yet. The steps below work once it is listed.</p>}
      <img className="landing-shot" src="/listing/in-onshape.webp" width={2000} height={1000} alt="Control Kit scanning the HORS robot in Onshape's right panel, beside the 3D assembly" />
    </header>

    <section className="landing-features" aria-label="What Control Kit does">
      {features.map((feature, index) => <article key={feature.title} className={`landing-feature${index % 2 ? ' flip' : ''}`}>
        <div className="landing-copy"><span className="landing-icon">{feature.icon}</span><h2>{feature.title}</h2><p>{feature.text}</p></div>
        <img className="landing-shot" src={`/listing/${feature.image}.webp`} width={1600} height={1000} loading="lazy" alt={feature.alt} />
      </article>)}
    </section>

    <section id="install" className="landing-section">
      <h2>Install</h2>
      <ol className="landing-steps">
        <li><strong>Add Control Kit to your Onshape account.</strong> Open the <a className="link" href={appStoreUrl} target="_blank" rel="noopener noreferrer">Onshape App Store</a>, search for Control Kit, and add it.</li>
        <li><strong>Open it beside an assembly.</strong> In any Assembly tab, choose Control Kit in the right-hand panel.</li>
        <li><strong>Connect Onshape.</strong> Sign-in opens in a new tab and asks for read access to your documents and profile. Come back to the panel and choose "I've connected".</li>
        <li><strong>Scan.</strong> A scan reads the assembly at its current revision. Your team's choices are saved with the document and kept across rescans.</li>
      </ol>
      <img className="landing-shot narrow" src="/listing/panel-overview.webp" width={640} height={1310} loading="lazy" alt="Control Kit in the narrow Onshape right panel" />
    </section>

    <section id="data" className="landing-section">
      <h2>Your data</h2>
      <ul className="landing-list">
        <li>Control Kit only reads documents. It never edits your CAD.</li>
        <li>Onshape sign-in tokens are stored encrypted on our server; your browser holds only an opaque session cookie.</li>
        <li>To make rescans fast and cheap, Control Kit keeps, for you alone, the assembly and its bill of materials for 30 days per revision, your latest scan for a week, part pictures for 30 days, and exported STEP files for an hour.</li>
        <li>Vendor prices come from the vendors' public catalogs. Totals are list prices before shipping, tax, or team discounts.</li>
        <li>If AI review is turned on and you ask for it, the undecided parts' names, descriptions, part numbers, and candidate products, with a few details from the assembly, are sent to Google Gemini, or to Anthropic if Gemini is unavailable. Nothing is sent unless you click it.</li>
      </ul>
      <p className="muted small">The full details are on the <a className="link" href="/privacy">privacy page</a>.</p>
    </section>

    <section className="landing-section">
      <h2>Good to know</h2>
      <ul className="landing-list">
        <li>On free Onshape plans, a document may need to be public before apps can read it.</li>
        <li>Onshape's sign-in needs third-party cookies allowed for the panel to stay connected.</li>
        <li>Questions or a part sorted wrong? See <a className="link" href="/support">Support</a>.</li>
      </ul>
    </section>
    <footer className="landing-footer muted small"><PolicyLinks /><span>Control Kit is an independent app for Onshape. Onshape is a trademark of PTC Inc.; goBILDA, REV, ServoCity, AndyMark, and Pitsco are trademarks of their owners.</span></footer>
  </main>;
}
