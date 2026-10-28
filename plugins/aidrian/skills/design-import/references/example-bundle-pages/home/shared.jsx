/* global React */
// MIXED FILE — classify by export role, not by file.
// Icons + primitives: TRANSLATE (map to the project design system / repo icon set).
// Mock data: DISCARD (never a product source).

/* ============ Icons — TRANSLATE ============ */
const exIconPaths = {
  plus: 'M12 4.5v15m7.5-7.5h-15',
  check: 'm4.5 12.75 6 6 9-13.5',
};

const ExIcon = ({ name, size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path d={exIconPaths[name]} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* ============ Shared primitives — TRANSLATE ============ */
const ExBtn = ({ children, primary }) => (
  <button
    style={{
      fontFamily: 'var(--font-sans)',
      borderRadius: 'var(--radius)',
      padding: '8px 14px',
      background: primary ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
      color: primary ? 'hsl(var(--primary-foreground))' : 'hsl(var(--foreground))',
      border: 'none',
    }}
  >
    {children}
  </button>
);

/* ============ Mock data — DISCARD ============ */
const EX_ITEMS = [
  { id: 1, name: 'Alpha booking', status: 'confirmed' },
  { id: 2, name: 'Beta booking', status: 'pending' },
];
